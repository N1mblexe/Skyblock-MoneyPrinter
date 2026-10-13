// NPC view helpers: persisted prefs, memoized computation, row filtering.
import { LS_VIEWPREFS } from '../../../config.ts';
import { computeNpcFlips } from '../../../domain/npc.ts';
import { matchesQuery } from '../../../domain/search.ts';
import { lsGet, lsSet } from '../../../storage/local.ts';
import type { CalcCtx, Catalog, NpcFlipRow, Settings, Snapshot } from '../../../types/contracts.ts';
import type { SortState } from '../../table.ts';

export type NpcDirection = NpcFlipRow['direction'];

export interface NpcPrefs {
  dir: NpcDirection;
  q: string;
  /** percent, e.g. 1 = 1% */
  minMargin: number;
  minPph: number;
  /** show suspect rows on this tab even when settings.hideSuspicious is on */
  showHidden: boolean;
  sort?: SortState;
}

export const PREFS_KEY = LS_VIEWPREFS + 'npc';

export const defaultPrefs = (): NpcPrefs => ({ dir: 'bz2npc', q: '', minMargin: 1, minPph: 0, showHidden: false });

const finiteNonNeg = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fb);

export function loadPrefs(): NpcPrefs {
  const p = defaultPrefs();
  const raw = lsGet<unknown>(PREFS_KEY, null);
  if (!raw || typeof raw !== 'object') return p;
  const r = raw as Record<string, unknown>;
  if (r.dir === 'bz2npc' || r.dir === 'npc2bz') p.dir = r.dir;
  if (typeof r.q === 'string') p.q = r.q;
  p.minMargin = finiteNonNeg(r.minMargin, p.minMargin);
  p.minPph = finiteNonNeg(r.minPph, p.minPph);
  if (typeof r.showHidden === 'boolean') p.showHidden = r.showHidden;
  const s = r.sort as Record<string, unknown> | undefined;
  if (s && typeof s.key === 'string' && (s.dir === 'asc' || s.dir === 'desc')) p.sort = { key: s.key, dir: s.dir };
  return p;
}

export function savePrefs(p: NpcPrefs): void {
  lsSet(PREFS_KEY, p);
}

/** Settings fields computeNpcFlips depends on (lang/theme changes must not trigger a recompute). */
const settingsKey = (s: Settings) => [s.costMode, s.sellMode, s.share, s.taxRate, s.capital, s.cycleHours].join('|');

/** Memoized computeNpcFlips: recomputes only when snapshot/catalog identity, relevant settings or history tick change. */
export function createNpcMemo(compute: (ctx: CalcCtx) => NpcFlipRow[] = computeNpcFlips) {
  let last: { snap: Snapshot; catalog: Catalog; sk: string; tick: number; rows: NpcFlipRow[] } | null = null;
  return (ctx: CalcCtx, tick: number): NpcFlipRow[] => {
    const sk = settingsKey(ctx.settings);
    if (last && last.snap === ctx.snap && last.catalog === ctx.catalog && last.sk === sk && last.tick === tick) return last.rows;
    const rows = compute(ctx);
    last = { snap: ctx.snap, catalog: ctx.catalog, sk, tick, rows };
    return rows;
  };
}

export interface FilterResult {
  rows: NpcFlipRow[];
  /** rows in this direction before any filter */
  total: number;
  /** suspect rows passing the other filters that are hidden (or would be, when showHidden) */
  suspect: number;
}

export function filterRows(
  all: readonly NpcFlipRow[],
  p: NpcPrefs,
  catalog: Catalog | null,
  hideSuspicious: boolean,
): FilterResult {
  const minM = p.minMargin / 100;
  const out: NpcFlipRow[] = [];
  let total = 0;
  let suspect = 0;
  for (const r of all) {
    if (r.direction !== p.dir) continue;
    total++;
    if (r.margin < minM || r.profitPerHour < p.minPph) continue;
    if (!matchesQuery(catalog, r.id, p.q)) continue;
    if (r.risk.level === 'suspect') {
      suspect++;
      if (hideSuspicious && !p.showHidden) continue;
    }
    out.push(r);
  }
  return { rows: out, total, suspect };
}
