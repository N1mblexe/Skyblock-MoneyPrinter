// Detail-panel bodies for the NPC & Shops view (HTML strings; every value escaped here).
import { t } from '../../../i18n/index.ts';
import { npcBuyRate } from '../../../domain/pricing.ts';
import type { Catalog, Quote, RiskReport, Settings, ShopRow, Snapshot } from '../../../types/contracts.ts';
import { consListHtml, riskBadge, riskFlagText, riskScopeHtml, sourceBadge, type RiskScope } from '../../cells.ts';
import { esc } from '../../dom.ts';
import { fmtCoins, fmtCompact, fmtHours, fmtInt, fmtNum, fmtPct } from '../../format.ts';
import { currencyLabel, type NpcRow } from './npcData.ts';

interface Ctx {
  snap: Snapshot;
  catalog: Catalog;
  settings: Settings;
  watched: boolean;
  /** clamp on the bazaar buy quote (bz2npc rows in buy-order mode) */
  buyClamp?: Quote['clamped'];
}

const kv = (pairs: [string, string][]): string =>
  `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

function riskSection(r: RiskReport | null, scope?: RiskScope): string {
  if (!r) return `<h3>${esc(t('npc.d_risk'))}</h3><p class="muted small">${esc(t('npc.d_noProduct'))}</p>`;
  const flags = r.flags.filter((f) => f !== 'NO_HISTORY' || r.flags.length === 1);
  const list = flags.length
    ? `<ul class="npc-flags">${flags.map((f) => `<li>${esc(riskFlagText(f))}</li>`).join('')}</ul>`
    : `<p class="muted small">${esc(t('npc.d_noFlags'))}</p>`;
  return `<h3>${esc(t('npc.d_risk'))} ${riskBadge(r)}</h3>${list}${scope ? riskScopeHtml(scope) : ''}`;
}

function links(items: { href: string; label: string }[], watched: boolean): string {
  const a = items.map((l) => `<a class="btn btn-sm" href="${esc(l.href)}">${esc(l.label)}</a>`).join('');
  const star = `<button type="button" class="btn btn-sm npc-watch-btn" data-panel-act="watch" aria-pressed="${watched}">${
    watched ? '★' : '☆'
  } ${esc(t(watched ? 'common.unwatch' : 'common.watch'))}</button>`;
  return `<h3>${esc(t('npc.d_links'))}</h3><div class="npc-d-links">${a}${star}</div>`;
}

const itemHref = (id: string) => `#/item/${encodeURIComponent(id)}`;
const limLabel = (k: string) => t(`npc.lim_${k}`);

export function flipDetailHtml(r: NpcRow, c: Ctx): string {
  const s = c.settings;
  const tp = r.tp;
  const batch = fmtInt(tp.batchQty);
  const slots = fmtInt(tp.slots ?? 0);
  const steps: string[] = [];
  // a buy order capped at the ask is an insta-buy (walks the sell offers, no slot)
  const clamp = r.direction === 'bz2npc' && s.costMode === 'order' ? c.buyClamp : undefined;
  if (r.direction === 'bz2npc') {
    steps.push(
      s.costMode === 'order' && clamp !== 'ask'
        ? t('npc.step_buyOrder', { price: fmtCoins(r.buyAt), batch, slots })
        : t('npc.step_instaBuy', { price: fmtCoins(r.buyAt), batch }),
    );
    steps.push(t('npc.step_sellNpc', { price: fmtCoins(r.sellAt) }));
  } else {
    steps.push(
      t('npc.step_buyNpc', { price: fmtCoins(r.buyAt), batch, limit: fmtInt(s.npcDailyLimit), perHour: fmtNum(npcBuyRate(s.npcDailyLimit), 1) }),
    );
    steps.push(
      s.sellMode === 'offer'
        ? t('npc.step_sellOffer', { price: fmtCoins(r.sellAt), slots })
        : t('npc.step_instaSell', { price: fmtCoins(r.sellAt) }),
    );
  }
  steps.push(t('npc.step_profit', { profit: fmtCoins(r.profit), pph: fmtCoins(r.profitPerHour) }));

  const nums: [string, string][] = [
    [t('npc.col_profit'), `<span class="${r.profit > 0 ? 'pos' : 'neg'}">${esc(fmtCoins(r.profit))}</span>`],
    [t('npc.col_margin'), esc(fmtPct(r.margin))],
    [t('npc.col_uph'), esc(fmtInt(tp.unitsPerHour))],
    [t('npc.col_pph'), `<strong class="pos">${esc(fmtCoins(r.profitPerHour))}</strong>`],
    [t('npc.d_batch'), esc(batch)],
    [t('npc.col_capital'), esc(fmtCoins(tp.capitalUsed))],
    [t('npc.d_fillHours'), esc(fmtHours(tp.fillHours))],
  ];
  // the NPC leg is instant: no fill time (an NPC purchase is bounded by the daily limit instead)
  const hours = (h: number, npcLeg: boolean) => (npcLeg ? esc(t('npc.d_instant')) : esc(fmtHours(h)));
  if (tp.buyHours != null) nums.push([t('npc.d_buyHours'), hours(tp.buyHours, r.direction === 'npc2bz')]);
  if (tp.sellHours != null) nums.push([t('npc.d_sellHours'), hours(tp.sellHours, r.direction === 'bz2npc')]);
  nums.push([t('npc.col_slots'), esc(slots)]);
  nums.push([t('npc.col_lim'), esc(limLabel(tp.limitedBy))]);
  nums.push([t('npc.col_vol'), esc(fmtCompact(r.weekVol))]);
  if (r.direction === 'npc2bz') {
    nums.push([t('npc.d_npcLimit'), esc(fmtInt(s.npcDailyLimit))]);
    nums.push([t('npc.d_npcCap'), esc(t('npc.d_npcCapVal', { n: fmtNum(npcBuyRate(s.npcDailyLimit), 1), cycle: fmtInt(npcBuyRate(s.npcDailyLimit) * s.cycleHours) }))]);
  }
  const clampNote = clamp
    ? `<p class="small" data-testid="npc-clamp">${esc(t(clamp === 'npcFloor' ? 'npc.floorTitle' : 'flip.clampedAskTip'))}</p>`
    : '';
  const cons = consListHtml(r.cons, r.direction === 'bz2npc' ? { buy: r.buyAt } : { sell: s.taxRate < 1 ? r.sellAt / (1 - s.taxRate) : undefined });

  return (
    `<div class="npc-detail" data-detail="${esc(r.direction)}:${esc(r.id)}">` +
    `<p class="npc-d-route">${esc(t(`npc.dir_${r.direction}`))} · <span class="mono">${esc(r.id)}</span></p>` +
    `<h3>${esc(t('npc.d_steps'))}</h3><ol class="npc-steps">${steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` +
    clampNote +
    `<h3>${esc(t('npc.d_numbers'))}</h3>${kv(nums)}` +
    (cons ? `<h3>${esc(t('risk.consTitle'))}</h3>${cons}` : '') +
    riskSection(r.risk, r.direction === 'bz2npc' ? 'buy' : 'sell') +
    links([{ href: itemHref(r.id), label: t('npc.d_itemPage') }], c.watched) +
    `</div>`
  );
}

export function shopDetailHtml(r: ShopRow, c: Ctx): string {
  const cur = currencyLabel(r.currency, c.catalog);
  const shop = r.shop || t('npc.shopUnknown');
  const steps: string[] = [
    t('npc.step_shopBuy', { shop, cost: fmtInt(r.costQty), cur, out: fmtInt(r.outQty), item: r.name }),
  ];
  if (r.value != null) {
    steps.push(t(r.valueSource === 'npc' ? 'npc.step_shopSellNpc' : 'npc.step_shopSellBz', { value: fmtCoins(r.value) }));
    if (r.coinsPerCurrency != null) steps.push(t('npc.step_shopRate', { cur, n: fmtCoins(r.coinsPerCurrency) }));
  }
  const src =
    r.valueSource === 'npc'
      ? sourceBadge('npc')
      : r.valueSource === 'bazaar'
        ? `<span class="badge src-bazaar">${esc(t('common.src_bazaar'))}</span>`
        : '—';
  const nums: [string, string][] = [
    [t('npc.col_cost'), `${esc(fmtInt(r.costQty))} ${esc(cur)}`],
    [t('npc.col_outQty'), esc(fmtInt(r.outQty))],
    [t('npc.col_value'), esc(fmtCoins(r.value))],
    [t('npc.d_valueSource'), src],
    [t('npc.col_cpc'), `<strong>${esc(fmtCoins(r.coinsPerCurrency))}</strong>`],
    [t('npc.col_vol'), esc(fmtCompact(r.weekVol))],
  ];

  let compare = '';
  const cp = c.snap.products[r.currency];
  if (cp && cp.ask != null && cp.ask > 0 && r.coinsPerCurrency != null) {
    compare = `<p class="small npc-d-compare">${esc(
      t('npc.d_curOnBazaar', { cur, ask: fmtCoins(cp.ask), ratio: fmtNum(r.coinsPerCurrency / cp.ask, 2) }),
    )}</p>`;
  }
  const linkList = [{ href: itemHref(r.id), label: t('npc.d_itemPage') }];
  if (c.catalog.items[r.currency] && r.currency !== 'SKYBLOCK_COIN') linkList.push({ href: itemHref(r.currency), label: t('npc.d_currencyPage', { cur }) });

  return (
    `<div class="npc-detail" data-detail="${esc(r.key)}">` +
    `<p class="npc-d-route">${esc(shop)} · ${esc(cur)}</p>` +
    (r.value == null ? `<p class="banner banner-warn small">${esc(t('npc.d_unpriced'))}</p>` : '') +
    `<h3>${esc(t('npc.d_steps'))}</h3><ol class="npc-steps">${steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` +
    compare +
    `<h3>${esc(t('npc.d_numbers'))}</h3>${kv(nums)}` +
    riskSection(r.risk) +
    links(linkList, c.watched) +
    `</div>`
  );
}
