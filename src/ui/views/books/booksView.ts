// Book combining: buy 2^(L-k) level-k enchanted books, combine on an anvil, sell one level-L book.
// Rows come from ctx.derived.books(); unverified chains (above the curated anvil max) are hidden by default.
import { BOOK, HOTKEYS, LS_VIEWPREFS } from '../../../config.ts';
import { parseBookId } from '../../../domain/books.ts';
import { matchesQuery } from '../../../domain/search.ts';
import { msgText, onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, BookRow, Catalog, Route, Snapshot, View, ViewContext } from '../../../types/contracts.ts';
import { riskBadge } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtCompact, fmtHours, fmtInt, fmtPct } from '../../format.ts';
import {
  bindQueryState,
  createDetailPanel,
  createFilterBar,
  createKitTable,
  registerHotkeys,
  type DetailPanel,
  type FilterBar,
  type KitColumn,
  type KitTableHandle,
  type QuerySchema,
  type QueryState,
  type QueryValues,
} from '../../kit/index.ts';
import '../flip/flip.css';
import { focusedRowKey, kv, limitedText, orderBookHtml, riskListHtml, section, signCls, span, tpPairs, watchButton } from '../flip/parts.ts';
import './books.css';

export const BOOKS_PREFS_KEY = LS_VIEWPREFS + 'books';

const SORT_KEYS = ['name', 'chain', 'buyAt', 'cost', 'sellAt', 'profit', 'margin', 'uph', 'pph', 'risk', 'verified'] as const;

export const BOOKS_SCHEMA = {
  q: { kind: 'string', def: '' },
  ver: { kind: 'bool', def: BOOK.hideUnverified },
  /** percent */
  minMargin: { kind: 'number', def: null, min: 0 },
  minPph: { kind: 'number', def: null, min: 0 },
  sus: { kind: 'bool', def: false },
  sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' }, keys: SORT_KEYS },
} as const satisfies QuerySchema;

type Prefs = QueryValues<typeof BOOKS_SCHEMA>;

/** Combines per level step, e.g. count 8 -> [4, 2, 1] (sum = count - 1). */
export function combineSteps(count: number): number[] {
  const out: number[] = [];
  for (let c = count / 2; c >= 1; c /= 2) out.push(c);
  return out;
}

/** Text of the chain explainer: "Buy 8 × Ultimate Wise II → combine on anvil 4+2+1 times → Ultimate Wise V" (HTML). */
export function chainText(r: BookRow, inputName: string): string {
  return t('books.chainText', {
    n: fmtInt(r.count),
    input: esc(inputName),
    steps: combineSteps(r.count).join('+'),
    output: esc(r.name),
  });
}

/** True when the catalog has a book rule for any enchant on the bazaar. */
function anyRules(snap: Snapshot, catalog: Catalog): boolean {
  const seen = new Set<string>();
  for (const id of Object.keys(snap.products)) {
    const b = parseBookId(id);
    if (!b || seen.has(b.base)) continue;
    seen.add(b.base);
    if (catalog.bookRule(b.base)) return true;
  }
  return false;
}

export function createBooksView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext;
  let qs: QueryState<Prefs>;
  let bar: FilterBar | null = null;
  let table: KitTableHandle<BookRow> | null = null;
  let panel: DetailPanel | null = null;
  const cleanups: (() => void)[] = [];

  let all: BookRow[] = [];
  let selectedId: string | null = null;
  let emptyText = '';
  let dataDirty = true;
  let rulesMemo: { snap: Snapshot; catalog: Catalog; has: boolean } | null = null;

  let els: {
    title: HTMLElement;
    intro: HTMLElement;
    banner: HTMLElement;
    unverBanner: HTMLElement;
    msg: HTMLElement;
    body: HTMLElement;
    count: HTMLElement;
    hiddenBtn: HTMLButtonElement;
    note: HTMLElement;
  };

  const name = (id: string): string => ctx.store.get().catalog?.name(id) ?? id;

  const num = (key: string, get: (r: BookRow) => number | null, html: (r: BookRow) => string, extra: Partial<KitColumn<BookRow>> = {}): KitColumn<BookRow> => ({
    key,
    label: () => t(`books.col_${key}`),
    title: () => t(`books.tip_${key}`),
    get,
    html,
    align: 'right',
    ...extra,
  });

  const verBadge = (v: boolean): string =>
    `<span class="badge book-ver ${v ? 'risk-ok' : 'risk-caution'}">${esc(t(v ? 'common.verified' : 'common.unverified'))}</span>`;

  const columns: KitColumn<BookRow>[] = [
    {
      key: 'name',
      label: () => t('books.col_item'),
      title: () => t('books.tip_item'),
      get: (r) => r.name,
      html: (r) => `<a href="#/item/${encodeURIComponent(r.id)}">${esc(r.name)}</a><span class="id-sub">${esc(r.id)}</span>`,
      csv: (r) => `${r.name} (${r.id})`,
      cls: 'name-cell',
      priority: 0,
    },
    {
      key: 'chain',
      label: () => t('books.col_chain'),
      title: () => t('books.tip_chain'),
      get: (r) => r.count,
      html: (r) => `<span class="book-chain">${esc(t('books.chainCell', { k: r.fromLevel, l: r.toLevel, n: r.count }))}</span>`,
      csv: (r) => t('books.chainCell', { k: r.fromLevel, l: r.toLevel, n: r.count }),
      align: 'center',
      priority: 1,
    },
    num('buyAt', (r) => r.buyAt, (r) => esc(fmtCoins(r.buyAt)), { priority: 2 }),
    num('cost', (r) => r.cost, (r) => esc(fmtCoins(r.cost)), { priority: 3 }),
    num('sellAt', (r) => r.sellAt, (r) => esc(fmtCoins(r.sellAt)), { priority: 2 }),
    num('profit', (r) => r.profit, (r) => span(signCls(r.profit), fmtCoins(r.profit)), { priority: 3 }),
    num('margin', (r) => r.margin, (r) => span(signCls(r.margin), fmtPct(r.margin)), { priority: 1 }),
    num('uph', (r) => r.tp.unitsPerHour, (r) => esc(fmtCompact(r.tp.unitsPerHour)), { priority: 3 }),
    num('pph', (r) => r.profitPerHour, (r) => `<strong>${span(signCls(r.profitPerHour), fmtCoins(r.profitPerHour))}</strong>`, { priority: 1 }),
    {
      key: 'risk',
      label: () => t('books.col_risk'),
      title: () => t('books.tip_risk'),
      get: (r) => r.risk.score,
      html: (r) => riskBadge(r.risk),
      csv: (r) => t(`risk.${r.risk.level}`),
      align: 'center',
      priority: 2,
    },
    {
      key: 'verified',
      label: () => t('books.col_verified'),
      title: () => t('books.tip_verified'),
      get: (r) => (r.verified ? 1 : 0),
      html: (r) => verBadge(r.verified),
      csv: (r) => t(r.verified ? 'common.yes' : 'common.no'),
      align: 'center',
      priority: 2,
    },
  ];

  // ---------------------------------------------------------------- detail panel
  function ruleText(r: BookRow): string {
    const rule = ctx.store.get().catalog?.bookRule(r.base) ?? null;
    if (!rule) return t('books.ruleNone');
    if (!rule.verified) return t('books.ruleTable', { m: rule.maxLevel });
    if (r.toLevel > rule.maxLevel) return t('books.ruleOver', { m: rule.maxLevel, l: r.toLevel });
    return t('books.ruleVerified', { m: rule.maxLevel });
  }

  function detailHtml(r: BookRow): string {
    const s = ctx.store.get();
    const { costMode, sellMode, orderSlots } = s.settings;
    const tp = r.tp;
    const inName = name(r.inputId);
    const books = Math.round(tp.batchQty);
    const inputs = books * r.count;
    const steps = [
      costMode === 'order'
        ? t('books.stepBuyOrder', { n: fmtInt(inputs), input: esc(inName), price: esc(fmtCoins(r.buyAt)), h: esc(fmtHours(tp.buyHours ?? tp.fillHours)) })
        : t('books.stepBuyInsta', { n: fmtInt(inputs), input: esc(inName), price: esc(fmtCoins(r.buyAt)) }),
      t('books.stepCombine', { c: fmtInt(books * (r.count - 1)), books: fmtInt(books), output: esc(r.name) }),
      sellMode === 'offer'
        ? t('books.stepSellOffer', { output: esc(r.name), price: esc(fmtCoins(r.sellAt)), h: esc(fmtHours(tp.sellHours ?? tp.fillHours)) })
        : t('books.stepSellInsta', { output: esc(r.name), price: esc(fmtCoins(r.sellAt)) }),
    ];
    const watched = ctx.watch.has(r.id);
    const snap = s.snapshot;
    return (
      `<div class="dp books-dp" data-id="${esc(r.id)}">` +
      section(
        t('books.chainTitle'),
        `<p class="book-chain-text" data-testid="books-chain">${chainText(r, inName)}</p>` +
          `<p class="small">${esc(t('books.chainTotal', { c: r.count - 1 }))}</p>` +
          `<p class="muted small">${esc(t('books.xpNote'))}</p>`,
      ) +
      section(t('books.ruleTitle'), `<p>${verBadge(r.verified)}</p><p class="small">${esc(ruleText(r))}</p>`) +
      section(
        t('books.planTitle'),
        (books >= 1
          ? `<ol class="dp-steps">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>`
          : `<p class="small" data-testid="plan-zero">${esc(t('flip.planZero', { why: limitedText(tp.limitedBy) }))}</p>`) +
          kv([
            [t('flip.profitUnit'), span(signCls(r.profit), fmtCoins(r.profit))],
            [t('books.col_cost'), esc(fmtCoins(r.cost))],
            ...tpPairs(tp, orderSlots, r.profitPerHour),
          ]),
      ) +
      section(t('flip.riskTitle'), riskListHtml(r.risk)) +
      section(t('books.inputBook', { book: t('flip.bookTitle'), name: inName }), orderBookHtml(snap?.products[r.inputId])) +
      section(t('books.outputBook', { book: t('flip.bookTitle'), name: r.name }), orderBookHtml(snap?.products[r.id])) +
      section(
        t('flip.linksTitle'),
        `<div class="dp-links"><a class="btn btn-sm" href="#/item/${encodeURIComponent(r.inputId)}">${esc(t('books.openInput'))}</a>` +
          `<a class="btn btn-sm" href="#/item/${encodeURIComponent(r.id)}">${esc(t('books.openOutput'))}</a>` +
          `<button type="button" class="btn btn-sm" data-panel="watch" aria-pressed="${watched}">${esc(t(watched ? 'flip.watchRemove' : 'flip.watchAdd'))}</button></div>`,
      ) +
      '</div>'
    );
  }

  function openDetail(r: BookRow): void {
    selectedId = r.id;
    table?.setSelected(r.id);
    panel?.open(r.name, detailHtml(r));
  }

  function refreshPanel(): void {
    if (!panel?.isOpen() || !selectedId) return;
    const r = all.find((x) => x.id === selectedId);
    if (!r) return;
    const active = document.activeElement as HTMLElement | null;
    const focusSel = active && panel.el.contains(active) ? active.dataset.panel : undefined;
    panel.open(r.name, detailHtml(r));
    if (focusSel) panel.el.querySelector<HTMLElement>(`[data-panel="${focusSel}"]`)?.focus();
  }

  function toggleWatch(id: string): void {
    const was = ctx.watch.has(id);
    ctx.watch.toggle(id);
    ctx.toast(t(was ? 'flip.unstarred' : 'flip.starred', { name: name(id) }), 'ok');
  }

  // ---------------------------------------------------------------- render
  function hasRules(s: AppState): boolean {
    if (!s.snapshot || !s.catalog) return false;
    if (rulesMemo?.snap !== s.snapshot || rulesMemo.catalog !== s.catalog) {
      rulesMemo = { snap: s.snapshot, catalog: s.catalog, has: anyRules(s.snapshot, s.catalog) };
    }
    return rulesMemo.has;
  }

  function filtered(s: AppState): { shown: BookRow[]; hidden: number; unverHidden: number } {
    const p = qs.get();
    const minM = p.minMargin != null ? p.minMargin / 100 : -Infinity;
    const minP = p.minPph ?? -Infinity;
    const hideSusp = s.settings.hideSuspicious && !p.sus;
    const shown: BookRow[] = [];
    let hidden = 0;
    let unverHidden = 0;
    for (const r of all) {
      if (r.margin < minM || r.profitPerHour < minP) continue;
      if (p.q && !matchesQuery(s.catalog, r.id, p.q)) continue;
      if (p.ver && !r.verified) {
        unverHidden++;
        continue;
      }
      if (r.risk.level === 'suspect' && s.settings.hideSuspicious) {
        hidden++;
        if (hideSusp) continue;
      }
      shown.push(r);
    }
    return { shown, hidden, unverHidden };
  }

  function render(): void {
    if (!root || !table) return;
    const s = ctx.store.get();
    const failed = !!s.catalogError && !s.catalog;
    els.banner.hidden = !failed;
    if (failed) els.banner.textContent = t('common.catalogError', { err: msgText(s.catalogError!) });

    all = ctx.derived.books();
    const p = qs.get();
    if (!s.snapshot || !s.catalog) {
      els.msg.textContent = !s.snapshot ? t('common.waitingData') : failed ? t('books.catalogFailed') : t('books.loadingNames');
      els.msg.hidden = false;
      els.body.hidden = true;
      els.unverBanner.hidden = true;
      return;
    }
    const rules = hasRules(s);
    if (!rules && p.ver) {
      // nothing can be verified: explain instead of showing an empty table
      els.msg.textContent = t('books.noRules');
      els.msg.hidden = false;
      els.msg.dataset.state = 'noRules';
      els.body.hidden = true;
      els.unverBanner.hidden = true;
      return;
    }
    delete els.msg.dataset.state;
    els.msg.hidden = true;
    els.body.hidden = false;

    const { shown, hidden, unverHidden } = filtered(s);
    els.unverBanner.hidden = p.ver || !shown.some((r) => !r.verified);
    els.count.textContent = t('books.count', { n: fmtInt(shown.length) });
    if (hidden > 0) {
      els.hiddenBtn.hidden = false;
      els.hiddenBtn.textContent = p.sus ? t('common.hideHidden') : t('common.hiddenCount', { n: hidden });
      els.hiddenBtn.title = p.sus ? t('common.hideHidden') : t('common.showHidden');
      els.hiddenBtn.setAttribute('aria-pressed', String(p.sus));
    } else els.hiddenBtn.hidden = true;
    emptyText = !all.length
      ? t('books.emptyNone')
      : hidden > 0 && !p.sus
        ? t('books.emptyHidden', { n: hidden })
        : unverHidden > 0
          ? t('books.emptyUnverified', { n: unverHidden })
          : t('books.empty');
    table.setRows(shown);
    if (dataDirty) {
      dataDirty = false;
      refreshPanel();
    }
  }

  const schedule = rafDebounce(render);

  function applyLabels(): void {
    els.title.textContent = t('books.title');
    els.intro.textContent = t('books.intro');
    els.unverBanner.innerHTML = t('books.bannerUnverified');
    els.note.innerHTML = `<p>${t('books.note')}</p>`;
  }

  function starCurrent(): void {
    if (!table) return;
    const id = (panel?.isOpen() ? selectedId : null) ?? focusedRowKey(table.el) ?? selectedId;
    if (!id) {
      ctx.toast(t('flip.starNone'), 'info');
      return;
    }
    toggleWatch(id);
  }

  return {
    id: 'books',
    mount(el, c, route) {
      root = el;
      ctx = c;
      selectedId = null;
      dataDirty = true;
      qs = bindQueryState(BOOKS_SCHEMA, route, ctx.setQuery, BOOKS_PREFS_KEY);

      els = {
        title: h('h1', { class: 'view-title' }),
        intro: h('p', { class: 'muted small view-intro' }),
        banner: h('div', { class: 'banner banner-warn', role: 'status', hidden: true }),
        unverBanner: h('div', { class: 'banner banner-warn', role: 'note', 'data-testid': 'books-unverified', hidden: true }),
        msg: h('div', { class: 'empty', role: 'status', 'data-testid': 'books-msg' }),
        body: h('div', { class: 'books-body' }),
        count: h('span', { 'data-testid': 'books-count' }),
        hiddenBtn: h('button', { type: 'button', class: 'hidden-count', 'data-testid': 'books-hidden', hidden: true }),
        note: h('div', { class: 'note' }),
      };
      els.hiddenBtn.addEventListener('click', () => qs.set({ sus: !qs.get().sus }));

      bar = createFilterBar(
        [
          { kind: 'search', key: 'q', label: () => t('books.search'), placeholder: () => t('books.searchPh') },
          { kind: 'toggle', key: 'ver', label: () => t('books.verifiedOnly') },
          { kind: 'number', key: 'minMargin', label: () => t('books.minMargin'), suffix: '%' },
          { kind: 'number', key: 'minPph', label: () => t('books.minPph') },
          { kind: 'toggle', key: 'sus', label: () => t('books.showSuspect') },
        ],
        qs,
      );

      panel = createDetailPanel({ returnFocus: () => table?.el.querySelector<HTMLElement>('[data-key][tabindex="0"]') ?? null });
      panel.onClose(() => {
        selectedId = null;
        table?.setSelected(null);
      });
      panel.el.addEventListener('click', (ev) => {
        const btn = (ev.target as Element | null)?.closest<HTMLElement>('[data-panel="watch"]');
        if (btn && selectedId) toggleWatch(selectedId);
      });

      const extra = h('div', { class: 'books-tools' }, els.count, els.hiddenBtn);
      table = createKitTable<BookRow>({
        columns,
        rowKey: (r) => r.id,
        sort: qs.get().sort,
        onSortChange: (sort) => qs.set({ sort }),
        onActivate: openDetail,
        rowClass: (r) => (r.risk.level === 'ok' ? '' : `risk-row-${r.risk.level}`),
        emptyText: () => emptyText || t('books.empty'),
        columnsKey: 'books',
        toolbar: { columns: true, exportName: 'books', extra },
        rowActions: (r) => watchButton(ctx.watch.has(r.id), r.name),
        onRowAction: (action, r) => {
          if (action === 'watch') toggleWatch(r.id);
        },
      });
      els.body.append(els.unverBanner, table.el);

      const main = h(
        'div',
        { class: 'books-main' },
        h('header', { class: 'view-head' }, els.title, els.intro),
        bar.el,
        els.banner,
        els.msg,
        els.body,
        els.note,
      );
      el.append(h('section', { class: 'books-view kit-split', 'data-testid': 'books-view' }, main, panel.el));
      applyLabels();

      cleanups.push(
        qs.onChange((v) => {
          const cur = table?.getSort();
          if (cur && (cur.key !== v.sort.key || cur.dir !== v.sort.dir)) table!.setSort(v.sort);
          schedule();
        }),
        ctx.store.subscribe((s, prev) => {
          if (
            s.snapshot !== prev.snapshot ||
            s.settings !== prev.settings ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.historyTick !== prev.historyTick ||
            s.watchlist !== prev.watchlist
          ) {
            dataDirty = true;
            schedule();
          }
        }),
        onLangChange(() => {
          applyLabels();
          bar?.refresh();
          table?.refresh();
          dataDirty = true;
          render();
        }),
        registerHotkeys(
          Object.fromEntries([...HOTKEYS.star.map((k) => [k, starCurrent]), ...HOTKEYS.export.map((k) => [k, () => table?.exportCsv()])]),
        ),
      );
      render();
    },
    update(route: Route) {
      if (!root) return;
      qs.fromRoute(route);
    },
    unmount() {
      for (const fn of cleanups.splice(0)) fn();
      bar?.destroy();
      table?.destroy();
      panel?.destroy();
      bar = null;
      table = null;
      panel = null;
      all = [];
      rulesMemo = null;
      if (root) root.replaceChildren();
      root = null;
    },
  };
}
