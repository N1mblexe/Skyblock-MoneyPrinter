// Acceptance limits of the catalog build (pure; scripts/build-data.ts fails when any check fails).

export const LIMITS = {
  bazaarRecipes: 440,
  forge: 100,
  nb: 400,
  ns: 2000,
  /** 600 KB budget for public/data/catalog.json */
  bytes: 600 * 1024,
  /** fully priceable bazaar-output recipes: a note, not a failure */
  priceableTarget: 380,
  copperToBazaar: 7,
  shards: 100,
  booksT: 30,
  kat: 200,
  bits: 50,
  /** kind 'shop' recipes (npc_shop offers that cost items, NEU trades) */
  shopRecipes: 60,
  /** George pet prices */
  george: 100,
  /** recipes whose output is an auctionable non-bazaar item (AH crafts, plus forge, shop and sub-craft ones) */
  ahOutput: 400,
} as const;

export type Limits = { readonly [K in keyof typeof LIMITS]: number };

export interface AcceptanceStats {
  /** craft/forge recipes with a bazaar output (shop recipes not counted) */
  bazaarOutput: number;
  forge: number;
  /** bazaar ids with a non-empty name, and the bazaar product count */
  bazaarNamed: number;
  bazaarProducts: number;
  withNb: number;
  withNs: number;
  bytes: number;
  copperToBazaar: number;
  shards: number;
  booksWithT: number;
  katSteps: number;
  bitsOffers: number;
  shopRecipes: number;
  george: number;
  ahOutput: number;
  hasPetLeveling: boolean;
  /** books.ENCHANTMENT_SHARPNESS.m */
  sharpnessMax: number | undefined;
}

/** Every failed check, as a readable line; empty when the catalog passes. */
export function acceptanceFailures(s: AcceptanceStats, limits: Limits = LIMITS): string[] {
  const fails: string[] = [];
  const atLeast = (v: number, min: number, what: string) => {
    if (v < min) fails.push(`${what} ${v} < ${min}`);
  };
  atLeast(s.bazaarOutput, limits.bazaarRecipes, 'bazaar-output recipes');
  atLeast(s.forge, limits.forge, 'forge recipes');
  if (s.bazaarNamed !== s.bazaarProducts) fails.push(`named bazaar ids ${s.bazaarNamed} / ${s.bazaarProducts}`);
  atLeast(s.withNb, limits.nb, 'items with nb');
  atLeast(s.withNs, limits.ns, 'items with ns');
  if (s.bytes > limits.bytes) fails.push(`size ${s.bytes} > ${limits.bytes}`);
  atLeast(s.copperToBazaar, limits.copperToBazaar, 'copper offers to bazaar ids');
  atLeast(s.shards, limits.shards, 'shards with metadata');
  atLeast(s.booksWithT, limits.booksT, 'books with table max');
  atLeast(s.katSteps, limits.kat, 'kat steps');
  atLeast(s.bitsOffers, limits.bits, 'bits offers');
  atLeast(s.shopRecipes, limits.shopRecipes, 'shop recipes');
  atLeast(s.george, limits.george, 'george prices');
  atLeast(s.ahOutput, limits.ahOutput, 'AH-output recipes');
  if (!s.hasPetLeveling) fails.push('no pet leveling table (constants/pets.json)');
  if (s.sharpnessMax !== 5) fails.push(`books.ENCHANTMENT_SHARPNESS.m = ${s.sharpnessMax} (expected 5)`);
  return fails;
}
