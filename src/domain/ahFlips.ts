// AH flip finder: buy the lowest BIN, relist just under the second-lowest BIN, after the AH seller fees.
// One AH id covers every copy of an item (pet level, stars, reforges, enchants), so the gap can be a different
// variant: such ids carry AH_VARIANT, and a very large gap AH_GAP. Max-level pet keys (`PET;i@MAX`) hold one level,
// so they are flipped too, without AH_VARIANT.
// George flips: buy a pet below what George pays for it (NEU constants/george.json) and sell it to him: no fees.
import { AH, AH_FLIP, AH_SALES } from '../config.ts';
import type { AhPrice, AhSalesStat, AhSnapshot, Catalog, PlanInputs, ProfitSegment, RiskReport } from '../types/contracts.ts';
import { ahListingFee, ahNet } from './pricing.ts';
import { reportFromFlags } from './risk.ts';
import { ahRate } from './market.ts';
import { ahFlags } from './sale.ts';

/** 'ah': relist on the AH under the second-lowest BIN; 'george': sell to George. */
export type AhFlipVenue = 'ah' | 'george';

export interface AhFlipRow {
  /** unique: `${venue}:${id}` */
  key: string;
  venue: AhFlipVenue;
  /** the AH key: an item id, a pet `TYPE;IDX`, or a max-level pet `TYPE;IDX@MAX` */
  id: string;
  name: string;
  /** lowest BIN per item: what you pay */
  buy: number;
  /** second-lowest BIN per item ('george': George's price) */
  next: number;
  /** your relist price per item (next − AH_FLIP.undercut, capped at the median sold when conservative; 'george': his price) */
  sellAt: number;
  /** per item, on the whole relisted stack (0 for George) */
  listingFee: number;
  claimTax: number;
  /** per item: net sale − buy */
  profit: number;
  margin: number;
  /** (next − buy) / buy */
  gap: number;
  /** BIN listings of this key */
  count: number;
  /** items in the cheapest listing: you buy (and relist) the whole stack */
  stack: number;
  /** listings you can flip now ('george': kept listings below his price; 'ah': 1) */
  units: number;
  /** hours to sell what you bought: stack / sales per hour (0 for George: he buys at once) */
  sellHours: number;
  /** measured AH sales per hour of this key; null while there is none (AH_SALES.defaultPerHour is assumed) */
  salesPerHour: number | null;
  /** profit × stack / sellHours ('george': profit × units per hour, see plan) */
  profitPerHour: number;
  /** the relist price before the median-sold cap, when the cap lowered it */
  sellRef?: number;
  /** a max-level pet key (`@MAX`): every listing is the same level */
  maxLevel: boolean;
  /** the cheapest listing, for /viewauction */
  uuid?: string;
  /** its name as listed ("[Lvl 100] Ender Dragon") */
  listingName?: string;
  pet: boolean;
  risk: RiskReport;
  /** planner inputs (AH legs: no order slots, no shared bazaar market) */
  plan: PlanInputs;
}

/** Max-level pet keys (`ENDERMAN;3@MAX`) repeat listings already counted under the plain pet id. */
export const isPetMaxKey = (id: string): boolean => id.endsWith(AH.petMaxSuffix);

/** Scan v4's pet level keys (`@L49`, `@L89`, `@L99`, `@MAX`): each repeats a listing of the plain pet id. */
export const isPetLevelKey = (id: string): boolean => /@(?:MAX|L\d+)$/.test(id);

const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];

/** "ENDER_DRAGON;4" -> "Ender Dragon (Legendary)" from the listing name, else from the id (level keys ignored). */
export function petName(id: string, listingName?: string): string {
  const [type = id, idx] = id.replace(/@.*$/, '').split(';');
  const base = listingName?.replace(/^\[Lvl \d+\]\s*/, '').trim() || type.toLowerCase().replace(/(^|_)(\w)/g, (_, s: string, c: string) => (s ? ' ' : '') + c.toUpperCase());
  const rarity = RARITIES[Number(idx)];
  return rarity ? `${base} (${rarity})` : base;
}

export interface AhFlipOptions {
  /** mayor Derpy: claim tax ×4 */
  derpy?: boolean;
  /** realized AH sales per key (ctx.ahSales); stats seen over less than AH_SALES.minCoverageHours are ignored */
  sales?: (id: string) => AhSalesStat | null;
  /** settings.conservative: relist at no more than the median sold price (once AH_SALES.minSales sales are seen) */
  conservative?: boolean;
  /** settings.share: your part of the measured sales (ahRate); 1 when absent */
  share?: number;
}

/** salesOf's rule without a context: a stat counts once the feed has covered AH_SALES.minCoverageHours. */
const measured = (o: AhFlipOptions, id: string): AhSalesStat | null => {
  const s = o.sales?.(id) ?? null;
  return s && s.coverageHours >= AH_SALES.minCoverageHours ? s : null;
};

const nameOf = (id: string, a: AhPrice, catalog: Catalog, pet: boolean): string =>
  pet ? petName(id, a.name) : catalog.items[id] ? catalog.name(id) : (a.name ?? catalog.name(id));

/**
 * Profitable lowest → second-lowest BIN flips of a scan (needs scan v2: next prices). Prices are per item (scan v4
 * divides stacks); you buy the cheapest listing whole and relist it, so the fees are taken on the stack. Plain ids and
 * `@MAX` keys are flipped; level-band keys (`@L49` ...) are skipped. The sale takes stack / ahRate(measured sales per hour,
 * share) hours: as the lowest BIN you sell to the next buyer.
 */
export function computeAhFlips(ah: AhSnapshot, catalog: Catalog, o: AhFlipOptions = {}): AhFlipRow[] {
  const rows: AhFlipRow[] = [];
  for (const [id, a] of Object.entries(ah.lowestBin)) {
    if (a.next == null || a.count < AH_FLIP.minCount || !(a.price > 0)) continue;
    const maxLevel = isPetMaxKey(id);
    if (!maxLevel && isPetLevelKey(id)) continue;
    let sellAt = a.next - AH_FLIP.undercut;
    if (!(sellAt > a.price)) continue;
    const sales = measured(o, id);
    let sellRef: number | undefined;
    if (o.conservative && sales && sales.n >= AH_SALES.minSales && sales.median > 0 && sales.median < sellAt) {
      sellRef = sellAt;
      sellAt = sales.median;
      if (!(sellAt > a.price)) continue;
    }
    const stack = a.stack != null && a.stack > 1 ? a.stack : 1;
    const net = ahNet(sellAt * stack, o.derpy) / stack;
    const profit = net - a.price;
    if (!(profit > 0)) continue;
    const pet = id.includes(';');
    const flags = ahFlags(a, catalog, id);
    if (pet && !maxLevel && !flags.includes('AH_VARIANT')) flags.push('AH_VARIANT');
    const perHour = sales?.perHour != null && sales.perHour > 0 ? sales.perHour : null;
    const rate = ahRate(perHour, o.share ?? 1);
    const sellHours = stack / rate;
    const listingFee = ahListingFee(sellAt * stack) / stack;
    const row: AhFlipRow = {
      key: `ah:${id}`,
      venue: 'ah',
      id,
      name: nameOf(id, a, catalog, pet),
      buy: a.price,
      next: a.next,
      sellAt,
      listingFee,
      claimTax: sellAt - net - listingFee,
      profit,
      margin: profit / a.price,
      gap: (a.next - a.price) / a.price,
      count: a.count,
      stack,
      units: 1,
      sellHours,
      salesPerHour: perHour,
      profitPerHour: profit * rate,
      maxLevel,
      ...(a.uuid ? { uuid: a.uuid } : {}),
      ...(a.name ? { listingName: a.name } : {}),
      pet,
      risk: reportFromFlags(flags),
      plan: { unitCost: a.price, buyCost: a.price, profitPerUnit: profit, unitsPerHour: rate, maxUnits: stack, orderUnits: [], uses: [] },
    };
    if (sellRef != null) row.sellRef = sellRef;
    rows.push(row);
  }
  return rows;
}

export interface GeorgeOptions {
  /** settings.cycleHours: the listings below George's price are one batch per cycle */
  cycleHours?: number;
}

/**
 * Pets listed below what George pays (catalog.george, keyed `TYPE;IDX`; any level): profit = George − buy per pet, no
 * fees, sold at once. Every kept listing below his price (scan v4 `prices`, else lowest and second-lowest) can be
 * flipped: the planner gets them as concave segments, the cheapest first.
 */
export function computeGeorgeFlips(ah: AhSnapshot, catalog: Catalog, o: GeorgeOptions = {}): AhFlipRow[] {
  const cycle = o.cycleHours != null && o.cycleHours > 0 ? o.cycleHours : 1;
  const rows: AhFlipRow[] = [];
  for (const [id, george] of Object.entries(catalog.george)) {
    const a = ah.lowestBin[id];
    if (!a || !(a.price > 0) || !(george > a.price)) continue;
    const prices = a.prices?.length ? a.prices : a.next != null ? [a.price, a.next] : [a.price];
    const segments: ProfitSegment[] = [];
    let cost = 0;
    for (const p of prices) {
      if (!(p < george)) break;
      cost += p;
      segments.push({ upTo: segments.length + 1, profitPerUnit: george - p });
    }
    const units = segments.length;
    const profit = george - a.price;
    const avgBuy = cost / units;
    rows.push({
      key: `george:${id}`,
      venue: 'george',
      id,
      name: nameOf(id, a, catalog, true),
      buy: a.price,
      next: george,
      sellAt: george,
      listingFee: 0,
      claimTax: 0,
      profit,
      margin: profit / a.price,
      gap: profit / a.price,
      count: a.count,
      stack: 1,
      units,
      sellHours: 0,
      salesPerHour: null,
      profitPerHour: (units * (george - avgBuy)) / cycle,
      maxLevel: false,
      ...(a.uuid ? { uuid: a.uuid } : {}),
      ...(a.name ? { listingName: a.name } : {}),
      pet: true,
      risk: reportFromFlags([]),
      plan: {
        unitCost: avgBuy,
        buyCost: avgBuy,
        profitPerUnit: george - avgBuy,
        unitsPerHour: units / cycle,
        maxUnits: units,
        orderUnits: [],
        uses: [],
        ...(units > 1 ? { segments } : {}),
      },
    });
  }
  return rows;
}
