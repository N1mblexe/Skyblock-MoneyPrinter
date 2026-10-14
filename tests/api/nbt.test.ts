import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  decodeItemBytes,
  decodeItemBytesRoot,
  extraAttributes,
  gunzip,
  readNbt,
  skyblockIdFromNbt,
  type NbtCompound,
} from '../../src/api/nbt.ts';
import page from '../fixtures/api/auctions-page.json' with { type: 'json' };

// ---- tiny NBT writer for synthetic items (test-only)
type W = { t: number; v: unknown };
const byte = (v: number): W => ({ t: 1, v });
const short = (v: number): W => ({ t: 2, v });
const int = (v: number): W => ({ t: 3, v });
const long = (v: bigint): W => ({ t: 4, v });
const float = (v: number): W => ({ t: 5, v });
const double = (v: number): W => ({ t: 6, v });
const bytes = (v: number[]): W => ({ t: 7, v });
const str = (v: string): W => ({ t: 8, v });
const list = (t: number, v: W[]): W => ({ t: 9, v: { t, items: v } });
const comp = (v: Record<string, W>): W => ({ t: 10, v });
const ints = (v: number[]): W => ({ t: 11, v });
const longs = (v: bigint[]): W => ({ t: 12, v });

function enc(w: W, out: number[]): void {
  const b = (size: number, fn: (dv: DataView) => void) => {
    const dv = new DataView(new ArrayBuffer(size));
    fn(dv);
    out.push(...new Uint8Array(dv.buffer));
  };
  const s = (x: string) => {
    const u = new TextEncoder().encode(x);
    b(2, (d) => d.setUint16(0, u.length));
    out.push(...u);
  };
  const v = w.v as never;
  switch (w.t) {
    case 1: return b(1, (d) => d.setInt8(0, v));
    case 2: return b(2, (d) => d.setInt16(0, v));
    case 3: return b(4, (d) => d.setInt32(0, v));
    case 4: return b(8, (d) => d.setBigInt64(0, v));
    case 5: return b(4, (d) => d.setFloat32(0, v));
    case 6: return b(8, (d) => d.setFloat64(0, v));
    case 7: {
      const a = v as number[];
      b(4, (d) => d.setInt32(0, a.length));
      for (const x of a) b(1, (d) => d.setInt8(0, x));
      return;
    }
    case 8: return s(v);
    case 9: {
      const l = v as { t: number; items: W[] };
      out.push(l.t);
      b(4, (d) => d.setInt32(0, l.items.length));
      for (const it of l.items) enc(it, out);
      return;
    }
    case 10: {
      for (const [k, c] of Object.entries(v as Record<string, W>)) {
        out.push(c.t);
        s(k);
        enc(c, out);
      }
      out.push(0);
      return;
    }
    case 11: {
      const a = v as number[];
      b(4, (d) => d.setInt32(0, a.length));
      for (const x of a) b(4, (d) => d.setInt32(0, x));
      return;
    }
    case 12: {
      const a = v as bigint[];
      b(4, (d) => d.setInt32(0, a.length));
      for (const x of a) b(8, (d) => d.setBigInt64(0, x));
      return;
    }
  }
}

function nbt(root: Record<string, W>, name = ''): Uint8Array {
  const out = [10];
  const u = new TextEncoder().encode(name);
  out.push(u.length >> 8, u.length & 255, ...u);
  enc(comp(root), out);
  return Uint8Array.from(out);
}

/** item_bytes-like base64 for one item with these ExtraAttributes. */
function itemB64(ea: Record<string, W>): string {
  const root = nbt({ i: list(10, [comp({ id: short(403), Count: byte(1), tag: comp({ ExtraAttributes: comp(ea) }) })]) });
  return gzipSync(root).toString('base64');
}

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
  it('round-trips through DecompressionStream', async () => {
    const data = new TextEncoder().encode('hello nbt'.repeat(50));
    expect(await gunzip(new Uint8Array(gzipSync(data)))).toEqual(data);
    expect(base64ToBytes(Buffer.from([0, 1, 254, 255]).toString('base64'))).toEqual(Uint8Array.of(0, 1, 254, 255));
  });

  it('rejects data that is not gzip', async () => {
    await expect(decodeItemBytes(btoa('not gzip at all'))).rejects.toThrow();
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
