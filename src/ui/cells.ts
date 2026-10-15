// Shared cell renderers for views (risk badge, item name cell, price-source badge). Owner: lead.
import { t } from '../i18n/index.ts';
import type { QuoteSource, RiskFlag, RiskReport } from '../types/contracts.ts';
import { esc } from './dom.ts';

/** Text explanation of one flag. */
export const riskFlagText = (f: RiskFlag): string => t(`risk.${f}`);

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

const SRC_KEY: Record<QuoteSource, string> = { order: 'srcOrder', insta: 'srcInsta', npc: 'srcNpc', craft: 'srcCraft' };

/** Price source badge (buy order / insta / NPC / craft). */
export function sourceBadge(s: QuoteSource): string {
  return `<span class="badge src-${s}">${esc(t(`risk.${SRC_KEY[s]}`))}</span>`;
}
