// Item detail view: #/item/<bazaar id>. Key facts, risk, top-10 order book, price history chart, recipes.
import { LS_VIEWPREFS, PRICE_TICK } from '../../../config.ts';
import { afterTax, buyQuote, round1, sellQuote } from '../../../domain/pricing.ts';
import { assessRisk } from '../../../domain/risk.ts';
import { matchesQuery, resolveUserInput, searchItems } from '../../../domain/search.ts';
import { deriveName } from '../../../domain/ids.ts';
import { onLangChange } from '../../../i18n/index.ts';
import { lsGet, lsSet } from '../../../storage/local.ts';
import type {
  AppState,
  Catalog,
  HistoryPoint,
  HistoryRange,
  OrderLevel,
  Product,
  Recipe,
  Route,
  Snapshot,
  View,
  ViewContext,
} from '../../../types/contracts.ts';
import { itemCell, riskBadge, riskFlagText } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtHours, fmtInt, fmtPct } from '../../format.ts';
import { createTable, type TableHandle } from '../../table.ts';
import { fmtPrice, fmtQty, fmtSignedPct, fmtStamp, fmtTick } from './helpers.ts';
import { createLineChart, type ChartData, type LineChart } from './lineChart.ts';
import './i18n.ts';
import './item.css';

const BOOK_LEVELS = 10;
const USING_LIMIT = 20;
const SUGGEST_LIMIT = 8;
const RANGES: HistoryRange[] = ['3h', '24h', '7d'];
const PREFS_KEY = LS_VIEWPREFS + 'item';

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

const pctClass = (x: number | null | undefined) => (x == null || !Number.isFinite(x) || x === 0 ? '' : x > 0 ? 'pos' : 'neg');

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

  const t = (k: string, p?: Record<string, string | number>) => ctx!.t(`item.${k}`, p);
  const st = (): AppState => ctx!.store.get();
  const nameOf = (x: string) => st().catalog?.name(x) ?? deriveName(x);

  // ---- persistent pieces (built in mount)
  let msgEl!: HTMLElement;
  let mainEl!: HTMLElement;
  let headEl!: HTMLElement;
  let factsEl!: HTMLElement;
  let riskEl!: HTMLElement;
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
  function itemLink(x: string): string {
    const name = nameOf(x);
    if (st().snapshot?.products[x]) return `<a href="#/item/${encodeURIComponent(x)}">${esc(name)}</a>`;
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
    if (r.req) s += `<span class="id-sub">${esc(r.req)}</span>`;
    return s;
  }

  const craftLink = (r: Recipe) =>
    `<a class="btn btn-sm" href="#/craft?q=${encodeURIComponent(r.output)}">${esc(t('openCraft'))} →</a>`;

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
  const craftCol = { key: 'go', label: () => t('colCraft'), get: () => null, html: craftLink, align: 'right' as const, sortable: false };

  // ---------------------------------------------------------------- rendering
  function showMsg(html: string): void {
    msgEl.innerHTML = html;
    msgEl.hidden = false;
    mainEl.hidden = true;
  }

  function renderStatic(): void {
    backLink.textContent = t('back');
    backLink.title = t('backTitle');
    searchLabel.textContent = t('searchLabel');
    searchInput.placeholder = t('searchPh');
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
      showMsg(`<div class="card"><p class="empty">${esc(t('loading'))}</p></div>`);
      return;
    }
    const p = s.snapshot.products[id];
    if (!p) {
      showMsg(
        `<div class="card"><h2>${esc(t('unknownTitle'))}</h2><p class="note">${esc(t('unknown', { id }))}</p></div>`,
      );
      return;
    }
    msgEl.hidden = true;
    mainEl.hidden = false;
    renderHead(p, s);
    renderFacts(p, s);
    tblBids.setRows(bookRows(p.bids, 'b'));
    tblAsks.setRows(bookRows(p.asks, 'a'));
    renderRecipes(s);
  }

  function renderHead(p: Product, s: AppState): void {
    const info = s.catalog?.items[id];
    const risk = assessRisk(p, ctx!.history.stats(id));
    const tier = info?.tier
      ? `<span class="badge item-tier tier-${esc(info.tier.toLowerCase().replace(/[^a-z]+/g, '_'))}">${esc(info.tier.replace(/_/g, ' '))}</span>`
      : '';
    headEl.innerHTML =
      `<h2 data-testid="item-name">${esc(nameOf(id))}</h2>` +
      `<div class="item-badges">${tier}${riskBadge(risk)}</div>` +
      `<span class="id-sub">${esc(id)}</span>`;

    const flags = risk.flags.length
      ? `<ul class="item-flags">${risk.flags
          .map((f) => `<li><span class="mono small muted">${esc(f)}</span> ${esc(riskFlagText(f))}</li>`)
          .join('')}</ul>`
      : `<p class="note">${esc(t('riskNone'))}</p>`;
    riskEl.innerHTML =
      `<h3>${esc(t('riskTitle'))} ${riskBadge(risk)} <span class="small muted">${esc(t('riskScore', { n: risk.score }))}</span></h3>` +
      flags;
  }

  function kv(rows: [string, string, string?][]): string {
    return `<dl class="kv">${rows.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('')}</dl>`;
  }

  function renderFacts(p: Product, s: AppState): void {
    const info = s.catalog?.items[id];
    const { bid, ask } = p;
    const spread = bid != null && ask != null ? ask - bid : null;
    const spreadPct = spread != null && bid! > 0 ? spread / bid! : null;
    const change = ctx!.history.stats(id)?.change24h ?? null;

    const market = kv([
      [t('bid'), esc(fmtPrice(bid))],
      [t('ask'), esc(fmtPrice(ask))],
      [t('spread'), esc(fmtPrice(spread))],
      [t('spreadPct'), esc(fmtPct(spreadPct))],
      [t('change24h'), change == null ? `<span class="muted">${esc(t('change24hNone'))}</span>` : esc(fmtSignedPct(change)), pctClass(change)],
    ]);

    const tax = s.settings.taxRate;
    const bq = buyQuote(p, 'order', undefined, info?.npcSell);
    const sq = sellQuote(p, 'offer');
    const net = sq ? afterTax(sq.price, tax) : null;
    const profit = bq && net != null ? net - bq.price : null;
    const margin = profit != null && bq!.price > 0 ? profit / bq!.price : null;
    const floored = bq != null && bid != null && bq.price > round1(bid + PRICE_TICK);
    const yours =
      kv([
        [t('buyOrderAt'), esc(fmtPrice(bq?.price))],
        [t('sellOfferAt'), esc(fmtPrice(sq?.price))],
        [t('afterTax', { tax: fmtTax(tax) }), esc(fmtPrice(net))],
        [t('flipProfit'), esc(fmtPrice(profit)), pctClass(profit)],
        [t('flipMargin'), esc(fmtPct(margin)), pctClass(margin)],
      ]) +
      (floored
        ? `<p class="banner banner-warn small" data-testid="npc-floor">${esc(
            t('npcFloorApplied', { npc: fmtPrice(info?.npcSell), bid: fmtPrice(bid) }),
          )}</p>`
        : '') +
      `<p class="note small">${esc(t('yourNote'))}</p>`;

    const q = p.quick;
    const volume =
      kv([
        [t('instaBuysWeek'), esc(fmtInt(p.instaBuysWeek))],
        [t('instaSellsWeek'), esc(fmtInt(p.instaSellsWeek))],
        [t('buyOrderCount'), esc(fmtInt(q.sellOrders))],
        [t('sellOfferCount'), esc(fmtInt(q.buyOrders))],
        [t('buyOrderUnits'), esc(fmtInt(q.sellVolume))],
        [t('sellOfferUnits'), esc(fmtInt(q.buyVolume))],
      ]) + `<p class="note small">${esc(t('volumeNote'))}</p>`;

    const diff = (avg: number, top: number | null) => (top != null && top > 0 && avg > 0 ? (avg - top) / top : null);
    const dBuy = diff(q.buyPrice, ask);
    const dSell = diff(q.sellPrice, bid);
    const quick =
      `<div class="item-quick"><table class="tbl-plain"><thead><tr><th>${esc(t('quickSide'))}</th><th class="num">${esc(
        t('quickBook'),
      )}</th><th class="num">${esc(t('quickAvg'))}</th><th class="num">${esc(t('quickDiff'))}</th></tr></thead><tbody>` +
      `<tr><td>${esc(t('quickInstaBuy'))}</td><td class="num">${esc(fmtPrice(ask))}</td><td class="num">${esc(
        fmtPrice(q.buyPrice || null),
      )}</td><td class="num">${esc(fmtSignedPct(dBuy))}</td></tr>` +
      `<tr><td>${esc(t('quickInstaSell'))}</td><td class="num">${esc(fmtPrice(bid))}</td><td class="num">${esc(
        fmtPrice(q.sellPrice || null),
      )}</td><td class="num">${esc(fmtSignedPct(dSell))}</td></tr>` +
      `</tbody></table></div><p class="note small">${esc(t('quickNote'))}</p>`;

    let npc: string;
    if (!s.catalog) {
      npc = `<p class="note">${esc(s.catalogError ? t('catalogError', { err: s.catalogError }) : t('catalogLoading'))}</p>`;
    } else if (info?.npcSell == null && info?.npcBuy == null) {
      npc = `<p class="note">${esc(t('npcNone'))}</p>`;
    } else {
      npc = kv([
        [t('npcSell'), esc(fmtPrice(info?.npcSell))],
        [t('npcBuy'), esc(fmtPrice(info?.npcBuy))],
      ]);
    }

    const card = (title: string, body: string, cls = '') => `<section class="card ${cls}"><h3>${esc(title)}</h3>${body}</section>`;
    factsEl.innerHTML =
      card(t('marketTitle'), market) +
      card(t('yourTitle'), yours) +
      card(t('volumeTitle'), volume) +
      card(t('quickTitle'), quick, 'item-quick-card') +
      card(t('npcTitle'), npc);
  }

  function renderRecipes(s: AppState): void {
    const cat = s.catalog;
    if (!cat) {
      const txt = s.catalogError ? t('catalogError', { err: s.catalogError }) : t('catalogLoading');
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
      ariaLabel: `${t('chartTitle')}: ${nameOf(id)} (${t(`range${range}`)}) · ${t('chartPoints', { n: pts.length })}`,
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
    headEl = h('header', { class: 'item-head' });
    factsEl = h('div', { class: 'item-facts' });
    riskEl = h('section', { class: 'card item-risk', 'data-testid': 'item-risk' });

    tblBids = bookTable();
    tblAsks = bookTable();
    bookTitle = h('h3');
    bidsTitle = h('h4', { class: 'item-side item-side-bid' });
    asksTitle = h('h4', { class: 'item-side item-side-ask' });
    bookNote = h('p', { class: 'note small' });
    const book = h(
      'section',
      { class: 'card item-book', 'data-testid': 'order-book' },
      bookTitle,
      h('div', { class: 'item-book-grid' }, h('div', null, bidsTitle, tblBids.el), h('div', null, asksTitle, tblAsks.el)),
      bookNote,
    );

    chart = createLineChart();
    chartTitle = h('h3');
    chartLegend = h('div', { class: 'lc-legend' });
    chartNote = h('p', { class: 'note small' });
    rangeSeg = h('div', { class: 'seg', role: 'group' });
    for (const r of RANGES) {
      rangeSeg.append(
        h('button', { type: 'button', 'data-range': r, 'aria-pressed': String(r === range), onclick: () => setRange(r) }),
      );
    }
    const chartSec = h(
      'section',
      { class: 'card item-chart' },
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
    recOutTitle = h('h3');
    recOutMsg = h('p', { class: 'note', hidden: true });
    recInTitle = h('h3');
    recInMsg = h('p', { class: 'note small', hidden: true });
    const recipes = h(
      'div',
      { class: 'item-recipes' },
      h('section', { class: 'card', 'data-testid': 'recipes-out' }, recOutTitle, recOutMsg, tblOut.el),
      h('section', { class: 'card', 'data-testid': 'recipes-in' }, recInTitle, tblIn.el, recInMsg),
    );

    mainEl = h('div', { class: 'item-main', hidden: true }, headEl, factsEl, riskEl, book, chartSec, recipes);
    const view = h('div', { class: 'item-view', 'data-testid': 'item-view' }, h('div', { class: 'item-top' }, backLink, searchBox), msgEl, mainEl);
    el.append(view);
    root = view;
  }

  function outputCell(r: Recipe): string {
    const count = r.outCount !== 1 ? ` <span class="muted small">×${esc(fmtQty(r.outCount))}</span>` : '';
    return itemCell(r.output, nameOf(r.output), !!st().snapshot?.products[r.output]).replace('</a>', `</a>${count}`);
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
          if (s.snapshot !== prev.snapshot || s.catalog !== prev.catalog || s.catalogError !== prev.catalogError || s.settings !== prev.settings) {
            schedule();
          }
          if (s.historyTick !== prev.historyTick) {
            schedule(); // stats (24h change, spike flag) changed
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
    },
  };
}
