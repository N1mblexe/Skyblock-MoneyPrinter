import { describe, expect, it } from 'vitest';
import { deriveName, neuItemId, neuToBazaarId, parseNeuStack, stripFormatting } from '../../src/domain/ids.ts';
import { extractNpcOffers, extractRecipes, extractShopRecipes } from '../../scripts/lib/neu.ts';

describe('parseNeuStack', () => {
  it.each([
    ['ENCHANTED_MITHRIL:160', 'ENCHANTED_MITHRIL', 160],
    ['SKYBLOCK_COIN:8.0', 'SKYBLOCK_COIN', 8],
    ['GOLDEN_APPLE-1:2', 'GOLDEN_APPLE-1', 2],
    ['INK_SACK-4', 'INK_SACK-4', 1],
    ['DIAMOND', 'DIAMOND', 1],
    ['ULTIMATE_WISE;1:3', 'ULTIMATE_WISE;1', 3],
    ['ULTIMATE_WISE;1', 'ULTIMATE_WISE;1', 1],
    ['SKYBLOCK_COIN:2.5', 'SKYBLOCK_COIN', 2.5],
  ])('%s', (s, id, qty) => {
    expect(parseNeuStack(s)).toEqual({ id, qty });
  });
});

describe('neuToBazaarId', () => {
  const bz = new Set([
    'ENCHANTED_GOLD', 'ENCHANTMENT_LIFE_STEAL_2', 'ENCHANTMENT_ULTIMATE_WISE_1', 'INK_SACK:4', 'LOG:1',
    'SHARD_BLUE_JAY', 'SHARD_CINDER_BAT', 'SHARD_WITHER', 'SHARD_WITHER_SPECTER', 'SHARD_PACKRAT_SKULL',
  ]);
  it.each([
    ['ENCHANTED_GOLD', undefined, 'ENCHANTED_GOLD'],
    ['LIFE_STEAL;2', undefined, 'ENCHANTMENT_LIFE_STEAL_2'],
    ['ULTIMATE_WISE;1', '§fEnchanted Book', 'ENCHANTMENT_ULTIMATE_WISE_1'],
    ['INK_SACK-4', '§fLapis Lazuli', 'INK_SACK:4'],
    ['LOG-1', undefined, 'LOG:1'],
    ['ATTRIBUTE_SHARD_AIRBORNE_RESISTANCE;1', '§9Blue Jay Shard', 'SHARD_BLUE_JAY'],
    // underscore-insensitive / misspelling / containment fallbacks
    ['ATTRIBUTE_SHARD_MAGIC_FIND;1', '§aCinderbat Shard', 'SHARD_CINDER_BAT'],
    ['ATTRIBUTE_SHARD_BREEZE;1', '§5Wither Spectre Shard', 'SHARD_WITHER_SPECTER'],
    ['ATTRIBUTE_SHARD_FIESTA_FORTUNE;1', '§9Packrat Shard', 'SHARD_PACKRAT_SKULL'],
    // unknown shard keeps the derived SHARD_ name
    ['ATTRIBUTE_SHARD_X;1', '§fRainbug Shard', 'SHARD_RAINBUG'],
    // unknown ids
    ['SOME_UNKNOWN_ITEM', undefined, 'SOME_UNKNOWN_ITEM'],
    ['GOLDEN_APPLE-1', undefined, 'GOLDEN_APPLE:1'],
    ['NOT_ON_BAZAAR;3', undefined, 'ENCHANTMENT_NOT_ON_BAZAAR_3'],
    // pets keep their NEU id
    ['AMMONITE;4', '§7[Lvl {LVL}] §6Ammonite', 'AMMONITE;4'],
    // runes and potions keep their NEU id, with or without a display name
    ['BITE_RUNE;1', undefined, 'BITE_RUNE;1'],
    ['AXE_FADING_BLUE_RUNE;3', '§a◆ Fading Blue Rune III', 'AXE_FADING_BLUE_RUNE;3'],
    ['POTION_ABSORPTION;1', undefined, 'POTION_ABSORPTION;1'],
    ['POTION_DUNGEON;4', '§fDungeon IV Potion', 'POTION_DUNGEON;4'],
    ['POTION_AWKWARD', undefined, 'POTION_AWKWARD'],
  ])('%s', (id, dn, want) => {
    expect(neuToBazaarId(id, bz, dn)).toBe(want);
  });
  it('works with an empty bazaar set', () => {
    expect(neuToBazaarId('ULTIMATE_WISE;1', new Set())).toBe('ENCHANTMENT_ULTIMATE_WISE_1');
    expect(neuToBazaarId('INK_SACK-4', new Set())).toBe('INK_SACK:4');
  });
});

describe('neuItemId (NEU ItemResolutionQuery rules for RUNE / POTION)', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['RUNE', { runes: { BITE: 1 } }, 'BITE_RUNE;1'],
    ['RUNE', { runes: { axe_fading_blue: 3 } }, 'AXE_FADING_BLUE_RUNE;3'],
    ['UNIQUE_RUNE', { runes: { GRAND_SEARING: 3 } }, 'GRAND_SEARING_RUNE;3'],
    // not exactly one rune with an integer level -> the id as is
    ['RUNE', {}, 'RUNE'],
    ['RUNE', { runes: {} }, 'RUNE'],
    ['RUNE', { runes: { BITE: 1, ZOMBIE_SLASH: 2 } }, 'RUNE'],
    ['RUNE', { runes: { BITE: '1' } }, 'RUNE'],
    ['RUNE', { runes: [1] }, 'RUNE'],
    ['POTION', { potion: 'absorption', potion_level: 1, potion_type: 'POTION' }, 'POTION_ABSORPTION;1'],
    // potion_name wins over potion, spaces become '_'
    ['POTION', { potion_name: 'True Resistance', potion: 'true_defense', potion_level: 4 }, 'POTION_TRUE_RESISTANCE;4'],
    ['POTION', { potion: 'dungeon' }, 'POTION_DUNGEON;0'],
    ['POTION', { potion_type: 'AWKWARD', last_potion_ingredient: 'NETHER_STALK' }, 'POTION_AWKWARD'],
    ['POTION', {}, 'WATER_BOTTLE'],
    // other ids unchanged, even with rune / potion fields
    ['ENCHANTED_BOOK', { runes: { BITE: 1 } }, 'ENCHANTED_BOOK'],
    ['HYPERION', { potion: 'x', potion_level: 1 }, 'HYPERION'],
  ])('%s %j -> %s', (id, extra, want) => {
    expect(neuItemId(id, extra)).toBe(want);
  });
  it('gives the ids the catalog keeps', () => {
    const bz = new Set<string>();
    for (const [id, extra] of [['RUNE', { runes: { BITE: 1 } }], ['POTION', { potion: 'dungeon', potion_level: 4 }]] as const)
      expect(neuToBazaarId(neuItemId(id, extra), bz)).toBe(neuItemId(id, extra));
  });
});

describe('deriveName', () => {
  it.each([
    ['ENCHANTMENT_LIFE_STEAL_2', 'Life Steal II'],
    ['ENCHANTMENT_ULTIMATE_WISE_1', 'Ultimate Wise I'],
    ['ENCHANTMENT_SHARPNESS_12', 'Sharpness 12'],
    ['SHARD_BLUE_JAY', 'Blue Jay Shard'],
    ['LOG:1', 'Log (1)'],
    ['ENCHANTED_GOLD', 'Enchanted Gold'],
    ['ESSENCE_DRAGON', 'Dragon Essence'],
    ['BITE_RUNE;1', 'Bite Rune I'],
    ['AXE_FADING_BLUE_RUNE;3', 'Axe Fading Blue Rune III'],
    ['POTION_ABSORPTION;1', 'Absorption I Potion'],
    ['POTION_TRUE_RESISTANCE;12', 'True Resistance 12 Potion'],
  ])('%s -> %s', (id, want) => {
    expect(deriveName(id)).toBe(want);
  });
  it('strips formatting', () => {
    expect(stripFormatting('§9Blue §lJay ')).toBe('Blue Jay');
  });
});

describe('NEU extraction', () => {
  it('reads crafting grid, recipes[] crafting and forge', () => {
    const rs = extractRecipes({
      internalname: 'ENCHANTED_GOLD_BLOCK',
      crafttext: 'Requires: Gold Ingot VII',
      recipe: { A1: 'ENCHANTED_GOLD:32', A2: 'ENCHANTED_GOLD:32', A3: '', B1: 'ENCHANTED_GOLD:32', B2: 'ENCHANTED_GOLD:32', B3: 'ENCHANTED_GOLD:32', C1: '', C2: '', C3: '' },
      recipes: [
        { type: 'crafting', A1: 'STICK:1', A2: '', A3: '', B1: '', B2: '', B3: '', C1: '', C2: '', C3: '', count: 4, overrideOutputId: 'OTHER' },
        { type: 'forge', inputs: ['ENCHANTED_MITHRIL:160'], count: 1, overrideOutputId: 'REFINED_MITHRIL', duration: 21600 },
        { type: 'drops', drops: [] },
      ],
    });
    expect(rs).toHaveLength(3);
    expect(rs[0]).toMatchObject({ output: 'ENCHANTED_GOLD_BLOCK', count: 1, kind: 'craft', req: 'Requires: Gold Ingot VII' });
    expect(rs[0]!.inputs.reduce((a, s) => a + s.qty, 0)).toBe(160);
    expect(rs[1]).toMatchObject({ output: 'OTHER', count: 4, inputs: [{ id: 'STICK', qty: 1 }] });
    expect(rs[2]).toMatchObject({ output: 'REFINED_MITHRIL', kind: 'forge', duration: 21600, inputs: [{ id: 'ENCHANTED_MITHRIL', qty: 160 }] });
  });
  it('keeps only coin-only npc_shop offers', () => {
    const offers = extractNpcOffers({
      internalname: 'ADVENTURER_NPC',
      recipes: [
        { type: 'npc_shop', cost: ['SKYBLOCK_COIN:8.0'], result: 'ROTTEN_FLESH:1' },
        { type: 'npc_shop', cost: ['SKYBLOCK_COIN:40.0'], result: 'BONE:5' },
        { type: 'npc_shop', cost: ['SKYBLOCK_COIN:10.0', 'GOLD_INGOT:1'], result: 'STRING:1' },
      ],
    });
    expect(offers.map((o) => [o.result, o.coins / o.qty])).toEqual([['ROTTEN_FLESH', 8], ['BONE', 8]]);
  });
  it('reads multi-cost npc_shop offers and trades as shop recipes', () => {
    const rs = extractShopRecipes({
      internalname: 'ALCHEMIST_NPC',
      recipes: [
        // coin-only: an nb offer, not a shop recipe
        { type: 'npc_shop', cost: ['SKYBLOCK_COIN:8.0'], result: 'ROTTEN_FLESH:1' },
        // items + coins, items only
        { type: 'npc_shop', cost: ['SKYBLOCK_COIN:10.0', 'GOLD_INGOT:2'], result: 'STRING:3' },
        { type: 'npc_shop', cost: ['ENCHANTED_EMERALD:6'], result: 'WOOD_SINGULARITY' },
        // another currency, or a bad stack: skipped
        { type: 'npc_shop', cost: ['SKYBLOCK_BIT:100', 'GOLD_INGOT:1'], result: 'X' },
        { type: 'npc_shop', cost: ['SKYBLOCK_COPPER:20'], result: 'Y' },
        { type: 'npc_shop', cost: ['GOLD_INGOT:1', ''], result: 'Z' },
        { type: 'npc_shop', cost: [], result: 'Z' },
        { type: 'npc_shop', cost: ['GOLD_INGOT:1'] },
        // trades: one cost stack; a min/max cost range uses the max
        { type: 'trade', cost: 'EMERALD:10', result: 'ZOMBIE_TALISMAN' },
        { type: 'trade', cost: 'LOG-1', min: 65, max: 76, result: 'EMERALD' },
        { type: 'trade', cost: ['ENDER_PEARL:2'], result: 'EMERALD:2' },
        { type: 'trade', cost: 'SKYBLOCK_GOLD_MEDAL:1', result: 'W' },
        { type: 'trade', cost: 'EMERALD:1' },
        { type: 'crafting', A1: 'STICK:1' },
      ],
    });
    expect(rs).toEqual([
      { shop: 'ALCHEMIST_NPC', output: 'STRING', count: 3, inputs: [{ id: 'SKYBLOCK_COIN', qty: 10 }, { id: 'GOLD_INGOT', qty: 2 }] },
      { shop: 'ALCHEMIST_NPC', output: 'WOOD_SINGULARITY', count: 1, inputs: [{ id: 'ENCHANTED_EMERALD', qty: 6 }] },
      { shop: 'trade', output: 'ZOMBIE_TALISMAN', count: 1, inputs: [{ id: 'EMERALD', qty: 10 }] },
      { shop: 'trade', output: 'EMERALD', count: 1, inputs: [{ id: 'LOG-1', qty: 76 }] },
      { shop: 'trade', output: 'EMERALD', count: 2, inputs: [{ id: 'ENDER_PEARL', qty: 2 }] },
    ]);
    expect(extractShopRecipes({ internalname: 'EMPTY' })).toEqual([]);
  });
});
