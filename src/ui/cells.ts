// Shared cell renderers for views (risk badge and scope, item name cell, price-source badge, conservative
// adjustments). Owner: lead.
import { RISK } from '../config.ts';
import { t } from '../i18n/index.ts';
import type { ConsInfo, QuoteSource, RiskFlag, RiskReport } from '../types/contracts.ts';
import { esc } from './dom.ts';
import { fmtCoins, fmtNum, fmtPct } from './format.ts';

/** Text explanation of one flag. */
export const riskFlagText = (f: RiskFlag): string =>
  t(`risk.${f}`, {
    wide: fmtPct(RISK.wideSpreadMargin, 0),
    extreme: fmtPct(RISK.extremeSpreadMargin, 0),
    few: RISK.fewOrders,
    imbalance: RISK.volumeImbalance[1],
  });

/** Risk level badge; tooltip lists the flag explanations (NO_HISTORY omitted unless alone). */
export function riskBadge(r: RiskReport): string {
  const flags = r.flags.filter((f) => f !== 'NO_HISTORY' || r.flags.length === 1);
  const tip = flags.map(riskFlagText).join('\n');
  return `<span class="badge risk-${r.level}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(t(`risk.${r.level}`))}</span>`;
}

/** Name with the id underneath; optional link to the item detail view. */
export function itemCell(id: string, name: string, link = false): string {
  const label = link ? `<a href="#/item/${encodeURIComponent(id)}">${esc(name)}</a>` : esc(name);
  return `${label}<span class="id-sub">${esc(id)}</span>`;
}

const SRC_KEY: Record<QuoteSource, string> = { order: 'srcOrder', insta: 'srcInsta', npc: 'srcNpc', craft: 'srcCraft', ah: 'srcAh', mix: 'srcMix' };

/** Price source badge (buy order / insta / NPC / craft). */
export function sourceBadge(s: QuoteSource): string {
  return `<span class="badge src-${s}">${esc(t(`risk.${SRC_KEY[s]}`))}</span>`;
}

/** The bazaar sides a row's risk covers (domain/risk.ts assessRisk `use`). */
export type RiskScope = 'both' | 'buy' | 'sell' | 'book' | 'fusion' | 'item';

/** One muted line naming the sides a risk report checked. */
export const riskScopeHtml = (scope: RiskScope): string => `<p class="muted small risk-scope">${esc(t(`risk.scope_${scope}`))}</p>`;

/** True when conservatism changed something on the row. */
const hasCons = (c: ConsInfo | undefined): c is ConsInfo =>
  !!c && (c.buyRef != null || c.sellRef != null || c.rateMul != null || (c.churn != null && c.churn > 0));

/** Small "adjusted" badge for a name cell when conservatism changed the row ('' otherwise). */
export function consBadge(c: ConsInfo | undefined): string {
  if (!hasCons(c)) return '';
  return ` <span class="badge cons-badge" title="${esc(t('risk.consTip'))}">${esc(t('risk.consBadge'))}</span>`;
}

/** A per-unit price with the bazaar's 0.1 tick visible (compact coins from 100k up). */
const fmtTick = (n: number | undefined): string => (n != null && Number.isFinite(n) && Math.abs(n) < 100_000 ? fmtNum(n, 1) : fmtCoins(n));

/**
 * What conservatism changed on a row, one line each ('' when nothing): the buy / sell price moved from the snapshot
 * quote (`now` = the row's adjusted per-unit prices, before tax), the fill-rate multiplier and the re-listing cost.
 */
export function consListHtml(c: ConsInfo | undefined, now: { buy?: number; sell?: number } = {}): string {
  if (!hasCons(c)) return '';
  const lines: string[] = [];
  if (c.buyRef != null) lines.push(t('risk.consBuy', { from: fmtTick(c.buyRef), to: fmtTick(now.buy) }));
  if (c.sellRef != null) lines.push(t('risk.consSell', { from: fmtTick(c.sellRef), to: fmtTick(now.sell) }));
  if (c.rateMul != null) lines.push(t('risk.consRate', { mul: fmtNum(c.rateMul, 2) }));
  if (c.churn != null && c.churn > 0) lines.push(t('risk.consChurn', { churn: fmtCoins(c.churn) }));
  return (
    `<ul class="dp-flags cons-list" data-testid="cons-list">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` +
    `<p class="muted small">${esc(t('risk.consNote'))}</p>`
  );
}
