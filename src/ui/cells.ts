// Shared cell renderers for views (risk badge, item name cell, price-source badge). Owner: lead.
import { registerDict, t } from '../i18n/index.ts';
import type { QuoteSource, RiskFlag, RiskReport } from '../types/contracts.ts';
import { esc } from './dom.ts';

registerDict('risk', {
  tr: {
    ok: 'Temiz',
    caution: 'Dikkat',
    suspect: 'Şüpheli',
    DEAD_BID: 'Ölü alış: en iyi buy order satış fiyatının yanında önemsiz (ör. 0,1).',
    WIDE_SPREAD: 'Geniş makas: alış ile satış arası %60’tan fazla.',
    EXTREME_SPREAD: 'Aşırı makas (%200+): bir taraf neredeyse kesin bayat ya da manipüle.',
    LOW_VOLUME: 'Düşük hacim: haftalık işlem çok az, emirler dolmayabilir.',
    FEW_ORDERS: 'Az emir: bir tarafta 5’ten az emir var.',
    THIN_TOP: 'İnce tepe: en iyi fiyatta çok az ürün var, bir sonraki seviye çok farklı.',
    QUICK_DIVERGENCE: 'Ortalama fiyat (quick_status) en iyi fiyattan çok farklı.',
    VOLUME_IMBALANCE: 'Dengesiz hacim: alım ve satım hacmi 10 kattan fazla farklı.',
    PRICE_SPIKE: 'Fiyat sıçraması: son 24 saatin medyanından çok saptı.',
    NO_HISTORY: 'Henüz yeterli fiyat geçmişi yok (sıçrama kontrolü yapılamadı).',
    srcOrder: 'Buy order',
    srcInsta: 'Insta',
    srcNpc: 'NPC',
    srcCraft: 'Craft',
  },
  en: {
    ok: 'Clean',
    caution: 'Caution',
    suspect: 'Suspect',
    DEAD_BID: 'Dead bid: the best buy order is negligible next to the ask (e.g. 0.1).',
    WIDE_SPREAD: 'Wide spread: more than 60% between bid and ask.',
    EXTREME_SPREAD: 'Extreme spread (200%+): one side is almost surely stale or manipulated.',
    LOW_VOLUME: 'Low volume: very few weekly trades, orders may not fill.',
    FEW_ORDERS: 'Few orders: fewer than 5 orders on one side.',
    THIN_TOP: 'Thin top: tiny amount at the best price, next level is far away.',
    QUICK_DIVERGENCE: 'Average price (quick_status) is far from the best price.',
    VOLUME_IMBALANCE: 'Imbalanced volume: buy and sell volume differ by more than 10x.',
    PRICE_SPIKE: 'Price spike: far from the 24h median.',
    NO_HISTORY: 'Not enough price history yet (spike check skipped).',
    srcOrder: 'Buy order',
    srcInsta: 'Insta',
    srcNpc: 'NPC',
    srcCraft: 'Craft',
  },
});

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
