// Bits shop (#/bits): which Community Shop offer turns bits into the most coins, what a bit costs in Booster Cookies
// at the user's fame rank, and the basket one cookie's bits buy (src/domain/bits.ts). The multiplier is
// settings.bitsMultiplier (the old LS_BITS prefs move there once); filters live in the URL. Recomputed when
// calcCtx() changes (prices, catalog, calc settings, the AH scan and sales, the mayor).
import { BITS, LS_BITS, LS_VIEWPREFS } from '../../../config.ts';
import { computeBitsRows, type BitsBasket, type BitsQuote, type BitsResult, type BitsRow, type BitsSource } from '../../../domain/bits.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import { isDerpy } from '../../../state/derived.ts';
import { lsGet } from '../../../storage/local.ts';
import type { AppState, CalcCtx, Settings, Store, View, ViewContext } from '../../../types/contracts.ts';
import { riskBadge } from '../../cells.ts';
import { esc, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtCompact, fmtHours, fmtInt, fmtNum, fmtPct, locale } from '../../format.ts';
import {
  bindQueryState,
  createDetailPanel,
  createFilterBar,
  createKitTable,
  parseNumberInput,
  type DetailPanel,
  type FilterBar,
  type KitColumn,
  type KitTableHandle,
  type QueryState,
} from '../../kit/index.ts';
import './bits.css';
import { BITS_SCHEMA, filterBitsRows, legacyMultiplier, rankOf, validMultiplier, type BitsQuery } from './model.ts';

export { BITS_SCHEMA, filterBitsRows };

/** Multiplier with up to two decimals in the active locale ("1.6", "2.38"). */
const fmtMult = (m: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(m);

const srcBadge = (s: BitsSource | null) => (s ? `<span class="badge src-${s}">${esc(t(`bits.src_${s}`))}</span>` : '—');

/** Move the old page's LS_BITS prefs into settings.bitsMultiplier once (only over the default), then drop them. */
export function migrateBitsPrefs(store: Store<AppState>): void {
  try {
    const m = legacyMultiplier(lsGet<unknown>(LS_BITS, null));
    if (m == null) return;
    const s = store.get().settings;
    if (s.bitsMultiplier === 1 && m !== 1) store.set({ settings: { ...s, bitsMultiplier: m } });
    localStorage.removeItem(LS_BITS);
  } catch {
    /* blocked storage: nothing to migrate */
  }
}

function liqText(r: { liquidity: number | null; source: BitsSource | null }): string {
  if (r.source === 'npc') return '∞';
  if (r.liquidity == null) return '—';
  return r.source === 'ah' ? t('bits.liqListings', { n: fmtInt(r.liquidity), count: r.liquidity }) : t('bits.liqWeek', { n: fmtCompact(r.liquidity) });
}

const vsHtml = (vs: number | null) =>
  vs == null ? '—' : `<span class="${vs > 1 ? 'pos' : vs < 1 ? 'neg' : ''}">${esc(t('bits.vsTimes', { x: fmtNum(vs, 2) }))}</span>`;

function columns(): KitColumn<BitsRow>[] {
  return [
    {
      key: 'name',
      label: () => t('bits.col_item'),
      get: (r) => r.name,
      cls: 'name-cell',
      priority: 0,
      csv: (r) => r.id,
      html: (r) =>
        `<span>${esc(r.name)}${r.outQty > 1 ? ` <span class="muted">×${esc(fmtInt(r.outQty))}</span>` : ''}</span>` +
        `<span class="id-sub">${esc(r.id)}${r.untradeable ? ` · ${esc(t('bits.untradeable'))}` : ''}</span>`,
    },
    { key: 'bits', label: () => t('bits.col_bits'), get: (r) => r.bits, align: 'right', priority: 1, html: (r) => esc(fmtInt(r.bits)) },
    { key: 'value', label: () => t('bits.col_value'), title: () => t('bits.tip_value'), get: (r) => r.value, align: 'right', priority: 2, html: (r) => esc(fmtCoins(r.value)) },
    {
      key: 'source',
      label: () => t('bits.col_source'),
      get: (r) => r.valueSource,
      csv: (r) => r.valueSource ?? '',
      align: 'center',
      priority: 2,
      html: (r) => srcBadge(r.valueSource),
    },
    {
      key: 'cpb',
      label: () => t('bits.col_cpb'),
      get: (r) => r.coinsPerBit,
      align: 'right',
      priority: 1,
      html: (r) => (r.coinsPerBit == null ? '—' : `<strong>${esc(fmtCoins(r.coinsPerBit))}</strong>`),
    },
    { key: 'vs', label: () => t('bits.col_vs'), title: () => t('bits.tip_vs'), get: (r) => r.vsCookie, align: 'right', priority: 1, html: (r) => vsHtml(r.vsCookie) },
    {
      key: 'liq',
      label: () => t('bits.col_liq'),
      title: () => t('bits.tip_liq'),
      get: (r) => (r.valueSource === 'npc' ? Infinity : r.liquidity),
      align: 'right',
      priority: 3,
      html: (r) => esc(liqText({ liquidity: r.liquidity, source: r.valueSource })),
    },
    {
      key: 'risk',
      label: () => t('bits.col_risk'),
      get: (r) => r.risk?.score ?? null,
      csv: (r) => (r.risk ? t(`risk.${r.risk.level}`) : ''),
      align: 'center',
      priority: 1,
      html: (r) => (r.risk ? riskBadge(r.risk) : '—'),
    },
  ];
}

function quoteLabel(q: BitsQuote, s: Settings): string {
  if (q.venue === 'bazaar') return t(s.sellMode === 'offer' ? 'bits.q_bazaarOffer' : 'bits.q_bazaarInsta', { tax: fmtPct(s.taxRate, 2) });
  return t(q.venue === 'ah' ? 'bits.q_ah' : 'bits.q_npc');
}

/** Detail panel body: the offer, every way to sell it (the winner first), and the caveats. */
export function bitsDetail(r: BitsRow, s: Settings, o: { derpy: boolean; ahOn: boolean; hasItemPage: boolean }): string {
  const kv = (k: string, v: string) => `<div><dt>${esc(t(k))}</dt><dd>${v}</dd></div>`;
  const notes: string[] = [];
  let how = '';
  if (r.untradeable) notes.push(t('bits.d_untradeable'));
  else if (!r.quotes.length) notes.push(t(o.ahOn ? 'bits.d_unpriced' : 'bits.d_unpricedAhOff'));
  else {
    const th = (k: string, cls = '') => `<th scope="col"${cls ? ` class="${cls}"` : ''}>${esc(t(k))}</th>`;
    const tr = (q: BitsQuote, i: number) => `<tr class="${i === 0 ? 'bits-win' : 'muted'}" data-src="${q.venue}">
        <th scope="row">${srcBadge(q.venue)} ${esc(quoteLabel(q, s))}${i === 0 ? ` <span class="badge risk-ok">${esc(t('bits.d_best'))}</span>` : ''}</th>
        <td class="num">${esc(fmtCoins(q.gross))}</td>
        <td class="num">${q.fees > 0 ? `−${esc(fmtCoins(q.fees))}` : '—'}</td>
        <td class="num">${esc(fmtCoins(q.net))}</td>
      </tr>`;
    how = `<h3 class="bits-d-h">${esc(t('bits.d_how'))}</h3>
      <div class="bits-quotes" tabindex="0" role="region" aria-label="${esc(t('bits.d_how'))}"><table class="tbl-plain">
        <thead><tr>${th('bits.d_hSource')}${th('bits.d_hPrice', 'num')}${th('bits.d_hFees', 'num')}${th('bits.d_hNet', 'num')}</tr></thead>
        <tbody>${r.quotes.map(tr).join('')}</tbody>
      </table></div>`;
    if (r.outQty > 1) notes.push(t('bits.d_perItem', { qty: fmtInt(r.outQty) }));
    if (o.derpy && r.quotes.some((q) => q.venue === 'ah')) notes.push(t('bits.d_derpy'));
    if (r.valueSource === 'ah') notes.push(t('bits.d_ahNote'));
  }
  return `<div class="bits-detail">
    <p class="bits-badges">${r.risk ? riskBadge(r.risk) : ''} <span class="id-sub">${esc(r.id)}</span></p>
    <dl class="kv">
      ${kv('bits.d_bits', esc(t('bits.d_bitsVal', { n: fmtInt(r.bits) })))}
      ${r.outQty !== 1 ? kv('bits.d_qty', esc(`×${fmtInt(r.outQty)}`)) : ''}
      ${kv('bits.d_value', esc(fmtCoins(r.value)))}
      ${kv('bits.d_cpb', `<strong>${esc(fmtCoins(r.coinsPerBit))}</strong>`)}
      ${kv('bits.d_vs', vsHtml(r.vsCookie))}
      ${r.rate != null && r.valueSource !== 'npc' ? kv('bits.d_rate', esc(t('bits.d_rateVal', { n: fmtNum(r.rate, 2), h: fmtHours(BITS.basketHours) }))) : ''}
    </dl>
    ${how}
    ${notes.map((n) => `<p class="note small">${esc(n)}</p>`).join('')}
    ${o.hasItemPage ? `<p class="bits-actions"><a class="btn btn-sm btn-ghost" href="#/item/${encodeURIComponent(r.id)}">${esc(t('bits.openItem'))} →</a></p>` : ''}
  </div>`;
}

/** The basket card: one cookie's bits, offer by offer, and the bits left over. */
function basketHtml(b: BitsBasket): string {
  if (!b.lines.length) return `<p class="muted small">${esc(t('bits.b_empty'))}</p>`;
  const lines = b.lines
    .map(
      (l) =>
        `<li data-basket="${esc(l.row.key)}"><button type="button" class="link" data-bits-open="${esc(l.row.key)}">${esc(t('bits.b_line', { n: fmtInt(l.offers), name: l.row.name }))}</button> <span class="muted">${esc(t('bits.b_bits', { n: fmtInt(l.bits) }))}</span> <span class="num">${esc(fmtCoins(l.coins))}</span></li>`,
    )
    .join('');
  return `<ul class="bits-basket-lines">${lines}</ul>
    <p class="small"><strong>${esc(t('bits.b_total', { coins: fmtCoins(b.coins), bits: fmtInt(b.bits) }))}</strong></p>
    ${b.leftBits > 0 ? `<p class="note small">${esc(t('bits.b_left', { n: fmtInt(b.leftBits), h: fmtHours(BITS.basketHours) }))}</p>` : ''}`;
}

export function createBitsView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let qs: QueryState<BitsQuery> | null = null;
  let bar: FilterBar | null = null;
  let table: KitTableHandle<BitsRow> | null = null;
  let panel: DetailPanel | null = null;
  let detailEl: HTMLElement | null = null;
  let openKey: string | null = null;
  const subs: (() => void)[] = [];
  /** calcCtx() carries settings.bitsMultiplier (a calc setting): one result per context */
  let memo: { c: CalcCtx; res: BitsResult } | null = null;

  const $ = <E extends Element = HTMLElement>(sel: string) => root!.querySelector<E>(sel)!;
  const multiplier = () => ctx!.store.get().settings.bitsMultiplier;

  function result(): BitsResult | null {
    const c = ctx?.derived.calcCtx();
    if (!c || !ctx!.store.get().catalog) return null;
    if (memo?.c !== c) memo = { c, res: computeBitsRows(c) };
    return memo.res;
  }

  function setMultiplier(m: number): void {
    const s = ctx!.store.get().settings;
    if (s.bitsMultiplier !== m) ctx!.store.set({ settings: { ...s, bitsMultiplier: m } });
    syncRank();
  }

  function fillRanks(): void {
    $('[data-bits-rank]').innerHTML =
      BITS.fameRanks.map(([name, , m]) => `<option value="${esc(name)}">${esc(t('bits.rankOpt', { rank: name, mult: fmtMult(m) }))}</option>`).join('') +
      `<option value="">${esc(t('bits.rankCustom'))}</option>`;
  }

  /** Rank select, custom input and the "in effect" line from the setting (the input keeps text the user is typing). */
  function syncRank(): void {
    if (!root || !ctx) return;
    const m = multiplier();
    const rank = rankOf(m);
    $<HTMLSelectElement>('[data-bits-rank]').value = rank ?? '';
    const inp = $<HTMLInputElement>('[data-bits-custom]');
    if (document.activeElement !== inp) {
      inp.value = rank == null ? String(m) : '';
      inp.removeAttribute('aria-invalid');
    }
    $('[data-bits-using]').textContent = rank == null ? t('bits.usingCustom', { mult: fmtMult(m) }) : t('bits.usingRank', { mult: fmtMult(m), rank });
    $('.bits-rank').classList.toggle('bits-custom-on', rank == null);
  }

  function applyLabels(): void {
    if (!root) return;
    $('h1').textContent = t('bits.title');
    $('.bits-intro').textContent = t('bits.intro', { base: fmtInt(BITS.perCookie) });
    $('.bits-rank-lbl').textContent = t('bits.rank');
    $('.bits-custom-lbl').textContent = t('bits.custom');
    $<HTMLInputElement>('[data-bits-custom]').placeholder = t('bits.customPh');
    $('.bits-basket-h').textContent = t('bits.b_title');
    fillRanks();
    syncRank();
  }

  function stat(key: string, label: string, value: string, sub: string, cls = ''): string {
    return `<div class="card bits-stat" data-stat="${key}"><span class="bits-stat-l">${esc(label)}</span><span class="bits-stat-v num ${cls}">${value}</span><span class="bits-stat-s muted small">${esc(sub)}</span></div>`;
  }

  function renderStats(res: BitsResult, s: Settings): void {
    const m = res.summary;
    const best = m.best;
    const cookieSub = m.cookieCost == null ? t('bits.s_cookieNone') : t(s.costMode === 'order' ? 'bits.s_cookieOrder' : 'bits.s_cookieInsta');
    const profitCls = m.profitPerCookie == null ? '' : m.profitPerCookie >= 0 ? 'pos' : 'neg';
    $('.bits-stats').innerHTML = [
      stat('bitsPerCookie', t('bits.s_bitsPerCookie'), esc(fmtInt(m.bitsPerCookie)), `${fmtInt(BITS.perCookie)} × ${fmtMult(m.multiplier)}`),
      stat('cookie', t('bits.s_cookie'), esc(fmtCoins(m.cookieCost)), cookieSub),
      stat('costPerBit', t('bits.s_costPerBit'), esc(fmtCoins(m.cookieCostPerBit)), t('bits.s_costPerBitSub')),
      stat(
        'best',
        t('bits.s_best'),
        best ? `<button type="button" class="link" data-bits-open="${esc(best.key)}">${esc(best.name)}</button>` : '—',
        best ? t('bits.s_bestSub', { cpb: fmtCoins(best.coinsPerBit) }) : t('bits.s_bestNone'),
      ),
      stat('basket', t('bits.s_basket'), esc(fmtCoins(m.coinsPerCookie)), t('bits.s_basketSub', { h: fmtHours(BITS.basketHours) })),
      stat('profit', t('bits.s_profit'), esc(fmtCoins(m.profitPerCookie)), t('bits.s_profitSub'), profitCls),
    ].join('');
    $('.bits-basket-body').innerHTML = basketHtml(m.basket);
  }

  function renderHint(s: AppState): void {
    const el = $('.bits-hint');
    const msg = !s.settings.ahEnabled ? 'ahOff' : !s.ah ? 'ahWaiting' : null;
    el.hidden = !msg;
    el.innerHTML = msg
      ? `<div class="banner banner-info">${esc(t(`bits.${msg}`))}${msg === 'ahOff' ? ` <button type="button" class="btn btn-sm" data-bits-ah-on>${esc(t('bits.turnOn'))}</button>` : ''}</div>`
      : '';
  }

  function showDetail(r: BitsRow, reopen: boolean): void {
    if (!panel || !detailEl || !ctx) return;
    const s = ctx.store.get();
    detailEl.innerHTML = bitsDetail(r, s.settings, {
      derpy: isDerpy(s.election),
      ahOn: s.settings.ahEnabled,
      hasItemPage: !!s.catalog?.items[r.id] || !!s.snapshot?.products[r.id],
    });
    if (reopen || !panel.isOpen()) panel.open(r.name, detailEl);
  }

  function open(r: BitsRow): void {
    openKey = r.key;
    table?.setSelected(openKey);
    showDetail(r, true);
  }

  function render(): void {
    if (!root || !ctx || !table || !qs) return;
    const s = ctx.store.get();
    renderHint(s);
    const res = result();
    const ready = !!res;
    const st = $('.bits-state');
    st.hidden = ready;
    st.innerHTML = ready ? '' : `<div class="empty card">${esc(t('bits.waiting'))}</div>`;
    table.el.hidden = !ready;
    $('.bits-stats').hidden = !ready;
    $('.bits-basket').hidden = !ready;
    if (!res) return;
    renderStats(res, s.settings);
    const v = qs.get();
    const out = filterBitsRows(
      res.rows,
      { q: v.q, minCpb: v.minCpb, src: v.src, unsold: v.unsold, hideSuspect: s.settings.hideSuspicious && !v.suspect },
      s.catalog,
    );
    const cur = table.getSort();
    if (!cur || cur.key !== v.sort.key || cur.dir !== v.sort.dir) table.setSort(v.sort);
    table.setRows(out.rows);
    $('[data-testid="bits-count"]').textContent = t('bits.count', { n: out.rows.length, total: res.rows.length, count: res.rows.length });
    if (openKey && panel?.isOpen()) {
      const r = res.rows.find((x) => x.key === openKey);
      if (r) showDetail(r, false);
    }
  }

  const schedule = rafDebounce(render);

  return {
    id: 'bits',
    mount(el, c, route) {
      root = el;
      ctx = c;
      migrateBitsPrefs(c.store);
      el.innerHTML = `<div class="bits-view kit-split">
        <header class="bits-head"><h1 tabindex="-1"></h1><p class="bits-intro muted small"></p></header>
        <div class="bits-rank card">
          <label class="field"><span class="field-label bits-rank-lbl"></span><select data-bits-rank data-testid="bits-rank"></select></label>
          <label class="field"><span class="field-label bits-custom-lbl"></span><input type="text" inputmode="decimal" autocomplete="off" data-bits-custom data-testid="bits-custom"></label>
          <span class="bits-using small" role="status" data-bits-using data-testid="bits-using"></span>
        </div>
        <div class="bits-stats"></div>
        <section class="bits-basket card" hidden><h2 class="bits-basket-h"></h2><div class="bits-basket-body"></div></section>
        <div class="bits-hint" hidden></div>
        <div class="bits-bar"></div>
        <div class="bits-state" hidden></div>
        <div class="bits-table"></div>
      </div>`;
      const state = bindQueryState(BITS_SCHEMA, route, c.setQuery, LS_VIEWPREFS + 'bits');
      qs = state;
      bar = createFilterBar(
        [
          { kind: 'search', key: 'q', label: () => t('bits.search'), placeholder: () => t('bits.searchPh') },
          { kind: 'number', key: 'minCpb', label: () => t('bits.minCpb') },
          {
            kind: 'segment',
            key: 'src',
            label: () => t('bits.source'),
            options: [
              { value: 'all', label: () => t('bits.src_all') },
              { value: 'bazaar', label: () => t('bits.src_bazaar') },
              { value: 'ah', label: () => t('bits.src_ah') },
            ],
          },
          { kind: 'toggle', key: 'unsold', label: () => t('bits.showUnsold') },
          { kind: 'toggle', key: 'suspect', label: () => t('bits.showSuspect') },
        ],
        state,
      );
      $('.bits-bar').append(bar.el);
      const extra = document.createElement('div');
      extra.className = 'bits-tools';
      extra.innerHTML = '<span class="bits-count" role="status" data-testid="bits-count"></span>';
      panel = createDetailPanel({ returnFocus: () => table?.el.querySelector<HTMLElement>('[data-key][tabindex="0"]') ?? null });
      detailEl = document.createElement('div');
      table = createKitTable<BitsRow>({
        columns: columns(),
        rowKey: (r) => r.key,
        sort: state.get().sort,
        onSortChange: (s) => qs?.set({ sort: s }),
        emptyText: () => t('bits.empty'),
        onActivate: open,
        selectedKey: null,
        columnsKey: 'bits',
        toolbar: { columns: true, exportName: 'bits-shop', extra },
      });
      $('.bits-table').append(table.el);
      $('.bits-view').append(panel.el);
      subs.push(
        panel.onClose(() => {
          openKey = null;
          table?.setSelected(null);
        }),
      );

      const onClick = (ev: MouseEvent) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (target?.closest('[data-bits-ah-on]')) c.store.set((s) => ({ settings: { ...s.settings, ahEnabled: true } }));
        const best = target?.closest<HTMLElement>('[data-bits-open]');
        const r = best ? memo?.res.rows.find((x) => x.key === best.dataset.bitsOpen) : null;
        if (r) open(r);
      };
      // a rank sets its multiplier; "Custom" leaves the value for the input
      const onRank = () => {
        const name = $<HTMLSelectElement>('[data-bits-rank]').value;
        const m = BITS.fameRanks.find(([n]) => n === name)?.[2];
        if (m != null) setMultiplier(m);
        else $<HTMLInputElement>('[data-bits-custom]').focus();
      };
      const customInp = $<HTMLInputElement>('[data-bits-custom]');
      const onCustom = () => {
        const n = parseNumberInput(customInp.value);
        if (n === null) return;
        if (n === undefined || !validMultiplier(n)) {
          customInp.setAttribute('aria-invalid', 'true');
          customInp.title = t('bits.customInvalid');
          return;
        }
        customInp.removeAttribute('aria-invalid');
        customInp.removeAttribute('title');
        setMultiplier(n);
      };
      const rankSel = $<HTMLSelectElement>('[data-bits-rank]');
      el.addEventListener('click', onClick);
      rankSel.addEventListener('change', onRank);
      customInp.addEventListener('input', onCustom);
      customInp.addEventListener('change', onCustom);
      subs.push(() => {
        el.removeEventListener('click', onClick);
        rankSel.removeEventListener('change', onRank);
        customInp.removeEventListener('input', onCustom);
        customInp.removeEventListener('change', onCustom);
      });
      subs.push(state.onChange(() => schedule()));
      subs.push(
        c.store.subscribe((s, prev) => {
          if (
            s.snapshot !== prev.snapshot ||
            s.catalog !== prev.catalog ||
            s.settings !== prev.settings ||
            s.ah !== prev.ah ||
            s.ahSales !== prev.ahSales ||
            s.election !== prev.election
          ) {
            if (s.settings.bitsMultiplier !== prev.settings.bitsMultiplier) syncRank();
            schedule();
          }
        }),
      );
      subs.push(
        onLangChange(() => {
          applyLabels();
          bar?.refresh();
          table?.refresh();
          schedule();
        }),
      );
      applyLabels();
      render();
    },
    update(route) {
      qs?.fromRoute(route);
    },
    unmount() {
      for (const off of subs.splice(0)) off();
      bar?.destroy();
      table?.destroy();
      panel?.destroy();
      bar = null;
      table = null;
      panel = null;
      detailEl = null;
      qs = null;
      openKey = null;
      memo = null;
      if (root) root.textContent = '';
      root = null;
      ctx = null;
    },
  };
}
