// Trades page (#/trades): My orders (tracked bazaar orders vs the live book, src/domain/orders.ts) and the Trade
// journal (#/trades?view=journal, src/domain/journal.ts). Both lists live in AppState (persisted by app.ts).
// Other pages prefill the forms with ?add=<id>&side=&price=&qty= (orders) or ?view=journal&add=<id>&qty=&buy=&sell=&src=.
import { byItem, newTradeKey, profitOf, summarize, type JournalTotals } from '../../../domain/journal.ts';
import { orderStatus, type OrderStatus } from '../../../domain/orders.ts';
import { resolveUserInput } from '../../../domain/search.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import { parseJournal } from '../../../storage/local.ts';
import type { Catalog, JournalEntry, MyOrder, Route, View, ViewContext } from '../../../types/contracts.ts';
import { esc } from '../../dom.ts';
import { fmtAge, fmtCoins, fmtHours, fmtInt, fmtPct } from '../../format.ts';
import { createKitTable, downloadJson, type KitColumn, type KitTableHandle } from '../../kit/index.ts';
import { fmtQty } from '../craft/helpers.ts';
import { fmtPrice } from '../item/helpers.ts';
import './trades.css';

type Tab = 'orders' | 'journal';
interface OrderRow {
  o: MyOrder;
  st: OrderStatus;
  name: string;
}

const STATUS_CLS = { top: 'risk-ok', tied: 'risk-caution', outbid: 'risk-suspect', undercut: 'risk-suspect', unknown: '' } as const;
const PREFILL_KEYS = ['add', 'side', 'price', 'qty', 'cost', 'buy', 'sell', 'tax', 'src'] as const;
export const JOURNAL_FORMAT = 'bazaarMasasi.journal';

const num = (s: string | undefined) => (s != null && s.trim() !== '' ? Number(s) : NaN);
const nameOf = (cat: Catalog | null, id: string) => cat?.name(id) ?? id;

/** Journal entries from an exported file (the envelope or a bare array); invalid entries dropped. */
export function parseJournalImport(text: string): JournalEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { journal?: unknown }).journal) ? (raw as { journal: unknown[] }).journal : [];
  return arr.flatMap((x) => (x && typeof x === 'object' && !Array.isArray(x) ? [parseJournal(x as Record<string, unknown>)].filter((e): e is JournalEntry => !!e) : []));
}

function orderColumns(): KitColumn<OrderRow>[] {
  return [
    {
      key: 'name',
      label: () => t('trades.col_item'),
      get: (r) => r.name,
      cls: 'name-cell',
      priority: 0,
      csv: (r) => r.o.id,
      html: (r) =>
        `<a href="#/item/${encodeURIComponent(r.o.id)}">${esc(r.name)}</a><span class="id-sub">${esc(t(r.o.side === 'buy' ? 'trades.sideBuy' : 'trades.sideSell'))} · ${esc(fmtQty(r.o.qty))}×</span>`,
    },
    { key: 'price', label: () => t('trades.col_price'), get: (r) => r.o.price, align: 'right', priority: 1, html: (r) => esc(fmtPrice(r.o.price)) },
    { key: 'best', label: () => t('trades.col_best'), get: (r) => r.st.best, align: 'right', priority: 2, html: (r) => (r.st.best == null ? '—' : esc(fmtPrice(r.st.best))) },
    {
      key: 'status',
      label: () => t('trades.col_status'),
      get: (r) => ['top', 'tied', 'undercut', 'outbid', 'unknown'].indexOf(r.st.kind),
      csv: (r) => t(`trades.st_${r.st.kind}`),
      align: 'center',
      priority: 1,
      html: (r) =>
        `<span class="badge ${STATUS_CLS[r.st.kind]}" title="${esc(t(`trades.st_${r.st.kind}Title`))}" data-status="${r.st.kind}">${esc(t(`trades.st_${r.st.kind}`))}</span>`,
    },
    { key: 'ahead', label: () => t('trades.col_ahead'), get: (r) => r.st.ahead, align: 'right', priority: 3, html: (r) => esc(fmtInt(r.st.ahead)) },
    {
      key: 'eta',
      label: () => t('trades.col_eta'),
      get: (r) => r.st.etaHours,
      align: 'right',
      priority: 2,
      html: (r) => (r.st.etaHours == null ? '—' : esc(fmtHours(r.st.etaHours))),
    },
    {
      key: 'placed',
      label: () => t('trades.col_placed'),
      get: (r) => r.o.placedAt,
      align: 'right',
      priority: 3,
      html: (r) => esc(t('trades.placedAgo', { age: fmtAge(Date.now() - r.o.placedAt) })),
    },
  ];
}

function journalColumns(cat: () => Catalog | null): KitColumn<JournalEntry>[] {
  const coins = (k: 'buy' | 'sell' | 'fees') => (e: JournalEntry) => esc(k === 'fees' ? fmtCoins(e[k]) : fmtPrice(e[k]));
  return [
    {
      key: 'date',
      label: () => t('trades.col_date'),
      get: (e) => e.at,
      csv: (e) => new Date(e.at).toISOString(),
      priority: 2,
      html: (e) => esc(new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(e.at)),
    },
    {
      key: 'name',
      label: () => t('trades.col_item'),
      get: (e) => nameOf(cat(), e.id),
      cls: 'name-cell',
      priority: 0,
      csv: (e) => e.id,
      html: (e) => `<a href="#/item/${encodeURIComponent(e.id)}">${esc(nameOf(cat(), e.id))}</a>${e.note ? `<span class="id-sub">${esc(e.note)}</span>` : ''}`,
    },
    { key: 'qty', label: () => t('trades.col_qty'), get: (e) => e.qty, align: 'right', priority: 2, html: (e) => esc(fmtQty(e.qty)) },
    { key: 'buy', label: () => t('trades.col_buy'), get: (e) => e.buy, align: 'right', priority: 3, html: coins('buy') },
    { key: 'sell', label: () => t('trades.col_sell'), get: (e) => e.sell, align: 'right', priority: 3, html: coins('sell') },
    { key: 'fees', label: () => t('trades.col_fees'), get: (e) => e.fees, align: 'right', priority: 3, defaultHidden: true, html: coins('fees') },
    {
      key: 'profit',
      label: () => t('trades.col_profit'),
      get: profitOf,
      align: 'right',
      priority: 1,
      html: (e) => {
        const p = profitOf(e);
        return `<strong class="${p > 0 ? 'pos' : p < 0 ? 'neg' : ''}">${esc(fmtCoins(p))}</strong>`;
      },
    },
    { key: 'source', label: () => t('trades.col_source'), get: (e) => t(`trades.src_${e.source}`), priority: 3, html: (e) => esc(t(`trades.src_${e.source}`)) },
  ];
}

export function createTradesView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let tab: Tab = 'orders';
  let ordersTable: KitTableHandle<OrderRow> | null = null;
  let journalTable: KitTableHandle<JournalEntry> | null = null;
  let datalistCatalog: Catalog | null = null;
  /** where a prefilled journal entry came from (planner / order) */
  let journalSrc: JournalEntry['source'] = 'manual';
  const subs: (() => void)[] = [];
  const $ = <E extends Element = HTMLElement>(sel: string) => root!.querySelector<E>(sel)!;
  const cat = () => ctx?.store.get().catalog ?? null;
  const val = (sel: string) => $<HTMLInputElement>(sel).value;
  const setVal = (sel: string, v: string | number) => ($<HTMLInputElement>(sel).value = String(v));

  function labels(): void {
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => (el.textContent = t(el.dataset.t!)));
    root.querySelectorAll<HTMLElement>('[data-t-ph]').forEach((el) => el.setAttribute('placeholder', t(el.dataset.tPh!)));
    root.querySelectorAll<HTMLElement>('[data-t-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.tAria!)));
    root.querySelectorAll<HTMLElement>('[data-t-title]').forEach((el) => el.setAttribute('title', t(el.dataset.tTitle!)));
  }

  function fillDatalist(): void {
    const c = cat();
    if (!c || c === datalistCatalog) return;
    datalistCatalog = c;
    $('#trades-items').innerHTML = Object.values(c.items)
      .filter((i) => i.bazaar)
      .map((i) => i.name)
      .sort()
      .map((n) => `<option value="${esc(n)}"></option>`)
      .join('');
  }

  function showTab(): void {
    $('[data-pane="orders"]').hidden = tab !== 'orders';
    $('[data-pane="journal"]').hidden = tab !== 'journal';
    root!.querySelectorAll<HTMLButtonElement>('[data-trades-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tradesTab === tab)));
  }

  // ---------------------------------------------------------------- orders
  function renderOrders(): void {
    const s = ctx!.store.get();
    const rows: OrderRow[] = s.orders.map((o) => ({ o, st: orderStatus(o, s.snapshot?.products[o.id]), name: nameOf(s.catalog, o.id) }));
    ordersTable!.setRows(rows);
  }

  function addOrder(): void {
    const c = cat();
    const text = val('[data-o-item]').trim();
    const id = c && text ? resolveUserInput(c, text, new Set(Object.keys(ctx!.store.get().snapshot?.products ?? {}))) : null;
    if (!id) return void ctx!.toast(t('trades.unknownItem', { text }), 'err');
    const price = num(val('[data-o-price]'));
    const qty = num(val('[data-o-qty]'));
    if (!(price > 0) || !(qty > 0)) return void ctx!.toast(t('trades.badNumber'), 'err');
    const side = val('[data-o-side]') === 'sell' ? 'sell' : 'buy';
    const cost = num(val('[data-o-cost]'));
    const o: MyOrder = { key: newTradeKey('o'), id, side, price, qty, placedAt: Date.now(), ...(side === 'sell' && cost > 0 ? { cost } : {}) };
    o.lastStatus = orderStatus(o, ctx!.store.get().snapshot?.products[id]).kind;
    ctx!.store.set((s) => ({ orders: [o, ...s.orders] }));
    ctx!.toast(t('trades.orderAdded', { side: t(side === 'buy' ? 'trades.sideBuy' : 'trades.sideSell'), name: nameOf(c, id) }), 'ok');
    setVal('[data-o-item]', '');
    setVal('[data-o-price]', '');
    setVal('[data-o-cost]', '');
  }

  function onOrderAction(action: string, r: OrderRow): void {
    const s = ctx!.store.get();
    if (action === 'remove') ctx!.store.set({ orders: s.orders.filter((o) => o.key !== r.o.key) });
    else if (action === 'reprice' && r.st.reprice != null) {
      const price = r.st.reprice;
      ctx!.store.set({ orders: s.orders.map((o) => (o.key === r.o.key ? { ...o, price, lastStatus: 'top' } : o)) });
      ctx!.toast(t('trades.repriceDone', { price: fmtPrice(price) }), 'ok');
    } else if (action === 'filled') {
      ctx!.store.set({ orders: s.orders.filter((o) => o.key !== r.o.key) });
      if (r.o.side === 'buy') {
        // next leg: a sell offer for the same items, priced at the top of the asks, with the buy price as its cost
        const ask = s.snapshot?.products[r.o.id]?.asks[0]?.price;
        setVal('[data-o-item]', r.name);
        setVal('[data-o-side]', 'sell');
        setVal('[data-o-qty]', r.o.qty);
        setVal('[data-o-price]', ask != null ? Math.max(0.1, Math.round((ask - 0.1) * 10) / 10) : '');
        setVal('[data-o-cost]', r.o.price);
        $<HTMLInputElement>('[data-o-price]').focus();
        ctx!.toast(t('trades.filledBuy'), 'ok');
      } else {
        const e: JournalEntry = {
          key: newTradeKey('j'),
          id: r.o.id,
          qty: r.o.qty,
          buy: r.o.cost ?? 0,
          sell: r.o.price,
          tax: s.settings.taxRate,
          fees: 0,
          at: Date.now(),
          source: 'order',
        };
        ctx!.store.set((cur) => ({ journal: [e, ...cur.journal] }));
        ctx!.toast(t('trades.filledSell'), 'ok');
      }
    }
  }

  // ---------------------------------------------------------------- journal
  function sumTile(key: string, x: JournalTotals): string {
    return `<div class="card trades-sum"><span class="small muted">${esc(t(key))}</span>
      <strong class="${x.profit > 0 ? 'pos' : x.profit < 0 ? 'neg' : ''}">${esc(fmtCoins(x.profit))}</strong>
      <span class="small muted">${esc(t('trades.sumLine', { n: x.trades, roi: x.roi == null ? '—' : fmtPct(x.roi) }))}</span></div>`;
  }

  function renderJournal(): void {
    const s = ctx!.store.get();
    const sum = summarize(s.journal, Date.now());
    $('.trades-sums').innerHTML = sumTile('trades.sum_today', sum.today) + sumTile('trades.sum_week', sum.week) + sumTile('trades.sum_all', sum.all);
    const items = byItem(s.journal);
    const list = (xs: typeof items) => xs.map((x) => `<li><span>${esc(nameOf(s.catalog, x.id))}</span> <strong class="${x.profit >= 0 ? 'pos' : 'neg'}">${esc(fmtCoins(x.profit))}</strong></li>`).join('');
    $('.trades-items').innerHTML = items.length
      ? `<div><h3>${esc(t('trades.bestItems'))}</h3><ol>${list(items.filter((x) => x.profit > 0).slice(0, 3))}</ol></div>` +
        (items.some((x) => x.profit < 0)
          ? `<div><h3>${esc(t('trades.worstItems'))}</h3><ol>${list(items.filter((x) => x.profit < 0).slice(-3).reverse())}</ol></div>`
          : '')
      : '';
    journalTable!.setRows(s.journal);
  }

  function addTrade(): void {
    const c = cat();
    const text = val('[data-j-item]').trim();
    const id = c && text ? resolveUserInput(c, text) : null;
    if (!id) return void ctx!.toast(t('trades.unknownItem', { text }), 'err');
    const qty = num(val('[data-j-qty]'));
    const buy = num(val('[data-j-buy]') || '0');
    const sell = num(val('[data-j-sell]'));
    const fees = num(val('[data-j-fees]') || '0');
    if (!(qty > 0) || !(buy >= 0) || !(sell >= 0) || !(fees >= 0)) return void ctx!.toast(t('trades.badTrade'), 'err');
    const taxed = $<HTMLInputElement>('[data-j-taxed]').checked;
    const e: JournalEntry = { key: newTradeKey('j'), id, qty, buy, sell, tax: taxed ? ctx!.store.get().settings.taxRate : 0, fees, at: Date.now(), source: journalSrc };
    journalSrc = 'manual';
    ctx!.store.set((s) => ({ journal: [e, ...s.journal] }));
    ctx!.toast(t('trades.tradeAdded', { name: nameOf(c, id) }), 'ok');
    for (const sel of ['[data-j-item]', '[data-j-buy]', '[data-j-sell]', '[data-j-fees]']) setVal(sel, '');
  }

  function exportJournal(): void {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const file = `trade-journal-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.json`;
    downloadJson(file, JSON.stringify({ format: JOURNAL_FORMAT, v: 1, exportedAt: d.toISOString(), journal: ctx!.store.get().journal }, null, 2));
    ctx!.toast(t('trades.exported', { file }), 'ok');
  }

  async function importJournal(file: File): Promise<void> {
    const entries = parseJournalImport(await file.text());
    if (!entries.length) return void ctx!.toast(t('trades.importBad'), 'err');
    ctx!.store.set((s) => {
      const have = new Set(s.journal.map((e) => e.key));
      return { journal: [...entries.filter((e) => !have.has(e.key)), ...s.journal].sort((a, b) => b.at - a.at) };
    });
    ctx!.toast(t('trades.imported', { n: entries.length }), 'ok');
  }

  // ---------------------------------------------------------------- prefill from other pages
  function prefill(route: Route): void {
    const q = route.query;
    if (!q?.add || !ctx) return;
    const name = nameOf(cat(), q.add);
    if (tab === 'orders') {
      setVal('[data-o-item]', name);
      if (q.side === 'buy' || q.side === 'sell') setVal('[data-o-side]', q.side);
      if (q.price) setVal('[data-o-price]', q.price);
      if (q.qty) setVal('[data-o-qty]', q.qty);
      if (q.cost) setVal('[data-o-cost]', q.cost);
      $<HTMLInputElement>('[data-o-price]').focus();
    } else {
      setVal('[data-j-item]', name);
      if (q.qty) setVal('[data-j-qty]', q.qty);
      if (q.buy) setVal('[data-j-buy]', q.buy);
      if (q.sell) setVal('[data-j-sell]', q.sell);
      if (q.tax === '0') $<HTMLInputElement>('[data-j-taxed]').checked = false;
      journalSrc = q.src === 'plan' || q.src === 'order' ? q.src : 'manual';
      $<HTMLInputElement>('[data-j-sell]').focus();
    }
    ctx.setQuery(Object.fromEntries(PREFILL_KEYS.map((k) => [k, undefined])));
  }

  function render(): void {
    if (!root || !ctx) return;
    fillDatalist();
    renderOrders();
    renderJournal();
  }

  return {
    id: 'trades',
    mount(el, c, route) {
      root = el;
      ctx = c;
      tab = route.query?.view === 'journal' ? 'journal' : 'orders';
      el.innerHTML = `<div class="trades-view">
        <header class="trades-head">
          <h1 tabindex="-1" data-t="trades.title"></h1>
          <p class="muted small" data-t="trades.intro"></p>
          <div class="seg trades-tabs" role="group" data-t-aria="trades.tabsLabel">
            <button type="button" data-trades-tab="orders" data-testid="trades-tab-orders" data-t="trades.tabOrders"></button>
            <button type="button" data-trades-tab="journal" data-testid="trades-tab-journal" data-t="trades.tabJournal"></button>
          </div>
        </header>
        <datalist id="trades-items"></datalist>
        <section data-pane="orders" aria-labelledby="trades-orders-h">
          <h2 id="trades-orders-h" class="kit-sr" data-t="trades.tabOrders"></h2>
          <form class="card trades-form" data-form="order" novalidate>
            <label class="field"><span class="field-label" data-t="trades.item"></span><input type="text" list="trades-items" autocomplete="off" data-o-item data-t-ph="trades.itemPh" data-testid="order-item"></label>
            <label class="field"><span class="field-label" data-t="trades.side"></span><select data-o-side data-testid="order-side"><option value="buy" data-t="trades.sideBuy"></option><option value="sell" data-t="trades.sideSell"></option></select></label>
            <label class="field"><span class="field-label" data-t="trades.price"></span><input type="number" min="0" step="0.1" inputmode="decimal" data-o-price data-testid="order-price"></label>
            <label class="field"><span class="field-label" data-t="trades.qty"></span><input type="number" min="1" step="1" inputmode="numeric" value="64" data-o-qty data-testid="order-qty"></label>
            <label class="field"><span class="field-label" data-t="trades.cost" data-t-title="trades.costHelp"></span><input type="number" min="0" step="0.1" inputmode="decimal" data-o-cost></label>
            <button type="submit" class="btn" data-t="trades.addOrder" data-testid="order-add"></button>
          </form>
          <div class="trades-orders"></div>
        </section>
        <section data-pane="journal" aria-labelledby="trades-journal-h">
          <h2 id="trades-journal-h" class="kit-sr" data-t="trades.tabJournal"></h2>
          <div class="trades-sums" data-testid="journal-sums"></div>
          <form class="card trades-form" data-form="trade" novalidate>
            <label class="field"><span class="field-label" data-t="trades.item"></span><input type="text" list="trades-items" autocomplete="off" data-j-item data-t-ph="trades.itemPh" data-testid="trade-item"></label>
            <label class="field"><span class="field-label" data-t="trades.qty"></span><input type="number" min="1" step="1" inputmode="numeric" value="1" data-j-qty data-testid="trade-qty"></label>
            <label class="field"><span class="field-label" data-t="trades.buy"></span><input type="number" min="0" step="0.1" inputmode="decimal" data-j-buy data-testid="trade-buy"></label>
            <label class="field"><span class="field-label" data-t="trades.sell"></span><input type="number" min="0" step="0.1" inputmode="decimal" data-j-sell data-testid="trade-sell"></label>
            <label class="field"><span class="field-label" data-t="trades.fees"></span><input type="number" min="0" step="1" inputmode="decimal" data-j-fees></label>
            <label class="field field-check"><span class="check-row"><input type="checkbox" checked data-j-taxed><span class="field-label" data-t="trades.taxed"></span></span></label>
            <button type="submit" class="btn" data-t="trades.addTrade" data-testid="trade-add"></button>
          </form>
          <div class="trades-io"><button type="button" class="btn btn-sm" data-j-export data-t="trades.exportJson"></button>
            <label class="btn btn-sm trades-import"><span data-t="trades.importJson"></span><input type="file" accept="application/json,.json" data-j-import class="kit-sr"></label></div>
          <div class="trades-items"></div>
          <div class="trades-journal"></div>
        </section>
      </div>`;
      ordersTable = createKitTable<OrderRow>({
        columns: orderColumns(),
        rowKey: (r) => r.o.key,
        sort: { key: 'status', dir: 'desc' },
        emptyText: () => t('trades.ordersEmpty'),
        columnsKey: 'trades.orders',
        toolbar: { columns: true, exportName: 'my-orders' },
        rowActions: (r) =>
          (r.st.reprice != null && r.st.kind !== 'top'
            ? `<button type="button" class="btn btn-sm" data-action="reprice">${esc(t('trades.reprice', { price: fmtPrice(r.st.reprice) }))}</button>`
            : '') +
          `<button type="button" class="btn btn-sm" data-action="filled">${esc(t('trades.filled'))}</button>` +
          `<button type="button" class="btn btn-ghost btn-sm" data-action="remove" aria-label="${esc(`${t('trades.remove')}: ${r.name}`)}" title="${esc(t('trades.remove'))}">×</button>`,
        onRowAction: onOrderAction,
      });
      $('.trades-orders').append(ordersTable.el);
      journalTable = createKitTable<JournalEntry>({
        columns: journalColumns(cat),
        rowKey: (e) => e.key,
        sort: { key: 'date', dir: 'desc' },
        emptyText: () => t('trades.journalEmpty'),
        columnsKey: 'trades.journal',
        toolbar: { columns: true, exportName: 'trade-journal' },
        rowActions: (e) =>
          `<button type="button" class="btn btn-ghost btn-sm" data-action="remove" aria-label="${esc(`${t('trades.removeTrade')}: ${nameOf(cat(), e.id)}`)}" title="${esc(t('trades.removeTrade'))}">×</button>`,
        onRowAction: (action, e) => {
          if (action === 'remove') c.store.set((s) => ({ journal: s.journal.filter((x) => x.key !== e.key) }));
        },
      });
      $('.trades-journal').append(journalTable.el);

      const onSubmit = (ev: Event) => {
        ev.preventDefault();
        const form = (ev.target as HTMLElement).closest<HTMLFormElement>('form');
        if (form?.dataset.form === 'order') addOrder();
        else if (form?.dataset.form === 'trade') addTrade();
      };
      const onClick = (ev: MouseEvent) => {
        const target = ev.target instanceof Element ? ev.target : null;
        const tb = target?.closest<HTMLElement>('[data-trades-tab]');
        if (tb && tb.dataset.tradesTab !== tab) c.navigate({ id: 'trades', query: tb.dataset.tradesTab === 'journal' ? { view: 'journal' } : {} });
        if (target?.closest('[data-j-export]')) exportJournal();
      };
      const onChange = (ev: Event) => {
        const inp = ev.target instanceof HTMLInputElement && ev.target.matches('[data-j-import]') ? ev.target : null;
        const file = inp?.files?.[0];
        if (file) void importJournal(file).finally(() => (inp!.value = ''));
      };
      el.addEventListener('submit', onSubmit);
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      subs.push(() => {
        el.removeEventListener('submit', onSubmit);
        el.removeEventListener('click', onClick);
        el.removeEventListener('change', onChange);
      });
      subs.push(
        c.store.subscribe((s, prev) => {
          if (s.orders !== prev.orders || s.snapshot !== prev.snapshot || s.catalog !== prev.catalog) {
            fillDatalist();
            renderOrders();
          }
          if (s.journal !== prev.journal || s.catalog !== prev.catalog) renderJournal();
        }),
      );
      subs.push(
        onLangChange(() => {
          labels();
          ordersTable?.refresh();
          journalTable?.refresh();
          renderJournal();
        }),
      );
      labels();
      showTab();
      render();
      prefill(route);
    },
    update(route) {
      const next: Tab = route.query?.view === 'journal' ? 'journal' : 'orders';
      if (next !== tab) {
        tab = next;
        showTab();
      }
      prefill(route);
    },
    unmount() {
      for (const off of subs.splice(0)) off();
      ordersTable?.destroy();
      journalTable?.destroy();
      ordersTable = null;
      journalTable = null;
      datalistCatalog = null;
      if (root) root.textContent = '';
      root = null;
      ctx = null;
    },
  };
}
