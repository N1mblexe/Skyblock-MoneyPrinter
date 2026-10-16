// Market alerts: rules over every opportunity (flips, crafts, forges, chains, books, NPC flips, Kat upgrades) instead of one item.
// A rule fires only for rows that newly meet it (keys not met at the last check), so a steady opportunity does not
// fire every snapshot; a row that drops out and comes back fires again.
import type { BookRow, ChainRow, CraftRow, FlipRow, NpcFlipRow, OppAlertRule, OppHit, OpportunityKind, RiskReport } from '../types/contracts.ts';
import type { KatRow } from './kat.ts';

export const OPP_KINDS: readonly OpportunityKind[] = ['flip', 'craft', 'forge', 'chain', 'book', 'npc', 'kat'];
/** hits kept per rule */
export const OPP_HITS_MAX = 10;

/** One page row in a common shape. */
export interface OppCandidate {
  key: string;
  kind: OpportunityKind;
  id: string;
  name: string;
  profitPerHour: number;
  profit: number;
  margin: number;
  risk: RiskReport;
}

export interface OppSources {
  flips: readonly FlipRow[];
  crafts: readonly CraftRow[];
  chains: readonly ChainRow[];
  books: readonly BookRow[];
  npc: readonly NpcFlipRow[];
  kat: readonly KatRow[];
}

/** Priced rows of every page, with the keys the planner uses. */
export function oppCandidates(d: OppSources): OppCandidate[] {
  const out: OppCandidate[] = [];
  const add = (kind: OpportunityKind, key: string, r: { id: string; name: string; profitPerHour: number; profit: number; margin: number | null; risk: RiskReport }) =>
    r.margin != null && out.push({ key: `${kind}:${key}`, kind, id: r.id, name: r.name, profitPerHour: r.profitPerHour, profit: r.profit, margin: r.margin, risk: r.risk });
  for (const r of d.flips) add('flip', r.id, r);
  for (const r of d.crafts) if (!r.unpriced.length) add(r.recipe.kind === 'forge' ? 'forge' : 'craft', r.recipe.key, r);
  for (const c of d.chains) if (!c.row.unpriced.length) add('chain', c.key, c.row);
  for (const r of d.books) add('book', r.id, r);
  for (const r of d.npc) add('npc', `${r.id}:${r.direction}`, r);
  for (const r of d.kat) if (!r.unpriced.length) add('kat', r.key, r);
  return out;
}

const riskOk = (r: OppAlertRule, risk: RiskReport) => risk.level === 'ok' || (r.maxRisk === 'caution' && risk.level === 'caution');

/** Rows meeting one rule right now. */
export function oppMatches(rule: OppAlertRule, cands: readonly OppCandidate[]): OppCandidate[] {
  const scope = new Set(rule.scope);
  return cands.filter((c) => scope.has(c.kind) && c[rule.metric] > rule.value && riskOk(rule, c.risk));
}

export interface OppEvalResult {
  /** rules with updated seen / hits / lastFiredAt (same objects when nothing changed) */
  rules: OppAlertRule[];
  /** per rule key, the rows that newly met it (best first) */
  fired: Map<string, OppCandidate[]>;
}

export function evaluateOppAlerts(rules: readonly OppAlertRule[], cands: readonly OppCandidate[], now: number): OppEvalResult {
  const fired = new Map<string, OppCandidate[]>();
  const next = rules.map((r) => {
    if (!r.enabled) return r;
    const hits = oppMatches(r, cands).sort((a, b) => b[r.metric] - a[r.metric]);
    const seen = new Set(r.seen);
    const fresh = hits.filter((h) => !seen.has(h.key));
    const keys = hits.map((h) => h.key);
    const sameSeen = keys.length === r.seen.length && keys.every((k) => seen.has(k));
    if (!fresh.length) return sameSeen ? r : { ...r, seen: keys };
    fired.set(r.key, fresh);
    const newHits: OppHit[] = fresh.map((h) => ({ key: h.key, kind: h.kind, id: h.id, name: h.name, value: h[r.metric], at: now }));
    return { ...r, seen: keys, hits: [...newHits, ...r.hits].slice(0, OPP_HITS_MAX), lastFiredAt: now };
  });
  return { rules: next, fired };
}
