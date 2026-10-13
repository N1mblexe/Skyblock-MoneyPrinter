// Shard fusion view: user-maintained recipes (A × qa + B × qb → OUT × qo) with live profit.
// The editor DOM is built once per recipe and kept across price updates (focus/caret survive);
// only the result cells are re-rendered.
import { onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, Catalog, FusionRecipe, View, ViewContext } from '../../../types/contracts.ts';
import { itemCell } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtPct } from '../../format.ts';
import { createResolver, fusionDetails, itemSuggestions, topShards, type FusionDetail, type Resolver, type TermDetail } from './fusionCalc.ts';
import './fusion.css';
import './i18n.ts';

type ItemField = 'a' | 'b' | 'out';
type QtyField = 'qa' | 'qb' | 'qo';
const TERMS: { item: ItemField; qty: QtyField; label: string; side: 'buy' | 'sell' }[] = [
  { item: 'a', qty: 'qa', label: 'fusion.inA', side: 'buy' },
  { item: 'b', qty: 'qb', label: 'fusion.inB', side: 'buy' },
  { item: 'out', qty: 'qo', label: 'fusion.out', side: 'sell' },
];
const SUGGEST_LIMIT = 30;
const QUICK_N = 20;

interface RowEls {
  el: HTMLElement;
  title: HTMLElement;
  del: HTMLButtonElement;
  item: Record<ItemField, HTMLInputElement>;
  qty: Record<QtyField, HTMLInputElement>;
  unit: Record<ItemField, HTMLElement>;
  res: HTMLElement;
}

let seq = 0;

const emptyRecipe = (out = ''): FusionRecipe => ({ a: '', qa: 1, b: '', qb: 1, out, qo: 1 });

/** Positive integer from a qty input, or null while the value is invalid. */
function parseQty(v: string): number | null {
  const n = Number(v);
  if (!v.trim() || !Number.isFinite(n) || n < 1) return null;
  return Math.round(n);
}

export function createFusionView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let alive = false;
  const cleanups: (() => void)[] = [];

  // scaffold refs
  let listEl: HTMLElement;
  let statusEl: HTMLElement;
  let countEl: HTMLElement;
  let modesEl: HTMLElement;
  let quickSel: HTMLSelectElement;
  let datalist: HTMLDataListElement;
  let rows: RowEls[] = [];
  let quickSig = '';

  // memoized resolver (per catalog + snapshot identity)
  let resolver: Resolver | null = null;
  let resolverKey: [Catalog | null, AppState['snapshot']] = [null, null];
  const getResolver = (s: AppState): Resolver | null => {
    if (!s.catalog) return null;
    if (!resolver || resolverKey[0] !== s.catalog || resolverKey[1] !== s.snapshot) {
      resolver = createResolver(s.catalog, s.snapshot);
      resolverKey = [s.catalog, s.snapshot];
    }
    return resolver;
  };

  const state = () => ctx!.store.get();

  function setRecipe(i: number, patch: Partial<FusionRecipe>): void {
    const cur = state().fusion;
    if (!cur[i]) return;
    const next = cur.slice();
    next[i] = { ...cur[i]!, ...patch };
    ctx!.store.set({ fusion: next });
  }

  function addRecipe(out = ''): void {
    ctx!.store.set({ fusion: [...state().fusion, emptyRecipe(out)] });
    rows[rows.length - 1]?.item.a.focus();
  }

  function removeRow(row: RowEls): void {
    const i = rows.indexOf(row);
    if (i < 0) return;
    // Drop this row's DOM first so the store sync sees matching lengths and keeps the others intact.
    rows.splice(i, 1);
    row.el.remove();
    const next = state().fusion.slice();
    next.splice(i, 1);
    ctx!.store.set({ fusion: next });
    if (rows.length) relabelRows();
    else rebuildRows();
  }

  function fillSuggestions(q: string): void {
    const catalog = state().catalog;
    if (!catalog) {
      datalist.replaceChildren();
      return;
    }
    const items = itemSuggestions(catalog, q, SUGGEST_LIMIT);
    datalist.replaceChildren(
      ...items.map((it) => {
        const o = document.createElement('option');
        o.value = it.name || catalog.name(it.id);
        o.label = it.id;
        return o;
      }),
    );
  }

  function makeRow(r: FusionRecipe, n: number): RowEls {
    const item = {} as Record<ItemField, HTMLInputElement>;
    const qty = {} as Record<QtyField, HTMLInputElement>;
    const unit = {} as Record<ItemField, HTMLElement>;
    const title = h('h3', { class: 'fu-title' });
    const del = h('button', { type: 'button', class: 'btn btn-sm btn-danger fu-del' });
    const eq = h('div', { class: 'fu-eq' });
    const row: RowEls = { el: h('div', { class: 'card fu-row' }), title, del, item, qty, unit, res: h('div', { class: 'fu-res' }) };
    const idx = () => rows.indexOf(row);

    TERMS.forEach((term, ti) => {
      const itemIn = h('input', {
        type: 'text',
        class: 'fu-item',
        list: datalist.id,
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: t('fusion.itemPh'),
        'data-f': term.item,
      });
      itemIn.value = r[term.item];
      itemIn.addEventListener('focus', () => fillSuggestions(itemIn.value));
      itemIn.addEventListener('input', () => {
        fillSuggestions(itemIn.value);
        setRecipe(idx(), { [term.item]: itemIn.value });
      });

      const qtyIn = h('input', { type: 'number', class: 'fu-qty', min: 1, step: 1, inputmode: 'numeric', 'data-f': term.qty });
      qtyIn.value = String(r[term.qty]);
      qtyIn.addEventListener('input', () => {
        const v = parseQty(qtyIn.value);
        qtyIn.setAttribute('aria-invalid', v == null ? 'true' : 'false');
        if (v != null) setRecipe(idx(), { [term.qty]: v });
      });
      qtyIn.addEventListener('change', () => {
        if (parseQty(qtyIn.value) != null) return;
        const cur = state().fusion[idx()];
        if (cur) qtyIn.value = String(cur[term.qty]);
        qtyIn.setAttribute('aria-invalid', 'false');
      });

      item[term.item] = itemIn;
      qty[term.qty] = qtyIn;
      unit[term.item] = h('div', { class: 'fu-unit small', 'aria-live': 'polite' });
      const termEl = h(
        'div',
        { class: `fu-term fu-term-${term.item}` },
        h('label', { class: 'field fu-item-field' }, h('span', { class: 'field-label' }, t(term.label)), itemIn),
        h('label', { class: 'field fu-qty-field' }, h('span', { class: 'field-label' }, `× ${t('fusion.qty')}`), qtyIn),
        unit[term.item],
      );
      if (ti > 0) eq.append(h('span', { class: 'fu-op', 'aria-hidden': 'true' }, ti === 1 ? '+' : '→'));
      eq.append(termEl);
    });

    del.textContent = t('fusion.del');
    del.addEventListener('click', () => removeRow(row));
    row.el.append(h('div', { class: 'fu-head' }, title, del), eq, row.res);
    setRowLabels(row, n);
    return row;
  }

  function setRowLabels(row: RowEls, n: number): void {
    row.title.textContent = t('fusion.recipeN', { n });
    row.del.setAttribute('aria-label', t('fusion.delAria', { n }));
  }
  const relabelRows = () => rows.forEach((r, i) => setRowLabels(r, i + 1));

  function rebuildRows(): void {
    const fusion = state().fusion;
    rows = fusion.map((r, i) => makeRow(r, i + 1));
    if (rows.length) listEl.replaceChildren(...rows.map((r) => r.el));
    else
      listEl.replaceChildren(
        h('div', { class: 'card empty fu-empty' }, h('p', null, h('strong', null, t('fusion.emptyTitle'))), h('p', null, t('fusion.emptyHint'))),
      );
  }

  /** Bring the editor in line with store.fusion without touching what the user is editing. */
  function syncEditor(): void {
    const fusion = state().fusion;
    if (rows.length !== fusion.length) {
      const grew = fusion.length === rows.length + 1 && rows.length > 0;
      if (grew) {
        const r = makeRow(fusion[fusion.length - 1]!, fusion.length);
        rows.push(r);
        listEl.append(r.el);
      } else rebuildRows();
      return;
    }
    const active = document.activeElement;
    fusion.forEach((r, i) => {
      const row = rows[i]!;
      for (const term of TERMS) {
        const it = row.item[term.item];
        if (it !== active && it.value !== r[term.item]) it.value = r[term.item];
        const q = row.qty[term.qty];
        if (q !== active && parseQty(q.value) !== r[term.qty]) q.value = String(r[term.qty]);
      }
    });
  }

  // ------------------------------------------------------------------ results
  function unitHtml(d: TermDetail, side: 'buy' | 'sell'): string {
    if (!d.text.trim()) return '';
    if (!d.id) return `<span class="neg">${esc(t('fusion.notFound'))}</span>`;
    const price =
      d.unit == null
        ? `<span class="neg">${esc(t('fusion.noPrice'))}</span>`
        : esc(t(side === 'buy' ? 'fusion.unitBuy' : 'fusion.unitSell', { p: fmtCoins(d.unit) }));
    return `<div class="fu-name">${itemCell(d.id, d.name ?? d.id, true)}</div><div class="fu-price num">${price}</div>`;
  }

  const stat = (key: string, label: string, raw: number | null, text: string, cls = '') =>
    `<div class="fu-stat"><span class="fu-k">${esc(label)}</span><span class="num fu-v ${cls}" data-k="${key}"${
      raw == null ? '' : ` data-raw="${raw}"`
    }>${esc(text)}</span></div>`;

  function resHtml(d: FusionDetail | null, msg: string | null): string {
    const r = d?.row;
    const p = r?.profit ?? null;
    const pcls = p == null ? '' : p >= 0 ? 'pos' : 'neg';
    let html =
      stat('cost', t('fusion.cost'), r?.cost ?? null, fmtCoins(r?.cost)) +
      stat('value', t('fusion.value'), r?.value ?? null, fmtCoins(r?.value)) +
      stat('profit', t('fusion.profit'), p, fmtCoins(p), pcls) +
      stat('margin', t('fusion.margin'), r?.margin ?? null, fmtPct(r?.margin), r?.margin == null ? '' : pcls);
    if (msg) html += `<p class="fu-msg small muted">${esc(msg)}</p>`;
    else if (d && d.missing.length)
      html += `<p class="fu-msg fu-missing small neg">${esc(t('fusion.missing', { ids: d.missing.join(', ') }))}</p>`;
    return html;
  }

  function renderStatus(s: AppState): string | null {
    if (!s.catalog) {
      const cls = s.catalogError ? 'banner banner-err' : 'banner banner-info';
      const txt = s.catalogError ? t('fusion.catalogError', { err: s.catalogError }) : t('fusion.catalogLoading');
      statusEl.className = cls;
      statusEl.textContent = txt;
      statusEl.hidden = false;
      return s.catalogError ? txt : t('common.loading');
    }
    if (!s.snapshot) {
      statusEl.className = 'banner banner-info';
      statusEl.textContent = t('common.waitingData');
      statusEl.hidden = false;
      return t('common.waitingData');
    }
    statusEl.hidden = true;
    return null;
  }

  function renderQuick(s: AppState): void {
    const picks = s.snapshot ? topShards(s.snapshot, s.catalog, s.settings, QUICK_N) : [];
    const sig = picks.map((p) => `${p.id}:${Math.round(p.value)}`).join('|') + '|' + (s.catalog ? 1 : 0);
    quickSel.disabled = picks.length === 0;
    if (sig === quickSig || document.activeElement === quickSel) return;
    quickSig = sig;
    quickSel.replaceChildren(
      h('option', { value: '' }, t('fusion.quickAddPh')),
      ...picks.map((p) => h('option', { value: s.catalog ? p.name : p.id }, `${p.name} · ${fmtCoins(p.value)}`)),
    );
  }

  const renderResults = rafDebounce(() => {
    if (!alive || !ctx) return;
    const s = state();
    countEl.textContent = t('fusion.count', { n: s.fusion.length });
    modesEl.innerHTML = t('fusion.note2', {
      cost: esc(t(s.settings.costMode === 'order' ? 'common.costOrder' : 'common.costInsta')),
      sell: esc(t(s.settings.sellMode === 'offer' ? 'common.sellOffer' : 'common.sellInsta')),
    });
    renderQuick(s);
    const msg = renderStatus(s);
    const resolve = getResolver(s);
    const details =
      !msg && resolve && s.catalog && s.snapshot
        ? fusionDetails({ snap: s.snapshot, catalog: s.catalog, settings: s.settings }, s.fusion, resolve)
        : null;
    rows.forEach((row, i) => {
      const d = details?.[i] ?? null;
      for (const term of TERMS) row.unit[term.item].innerHTML = d ? unitHtml(d[term.item], term.side) : '';
      const rowMsg = msg ?? (d?.incomplete ? t('fusion.incomplete') : null);
      row.res.innerHTML = resHtml(d, rowMsg);
      row.el.classList.toggle('fu-row-missing', !!d && d.missing.length > 0 && !d.incomplete);
    });
  });

  // ------------------------------------------------------------------ scaffold
  function render(): void {
    if (!root) return;
    datalist = h('datalist', { id: `fusion-items-${++seq}` });
    countEl = h('span', { class: 'fu-count' });
    quickSel = h('select', { class: 'fu-quick', 'aria-label': t('fusion.quickAdd'), title: t('fusion.quickAddHelp') });
    quickSig = '';
    quickSel.addEventListener('change', () => {
      const v = quickSel.value;
      quickSel.value = '';
      if (v) addRecipe(v);
    });
    const addBtn = h('button', { type: 'button', class: 'btn btn-primary fu-add' }, t('fusion.add'));
    addBtn.addEventListener('click', () => addRecipe());
    statusEl = h('div', { class: 'banner banner-info', role: 'status', hidden: true });
    listEl = h('div', { class: 'fu-list' });
    modesEl = h('p');
    const note = h('div', { class: 'note' });
    note.innerHTML = `<p>${t('fusion.note1')}</p>`;
    note.append(modesEl);
    note.insertAdjacentHTML('beforeend', `<p>${esc(t('fusion.note3'))}</p><p>${esc(t('fusion.note4'))}</p>`);

    root.replaceChildren(
      h(
        'section',
        { class: 'fusion-view' },
        h('div', { class: 'fu-top' }, h('h2', null, t('fusion.title')), h('p', { class: 'muted' }, t('fusion.intro'))),
        statusEl,
        h(
          'div',
          { class: 'toolbar fu-toolbar' },
          h('div', null, countEl),
          h('div', { class: 'fu-actions' }, quickSel, addBtn),
        ),
        listEl,
        note,
        datalist,
      ),
    );
    rebuildRows();
    renderResults();
  }

  return {
    id: 'fusion',
    mount(el, c) {
      root = el;
      ctx = c;
      alive = true;
      render();
      cleanups.push(
        c.store.subscribe((s, prev) => {
          if (s.fusion !== prev.fusion) syncEditor();
          if (
            s.fusion !== prev.fusion ||
            s.snapshot !== prev.snapshot ||
            s.settings !== prev.settings ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError
          )
            renderResults();
        }),
        onLangChange(() => render()),
      );
    },
    update() {},
    unmount() {
      alive = false;
      for (const fn of cleanups.splice(0)) fn();
      root?.replaceChildren();
      rows = [];
      resolver = null;
      root = null;
      ctx = null;
    },
  };
}
