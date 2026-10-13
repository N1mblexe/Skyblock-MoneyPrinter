import { describe, expect, it } from 'vitest';
import { deriveName, neuToBazaarId, parseNeuStack, stripFormatting } from '../../src/domain/ids.ts';
import { extractNpcOffers, extractRecipes } from '../../scripts/lib/neu.ts';

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
  ])('%s', (id, dn, want) => {
    expect(neuToBazaarId(id, bz, dn)).toBe(want);
  });
  it('works with an empty bazaar set', () => {
    expect(neuToBazaarId('ULTIMATE_WISE;1', new Set())).toBe('ENCHANTMENT_ULTIMATE_WISE_1');
    expect(neuToBazaarId('INK_SACK-4', new Set())).toBe('INK_SACK:4');
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
});
