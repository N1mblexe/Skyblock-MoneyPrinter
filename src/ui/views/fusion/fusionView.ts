// Shard fusion view: a compact editable list, one recipe per row (A × qa + B × qb → OUT × qo) with live
// cost / value / profit / margin / profit per hour / risk from ctx.derived.fusion().
// Each row's editor DOM is built once and kept across price updates and reorders (focus and caret survive);
// only the result cells are re-rendered. Sorting never reorders while the user is typing in a field.
import { LS_VIEWPREFS } from '../../../config.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, Catalog, FusionRecipe, FusionRow, ItemInfo, Route, View, ViewContext } from '../../../types/contracts.ts';
import { itemCell, riskBadge } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtInt, fmtPct } from '../../format.ts';
import { bindQueryState, createDrawer, type Drawer, type QuerySchema, type QueryState } from '../../kit/index.ts';
import {
  createResolver,
  displayOrder,
  itemSuggestions,
  SORT_MODES,
  termDetail,
  topShards,
  type Resolver,
  type SortMode,
  type TermDetail,
} from './fusionCalc.ts';
import { downloadRecipes, parseRecipesJson, recipesToJson } from './fusionIo.ts';
import './fusion.css';

type ItemField = 'a' | 'b' | 'out';
type QtyField = 'qa' | 'qb' | 'qo';
const TERMS: { item: ItemField; qty: QtyField; label: string; side: 'buy' | 'sell' }[] = [
  { item: 'a', qty: 'qa', label: 'fusion.inA', side: 'buy' },
  { item: 'b', qty: 'qb', label: 'fusion.inB', side: 'buy' },
  { item: 'out', qty: 'qo', label: 'fusion.out', side: 'sell' },
];
const SUGGEST_LIMIT = 30;
const QUICK_N = 20;

const SCHEMA = {
  sort: { kind: 'enum', def: 'manual', values: SORT_MODES },
} as const satisfies QuerySchema;

interface RowEls {
  el: HTMLLIElement;
  num: HTMLElement;
  item: Record<ItemField, HTMLInputElement>;
  qty: Record<QtyField, HTMLInputElement>;
  unit: Record<ItemField, HTMLElement>;
  res: HTMLElement;
  btn: Record<'dup' | 'up' | 'down' | 'del', HTMLButtonElement>;
  /** latest computed result (kept on the row so reorders survive inserts/deletes) */
  result: FusionRow | null;
}

let seq = 0;

const emptyRecipe = (out = ''): FusionRecipe => ({ a: '', qa: 1, b: '', qb: 1, out, qo: 1 });

/** Positive integer from a qty input, or null while the value is invalid. */
function parseQty(v: string): number | null {
  const n = Number(v);
  if (!v.trim() || !Number.isFinite(n) || n < 1) return null;
  return Math.round(n);
}

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/(^|\s)\w/g, (m) => m.toUpperCase());

/** Shard chips: rarity (colored), families, alignment. */
export function shardChips(sh: ItemInfo['shard'] | null | undefined): string {
  if (!sh) return '';
  const rar = sh.rarity.toLowerCase().replace(/[^a-z_]/g, '');
  let s = `<span class="fu-chip fu-r-${rar}" title="${esc(t('fusion.rarity'))}">${esc(titleCase(sh.rarity))}</span>`;
  for (const f of sh.family) s += `<span class="fu-chip fu-fam" title="${esc(t('fusion.family'))}">${esc(f)}</span>`;
  if (sh.alignment) s += `<span class="fu-chip fu-align" title="${esc(t('fusion.alignment'))}">${esc(sh.alignment)}</span>`;
  return `<span class="fu-chips">${s}</span>`;
}

export function createFusionView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let alive = false;
  const cleanups: (() => void)[] = [];
  let qs: QueryState<{ sort: string }>;

  // scaffold refs
  let listEl: HTMLOListElement;
  let emptyEl: HTMLElement;
  let statusEl: HTMLElement;
  let countEl: HTMLElement;
  let modesEl: HTMLElement;
  let quickSel: HTMLSelectElement;
  let sortSel: HTMLSelectElement;
  let sortHint: HTMLElement;
  let datalist: HTMLDataListElement;
  let exportBtn: HTMLButtonElement;
  let copyBtn: HTMLButtonElement;
  let clearBtn: HTMLButtonElement;
  let importDrawer: Drawer | null = null;
  let rows: RowEls[] = [];
  let quickSig = '';
  let pendingOrder = false;

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
  const mode = (): SortMode => qs.get().sort as SortMode;

  // ------------------------------------------------------------------ store mutations
  function setRecipe(i: number, patch: Partial<FusionRecipe>): void {
    const cur = state().fusion;
    if (!cur[i]) return;
    const next = cur.slice();
    next[i] = { ...cur[i]!, ...patch };
    ctx!.store.set({ fusion: next });
  }

  /** Apply a structural change: rows (DOM) first so the store sync sees matching lengths, then the store. */
  function commit(recipes: FusionRecipe[], nextRows: RowEls[]): void {
    const keep = new Set(nextRows.map((r) => r.el));
    for (const r of rows) if (!keep.has(r.el)) r.el.remove();
    rows = nextRows;
    relabelRows();
    ctx!.store.set({ fusion: recipes });
    applyOrder(true);
    renderResults();
  }

  function addRecipe(out = ''): void {
    const r = emptyRecipe(out);
    const row = makeRow(r);
    commit([...state().fusion, r], [...rows, row]);
    row.item.a.focus();
  }

  function duplicate(row: RowEls): void {
    const i = rows.indexOf(row);
    const cur = state().fusion;
    if (i < 0 || !cur[i]) return;
    const copy = { ...cur[i]! };
    const dup = makeRow(copy);
    dup.result = row.result;
    const recipes = cur.slice();
    recipes.splice(i + 1, 0, copy);
    const next = rows.slice();
    next.splice(i + 1, 0, dup);
    commit(recipes, next);
    dup.btn.dup.focus();
  }

  function move(row: RowEls, delta: -1 | 1): void {
    if (mode() !== 'manual') return;
    const i = rows.indexOf(row);
    const j = i + delta;
    const cur = state().fusion;
    if (i < 0 || j < 0 || j >= rows.length) return;
    const recipes = cur.slice();
    [recipes[i], recipes[j]] = [recipes[j]!, recipes[i]!];
    const next = rows.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    commit(recipes, next);
    const b = delta < 0 ? row.btn.up : row.btn.down;
    (b.disabled ? (delta < 0 ? row.btn.down : row.btn.up) : b).focus();
  }

  function remove(row: RowEls): void {
    const i = rows.indexOf(row);
    if (i < 0) return;
    const recipes = state().fusion.slice();
    recipes.splice(i, 1);
    const next = rows.slice();
    next.splice(i, 1);
    commit(recipes, next);
    const focusRow = next[i] ?? next[i - 1];
    (focusRow ? focusRow.btn.del : root?.querySelector<HTMLElement>('.fu-add'))?.focus();
  }

  function clearAll(): void {
    const n = rows.length;
    if (!n) return;
    if (typeof window.confirm === 'function' && !window.confirm(t('fusion.clearConfirm', { n }))) return;
    commit([], []);
    ctx!.toast(t('fusion.cleared'), 'ok');
    root?.querySelector<HTMLElement>('.fu-add')?.focus();
  }

  function importRecipes(recipes: FusionRecipe[], replace: boolean): void {
    const made = recipes.map((r) => makeRow(r));
    if (replace) commit(recipes.slice(), made);
    else commit([...state().fusion, ...recipes], [...rows, ...made]);
  }

  // ------------------------------------------------------------------ editor rows
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

  function makeRow(r: FusionRecipe): RowEls {
    const item = {} as Record<ItemField, HTMLInputElement>;
    const qty = {} as Record<QtyField, HTMLInputElement>;
    const unit = {} as Record<ItemField, HTMLElement>;
    const mk = (act: string, glyph: string, cls = '') =>
      h('button', { type: 'button', class: `btn btn-ghost btn-sm fu-act ${cls}`.trim(), 'data-act': act }, glyph);
    const btn = { dup: mk('dup', '⧉'), up: mk('up', '↑'), down: mk('down', '↓'), del: mk('del', '×', 'fu-del') };
    const eq = h('div', { class: 'fu-eq' });
    const row: RowEls = {
      el: h('li', { class: 'fu-row' }),
      num: h('span', { class: 'fu-num' }),
      item,
      qty,
      unit,
      res: h('div', { class: 'fu-res' }),
      btn,
      result: null,
    };
    const idx = () => rows.indexOf(row);

    TERMS.forEach((term, ti) => {
      const itemIn = h('input', {
        type: 'text',
        class: 'fu-item',
        list: datalist.id,
        autocomplete: 'off',
        spellcheck: 'false',
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
      unit[term.item] = h('div', { class: 'fu-sub small' });
      const termEl = h(
        'div',
        { class: `fu-term fu-term-${term.item}` },
        h('div', { class: 'fu-in' }, itemIn, h('span', { class: 'fu-x', 'aria-hidden': 'true' }, '×'), qtyIn),
        unit[term.item],
      );
      if (ti > 0) eq.append(h('span', { class: 'fu-op', 'aria-hidden': 'true' }, ti === 1 ? '+' : '→'));
      eq.append(termEl);
    });

    btn.dup.addEventListener('click', () => duplicate(row));
    btn.up.addEventListener('click', () => move(row, -1));
    btn.down.addEventListener('click', () => move(row, 1));
    btn.del.addEventListener('click', () => remove(row));
    row.el.append(row.num, eq, row.res, h('div', { class: 'fu-acts' }, btn.dup, btn.up, btn.down, btn.del));
    return row;
  }

  function setRowLabels(row: RowEls, n: number): void {
    row.num.textContent = String(n);
    row.num.title = t('fusion.recipeN', { n });
    row.el.setAttribute('aria-label', t('fusion.recipeN', { n }));
    for (const term of TERMS) {
      const name = t(term.label);
      row.item[term.item].setAttribute('aria-label', t('fusion.itemAria', { n, term: name }));
      row.item[term.item].placeholder = `${name} · ${t('fusion.itemPh')}`;
      row.qty[term.qty].setAttribute('aria-label', t('fusion.qtyAria', { n, term: name }));
      row.qty[term.qty].title = t('fusion.qty');
    }
    const manual = mode() === 'manual';
    const last = rows.length - 1;
    const i = n - 1;
    const set = (b: HTMLButtonElement, key: string, disabled: boolean) => {
      b.title = !manual && (key === 'up' || key === 'down') ? t('fusion.moveManualOnly') : t(`fusion.${key}`);
      b.setAttribute('aria-label', t(`fusion.${key}Aria`, { n }));
      b.disabled = disabled;
    };
    set(row.btn.dup, 'dup', false);
    set(row.btn.up, 'up', !manual || i === 0);
    set(row.btn.down, 'down', !manual || i === last);
    set(row.btn.del, 'del', false);
  }
  const relabelRows = () => rows.forEach((r, i) => setRowLabels(r, i + 1));

  function rebuildRows(): void {
    for (const r of rows) r.el.remove();
    rows = state().fusion.map((r) => makeRow(r));
    relabelRows();
    applyOrder(true);
  }

  /** Bring the editor in line with store.fusion without touching what the user is editing. */
  function syncEditor(): void {
    const fusion = state().fusion;
    if (rows.length !== fusion.length) {
      rebuildRows();
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

  // ------------------------------------------------------------------ ordering
  /** True while focus is in a text/qty field of the list (sorting must wait). */
  const editing = (): boolean => {
    const a = document.activeElement;
    return a instanceof HTMLInputElement && listEl.contains(a);
  };

  /** Put rows in display order; without `force` this waits while the user is typing. */
  function applyOrder(force = false): void {
    if (!rows.length) {
      listEl.replaceChildren(emptyEl);
      pendingOrder = false;
      sortHint.hidden = true;
      return;
    }
    emptyEl.remove();
    const want = displayOrder(
      rows.map((r) => r.result),
      mode(),
    ).map((i) => rows[i]!.el);
    const children = [...listEl.children];
    const same = want.length === children.length && want.every((el, k) => children[k] === el);
    if (same) {
      pendingOrder = false;
      sortHint.hidden = true;
      return;
    }
    if (!force && editing() && want.every((el) => el.isConnected)) {
      pendingOrder = true;
      sortHint.hidden = false;
      return;
    }
    const active = document.activeElement;
    for (const el of want) listEl.append(el);
    pendingOrder = false;
    sortHint.hidden = true;
    if (active instanceof HTMLElement && active !== document.activeElement && active.isConnected) active.focus();
  }

  function onListFocusOut(ev: FocusEvent): void {
    if (!pendingOrder) return;
    const next = ev.relatedTarget;
    if (next instanceof HTMLInputElement && listEl.contains(next)) return;
    setTimeout(() => {
      if (alive && !editing()) applyOrder();
    }, 0);
  }

  // ------------------------------------------------------------------ results
  function unitHtml(d: TermDetail, side: 'buy' | 'sell'): string {
    if (!d.text.trim()) return '';
    if (!d.id) return `<span class="neg">${esc(t('fusion.notFound'))}</span>`;
    const price =
      d.unit == null
        ? `<span class="neg">${esc(t('fusion.noPrice'))}</span>`
        : esc(t(side === 'buy' ? 'fusion.unitBuy' : 'fusion.unitSell', { p: fmtCoins(d.unit) }));
    return `<span class="fu-name">${itemCell(d.id, d.name ?? d.id, true)}</span>${shardChips(d.shard)}<span class="fu-price num">${price}</span>`;
  }

  const stat = (key: string, label: string, raw: number | null, inner: string, cls = '', title = '') =>
    `<div class="fu-stat fu-s-${key}"${title ? ` title="${esc(title)}"` : ''}><span class="fu-k">${esc(label)}</span><span class="num fu-v ${cls}" data-k="${key}"${
      raw == null ? '' : ` data-raw="${raw}"`
    }>${inner}</span></div>`;

  function resHtml(r: FusionRow | null, msg: string | null): string {
    const p = r?.profit ?? null;
    const pcls = p == null ? '' : p >= 0 ? 'pos' : 'neg';
    const tp = r?.tp;
    const tpTitle = tp ? t('fusion.tpTitle', { uph: fmtInt(tp.unitsPerHour), lim: t(`fusion.lim_${tp.limitedBy}`) }) : '';
    const pph = r?.profitPerHour ?? null;
    let html =
      stat('cost', t('fusion.cost'), r?.cost ?? null, esc(fmtCoins(r?.cost))) +
      stat('value', t('fusion.value'), r?.value ?? null, esc(fmtCoins(r?.value)), '', t('fusion.valueTitle')) +
      stat('profit', t('fusion.profit'), p, esc(fmtCoins(p)), pcls) +
      stat('margin', t('fusion.margin'), r?.margin ?? null, esc(fmtPct(r?.margin)), r?.margin == null ? '' : pcls) +
      stat('pph', t('fusion.pph'), pph, esc(fmtCoins(pph)), pph == null ? '' : pph >= 0 ? 'pos' : 'neg', tpTitle) +
      stat('risk', t('fusion.risk'), r?.risk?.score ?? null, r?.risk ? riskBadge(r.risk) : '—');
    const missing = r ? r.missing.filter((m) => m !== '') : [];
    if (msg) html += `<p class="fu-msg small muted">${esc(msg)}</p>`;
    else if (missing.length) html += `<p class="fu-msg fu-missing small neg">${esc(t('fusion.missing', { ids: missing.join(', ') }))}</p>`;
    return html;
  }

  function renderStatus(s: AppState): string | null {
    if (!s.catalog) {
      const txt = s.catalogError ? t('fusion.catalogError', { err: s.catalogError }) : t('fusion.catalogLoading');
      statusEl.className = s.catalogError ? 'banner banner-err' : 'banner banner-info';
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
    exportBtn.disabled = copyBtn.disabled = clearBtn.disabled = s.fusion.length === 0;
    modesEl.innerHTML = t('fusion.note2', {
      cost: esc(t(s.settings.costMode === 'order' ? 'common.costOrder' : 'common.costInsta')),
      sell: esc(t(s.settings.sellMode === 'offer' ? 'common.sellOffer' : 'common.sellInsta')),
    });
    renderQuick(s);
    const msg = renderStatus(s);
    const calc = msg ? null : ctx.derived.calcCtx();
    const results = calc ? ctx.derived.fusion() : [];
    const resolve = getResolver(s);
    rows.forEach((row, i) => {
      const r = results[i] ?? null;
      const recipe = s.fusion[i];
      row.result = r;
      for (const term of TERMS)
        row.unit[term.item].innerHTML = calc && resolve && recipe ? unitHtml(termDetail(calc, recipe[term.item], term.side, resolve), term.side) : '';
      const incomplete = !!recipe && (!recipe.a.trim() || !recipe.b.trim() || !recipe.out.trim());
      row.res.innerHTML = resHtml(r, msg ?? (incomplete ? t('fusion.incomplete') : null));
      row.el.classList.toggle('fu-row-missing', !!r && !incomplete && r.missing.some((m) => m !== ''));
    });
    applyOrder();
  });

  // ------------------------------------------------------------------ export / import
  async function exportCopy(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(recipesToJson(state().fusion));
      ctx?.toast(t('common.copied'), 'ok');
    } catch {
      ctx?.toast(t('fusion.copyFail'), 'err');
    }
  }

  function openImport(): void {
    if (!importDrawer) importDrawer = buildImport();
    importDrawer.open();
  }

  function buildImport(): Drawer {
    const d = createDrawer({ title: () => t('fusion.importTitle') });
    const uidN = ++seq;
    const text = h('textarea', { class: 'fu-imp-text', rows: 10, spellcheck: 'false', 'data-testid': 'fusion-import-text' });
    const file = h('input', { type: 'file', accept: '.json,application/json,text/plain', 'data-testid': 'fusion-import-file' });
    const err = h('p', { class: 'fu-imp-err neg small', role: 'alert' });
    const radio = (value: string, label: string, checked: boolean) =>
      h('label', { class: 'check-row' }, h('input', { type: 'radio', name: `fu-imp-mode-${uidN}`, value, checked }), h('span', null, label));
    const go = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'fusion-import-go' }, t('fusion.importDo'));
    const cancel = h('button', { type: 'button', class: 'btn' }, t('fusion.cancel'));
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        text.value = await f.text();
        err.textContent = '';
      } catch {
        err.textContent = t('fusion.readFail');
      }
    });
    go.addEventListener('click', () => {
      const res = parseRecipesJson(text.value);
      if (!res.ok) {
        err.textContent =
          res.error === 'json'
            ? t('fusion.importErrJson', { err: res.detail ?? '' })
            : res.error === 'shape'
              ? t('fusion.importErrShape')
              : t('fusion.importErrEmpty');
        text.focus();
        return;
      }
      const replace = d.body.querySelector<HTMLInputElement>('input[type=radio][value=replace]')!.checked;
      importRecipes(res.recipes, replace);
      ctx?.toast(
        res.skipped ? t('fusion.importSkipped', { recipes: t('fusion.nRecipes', { n: res.recipes.length }), invalid: t('fusion.nInvalid', { n: res.skipped }) }) : t('fusion.importOk', { n: res.recipes.length }),
        res.skipped ? 'warn' : 'ok',
      );
      text.value = '';
      err.textContent = '';
      d.close();
    });
    cancel.addEventListener('click', () => d.close());
    d.body.append(
      h(
        'div',
        { class: 'fu-imp' },
        h('p', { class: 'small muted' }, t('fusion.importHelp')),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('fusion.importText')), text),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('fusion.importFile')), file),
        h(
          'fieldset',
          { class: 'fu-imp-mode' },
          h('legend', { class: 'field-label' }, t('fusion.importMode')),
          radio('append', t('fusion.importAppend'), true),
          radio('replace', t('fusion.importReplace'), false),
        ),
        err,
        h('div', { class: 'fu-imp-actions' }, go, cancel),
      ),
    );
    return d;
  }

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
    sortSel = h('select', { class: 'fu-sort', 'data-testid': 'fusion-sort' }, ...SORT_MODES.map((m) => h('option', { value: m }, t(`fusion.sort_${m}`))));
    sortSel.value = mode();
    sortSel.addEventListener('change', () => qs.set({ sort: sortSel.value }));
    sortHint = h('span', { class: 'fu-sort-hint small muted', role: 'status', hidden: true }, t('fusion.sortPaused'));
    const btn = (cls: string, label: string, onclick: () => void) => h('button', { type: 'button', class: `btn btn-sm ${cls}`, onclick }, label);
    const addBtn = btn('btn-primary fu-add', t('fusion.add'), () => addRecipe());
    exportBtn = btn('fu-export', t('fusion.exportJson'), () => downloadRecipes(state().fusion));
    copyBtn = btn('fu-copy', t('fusion.copyJson'), () => void exportCopy());
    const importBtn = btn('fu-import', t('fusion.importJson'), openImport);
    clearBtn = btn('btn-danger fu-clear', t('fusion.clear'), clearAll);
    statusEl = h('div', { class: 'banner banner-info', role: 'status', hidden: true });
    listEl = h('ol', { class: 'fu-list' });
    listEl.addEventListener('focusout', onListFocusOut);
    emptyEl = h('li', { class: 'card empty fu-empty' }, h('p', null, h('strong', null, t('fusion.emptyTitle'))), h('p', null, t('fusion.emptyHint')));
    modesEl = h('p');
    const note = h('details', { class: 'note fu-note' }, h('summary', null, t('fusion.noteTitle')));
    note.insertAdjacentHTML('beforeend', `<p>${t('fusion.note1')}</p>`);
    note.append(modesEl);
    note.insertAdjacentHTML('beforeend', `<p>${esc(t('fusion.note3'))}</p><p>${esc(t('fusion.note4'))}</p>`);

    root.replaceChildren(
      h(
        'section',
        { class: 'fusion-view' },
        h('header', { class: 'fu-top' }, h('h1', { tabindex: '-1' }, t('fusion.title')), h('p', { class: 'muted small' }, t('fusion.intro'))),
        statusEl,
        h(
          'div',
          { class: 'fu-toolbar', role: 'toolbar', 'aria-label': t('fusion.toolbarAria') },
          h('div', { class: 'fu-tb-left' }, countEl, h('label', { class: 'fu-sort-field' }, h('span', { class: 'field-label' }, t('fusion.sort')), sortSel), sortHint),
          h('div', { class: 'fu-tb-right' }, quickSel, addBtn, exportBtn, copyBtn, importBtn, clearBtn),
        ),
        listEl,
        note,
        datalist,
      ),
    );
    rows = [];
    rebuildRows();
    renderResults();
  }

  return {
    id: 'fusion',
    mount(el, c, route) {
      root = el;
      ctx = c;
      alive = true;
      qs = bindQueryState(SCHEMA, route, c.setQuery, LS_VIEWPREFS + 'fusion');
      render();
      cleanups.push(
        qs.onChange((v) => {
          if (sortSel.value !== v.sort) sortSel.value = v.sort;
          relabelRows();
          applyOrder(true);
        }),
        c.store.subscribe((s, prev) => {
          if (s.fusion !== prev.fusion) syncEditor();
          if (
            s.fusion !== prev.fusion ||
            s.snapshot !== prev.snapshot ||
            s.settings !== prev.settings ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.historyTick !== prev.historyTick
          )
            renderResults();
        }),
        onLangChange(() => {
          if (importDrawer && !importDrawer.isOpen()) {
            importDrawer.destroy();
            importDrawer = null;
          }
          render();
        }),
      );
    },
    update(route: Route) {
      if (root) qs.fromRoute(route);
    },
    unmount() {
      alive = false;
      for (const fn of cleanups.splice(0)) fn();
      importDrawer?.destroy();
      importDrawer = null;
      root?.replaceChildren();
      rows = [];
      resolver = null;
      root = null;
      ctx = null;
    },
  };
}
