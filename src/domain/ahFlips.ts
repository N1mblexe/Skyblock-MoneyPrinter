// AH flip finder: buy the lowest BIN, relist just under the second-lowest BIN, after the AH seller fees.
// One AH id covers every copy of an item (pet level, stars, reforges, enchants), so the gap can be a different
// variant: such ids carry AH_VARIANT, and a very large gap AH_GAP.
import { AH, AH_FLIP } from '../config.ts';
import type { AhSnapshot, Catalog, RiskFlag, RiskReport } from '../types/contracts.ts';
import { ahClaimTax, ahListingFee, ahNet } from './pricing.ts';
import { reportFromFlags } from './risk.ts';

export interface AhFlipRow {
  id: string;
  name: string;
  /** lowest BIN: what you pay */
  buy: number;
  /** second-lowest BIN */
  next: number;
  /** your relist price (next − AH_FLIP.undercut) */
  sellAt: number;
  listingFee: number;
  claimTax: number;
  /** ahNet(sellAt) − buy */
  profit: number;
  margin: number;
  /** (next − buy) / buy */
  gap: number;
  /** BIN listings of this id */
  count: number;
  /** the cheapest listing, for /viewauction */
  uuid?: string;
  /** its name as listed ("[Lvl 100] Ender Dragon") */
  listingName?: string;
  pet: boolean;
  risk: RiskReport;
}

/** Scan v3's max-level pet keys (`ENDERMAN;3@MAX`) repeat listings already counted under the plain pet id. */
export const isPetMaxKey = (id: string): boolean => id.endsWith(AH.petMaxSuffix);

const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];

/** "ENDER_DRAGON;4" -> "Ender Dragon (Legendary)" from the listing name, else from the id. */
export function petName(id: string, listingName?: string): string {
  const [type = id, idx] = id.split(';');
  const base = listingName?.replace(/^\[Lvl \d+\]\s*/, '').trim() || type.toLowerCase().replace(/(^|_)(\w)/g, (_, s: string, c: string) => (s ? ' ' : '') + c.toUpperCase());
  const rarity = RARITIES[Number(idx)];
  return rarity ? `${base} (${rarity})` : base;
}

export interface AhFlipOptions {
  /** mayor Derpy: claim tax ×4 */
  derpy?: boolean;
}

/** Profitable lowest → second-lowest BIN flips of a scan (needs scan v2: next prices); `@MAX` keys are skipped. */
export function computeAhFlips(ah: AhSnapshot, catalog: Catalog, o: AhFlipOptions = {}): AhFlipRow[] {
  const variantCats = new Set<string>(AH_FLIP.variantCategories);
  const rows: AhFlipRow[] = [];
  for (const [id, a] of Object.entries(ah.lowestBin)) {
    if (a.next == null || a.count < AH_FLIP.minCount || !(a.price > 0) || isPetMaxKey(id)) continue;
    const sellAt = a.next - AH_FLIP.undercut;
    if (!(sellAt > a.price)) continue;
    const profit = ahNet(sellAt, o.derpy) - a.price;
    if (!(profit > 0)) continue;
    const pet = id.includes(';');
    const flags: RiskFlag[] = [];
    if (a.count < AH.minCount) flags.push('AH_THIN');
    if (a.next / a.price > AH_FLIP.gapRatio) flags.push('AH_GAP');
    if (pet || variantCats.has(catalog.items[id]?.category ?? '')) flags.push('AH_VARIANT');
    rows.push({
      id,
      name: pet ? petName(id, a.name) : catalog.items[id] ? catalog.name(id) : (a.name ?? catalog.name(id)),
      buy: a.price,
      next: a.next,
      sellAt,
      listingFee: ahListingFee(sellAt),
      claimTax: ahClaimTax(sellAt, o.derpy),
      profit,
      margin: profit / a.price,
      gap: (a.next - a.price) / a.price,
      count: a.count,
      ...(a.uuid ? { uuid: a.uuid } : {}),
      ...(a.name ? { listingName: a.name } : {}),
      pet,
      risk: reportFromFlags(flags),
    });
  }
  return rows;
}
