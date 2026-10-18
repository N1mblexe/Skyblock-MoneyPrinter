// Item detail view: #/item/<id>. Header actions (watch, quick alert, copy id), key facts, your flip (same as the
// Flips tab), market stats, AH lowest BIN, shard info, risk, top-10 order book, price history chart, recipes.
// Catalog / AH items that are not bazaar products get a reduced page (no book, chart or flip).
import { ahClaimTax, ahListingFee, ahNet } from '../../../domain/pricing.ts';
import { isDerpy } from '../../../state/derived.ts';
import { ALERT_METRICS } from '../../../domain/alertMetrics.ts';
import { AH_SALES, ALERTS, LS_VIEWPREFS } from '../../../config.ts';
import { flipPlanFor, metricValue } from '../../../domain/alerts.ts';
import { buyQuote } from '../../../domain/pricing.ts';
import { assessRisk } from '../../../domain/risk.ts';
import { matchesQuery, resolveUserInput, searchItems } from '../../../domain/search.ts';
import { deriveName } from '../../../domain/ids.ts';
import { msgText, onLangChange } from '../../../i18n/index.ts';
import { lsGet, lsSet } from '../../../storage/local.ts';
import type {
  AlertMetric,
  AlertRule,
  AppState,
  Catalog,
  FlipRow,
  HistoryPoint,
  HistoryRange,
  OrderLevel,
  Product,
  Recipe,
  Route,
  Snapshot,
  Throughput,
  View,
  ViewContext,
} from '../../../types/contracts.ts';
import { consListHtml, itemCell, riskBadge, riskFlagText, riskScopeHtml } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtAge, fmtCoins, fmtHours, fmtInt, fmtList, fmtNum, fmtPct } from '../../format.ts';
import { parseNumberInput } from '../../kit/index.ts';
import { createTable, type TableHandle } from '../../table.ts';
import {
  alertPrefill,
  alertValueFromInput,
  fmtPrice,
  fmtQty,
  fmtSignedPct,
  fmtStamp,
  fmtTick,
  fmtTrend,
  isBookId,
  PCT_METRICS,
} from './helpers.ts';
import { createLineChart, type ChartData, type LineChart } from './lineChart.ts';
import './item.css';

const BOOK_LEVELS = 10;
const USING_LIMIT = 20;
const SUGGEST_LIMIT = 8;
const RANGES: HistoryRange[] = ['3h', '24h', '7d'];
const PREFS_KEY = LS_VIEWPREFS + 'item';
const METRICS = ALERT_METRICS;

interface BookRow {
  key: string;
  price: number;
  amount: number;
  orders: number;
  cumAmount: number;
  cumCoins: number;
}

/** Top `n` levels with running totals. */
export function bookRows(levels: readonly OrderLevel[], side: string, n = BOOK_LEVELS): BookRow[] {
  let cumAmount = 0;
  let cumCoins = 0;
  return levels.slice(0, n).map((l, i) => {
    cumAmount += l.amount;
    cumCoins += l.amount * l.price;
    return { key: `${side}${i}`, price: l.price, amount: l.amount, orders: l.orders, cumAmount, cumCoins };
  });
}

/** Search bazaar products (catalog ranking when available, plus snapshot ids the catalog lacks). */
export function searchProducts(snap: Snapshot | null, catalog: Catalog | null, q: string, limit = SUGGEST_LIMIT): string[] {
  if (!q.trim()) return [];
  const has = (id: string) => (snap ? id in snap.products : !!catalog?.items[id]?.bazaar);
  const out: string[] = [];
  if (catalog) for (const i of searchItems(catalog, q, limit, (i) => has(i.id))) out.push(i.id);
  if (out.length < limit && snap) {
    for (const id of Object.keys(snap.products).sort()) {
      if (out.length >= limit) break;
      if (catalog?.items[id]) continue; // already ranked above
      if (matchesQuery(catalog, id, q)) out.push(id);
    }
  }
  return out;
}

/** Tax rate with only the digits it needs: 1,25% / 1,125% / 1%. */
function fmtTax(tax: number): string {
  const digits = (String(Math.round(tax * 100 * 1000) / 1000).split('.')[1] ?? '').length;
  return fmtPct(tax, digits);
}

/** Displayed per-unit flip numbers: the Flips tab row when the flip is profitable, else the same plan unfiltered. */
interface FlipView {
  buy: number;
  sell: number;
  net: number;
  profit: number;
  tp: Throughput;
  /** null when the flip is not on the Flips tab (not profitable) */
  row: FlipRow | null;
}

const pctClass = (x: number | null | undefined) => (x == null || !Number.isFinite(x) || x === 0 ? '' : x > 0 ? 'pos' : 'neg');
const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

export function createItemView(): View {
  let ctx: ViewContext | null = null;
  let root: HTMLElement | null = null;
  let id = '';
  let range: HistoryRange = '24h';
  let points: HistoryPoint[] = [];
  let pointsFor = '';
  let seriesToken = 0;
  let alive = false;
  const cleanups: (() => void)[] = [];
  /** flips() array -> rows by id (rebuilt only when derived recomputes) */
  let flipIndex: { src: readonly FlipRow[]; map: Map<string, FlipRow> } | null = null;

  // keys without a namespace are 'item.' keys; 'common.x' etc. pass through
  const t = (k: string, p?: Record<string, string | number>) => ctx!.t(k.includes('.') ? k : `item.${k}`, p);
  const st = (): AppState => ctx!.store.get();
  const nameOf = (x: string) => st().catalog?.name(x) ?? deriveName(x);

  // ---- persistent pieces (built in mount)
  let msgEl!: HTMLElement;
  let mainEl!: HTMLElement;
  let nameEl!: HTMLHeadingElement;
  let badgesEl!: HTMLElement;
  let idEl!: HTMLElement;
  let actionsEl!: HTMLElement;
  let watchBtn!: HTMLButtonElement;
  let alertBtn!: HTMLButtonElement;
  let copyBtn!: HTMLButtonElement;
  let linksEl!: HTMLElement;
  let alertCountEl!: HTMLElement;
  let alertForm: HTMLFormElement | null = null;
  let alertTitle!: HTMLElement;
  let metricLabel!: HTMLElement;
  let metricSel!: HTMLSelectElement;
  let opLabel!: HTMLElement;
  let opSel!: HTMLSelectElement;
  let valueLabel!: HTMLElement;
  let valueInput!: HTMLInputElement;
  let valueHint!: HTMLElement;
  let alertSave!: HTMLButtonElement;
  let alertCancel!: HTMLButtonElement;
  let offNote!: HTMLElement;
  let factsEl!: HTMLElement;
  let bookSec!: HTMLElement;
  let chartSec!: HTMLElement;
  let bookTitle!: HTMLElement;
  let bidsTitle!: HTMLElement;
  let asksTitle!: HTMLElement;
  let bookNote!: HTMLElement;
  let chartTitle!: HTMLElement;
  let chartLegend!: HTMLElement;
  let chartNote!: HTMLElement;
  let rangeSeg!: HTMLElement;
  let recOutTitle!: HTMLElement;
  let recOutMsg!: HTMLElement;
  let recInTitle!: HTMLElement;
  let recInMsg!: HTMLElement;
  let backLink!: HTMLAnchorElement;
  let searchLabel!: HTMLElement;
  let searchInput!: HTMLInputElement;
  let suggList!: HTMLUListElement;
  let tblBids!: TableHandle<BookRow>;
  let tblAsks!: TableHandle<BookRow>;
  let tblOut!: TableHandle<Recipe>;
  let tblIn!: TableHandle<Recipe>;
  let chart!: LineChart;

  // ---------------------------------------------------------------- cells
  const linkable = (x: string) => !!(st().snapshot?.products[x] || st().catalog?.items[x]);

  function itemLink(x: string): string {
    const name = nameOf(x);
    if (linkable(x)) return `<a href="#/item/${encodeURIComponent(x)}">${esc(name)}</a>`;
    return `<span title="${esc(x)}">${esc(name)}</span>`;
  }

  function inputsHtml(r: Recipe, highlight?: string): string {
    return r.inputs
      .map(
        (x) =>
          `<span class="item-rin${x.id === highlight ? ' is-self' : ''}"><span class="num">${esc(fmtQty(x.qty))}×</span> ${itemLink(x.id)}</span>`,
      )
      .join('');
  }

  function kindHtml(r: Recipe): string {
    let s = `<span class="badge item-kind-${r.kind}">${esc(t(r.kind === 'forge' ? 'kindForge' : 'kindCraft'))}</span>`;
    if (r.kind === 'forge' && r.durationSec) s += ` <span class="small muted">${esc(fmtHours(r.durationSec / 3600))}</span>`;
    if (r.req) s += `<span class="id-sub">${esc(t('req', { req: r.req.replace(/^requires:\s*/i, '') }))}</span>`;
    return s;
  }

  /** Craft tab link, plus a Books tab link when the output is an enchanted book. */
  const recipeLinks = (r: Recipe) =>
    (r.kind === 'forge'
      ? `<a class="btn btn-sm" href="#/forge?q=${encodeURIComponent(r.output)}" title="${esc(t('openForge'))}">${esc(t('openForgeShort'))} →</a>`
      : `<a class="btn btn-sm" href="#/craft?q=${encodeURIComponent(r.output)}" title="${esc(t('openCraft'))}">${esc(t('openCraftShort'))} →</a>`) +
    (isBookId(r.output)
      ? ` <a class="btn btn-sm" href="#/books?q=${encodeURIComponent(r.output)}" title="${esc(t('openBooksLong'))}">${esc(t('openBooks'))} →</a>`
      : '');

  // ---------------------------------------------------------------- tables
  function bookTable(): TableHandle<BookRow> {
    return createTable<BookRow>({
      rowKey: (r) => r.key,
      maxRows: BOOK_LEVELS,
      emptyText: () => t('bookEmpty'),
      columns: [
        { key: 'price', label: () => t('colPrice'), get: (r) => r.price, html: (r) => esc(fmtPrice(r.price)), align: 'right', sortable: false },
        { key: 'amount', label: () => t('colAmount'), get: (r) => r.amount, html: (r) => esc(fmtInt(r.amount)), align: 'right', sortable: false },
        { key: 'orders', label: () => t('colOrders'), get: (r) => r.orders, html: (r) => esc(fmtInt(r.orders)), align: 'right', sortable: false },
        { key: 'cumAmount', label: () => t('colCumAmount'), get: (r) => r.cumAmount, html: (r) => esc(fmtInt(r.cumAmount)), align: 'right', sortable: false },
        { key: 'cumCoins', label: () => t('colCumCoins'), get: (r) => r.cumCoins, html: (r) => esc(fmtCoins(r.cumCoins)), align: 'right', sortable: false },
      ],
    });
  }

  const kindCol = { key: 'kind', label: () => t('colKind'), get: (r: Recipe) => r.kind, html: kindHtml, cls: 'item-wrap' };
  const craftCol = { key: 'go', label: () => t('colCraft'), get: () => null, html: recipeLinks, align: 'right' as const, sortable: false };

  // ---------------------------------------------------------------- rendering
  function showMsg(html: string): void {
    msgEl.innerHTML = html;
    msgEl.hidden = false;
    mainEl.hidden = true;
    closeAlertForm();
  }

  function renderStatic(): void {
    backLink.textContent = t('back');
    backLink.title = t('backTitle');
    searchLabel.textContent = t('searchLabel');
    searchInput.placeholder = t('searchPh');
    actionsEl.setAttribute('aria-label', t('actionsAria'));
    alertBtn.textContent = t('addAlert');
    copyBtn.textContent = t('copyId');
    alertTitle.textContent = t('alertTitle');
    metricLabel.textContent = t('alertMetric');
    opLabel.textContent = t('alertOp');
    valueLabel.textContent = t('alertValue');
    for (const o of metricSel.options) o.textContent = ctx!.t(`alerts.m_${o.value}`);
    opSel.options[0]!.textContent = t('alertOpLt');
    opSel.options[1]!.textContent = t('alertOpGt');
    alertSave.textContent = t('alertSave');
    alertCancel.textContent = t('alertCancel');
    offNote.textContent = t('offBazaar');
    bookTitle.textContent = t('bookTitle');
    bidsTitle.textContent = t('bookBids');
    asksTitle.textContent = t('bookAsks');
    bookNote.textContent = t('bookNote');
    chartTitle.textContent = t('chartTitle');
    chartNote.textContent = t('chartNote');
    rangeSeg.setAttribute('aria-label', t('rangeAria'));
    for (const b of rangeSeg.querySelectorAll<HTMLButtonElement>('button')) {
      b.textContent = t(`range${b.dataset.range}`);
      b.setAttribute('aria-pressed', String(b.dataset.range === range));
    }
    chartLegend.innerHTML =
      `<span class="lc-key"><span class="lc-sw lc-bid"></span>${esc(t('chartBid'))}</span>` +
      `<span class="lc-key"><span class="lc-sw lc-ask"></span>${esc(t('chartAsk'))}</span>`;
    recOutTitle.textContent = t('recipesOutTitle');
    recInTitle.textContent = t('recipesInTitle');
  }

  function render(): void {
    if (!alive || !ctx) return;
    const s = st();
    if (!s.snapshot) {
      showMsg(`<div class="card"><h1 class="kit-sr">${esc(ctx.t('common.nav_item'))}</h1><p class="empty">${esc(t('loading'))}</p></div>`);
      return;
    }
    const p = s.snapshot.products[id] ?? null;
    const known = !!p || !!s.catalog?.items[id] || !!s.ah?.lowestBin[id] || !!s.ahSales?.byId[id];
    if (!known) {
      showMsg(`<div class="card"><h1>${esc(t('unknownTitle'))}</h1><p class="note">${esc(t('unknown', { id }))}</p></div>`);
      return;
    }
    msgEl.hidden = true;
    msgEl.replaceChildren();
    mainEl.hidden = false;
    offNote.hidden = !!p;
    bookSec.hidden = !p;
    chartSec.hidden = !p;
    if (!p) closeAlertForm();
    renderHead(p, s);
    renderFacts(p, s);
    if (p) {
      tblBids.setRows(bookRows(p.bids, 'b'));
      tblAsks.setRows(bookRows(p.asks, 'a'));
    }
    renderRecipes(s);
    if (alertForm && !alertForm.hidden) syncAlertHint();
  }

  function renderHead(p: Product | null, s: AppState): void {
    const info = s.catalog?.items[id];
    nameEl.textContent = nameOf(id);
    const tier = info?.tier
      ? `<span class="badge item-tier tier-${esc(info.tier.toLowerCase().replace(/[^a-z]+/g, '_'))}">${esc(info.tier.replace(/_/g, ' '))}</span>`
      : '';
    const cat = info?.category ? `<span class="badge item-cat" title="${esc(t('category'))}">${esc(info.category.replace(/_/g, ' '))}</span>` : '';
    badgesEl.innerHTML = tier + cat + (p ? riskBadge(assessRisk(p, ctx!.history.stats(id))) : '');
    idEl.textContent = id;
    renderActions(p, s);
  }

  function renderActions(p: Product | null, s: AppState): void {
    const on = ctx!.watch.has(id);
    watchBtn.textContent = on ? t('watchOn') : t('watchOff');
    watchBtn.title = on ? t('watchTitleOn') : t('watchTitleOff');
    watchBtn.setAttribute('aria-pressed', String(on));
    alertBtn.hidden = !p;
    alertBtn.setAttribute('aria-expanded', String(!!alertForm && !alertForm.hidden));
    const links: string[] = [];
    const link = (href: string, label: string) => `<a class="btn btn-sm btn-ghost" href="${esc(href)}">${esc(label)} →</a>`;
    const q = encodeURIComponent(id);
    if (p) links.push(link(`#/flip?q=${q}`, t('openFlip')));
    const made = s.catalog?.byOutput.get(id) ?? [];
    if (made.some((r) => r.kind === 'craft')) links.push(link(`#/craft?q=${q}`, t('openCraftShort')));
    if (made.some((r) => r.kind === 'forge')) links.push(link(`#/forge?q=${q}`, t('openForgeShort')));
    if (isBookId(id)) links.push(link(`#/books?q=${q}`, t('openBooks')));
    linksEl.innerHTML = links.length ? `<span class="small muted">${esc(t('openIn'))}</span> ${links.join(' ')}` : '';
    const n = s.alerts.filter((r) => r.id === id).length;
    alertCountEl.hidden = n === 0;
    alertCountEl.innerHTML = n ? `${esc(t('alertsHere', { n }))} · <a href="#/watch">${esc(t('manageAlerts'))}</a>` : '';
  }

  type KvRow = [label: string, valueHtml: string, cls?: string, key?: string];
  function kv(rows: KvRow[]): string {
    return `<dl class="kv">${rows
      .map(([k, v, cls, key]) => `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}${key ? ` data-k="${key}"` : ''}>${v}</dd>`)
      .join('')}</dl>`;
  }
  const card = (title: string, body: string, attrs = '', cls = '') =>
    `<section class="card item-card ${cls}"${attrs}><h2 class="item-card-h">${esc(title)}</h2>${body}</section>`;
  const note = (txt: string) => `<p class="note small">${esc(txt)}</p>`;

  function flipView(): FlipView | null {
    const c = ctx!.derived.calcCtx();
    if (!c) return null;
    const flips = ctx!.derived.flips();
    if (flipIndex?.src !== flips) flipIndex = { src: flips, map: new Map(flips.map((r) => [r.id, r])) };
    const row = flipIndex.map.get(id) ?? null;
    if (row) return { buy: row.buyAt, sell: row.sellAt, net: row.netSell, profit: row.profit, tp: row.tp, row };
    const plan = flipPlanFor(id, c);
    if (!plan) return null;
    return { buy: plan.buy.price, sell: plan.sell.price, net: plan.sell.net, profit: plan.profit, tp: plan.tp, row: null };
  }

  function yourFlipHtml(p: Product, s: AppState): string {
    const set = s.settings;
    const info = s.catalog?.items[id];
    const mode = t('modeLine', {
      buy: t(set.costMode === 'order' ? 'modeOrder' : 'modeInsta'),
      sell: t(set.sellMode === 'offer' ? 'modeOffer' : 'modeInstaSell'),
    });
    const head = `<p class="small muted item-mode" data-testid="flip-mode">${esc(mode)}</p>`;
    if (!s.catalog) return head + note(s.catalogError ? t('catalogError', { err: msgText(s.catalogError) }) : t('catalogLoading'));
    const f = flipView();
    if (!f) return head + `<p class="note">${esc(t('bookEmpty'))}</p>`;
    const margin = f.buy > 0 ? f.profit / f.buy : null;
    const tp = f.tp;
    const rows: KvRow[] = [
      [t(set.costMode === 'order' ? 'buyOrderAt' : 'buyInstaAt'), esc(fmtPrice(f.buy)), '', 'buy'],
      [t(set.sellMode === 'offer' ? 'sellOfferAt' : 'sellInstaAt'), esc(fmtPrice(f.sell)), '', 'sell'],
      [t('afterTax', { tax: fmtTax(set.taxRate) }), esc(fmtPrice(f.net)), '', 'net'],
      [t('flipProfit'), esc(fmtPrice(f.profit)), pctClass(f.profit), 'profit'],
      [t('flipMargin'), esc(fmtPct(margin)), pctClass(margin), 'margin'],
    ];
    if (f.row) {
      rows.push(
        [t('flipPph'), esc(fmtCoins(f.row.profitPerHour)), pctClass(f.row.profitPerHour), 'pph'],
        [t('flipUph'), esc(fmtQty(tp.unitsPerHour)), '', 'uph'],
        [t('flipBatch'), esc(fmtInt(tp.batchQty)), '', 'batch'],
        [t('buyHours'), esc(fin(tp.buyHours) ? fmtHours(tp.buyHours) : '—'), '', 'buyHours'],
        [t('sellHours'), esc(fin(tp.sellHours) ? fmtHours(tp.sellHours) : '—'), '', 'sellHours'],
        [t('flipSlots'), esc(fin(tp.slots) ? fmtInt(tp.slots) : '—'), '', 'slots'],
        [t('limitedBy'), esc(t(`lim_${tp.limitedBy}`)), '', 'limited'],
      );
    }
    let body = head + kv(rows);
    const cons = consListHtml(f.row?.cons, { buy: f.buy, sell: f.sell });
    if (cons) body += `<div class="item-cons" data-testid="item-cons"><h3 class="item-sub">${esc(t('risk.consTitle'))}</h3>${cons}</div>`;
    if (!f.row) body += `<p class="note small" data-testid="not-on-flip">${esc(t('notOnFlipTab'))}</p>`;
    if (set.costMode === 'order') {
      const q = buyQuote(p, 'order', undefined, info?.npcSell);
      if (q?.clamped === 'npcFloor') {
        body += `<p class="banner banner-warn small" data-testid="npc-floor">${esc(
          t('npcFloorApplied', { npc: fmtPrice(info?.npcSell), bid: fmtPrice(p.bid) }),
        )}</p>`;
      } else if (q?.clamped === 'ask') {
        body += `<p class="banner banner-info small" data-testid="ask-capped">${esc(t('askCapped', { ask: fmtPrice(p.ask) }))}</p>`;
      }
    }
    const insta = set.costMode === 'insta' || set.sellMode === 'insta';
    body += note(t('common.twoSentences', { a: t(insta ? 'yourNoteInsta' : 'yourNoteOrder'), b: t('yourNoteTax') }));
    return body;
  }

  function statsHtml(): string {
    const m = ctx!.derived.marketStats().get(id);
    if (!m || m.n === 0) return note(t('statsNone'));
    const pct = (x: number | null) => esc(fmtPct(x));
    return (
      kv([
        [t('change1h'), esc(fmtSignedPct(m.change1h)), pctClass(m.change1h), 'change1h'],
        [t('change24h'), esc(fmtSignedPct(m.change24h)), pctClass(m.change24h), 'change24h'],
        [t('volatility'), pct(m.volatility), '', 'volatility'],
        [t('spreadMedian'), pct(m.spreadMedian), '', 'spreadMedian'],
        [t('consistency'), pct(m.consistency), '', 'consistency'],
        [t('buyVolTrend'), esc(fmtTrend(m.buyVolTrend)), '', 'buyVolTrend'],
        [t('sellVolTrend'), esc(fmtTrend(m.sellVolTrend)), '', 'sellVolTrend'],
      ]) + note(t('statsLine', { points: t('statsPoints', { n: m.n }), note: t('statsNote') }))
    );
  }

  function ahHtml(s: AppState): string | null {
    const ah = s.ah;
    const a = ah?.lowestBin[id];
    if (!ah || !a) return null;
    const derpy = isDerpy(s.election);
    const rows: KvRow[] = [
      [t('ahLowest'), esc(fmtPrice(a.price)), '', 'ahPrice'],
      [t('ahCount'), esc(fmtInt(a.count)), '', 'ahCount'],
      [
        t('ahNet'),
        `<span title="${esc(t('ahNetTitle', { fee: fmtPrice(ahListingFee(a.price)), tax: fmtPrice(ahClaimTax(a.price, derpy)) }))}">${esc(fmtPrice(ahNet(a.price, derpy)))}</span>`,
        '',
        'ahNet',
      ],
      [t('ahAge'), esc(t('ahAgeVal', { age: fmtAge(Date.now() - ah.fetchedAt) })), '', 'ahAge'],
    ];
    const partial = ah.failedPages?.length ? note(t('ahPartial', { n: ah.failedPages.length })) : '';
    return kv(rows) + partial + (derpy ? note(t('ahDerpy')) : '') + note(t('ahCaveat'));
  }

  /**
   * Realized AH sales of this id (auctions_ended feed): median sold price, count, sales per hour (only once the feed
   * has covered AH_SALES.minCoverageHours) and coverage. null without the feed, or when the id has neither sales
   * nor AH listings.
   */
  function salesHtml(s: AppState): string | null {
    const sales = s.ahSales;
    if (!sales) return null;
    const a = sales.byId[id];
    if (!a) return s.ah?.lowestBin[id] ? note(t('salesNone', { h: fmtNum(sales.coverageHours, 1) })) : null;
    const min = AH_SALES.minCoverageHours;
    const rate =
      a.perHour != null && a.coverageHours >= min
        ? esc(t('salesPerHourVal', { n: fmtNum(a.perHour, 2) }))
        : `<span class="muted">${esc(t('salesPerHourLow', { h: fmtNum(a.coverageHours, 1), min }))}</span>`;
    const rows: KvRow[] = [
      [t('salesMedian'), esc(fmtPrice(a.median)), '', 'salesMedian'],
      [t('salesCount'), esc(t('salesCountVal', { n: fmtInt(a.n), items: fmtInt(a.items) })), '', 'salesCount'],
      [t('salesPerHour'), rate, '', 'salesPerHour'],
      [t('salesCoverage'), esc(t('salesCoverageVal', { h: fmtNum(a.coverageHours, 1) })), '', 'salesCoverage'],
      [t('salesLast'), esc(t('ahAgeVal', { age: fmtAge(Date.now() - a.last) })), '', 'salesLast'],
    ];
    let out = kv(rows);
    if (a.n < AH_SALES.minSales) out += note(t('salesFew', { min: AH_SALES.minSales }));
    if (!s.settings.ahEnabled) out += note(t('salesOff'));
    return out + note(t('salesCaveat'));
  }

  function shardHtml(s: AppState): string | null {
    const sh = s.catalog?.items[id]?.shard;
    if (!sh) return null;
    return kv([
      [t('shardRarity'), esc(sh.rarity || '—'), '', 'shardRarity'],
      [t('shardFamily'), esc(sh.family.length ? fmtList(sh.family, 'tags') : '—'), '', 'shardFamily'],
      [t('shardAlignment'), esc(sh.alignment ?? '—'), '', 'shardAlignment'],
    ]);
  }

  function npcHtml(s: AppState): string {
    const info = s.catalog?.items[id];
    if (!s.catalog) return `<p class="note">${esc(s.catalogError ? t('catalogError', { err: msgText(s.catalogError) }) : t('catalogLoading'))}</p>`;
    if (info?.npcSell == null && info?.npcBuy == null) return `<p class="note">${esc(t('npcNone'))}</p>`;
    return kv([
      [t('npcSell'), esc(fmtPrice(info?.npcSell))],
      [t('npcBuy'), esc(fmtPrice(info?.npcBuy))],
    ]);
  }

  function marketHtml(p: Product): string {
    const { bid, ask } = p;
    const spread = bid != null && ask != null ? ask - bid : null;
    const spreadPct = spread != null && bid! > 0 ? spread / bid! : null;
    const change = ctx!.history.stats(id)?.change24h ?? null;
    return kv([
      [t('bid'), esc(fmtPrice(bid))],
      [t('ask'), esc(fmtPrice(ask))],
      [t('spread'), esc(fmtPrice(spread))],
      [t('spreadPct'), esc(fmtPct(spreadPct))],
      [t('change24h'), change == null ? `<span class="muted">${esc(t('change24hNone'))}</span>` : esc(fmtSignedPct(change)), pctClass(change)],
    ]);
  }

  function volumeHtml(p: Product): string {
    const q = p.quick;
    return (
      kv([
        [t('instaBuysWeek'), esc(fmtInt(p.instaBuysWeek))],
        [t('instaSellsWeek'), esc(fmtInt(p.instaSellsWeek))],
        [t('buyOrderCount'), esc(fmtInt(q.sellOrders))],
        [t('sellOfferCount'), esc(fmtInt(q.buyOrders))],
        [t('buyOrderUnits'), esc(fmtInt(q.sellVolume))],
        [t('sellOfferUnits'), esc(fmtInt(q.buyVolume))],
      ]) + note(t('volumeNote'))
    );
  }

  function quickHtml(p: Product): string {
    const { bid, ask, quick: q } = p;
    const diff = (avg: number, top: number | null) => (top != null && top > 0 && avg > 0 ? (avg - top) / top : null);
    const row = (label: string, top: number | null, avg: number) =>
      `<tr><td>${esc(label)}</td><td class="num">${esc(fmtPrice(top))}</td><td class="num">${esc(fmtPrice(avg || null))}</td><td class="num">${esc(
        fmtSignedPct(diff(avg, top)),
      )}</td></tr>`;
    return (
      `<div class="item-quick"><table class="tbl-plain"><thead><tr><th>${esc(t('quickSide'))}</th><th class="num">${esc(
        t('quickBook'),
      )}</th><th class="num">${esc(t('quickAvg'))}</th><th class="num">${esc(t('quickDiff'))}</th></tr></thead><tbody>` +
      row(t('quickInstaBuy'), ask, q.buyPrice) +
      row(t('quickInstaSell'), bid, q.sellPrice) +
      `</tbody></table></div>` +
      note(t('quickNote'))
    );
  }

  function riskHtml(p: Product): string {
    const risk = assessRisk(p, ctx!.history.stats(id));
    const flags = risk.flags.length
      ? `<ul class="item-flags">${risk.flags
          .map((f) => `<li><span class="mono small muted">${esc(f)}</span> ${esc(riskFlagText(f))}</li>`)
          .join('')}</ul>`
      : `<p class="note">${esc(t('riskNone'))}</p>`;
    return `<p class="item-risk-head">${riskBadge(risk)} <span class="small muted">${esc(t('riskScore', { n: risk.score }))}</span></p>${flags}${riskScopeHtml('item')}`;
  }

  function renderFacts(p: Product | null, s: AppState): void {
    const parts: string[] = [];
    if (p) {
      parts.push(
        card(t('marketTitle'), marketHtml(p)),
        card(t('yourTitle'), yourFlipHtml(p, s), ' data-testid="item-flip"', 'item-flip-card'),
        card(t('statsTitle'), statsHtml(), ' data-testid="item-stats"'),
      );
    }
    const ah = ahHtml(s);
    if (ah) parts.push(card(t('ahTitle'), ah, ' data-testid="item-ah"'));
    const sales = salesHtml(s);
    if (sales) parts.push(card(t('salesTitle'), sales, ' data-testid="item-ah-sales"'));
    const shard = shardHtml(s);
    if (shard) parts.push(card(t('shardTitle'), shard, ' data-testid="item-shard"'));
    if (p) {
      parts.push(
        card(t('riskTitle'), riskHtml(p), ' data-testid="item-risk"', 'item-risk'),
        card(t('volumeTitle'), volumeHtml(p)),
        card(t('quickTitle'), quickHtml(p), '', 'item-quick-card'),
      );
    }
    parts.push(card(t('npcTitle'), npcHtml(s)));
    factsEl.innerHTML = parts.join('');
  }

  function renderRecipes(s: AppState): void {
    const cat = s.catalog;
    if (!cat) {
      const txt = s.catalogError ? t('catalogError', { err: msgText(s.catalogError) }) : t('catalogLoading');
      for (const [tbl, msg] of [
        [tblOut, recOutMsg],
        [tblIn, recInMsg],
      ] as const) {
        tbl.el.hidden = true;
        msg.textContent = txt;
        msg.hidden = false;
      }
      return;
    }
    const out = cat.byOutput.get(id) ?? [];
    tblOut.el.hidden = false;
    recOutMsg.hidden = true;
    tblOut.setRows(out);

    const snap = s.snapshot;
    const all = [...(cat.byInput.get(id) ?? [])].sort((a, b) => {
      const ba = snap?.products[a.output] ? 0 : 1;
      const bb = snap?.products[b.output] ? 0 : 1;
      return ba - bb || nameOf(a.output).localeCompare(nameOf(b.output));
    });
    tblIn.el.hidden = false;
    tblIn.setRows(all.slice(0, USING_LIMIT));
    recInMsg.hidden = all.length <= USING_LIMIT;
    recInMsg.textContent = all.length > USING_LIMIT ? t('recipesInMore', { n: USING_LIMIT, m: all.length }) : '';
  }

  // ---------------------------------------------------------------- quick alert
  /** Current value of the selected metric (same numbers the alert runner will compare against). */
  function currentMetric(): number | null {
    const m = metricSel.value as AlertMetric;
    const c = ctx!.derived.calcCtx();
    if (c) return metricValue(m, id, c);
    // without a catalog only the book metrics can be read
    const p = st().snapshot?.products[id];
    if (!p) return null;
    if (m === 'ask') return p.ask;
    if (m === 'bid') return p.bid;
    if (m === 'spreadPct') return p.ask != null && p.bid != null && p.bid > 0 ? (p.ask - p.bid) / p.bid : null;
    return null;
  }

  const fmtMetric = (m: string, v: number) => (PCT_METRICS.has(m) ? fmtPct(v, 2) : fmtPrice(v));

  function syncAlertHint(): void {
    const v = currentMetric();
    const m = metricSel.value;
    const pctHint = PCT_METRICS.has(m) ? ` (${t('alertPctHint')})` : '';
    valueHint.textContent = (v == null ? t('alertNowNone') : t('alertNow', { v: fmtMetric(m, v) })) + pctHint;
  }

  function prefillAlert(): void {
    const v = currentMetric();
    valueInput.value = v == null ? '' : String(alertPrefill(metricSel.value, opSel.value as 'lt' | 'gt', v));
    valueInput.removeAttribute('aria-invalid');
    syncAlertHint();
  }

  function openAlertForm(): void {
    if (!alertForm) return;
    alertForm.hidden = false;
    alertBtn.setAttribute('aria-expanded', 'true');
    prefillAlert();
    metricSel.focus();
  }

  function closeAlertForm(focusBtn = false): void {
    if (!alertForm || alertForm.hidden) return;
    alertForm.hidden = true;
    alertBtn.setAttribute('aria-expanded', 'false');
    if (focusBtn) alertBtn.focus();
  }

  function saveAlert(): void {
    const n = parseNumberInput(valueInput.value);
    if (n == null) {
      valueInput.setAttribute('aria-invalid', 'true');
      valueHint.textContent = t('alertInvalid');
      valueInput.focus();
      return;
    }
    const metric = metricSel.value as AlertMetric;
    const op = opSel.value as 'lt' | 'gt';
    const value = alertValueFromInput(metric, n);
    const rule: AlertRule = {
      key: `${id}|${metric}|${op}|${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      id,
      metric,
      op,
      value,
      enabled: true,
      cooldownMin: ALERTS.defaultCooldownMin,
    };
    ctx!.store.set((s) => ({ alerts: [...s.alerts, rule] }));
    ctx!.toast(
      t('alertAdded', { name: nameOf(id), metric: ctx!.t(`alerts.m_${metric}`), op: ctx!.t(`alerts.op_${op}`), v: fmtMetric(metric, value) }),
      'ok',
    );
    closeAlertForm(true);
  }

  async function copyId(): Promise<void> {
    const c = ctx;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(id);
      c?.toast(c.t('common.copied'), 'ok');
    } catch {
      c?.toast(c.t('item.copyFail'), 'err');
    }
  }

  // ---------------------------------------------------------------- chart
  function chartData(emptyKey: 'chartEmpty' | 'chartLoading'): ChartData {
    const pts = pointsFor === `${id}|${range}` ? points : [];
    return {
      ts: pts.map((p) => p.ts),
      lines: [
        { key: 'bid', label: t('chartBid'), cls: 'lc-bid', values: pts.map((p) => p.bid) },
        { key: 'ask', label: t('chartAsk'), cls: 'lc-ask', values: pts.map((p) => p.ask) },
      ],
      emptyText: t(emptyKey),
      ariaLabel: t('chartAria', { name: nameOf(id), range: t(`range${range}`), points: t('chartPoints', { n: pts.length }) }),
      fmtY: fmtPrice,
      fmtX: fmtTick,
      fmtTip: fmtStamp,
    };
  }

  function drawChart(): void {
    if (!alive) return;
    const loading = pointsFor !== `${id}|${range}`;
    chart.set(chartData(loading ? 'chartLoading' : 'chartEmpty'));
  }

  async function loadSeries(): Promise<void> {
    if (!alive || !ctx || !id) return;
    const token = ++seriesToken;
    const want = `${id}|${range}`;
    if (pointsFor !== want) drawChart();
    let pts: HistoryPoint[];
    try {
      pts = await ctx.history.series(id, range);
    } catch {
      pts = [];
    }
    if (!alive || token !== seriesToken) return;
    points = [...pts].sort((a, b) => a.ts - b.ts);
    pointsFor = want;
    drawChart();
  }

  function setRange(r: HistoryRange): void {
    if (r === range) return;
    range = r;
    lsSet(PREFS_KEY, { range });
    renderStatic();
    void loadSeries();
  }

  // ---------------------------------------------------------------- search
  let suggIds: string[] = [];
  let active = -1;

  function closeSugg(): void {
    suggList.hidden = true;
    suggList.innerHTML = '';
    suggIds = [];
    active = -1;
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
  }

  function renderSugg(): void {
    const q = searchInput.value;
    if (!q.trim()) return closeSugg();
    const s = st();
    suggIds = searchProducts(s.snapshot, s.catalog, q);
    if (active >= suggIds.length) active = suggIds.length - 1;
    suggList.innerHTML = suggIds.length
      ? suggIds
          .map(
            (x, i) =>
              `<li role="option" id="item-sugg-${i}" aria-selected="${i === active}"><a href="#/item/${encodeURIComponent(x)}" tabindex="-1">${itemCell(x, nameOf(x))}</a></li>`,
          )
          .join('')
      : `<li class="item-sugg-none">${esc(t('searchNone'))}</li>`;
    suggList.hidden = false;
    searchInput.setAttribute('aria-expanded', 'true');
    if (active >= 0) searchInput.setAttribute('aria-activedescendant', `item-sugg-${active}`);
    else searchInput.removeAttribute('aria-activedescendant');
  }

  function go(x: string): void {
    searchInput.value = '';
    closeSugg();
    ctx!.navigate({ id: 'item', param: x });
  }

  function onSearchKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!suggIds.length) return;
      ev.preventDefault();
      const n = suggIds.length;
      active = ev.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n;
      renderSugg();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const s = st();
      const ids = s.snapshot ? new Set(Object.keys(s.snapshot.products)) : undefined;
      const exact = s.catalog ? resolveUserInput(s.catalog, searchInput.value, ids) : null;
      const pick = active >= 0 ? suggIds[active] : (exact ?? suggIds[0]);
      if (!pick && s.snapshot) {
        const up = searchInput.value.trim().toUpperCase();
        if (s.snapshot.products[up]) return go(up);
      }
      if (pick) go(pick);
    } else if (ev.key === 'Escape') {
      closeSugg();
    }
  }

  // ---------------------------------------------------------------- build
  function buildAlertForm(): HTMLFormElement {
    alertTitle = h('h2', { class: 'item-card-h' });
    metricLabel = h('span', { class: 'field-label' });
    metricSel = h('select', { 'data-testid': 'alert-metric' });
    for (const m of METRICS) metricSel.append(h('option', { value: m }));
    opLabel = h('span', { class: 'field-label' });
    opSel = h('select', { 'data-testid': 'alert-op' }, h('option', { value: 'lt' }), h('option', { value: 'gt' }));
    valueLabel = h('span', { class: 'field-label' });
    valueInput = h('input', {
      type: 'text',
      inputmode: 'decimal',
      autocomplete: 'off',
      'data-testid': 'alert-value',
      'aria-describedby': 'item-alert-hint',
    });
    valueHint = h('span', { class: 'field-help', id: 'item-alert-hint', 'aria-live': 'polite' });
    alertSave = h('button', { type: 'submit', class: 'btn btn-sm btn-primary', 'data-testid': 'alert-save' });
    alertCancel = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' });
    alertCancel.addEventListener('click', () => closeAlertForm(true));
    metricSel.addEventListener('change', prefillAlert);
    opSel.addEventListener('change', prefillAlert);
    const form = h(
      'form',
      { class: 'card item-alert-form', id: 'item-alert-form', hidden: true, 'data-testid': 'item-alert-form', novalidate: true },
      alertTitle,
      h(
        'div',
        { class: 'item-alert-fields' },
        h('label', { class: 'field' }, metricLabel, metricSel),
        h('label', { class: 'field' }, opLabel, opSel),
        h('label', { class: 'field' }, valueLabel, valueInput, valueHint),
        h('div', { class: 'item-alert-btns' }, alertSave, alertCancel),
      ),
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      saveAlert();
    });
    form.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeAlertForm(true);
      }
    });
    return form;
  }

  function buildHead(): HTMLElement {
    nameEl = h('h1', { class: 'item-name', 'data-testid': 'item-name' });
    badgesEl = h('div', { class: 'item-badges' });
    idEl = h('span', { class: 'id-sub item-id' });
    watchBtn = h('button', { type: 'button', class: 'btn btn-sm item-watch', 'data-testid': 'item-watch', 'aria-pressed': 'false' });
    watchBtn.addEventListener('click', () => ctx?.watch.toggle(id));
    alertBtn = h('button', {
      type: 'button',
      class: 'btn btn-sm',
      'data-testid': 'item-alert-btn',
      'aria-expanded': 'false',
      'aria-controls': 'item-alert-form',
    });
    alertBtn.addEventListener('click', () => (alertForm?.hidden ? openAlertForm() : closeAlertForm()));
    copyBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-testid': 'item-copy' });
    copyBtn.addEventListener('click', () => void copyId());
    linksEl = h('span', { class: 'item-links' });
    actionsEl = h('div', { class: 'item-actions', role: 'group' }, watchBtn, alertBtn, copyBtn, linksEl);
    alertCountEl = h('p', { class: 'small muted item-alert-count', hidden: true });
    return h('header', { class: 'item-head' }, h('div', { class: 'item-title' }, nameEl, badgesEl), idEl, actionsEl, alertCountEl);
  }

  function build(el: HTMLElement): void {
    backLink = h('a', { class: 'btn btn-ghost btn-sm item-back', href: '#/flip', 'data-testid': 'item-back' });
    backLink.addEventListener('click', (ev) => {
      const ref = document.referrer;
      let sameSite = !ref;
      try {
        sameSite ||= new URL(ref).origin === location.origin;
      } catch {
        /* bad referrer */
      }
      if (window.history.length > 1 && sameSite) {
        ev.preventDefault();
        window.history.back();
      }
    });

    searchLabel = h('span', { class: 'field-label' });
    searchInput = h('input', {
      type: 'search',
      autocomplete: 'off',
      spellcheck: 'false',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': 'item-sugg',
      'data-testid': 'item-search',
    });
    suggList = h('ul', { class: 'item-sugg', id: 'item-sugg', role: 'listbox', hidden: true });
    suggList.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus so the click lands
    suggList.addEventListener('click', (ev) => {
      const a = (ev.target as Element).closest?.('a');
      if (!a) return;
      ev.preventDefault();
      const i = [...suggList.querySelectorAll('a')].indexOf(a as HTMLAnchorElement);
      const x = suggIds[i];
      if (x) go(x);
    });
    searchInput.addEventListener('input', () => {
      active = -1;
      renderSugg();
    });
    searchInput.addEventListener('keydown', onSearchKey);
    searchInput.addEventListener('focus', renderSugg);
    searchInput.addEventListener('blur', closeSugg);
    const searchBox = h('label', { class: 'field item-search' }, searchLabel, h('div', { class: 'item-search-box' }, searchInput, suggList));

    msgEl = h('div', { class: 'item-msg', hidden: true });
    const head = buildHead();
    alertForm = buildAlertForm();
    offNote = h('p', { class: 'banner banner-info small', hidden: true, 'data-testid': 'off-bazaar' });
    factsEl = h('div', { class: 'item-facts' });

    tblBids = bookTable();
    tblAsks = bookTable();
    bookTitle = h('h2', { class: 'item-card-h' });
    bidsTitle = h('h3', { class: 'item-side item-side-bid' });
    asksTitle = h('h3', { class: 'item-side item-side-ask' });
    bookNote = h('p', { class: 'note small' });
    bookSec = h(
      'section',
      { class: 'card item-card item-book', 'data-testid': 'order-book' },
      bookTitle,
      h('div', { class: 'item-book-grid' }, h('div', null, bidsTitle, tblBids.el), h('div', null, asksTitle, tblAsks.el)),
      bookNote,
    );

    chart = createLineChart();
    chartTitle = h('h2', { class: 'item-card-h' });
    chartLegend = h('div', { class: 'lc-legend' });
    chartNote = h('p', { class: 'note small' });
    rangeSeg = h('div', { class: 'seg', role: 'group' });
    for (const r of RANGES) {
      rangeSeg.append(
        h('button', { type: 'button', 'data-range': r, 'aria-pressed': String(r === range), onclick: () => setRange(r) }),
      );
    }
    chartSec = h(
      'section',
      { class: 'card item-card item-chart' },
      h('div', { class: 'item-chart-head' }, chartTitle, chartLegend, rangeSeg),
      h('div', { class: 'item-chart-box', 'data-testid': 'price-chart' }, chart.el),
      chartNote,
    );

    tblOut = createTable<Recipe>({
      rowKey: (r) => r.key,
      emptyText: () => t('recipesNoneOut'),
      columns: [
        { key: 'inputs', label: () => t('colInputs'), get: (r) => r.inputs.length, html: (r) => inputsHtml(r), cls: 'item-wrap', sortable: false },
        { key: 'out', label: () => t('colOutput'), get: (r) => r.outCount, html: (r) => `${esc(fmtQty(r.outCount))}×`, align: 'right' },
        kindCol,
        craftCol,
      ],
    });
    tblIn = createTable<Recipe>({
      rowKey: (r) => r.key,
      emptyText: () => t('recipesNoneIn'),
      columns: [
        { key: 'output', label: () => t('colOutput'), get: (r) => nameOf(r.output), html: (r) => outputCell(r), cls: 'name-cell' },
        {
          key: 'uses',
          label: () => t('colUses'),
          get: (r) => r.inputs.find((x) => x.id === id)?.qty ?? null,
          html: (r) => `${esc(fmtQty(r.inputs.find((x) => x.id === id)?.qty ?? 0))}×`,
          align: 'right',
        },
        { key: 'inputs', label: () => t('colInputs'), get: (r) => r.inputs.length, html: (r) => inputsHtml(r, id), cls: 'item-wrap', sortable: false },
        kindCol,
        craftCol,
      ],
    });
    recOutTitle = h('h2', { class: 'item-card-h' });
    recOutMsg = h('p', { class: 'note', hidden: true });
    recInTitle = h('h2', { class: 'item-card-h' });
    recInMsg = h('p', { class: 'note small', hidden: true });
    const recipes = h(
      'div',
      { class: 'item-recipes' },
      h('section', { class: 'card item-card', 'data-testid': 'recipes-out' }, recOutTitle, recOutMsg, tblOut.el),
      h('section', { class: 'card item-card', 'data-testid': 'recipes-in' }, recInTitle, tblIn.el, recInMsg),
    );

    mainEl = h('div', { class: 'item-main', hidden: true }, head, alertForm, offNote, factsEl, bookSec, chartSec, recipes);
    const view = h('div', { class: 'item-view', 'data-testid': 'item-view' }, h('div', { class: 'item-top' }, backLink, searchBox), msgEl, mainEl);
    el.append(view);
    root = view;
  }

  function outputCell(r: Recipe): string {
    const count = r.outCount !== 1 ? ` <span class="muted small">×${esc(fmtQty(r.outCount))}</span>` : '';
    return itemCell(r.output, nameOf(r.output), linkable(r.output)).replace('</a>', `</a>${count}`);
  }

  const schedule = rafDebounce(render);

  return {
    id: 'item',
    mount(el, c, route) {
      ctx = c;
      alive = true;
      id = route.param ?? '';
      const pref = lsGet<{ range?: string }>(PREFS_KEY, {});
      if (RANGES.includes(pref?.range as HistoryRange)) range = pref.range as HistoryRange;
      build(el);
      renderStatic();
      drawChart(); // always an <svg> in the chart box, even before data arrives
      render();
      void loadSeries();

      cleanups.push(
        c.store.subscribe((s, prev) => {
          if (
            s.snapshot !== prev.snapshot ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.settings !== prev.settings ||
            s.ah !== prev.ah ||
            s.ahSales !== prev.ahSales ||
            s.watchlist !== prev.watchlist ||
            s.alerts !== prev.alerts
          ) {
            schedule();
          }
          if (s.historyTick !== prev.historyTick) {
            schedule(); // stats (24h change, spike flag, market stats) changed
            void loadSeries();
          }
        }),
        onLangChange(() => {
          renderStatic();
          tblBids.refresh();
          tblAsks.refresh();
          tblOut.refresh();
          tblIn.refresh();
          render();
          drawChart();
          if (!suggList.hidden) renderSugg();
        }),
      );
    },
    update(route: Route) {
      const next = route.param ?? '';
      if (next === id) return;
      id = next;
      searchInput.value = '';
      closeSugg();
      closeAlertForm();
      render();
      void loadSeries();
      window.scrollTo?.(0, 0);
    },
    unmount() {
      alive = false;
      seriesToken++;
      for (const fn of cleanups.splice(0)) fn();
      tblBids?.destroy();
      tblAsks?.destroy();
      tblOut?.destroy();
      tblIn?.destroy();
      chart?.destroy();
      root?.remove();
      root = null;
      ctx = null;
      alertForm = null;
      flipIndex = null;
    },
  };
}
