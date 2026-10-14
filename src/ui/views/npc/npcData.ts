// NPC & Shops view helpers: URL/localStorage schemas, row filtering, currency grouping. Pure (no DOM).
import { LS_VIEWPREFS } from '../../../config.ts';
import { matchesQuery, normalizeText } from '../../../domain/search.ts';
import { getLang, t } from '../../../i18n/index.ts';
import { lsGet, lsSet } from '../../../storage/local.ts';
import type { Catalog, NpcFlipRow, Settings, ShopRow, Snapshot } from '../../../types/contracts.ts';
import type { QuerySchema, QueryValues } from '../../kit/index.ts';

export type NpcDirection = NpcFlipRow['direction'];
export type NpcSegment = NpcDirection | 'shops';
export const SEGMENTS = ['bz2npc', 'npc2bz', 'shops'] as const satisfies readonly NpcSegment[];

export const FLIP_SORT_KEYS = ['name', 'buyAt', 'sellAt', 'profit', 'margin', 'uph', 'capital', 'pph', 'vol', 'lim', 'slots', 'risk'] as const;
export const SHOP_SORT_KEYS = ['name', 'shop', 'currency', 'cost', 'outQty', 'value', 'cpc', 'vol', 'risk'] as const;

/** Segment lives in its own state so a filter reset never switches the segment. */
export const SEG_SCHEMA = {
  dir: { kind: 'enum', def: 'bz2npc', values: SEGMENTS },
} as const satisfies QuerySchema;

export const FLIP_SCHEMA = {
  q: { kind: 'string', def: '' },
  /** percent, 1 = 1% */
  minMargin: { kind: 'number', def: 1, min: 0 },
  minPph: { kind: 'number', def: null, min: 0 },
  minVol: { kind: 'number', def: null, min: 0 },
  /** show suspect rows on this tab even when settings.hideSuspicious is on */
  hidden: { kind: 'bool', def: false },
  sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' }, keys: FLIP_SORT_KEYS },
} as const satisfies QuerySchema;

export const SHOP_SCHEMA = {
  sq: { kind: 'string', def: '' },
  /** currency id; '' = all */
  cur: { kind: 'string', def: '' },
  svol: { kind: 'number', def: null, min: 0 },
  shidden: { kind: 'bool', def: false },
  ssort: { kind: 'sort', def: { key: 'cpc', dir: 'desc' }, keys: SHOP_SORT_KEYS },
} as const satisfies QuerySchema;

export type FlipFilters = QueryValues<typeof FLIP_SCHEMA>;
export type ShopFilters = QueryValues<typeof SHOP_SCHEMA>;

export const LS_SEG = LS_VIEWPREFS + 'npc.seg';
export const LS_FLIP = LS_VIEWPREFS + 'npc';
export const LS_SHOPS = LS_VIEWPREFS + 'npc.shops';

/**
 * Round 1 stored typed prefs ({dir, q, minMargin: 1, minPph: 0, showHidden, sort: {key, dir}}) under LS_FLIP.
 * Convert them once to the string-encoded query-state format so bindQueryState can read them.
 */
export function migrateNpcPrefs(): void {
  const raw = lsGet<unknown>(LS_FLIP, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>;
  if (Object.values(r).every((v) => typeof v === 'string')) return;
  const out: Record<string, string> = {};
  if (typeof r.q === 'string' && r.q) out.q = r.q;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const mm = num(r.minMargin);
  if (mm != null && mm !== 1) out.minMargin = String(mm);
  const pph = num(r.minPph);
  if (pph) out.minPph = String(pph);
  if (r.showHidden === true) out.hidden = '1';
  const s = r.sort as Record<string, unknown> | undefined;
  if (s && typeof s.key === 'string' && (s.dir === 'asc' || s.dir === 'desc')) out.sort = `${s.key}.${s.dir}`;
  lsSet(LS_FLIP, out);
  if ((r.dir === 'npc2bz' || r.dir === 'bz2npc') && lsGet<unknown>(LS_SEG, null) == null) lsSet(LS_SEG, { dir: r.dir });
}

// ---------------------------------------------------------------- flips

export interface NpcRow extends NpcFlipRow {
  /** weekly volume of the bazaar leg that fills you */
  weekVol: number;
}

/** Weekly volume of the bazaar leg (same convention as pricing.ts rates). */
export function bazaarLegVolume(r: NpcFlipRow, snap: Snapshot, s: Pick<Settings, 'costMode' | 'sellMode'>): number {
  const p = snap.products[r.id];
  if (!p) return 0;
  const v =
    r.direction === 'bz2npc'
      ? s.costMode === 'order'
        ? p.instaSellsWeek
        : p.instaBuysWeek
      : s.sellMode === 'offer'
        ? p.instaBuysWeek
        : p.instaSellsWeek;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export interface FilterResult<R> {
  rows: R[];
  /** rows in this segment before any filter */
  total: number;
  /** suspect rows passing the other filters (hidden unless showHidden) */
  suspect: number;
}

export function filterFlips(
  all: readonly NpcFlipRow[],
  dir: NpcDirection,
  f: FlipFilters,
  ctx: { snap: Snapshot; catalog: Catalog | null; settings: Settings },
): FilterResult<NpcRow> {
  const minM = (f.minMargin ?? 0) / 100;
  const out: NpcRow[] = [];
  let total = 0;
  let suspect = 0;
  for (const r of all) {
    if (r.direction !== dir) continue;
    total++;
    if (r.margin < minM) continue;
    if (f.minPph != null && r.profitPerHour < f.minPph) continue;
    const weekVol = bazaarLegVolume(r, ctx.snap, ctx.settings);
    if (f.minVol != null && weekVol < f.minVol) continue;
    if (!matchesQuery(ctx.catalog, r.id, f.q)) continue;
    if (r.risk.level === 'suspect') {
      suspect++;
      if (ctx.settings.hideSuspicious && !f.hidden) continue;
    }
    out.push({ ...r, weekVol });
  }
  return { rows: out, total, suspect };
}

// ---------------------------------------------------------------- shops

/** Display label of a shop currency ('SKYBLOCK_COPPER' -> 'Copper'). */
export function currencyLabel(cur: string, catalog: Catalog | null): string {
  if (cur === 'SKYBLOCK_COIN') return t('npc.coin');
  return catalog ? catalog.name(cur) : cur;
}

export interface CurrencyOption {
  id: string;
  label: string;
  count: number;
  /** offer with the highest coins per currency unit (null when none is priced) */
  best: ShopRow | null;
}

/** Currencies present in `rows`, most offers first, then by label. */
export function currencyOptions(rows: readonly ShopRow[], catalog: Catalog | null): CurrencyOption[] {
  const by = new Map<string, CurrencyOption>();
  for (const r of rows) {
    let o = by.get(r.currency);
    if (!o) by.set(r.currency, (o = { id: r.currency, label: currencyLabel(r.currency, catalog), count: 0, best: null }));
    o.count++;
    if (r.coinsPerCurrency != null && (o.best?.coinsPerCurrency == null || r.coinsPerCurrency > o.best.coinsPerCurrency)) o.best = r;
  }
  const coll = new Intl.Collator(getLang());
  return [...by.values()].sort((a, b) => b.count - a.count || coll.compare(a.label, b.label));
}

/** Rows without suspects (unless shown), before the search/currency/volume filters: the base for rates and options. */
export function visibleShops(all: readonly ShopRow[], hideSuspicious: boolean, showHidden: boolean): { rows: ShopRow[]; suspect: number } {
  let suspect = 0;
  const rows: ShopRow[] = [];
  for (const r of all) {
    if (r.risk?.level === 'suspect') {
      suspect++;
      if (hideSuspicious && !showHidden) continue;
    }
    rows.push(r);
  }
  return { rows, suspect };
}

export function filterShops(
  all: readonly ShopRow[],
  f: ShopFilters,
  catalog: Catalog | null,
  hideSuspicious: boolean,
): FilterResult<ShopRow> {
  const nq = normalizeText(f.sq);
  const out: ShopRow[] = [];
  let suspect = 0;
  for (const r of all) {
    if (f.cur && r.currency !== f.cur) continue;
    if (f.svol != null && r.weekVol < f.svol) continue;
    if (
      nq &&
      !matchesQuery(catalog, r.id, f.sq) &&
      !normalizeText(r.shop).includes(nq) &&
      !normalizeText(currencyLabel(r.currency, catalog)).includes(nq) &&
      !normalizeText(r.currency).includes(nq)
    )
      continue;
    if (r.risk?.level === 'suspect') {
      suspect++;
      if (hideSuspicious && !f.shidden) continue;
    }
    out.push(r);
  }
  // pre-sorted best rate first, so a (stable) sort by currency groups each currency best-first
  out.sort((a, b) => (a.coinsPerCurrency == null ? (b.coinsPerCurrency == null ? 0 : 1) : b.coinsPerCurrency == null ? -1 : b.coinsPerCurrency - a.coinsPerCurrency));
  return { rows: out, total: all.length, suspect };
}
