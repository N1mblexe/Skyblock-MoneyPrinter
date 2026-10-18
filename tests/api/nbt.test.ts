import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  base64ToBytes,
  decodeItemBytes,
  decodeItemBytesRoot,
  decodeRoot,
  extraAttributes,
  gunzip,
  gunzipBytes,
  itemCount,
  itemFromNbt,
  itemName,
  neuItemIdForScan,
  petInfoFromNbt,
  readNbt,
  SALES_SKIP,
  SCAN_SKIP,
  skyblockIdFromNbt,
  type NbtCompound,
} from '../../src/api/nbt.ts';
import page from '../fixtures/api/auctions-page.json' with { type: 'json' };
import ended from '../fixtures/ah-ended.json' with { type: 'json' };
import ahPage from '../fixtures/ah-page.json' with { type: 'json' };
import { byte, bytes, comp, double, float, int, itemB64, ints, list, long, longs, nbt, short, str, type W } from './nbtWriter.ts';

const EXPECTED_IDS = [
  'LUMBERJACK_ARTIFACT', 'CROWN_OF_AVARICE', 'CONTRABAND', 'GAUNTLET_OF_CONTAGION', 'CRIMSON_BOOTS', 'RABBIT_THE_FISH',
  'SORROW_LEGGINGS', 'SUNDIAL', 'LUSH_ARTIFACT', 'HYPERION', 'POWER_WITHER_HELMET', 'WARDEN_HELMET', 'BLACK_CAT;5',
  'HYPERION', 'JUJU_SHORTBOW', 'GOD_POTION_2', 'GOD_POTION_2', 'GOD_POTION_2', 'BLACK_CAT;5', 'HYPERION', 'HYPERION',
  'MACHINE_GUN_BOW', 'SCATHA;3',
];

describe('NBT reader on real item_bytes', () => {
  it('decodes every fixture auction to the expected id', async () => {
    const ids: (string | null)[] = [];
    for (const a of page.auctions) ids.push(skyblockIdFromNbt(await decodeItemBytes(a.item_bytes)));
    expect(ids).toEqual(EXPECTED_IDS);
  });

  it('exposes the full item (display name, count) through the root', async () => {
    const hype = page.auctions.find((a) => a.item_name.includes('Hyperion'))!;
    const root = await decodeItemBytesRoot(hype.item_bytes);
    const item = (root.i as NbtCompound[])[0]!;
    expect(item.Count).toBe(1);
    const display = (item.tag as NbtCompound).display as NbtCompound;
    expect(String(display.Name)).toContain('Hyperion');
    expect(Array.isArray(display.Lore)).toBe(true);
    const ea = extraAttributes(root)!;
    expect(ea.id).toBe('HYPERION');
    expect(typeof ea.uuid).toBe('string');
    expect(skyblockIdFromNbt(root)).toBe('HYPERION');
  });

  it('pets: petInfo JSON -> TYPE;RARITYINDEX, tier boost does not change the id', async () => {
    const cat = page.auctions.find((a) => a.item_name.includes('Black Cat'))!;
    const ea = (await decodeItemBytes(cat.item_bytes))!;
    expect(ea.id).toBe('PET');
    expect(JSON.parse(ea.petInfo as string)).toMatchObject({ type: 'BLACK_CAT', tier: 'MYTHIC' });
    expect(skyblockIdFromNbt(ea)).toBe('BLACK_CAT;5');

    const scatha = page.auctions.find((a) => a.item_name.includes('Scatha'))!;
    expect(scatha.tier).toBe('LEGENDARY'); // displayed tier is boosted
    const sea = (await decodeItemBytes(scatha.item_bytes))!;
    expect(JSON.parse(sea.petInfo as string)).toMatchObject({ tier: 'EPIC', heldItem: 'PET_ITEM_TIER_BOOST' });
    expect(skyblockIdFromNbt(sea)).toBe('SCATHA;3');
  });
});

describe('readNbt', () => {
  it('reads all tag types 1-12', () => {
    const root = readNbt(
      nbt(
        {
          b: byte(-5),
          s: short(-300),
          i: int(-70_000),
          l: long(1_791_969_546_275n),
          f: float(1.5),
          d: double(-2.25),
          ba: bytes([1, -1, 127]),
          str: str('§6Hyperion ✪'),
          li: list(3, [int(1), int(2)]),
          empty: list(0, []),
          c: comp({ x: str('y') }),
          ia: ints([1, -2, 3]),
          la: longs([5n, -6n]),
        },
        'root',
      ),
    );
    expect(root).toEqual({
      b: -5,
      s: -300,
      i: -70_000,
      l: 1_791_969_546_275,
      f: 1.5,
      d: -2.25,
      ba: Int8Array.from([1, -1, 127]),
      str: '§6Hyperion ✪',
      li: [1, 2],
      empty: [],
      c: { x: 'y' },
      ia: Int32Array.from([1, -2, 3]),
      la: [5, -6],
    });
  });

  it('empty root is {}', () => {
    expect(readNbt(Uint8Array.of(0))).toEqual({});
  });

  it('rejects malformed data', () => {
    expect(() => readNbt(Uint8Array.of(8, 0, 0))).toThrow(/root must be a compound/);
    expect(() => readNbt(Uint8Array.of())).toThrow(/unexpected end/);
    const good = nbt({ a: int(1) });
    expect(() => readNbt(good.subarray(0, good.length - 3))).toThrow(/unexpected end/);
    expect(() => readNbt(Uint8Array.of(10, 0, 0, 13, 0, 1, 97))).toThrow(/unknown tag type 13/);
    expect(() => readNbt(Uint8Array.of(10, 0, 0, 7, 0, 1, 97, 255, 255, 255, 255))).toThrow(/negative length/);
  });

  it('rejects absurd nesting', () => {
    let w = list(0, []);
    for (let i = 0; i < 600; i++) w = list(9, [w]);
    expect(() => readNbt(nbt({ deep: w }))).toThrow(/too deep/);
  });
});

describe('gunzip / base64', () => {
  it('round-trips through fflate, sync and async', async () => {
    const data = new TextEncoder().encode('hello nbt'.repeat(50));
    expect(gunzipBytes(new Uint8Array(gzipSync(data)))).toEqual(data);
    expect(await gunzip(new Uint8Array(gzipSync(data)))).toEqual(data);
    expect(base64ToBytes(Buffer.from([0, 1, 254, 255]).toString('base64'))).toEqual(Uint8Array.of(0, 1, 254, 255));
  });

  it('rejects data that is not gzip', async () => {
    await expect(decodeItemBytes(btoa('not gzip at all'))).rejects.toThrow();
    await expect(gunzip(Uint8Array.of(1, 2, 3))).rejects.toThrow();
    expect(() => decodeRoot(btoa('not gzip at all'))).toThrow();
  });
});

describe('skyblockIdFromNbt', () => {
  const pet = (petInfo: W) => ({ id: str('PET'), petInfo });

  it('synthetic items through decodeItemBytes', async () => {
    const book = itemB64({ id: str('ENCHANTED_BOOK'), enchantments: comp({ ultimate_wise: int(5) }) });
    expect(skyblockIdFromNbt(await decodeItemBytes(book))).toBe('ENCHANTMENT_ULTIMATE_WISE_5');
    const two = itemB64({ id: str('ENCHANTED_BOOK'), enchantments: comp({ sharpness: int(5), smite: int(5) }) });
    expect(skyblockIdFromNbt(await decodeItemBytes(two))).toBe('ENCHANTED_BOOK');
    const drill = itemB64({ id: str('DIVAN_DRILL'), drill_part_engine: str('amber_polished_drill_engine') });
    expect(skyblockIdFromNbt(await decodeItemBytes(drill))).toBe('DIVAN_DRILL');
    const dragon = itemB64(pet(str('{"type":"ENDER_DRAGON","tier":"LEGENDARY","exp":0}')));
    expect(skyblockIdFromNbt(await decodeItemBytes(dragon))).toBe('ENDER_DRAGON;4');
  });

  it('table of cases', () => {
    const ea = (o: Record<string, unknown>) => o as NbtCompound;
    expect(skyblockIdFromNbt(null)).toBeNull();
    expect(skyblockIdFromNbt(ea({}))).toBeNull();
    expect(skyblockIdFromNbt(ea({ id: '' }))).toBeNull();
    expect(skyblockIdFromNbt(ea({ id: 5 }))).toBeNull();
    expect(skyblockIdFromNbt(ea({ id: 'HYPERION' }))).toBe('HYPERION');
    // pets
    expect(skyblockIdFromNbt(ea({ id: 'PET', petInfo: '{"type":"BEE","tier":"COMMON"}' }))).toBe('BEE;0');
    expect(skyblockIdFromNbt(ea({ id: 'PET', petInfo: { type: 'GOLDEN_DRAGON', tier: 'legendary' } }))).toBe('GOLDEN_DRAGON;4');
    expect(skyblockIdFromNbt(ea({ id: 'PET', petInfo: '{"type":"X","tier":"DIVINE"}' }))).toBe('X');
    expect(skyblockIdFromNbt(ea({ id: 'PET', petInfo: '{"type":"X"}' }))).toBe('X');
    expect(skyblockIdFromNbt(ea({ id: 'PET', petInfo: '{"tier":"EPIC"}' }))).toBe('PET');
    expect(skyblockIdFromNbt(ea({ id: 'PET', petInfo: '{broken' }))).toBe('PET');
    expect(skyblockIdFromNbt(ea({ id: 'PET', petInfo: 'null' }))).toBe('PET');
    expect(skyblockIdFromNbt(ea({ id: 'PET' }))).toBe('PET');
    // books
    expect(skyblockIdFromNbt(ea({ id: 'ENCHANTED_BOOK', enchantments: { telekinesis: 1 } }))).toBe('ENCHANTMENT_TELEKINESIS_1');
    expect(skyblockIdFromNbt(ea({ id: 'ENCHANTED_BOOK', enchantments: { a: 1, b: 2 } }))).toBe('ENCHANTED_BOOK');
    expect(skyblockIdFromNbt(ea({ id: 'ENCHANTED_BOOK', enchantments: {} }))).toBe('ENCHANTED_BOOK');
    expect(skyblockIdFromNbt(ea({ id: 'ENCHANTED_BOOK', enchantments: { a: 'x' } }))).toBe('ENCHANTED_BOOK');
    expect(skyblockIdFromNbt(ea({ id: 'ENCHANTED_BOOK' }))).toBe('ENCHANTED_BOOK');
    // decoded roots
    expect(skyblockIdFromNbt(ea({ i: [{ tag: { ExtraAttributes: { id: 'SUNDIAL' } } }] }))).toBe('SUNDIAL');
    expect(skyblockIdFromNbt(ea({ i: [{ tag: {} }] }))).toBeNull();
    expect(skyblockIdFromNbt(ea({ i: [{}] }))).toBeNull();
    expect(skyblockIdFromNbt(ea({ i: [] }))).toBeNull();
    expect(skyblockIdFromNbt(ea({ i: 'nope' }))).toBeNull();
  });
});

describe('petInfoFromNbt', () => {
  const ea = (o: Record<string, unknown>) => o as NbtCompound;

  it('real fixture pets: type, base tier, exp, held item', async () => {
    const cats = page.auctions.filter((a) => a.item_name.includes('Black Cat'));
    const lvl100 = petInfoFromNbt(await decodeItemBytesRoot(cats.find((a) => a.item_name.startsWith('[Lvl 100]'))!.item_bytes));
    expect(lvl100).toEqual({ type: 'BLACK_CAT', tier: 'MYTHIC', exp: 2.603692896466553e7, heldItem: 'POIGNANT_LUCKY_CLOVER' });
    const lvl1 = petInfoFromNbt(await decodeItemBytes(cats.find((a) => a.item_name.startsWith('[Lvl 1]'))!.item_bytes));
    expect(lvl1).toEqual({ type: 'BLACK_CAT', tier: 'MYTHIC', exp: 0 });
    const scatha = page.auctions.find((a) => a.item_name.includes('Scatha'))!;
    expect(petInfoFromNbt(await decodeItemBytes(scatha.item_bytes))).toMatchObject({ tier: 'EPIC', heldItem: 'PET_ITEM_TIER_BOOST' });
    const hype = page.auctions.find((a) => a.item_name.includes('Hyperion'))!;
    expect(petInfoFromNbt(await decodeItemBytesRoot(hype.item_bytes))).toBeNull();
  });

  it('string and object petInfo, skins, synthetic items', async () => {
    const json = '{"type":"BLACK_CAT","exp":75291418.59,"tier":"MYTHIC","heldItem":"POIGNANT_LUCKY_CLOVER","candyUsed":0,"skin":"BLACK_CAT_PURRANORMAL"}';
    const want = { type: 'BLACK_CAT', tier: 'MYTHIC', exp: 75291418.59, heldItem: 'POIGNANT_LUCKY_CLOVER', skin: 'BLACK_CAT_PURRANORMAL' };
    expect(petInfoFromNbt(ea({ id: 'PET', petInfo: json }))).toEqual(want);
    expect(petInfoFromNbt(ea({ id: 'PET', petInfo: JSON.parse(json) }))).toEqual(want);
    expect(petInfoFromNbt(await decodeItemBytesRoot(itemB64({ id: str('PET'), petInfo: str(json) })))).toEqual(want);
    const root = ea({ i: [{ tag: { ExtraAttributes: { id: 'PET', petInfo: { type: 'BEE', tier: 'rare', exp: 12 } } } }] });
    expect(petInfoFromNbt(root)).toEqual({ type: 'BEE', tier: 'RARE', exp: 12 });
  });

  it('missing fields and bad input', () => {
    const pet = (petInfo: unknown) => petInfoFromNbt(ea({ id: 'PET', petInfo }));
    expect(pet('{"type":"X"}')).toEqual({ type: 'X', tier: '', exp: 0 });
    expect(pet('{"type":"X","tier":5,"exp":"lots","heldItem":"","skin":null}')).toEqual({ type: 'X', tier: '', exp: 0 });
    expect(pet('{"type":"X","exp":-3}')!.exp).toBe(0);
    expect(pet('{"tier":"EPIC"}')).toBeNull();
    expect(pet('{"type":""}')).toBeNull();
    expect(pet('{broken')).toBeNull();
    expect(pet('null')).toBeNull();
    expect(pet(7)).toBeNull();
    expect(pet(undefined)).toBeNull();
    expect(petInfoFromNbt(ea({ id: 'HYPERION', petInfo: '{"type":"X"}' }))).toBeNull();
    expect(petInfoFromNbt(ea({}))).toBeNull();
    expect(petInfoFromNbt(ea({ i: [] }))).toBeNull();
    expect(petInfoFromNbt(null)).toBeNull();
  });
});

describe('itemFromNbt', () => {
  const ea = (o: Record<string, unknown>) => o as NbtCompound;

  it('matches skyblockIdFromNbt and petInfoFromNbt on every fixture auction and the edge cases', async () => {
    const roots: (NbtCompound | null)[] = [null, ea({}), ea({ id: 5 }), ea({ id: 'PET' }), ea({ id: 'PET', petInfo: '{broken' }), ea({ i: [] })];
    roots.push(ea({ id: 'PET', petInfo: '{"tier":"EPIC"}' }), ea({ id: 'HYPERION', petInfo: '{"type":"X"}' }), ea({ id: 'ENCHANTED_BOOK', enchantments: { telekinesis: 1 } }));
    for (const a of page.auctions) roots.push(await decodeItemBytes(a.item_bytes), await decodeItemBytesRoot(a.item_bytes));
    for (const r of roots) expect(itemFromNbt(r)).toEqual({ id: skyblockIdFromNbt(r), pet: petInfoFromNbt(r) });
    expect(itemFromNbt(ea({ id: 'PET', petInfo: '{"type":"BEE","tier":"RARE","exp":12}' }))).toEqual({ id: 'BEE;2', pet: { type: 'BEE', tier: 'RARE', exp: 12 } });
  });

  it('parses petInfo once', () => {
    const parse = vi.spyOn(JSON, 'parse');
    itemFromNbt(ea({ id: 'PET', petInfo: '{"type":"BEE","tier":"RARE","exp":12}' }));
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockRestore();
  });
});

describe('readNbt skip', () => {
  const every = (): Record<string, W> => ({
    b: byte(1),
    s: short(2),
    i: int(3),
    l: long(4n),
    f: float(5),
    d: double(6),
    ba: bytes([1, 2]),
    str: str('long text '.repeat(10)),
    li: list(3, [int(1), int(2)]),
    lc: list(10, [comp({ a: str('x') }), comp({ b: list(8, [str('y')]) })]),
    ll: list(9, [list(1, [byte(1)])]),
    c: comp({ deep: comp({ x: int(1) }) }),
    ia: ints([1, 2]),
    la: longs([1n]),
  });

  it('skips a name at any depth, with every tag type inside, and keeps reading after it', () => {
    const bytesIn = nbt({ x: comp(every()), keep: int(7), inner: comp({ x: str('gone'), y: str('kept') }), list: list(10, [comp({ x: int(1), z: int(2) })]) });
    expect(readNbt(bytesIn, { skip: ['x'] })).toEqual({ keep: 7, inner: { y: 'kept' }, list: [{ z: 2 }] });
    // each tag type skipped on its own
    for (const [k, w] of Object.entries(every())) expect(readNbt(nbt({ [k]: w, after: int(1) }), { skip: [k] })).toEqual({ after: 1 });
    expect(readNbt(bytesIn, { skip: [] })).toEqual(readNbt(bytesIn));
  });

  it('parent.child skips only inside a compound of that name', () => {
    const root = nbt({ display: comp({ Name: str('§6Hi'), Lore: list(8, [str('a'), str('b')]) }), other: comp({ Lore: str('stays') }) });
    expect(readNbt(root, { skip: ['display.Lore'] })).toEqual({ display: { Name: '§6Hi' }, other: { Lore: 'stays' } });
    expect(readNbt(root, { skip: ['display.Lore', 'display.Name', 'other'] })).toEqual({ display: {} });
  });

  it('skipped bytes are still bounds-checked', () => {
    const good = nbt({ x: str('abcdef'), y: int(1) });
    expect(() => readNbt(good.subarray(0, 8), { skip: ['x'] })).toThrow(/unexpected end/);
    expect(() => readNbt(Uint8Array.of(10, 0, 0, 13, 0, 1, 120), { skip: ['x'] })).toThrow(/unknown tag type 13/);
    let w = list(0, []);
    for (let i = 0; i < 600; i++) w = list(9, [w]);
    expect(() => readNbt(nbt({ x: w }), { skip: ['x'] })).toThrow(/too deep/);
  });

  it('the scan and sales skip lists leave ids, counts and (sales) names intact on real items', () => {
    for (const a of [...ahPage.auctions, ...ended.auctions]) {
      const full = decodeRoot(a.item_bytes);
      const scan = decodeRoot(a.item_bytes, { skip: SCAN_SKIP });
      const sales = decodeRoot(a.item_bytes, { skip: SALES_SKIP });
      expect(itemFromNbt(scan)).toEqual(itemFromNbt(full));
      expect(itemFromNbt(sales)).toEqual(itemFromNbt(full));
      expect(itemCount(scan)).toBe(itemCount(full));
      expect(itemName(sales)).toBe(itemName(full));
      expect(itemName(scan)).toBe('');
      const item = (sales.i as NbtCompound[])[0]!;
      expect(((item.tag as NbtCompound).display as NbtCompound).Lore).toBeUndefined();
    }
  });
});

describe('itemCount / itemName', () => {
  it('reads Count and the display name, with defaults', async () => {
    const root = await decodeItemBytesRoot(itemB64({ id: str('ENCHANTED_DIAMOND') }, { count: 64, name: '§a[Lvl 7] §6Thing', lore: ['§7x'] }));
    expect(itemCount(root)).toBe(64);
    expect(itemName(root)).toBe('[Lvl 7] Thing');
    const ea = (o: Record<string, unknown>) => o as NbtCompound;
    expect(itemCount(ea({}))).toBe(1);
    expect(itemCount(ea({ i: [{ Count: 0 }] }))).toBe(1);
    expect(itemCount(ea({ i: [{ Count: 2.5 }] }))).toBe(1);
    expect(itemCount(ea({ i: [{ Count: 'x' }] }))).toBe(1);
    expect(itemCount(ea({ i: 'nope' }))).toBe(1);
    expect(itemName(ea({ i: [{ tag: { display: { Name: 5 } } }] }))).toBe('');
    expect(itemName(ea({ i: [{ tag: { display: 'x' } }] }))).toBe('');
    expect(itemName(ea({ i: [{ tag: 'x' }] }))).toBe('');
    expect(itemName(ea({ i: [] }))).toBe('');
  });

  it('real sales: pet names carry the level', () => {
    const names = ended.auctions.map((a) => itemName(decodeRoot(a.item_bytes, { skip: SALES_SKIP })));
    expect(names).toContain('[Lvl 70] Mosquito');
    expect(names).toContain('[Lvl 1] Bal');
    expect(names.every((n) => !n.includes('§'))).toBe(true);
  });
});

describe('RUNE and POTION ids (NEU names)', () => {
  const ea = (o: Record<string, unknown>) => o as NbtCompound;
  const id = (o: Record<string, unknown>) => skyblockIdFromNbt(ea(o));

  it('runes: NAME_RUNE;LEVEL', async () => {
    expect(id({ id: 'RUNE', runes: { MUSIC: 3 } })).toBe('MUSIC_RUNE;3');
    expect(id({ id: 'RUNE', runes: { BLOOD_2: 1 } })).toBe('BLOOD_2_RUNE;1');
    expect(id({ id: 'UNIQUE_RUNE', runes: { ANTLERS: 3 } })).toBe('ANTLERS_RUNE;3');
    expect(id({ id: 'RUNE', runes: { music: 2 } })).toBe('MUSIC_RUNE;2');
    expect(id({ id: 'RUNE', runes: { ' gem ': 0 } })).toBe('GEM_RUNE;0');
    // no single integer level: the raw id
    expect(id({ id: 'RUNE' })).toBe('RUNE');
    expect(id({ id: 'RUNE', runes: {} })).toBe('RUNE');
    expect(id({ id: 'RUNE', runes: { A: 1, B: 2 } })).toBe('RUNE');
    expect(id({ id: 'RUNE', runes: { A: 1.5 } })).toBe('RUNE');
    expect(id({ id: 'RUNE', runes: { A: 'x' } })).toBe('RUNE');
    expect(id({ id: 'UNIQUE_RUNE', runes: { ' ': 1 } })).toBe('UNIQUE_RUNE');
    expect(id({ id: 'RUNE', runes: 'x' })).toBe('RUNE');
    expect(neuItemIdForScan('RUNE', ea({ runes: { BITE: 1 } }))).toBe('BITE_RUNE;1');
    const b64 = itemB64({ id: str('RUNE'), runes: comp({ GEM: int(2) }) });
    expect(skyblockIdFromNbt(await decodeItemBytes(b64))).toBe('GEM_RUNE;2');
    // a real sale in the fixture
    const rune = ended.auctions.find((a) => itemName(decodeRoot(a.item_bytes)).includes('Enchant Rune'))!;
    expect(skyblockIdFromNbt(decodeRoot(rune.item_bytes))).toBe('ENCHANT_RUNE;1');
  });

  it('potions: POTION_<NAME>;<LEVEL>, POTION_<TYPE>, WATER_BOTTLE', () => {
    expect(id({ id: 'POTION', potion: 'critical', potion_level: 4 })).toBe('POTION_CRITICAL;4');
    expect(id({ id: 'POTION', potion: 'alchemy_xp_boost', potion_level: 3, potion_type: 'POTION' })).toBe('POTION_ALCHEMY_XP_BOOST;3');
    // potion_name wins over potion, spaces become underscores
    expect(id({ id: 'POTION', potion_name: 'Jump Boost', potion: 'jump', potion_level: 2 })).toBe('POTION_JUMP_BOOST;2');
    expect(id({ id: 'POTION', potion_name: '  ', potion: 'speed', potion_level: 1 })).toBe('POTION_SPEED;1');
    // no level: 0
    expect(id({ id: 'POTION', potion: 'critical' })).toBe('POTION_CRITICAL;0');
    expect(id({ id: 'POTION', potion: 'critical', potion_level: 'x' })).toBe('POTION_CRITICAL;0');
    expect(id({ id: 'POTION', potion_type: 'AWKWARD' })).toBe('POTION_AWKWARD');
    expect(id({ id: 'POTION', potion_type: 'mundane' })).toBe('POTION_MUNDANE');
    expect(id({ id: 'POTION', potion: '', potion_type: '' })).toBe('WATER_BOTTLE');
    expect(id({ id: 'POTION' })).toBe('WATER_BOTTLE');
    // other potion-like ids are untouched
    expect(id({ id: 'GOD_POTION_2' })).toBe('GOD_POTION_2');
    expect(neuItemIdForScan('HYPERION', ea({ potion: 'x' }))).toBe('HYPERION');
  });
});
