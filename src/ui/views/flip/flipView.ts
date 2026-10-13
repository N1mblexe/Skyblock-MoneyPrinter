// Flip finder: buy low (buy order), sell high (sell offer) on the same bazaar product.
import { LS_VIEWPREFS } from '../../../config.ts';
import { catalogFromFile } from '../../../data/catalog.ts';
import { computeFlips } from '../../../domain/flip.ts';
import { matchesQuery } from '../../../domain/search.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import { lsGet, lsSet } from '../../../storage/local.ts';
import type { AppState, Catalog, FlipRow, Route, Settings, View, ViewContext } from '../../../types/contracts.ts';
import { itemCell, riskBadge } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtCompact, fmtHours, fmtInt, fmtPct } from '../../format.ts';
import { sparklineSvg } from '../../sparkline.ts';
import { createTable, type Column, type SortState, type TableHandle } from '../../table.ts';
import './flip.css';
import './i18n.ts';

export interface FlipPrefs {
  q: string;
  minVol: number;
  /** percent, e.g. 1 = 1% */
  minMargin: number;
  minPph: number;
  sort: SortState;
}

export const FLIP_PREFS_KEY = LS_VIEWPREFS + 'flip';
export const defaultFlipPrefs = (): FlipPrefs => ({
  q: '',
  minVol: 10_000,
  minMargin: 1,
  minPph: 0,
  sort: { key: 'pph', dir: 'desc' },
});

const finite = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function loadPrefs(): FlipPrefs {
  const d = defaultFlipPrefs();
  const raw = lsGet<Partial<FlipPrefs> | null>(FLIP_PREFS_KEY, null);
  if (!raw || typeof raw !== 'object') return d;
  const s = raw.sort;
  return {
    q: typeof raw.q === 'string' ? raw.q : d.q,
    minVol: finite(raw.minVol, d.minVol),
    minMargin: finite(raw.minMargin, d.minMargin),
    minPph: finite(raw.minPph, d.minPph),
    sort:
      s && typeof s.key === 'string' && (s.dir === 'asc' || s.dir === 'desc') ? { key: s.key, dir: s.dir } : d.sort,
  };
}

/** Settings fields that change computeFlips output (lang/theme/hideSuspicious don't). */
const calcKey = (s: Settings) => [s.taxRate, s.capital, s.share, s.cycleHours, s.costMode, s.sellMode].join('|');

let fallbackCatalog: Catalog | null = null;
/** Empty catalog (names derived from ids) used only when the real catalog failed to load. */
function emptyCatalog(): Catalog {
  return (fallbackCatalog ??= catalogFromFile({ v: 1, generatedAt: '', items: {}, recipes: [] }));
}

const signCls = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n === 0 ? '' : n > 0 ? 'pos' : 'neg');
const span = (cls: string, txt: string) => (cls ? `<span class="${cls}">${esc(txt)}</span>` : esc(txt));

export function createFlipView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext;
  let table: TableHandle<FlipRow> | null = null;
  const cleanups: (() => void)[] = [];
  let prefs = loadPrefs();
  let reveal = false;
  let emptyText = '';

  // memo of the expensive computeFlips() run
  let memo: { snap: unknown; catalog: unknown; calc: string; tick: number; rows: FlipRow[] } | null = null;
  // per-history-tick caches (sparkline + 24h change)
  let extraTick = -1;
  const sparkCache = new Map<string, string>();
  const changeCache = new Map<string, number | null>();

  // DOM refs
  let els: {
    banner: HTMLElement;
    msg: HTMLElement;
    count: HTMLElement;
    hiddenBtn: HTMLButtonElement;
    sortHint: HTMLElement;
    body: HTMLElement;
    labels: { el: HTMLElement; key: string }[];
    inputs: { q: HTMLInputElement; minVol: HTMLInputElement; minMargin: HTMLInputElement; minPph: HTMLInputElement };
    note: HTMLElement;
    title: HTMLElement;
    intro: HTMLElement;
  };

  const savePrefs = () => lsSet(FLIP_PREFS_KEY, prefs);

  function syncExtras(): void {
    const tick = ctx.store.get().historyTick;
    if (tick === extraTick) return;
    extraTick = tick;
    sparkCache.clear();
    changeCache.clear();
  }

  function change24h(id: string): number | null {
    if (!changeCache.has(id)) changeCache.set(id, ctx.history.stats(id)?.change24h ?? null);
    return changeCache.get(id)!;
  }

  function spark(id: string): string {
    let s = sparkCache.get(id);
    if (s == null) {
      const asks = ctx.history.recent(id).map((p) => p.ask);
      const fin = asks.filter((v) => Number.isFinite(v) && v > 0);
      const trend = fin.length >= 2 ? fin[fin.length - 1]! - fin[0]! : 0;
      s = sparklineSvg(asks, { w: 72, h: 20, cls: trend > 0 ? 'pos' : trend < 0 ? 'neg' : '' });
      sparkCache.set(id, s);
    }
    return s;
  }

  const columns: Column<FlipRow>[] = [
    {
      key: 'name',
      label: () => t('flip.col_item'),
      title: () => t('flip.tip_item'),
      get: (r) => r.name,
      html: (r) => itemCell(r.id, r.name, true),
      cls: 'name-cell',
    },
    {
      key: 'spark',
      label: () => t('flip.col_spark'),
      title: () => t('flip.tip_spark'),
      get: () => null,
      html: (r) => spark(r.id),
      sortable: false,
      align: 'center',
      cls: 'flip-spark',
    },
    { key: 'buyAt', label: () => t('flip.col_buyAt'), title: () => t('flip.tip_buyAt'), get: (r) => r.buyAt, html: (r) => fmtCoins(r.buyAt), align: 'right' },
    { key: 'sellAt', label: () => t('flip.col_sellAt'), title: () => t('flip.tip_sellAt'), get: (r) => r.sellAt, html: (r) => fmtCoins(r.sellAt), align: 'right' },
    {
      key: 'profit',
      label: () => t('flip.col_profit'),
      title: () => t('flip.tip_profit'),
      get: (r) => r.profit,
      html: (r) => span(signCls(r.profit), fmtCoins(r.profit)),
      align: 'right',
    },
    {
      key: 'margin',
      label: () => t('flip.col_margin'),
      title: () => t('flip.tip_margin'),
      get: (r) => r.margin,
      html: (r) => span(signCls(r.margin), fmtPct(r.margin)),
      align: 'right',
    },
    {
      key: 'change',
      label: () => t('flip.col_change'),
      title: () => t('flip.tip_change'),
      get: (r) => change24h(r.id),
      html: (r) => {
        const c = change24h(r.id);
        return span(signCls(c), c != null && c > 0 ? '+' + fmtPct(c) : fmtPct(c));
      },
      align: 'right',
    },
    { key: 'vol', label: () => t('flip.col_vol'), title: () => t('flip.tip_vol'), get: (r) => r.weekVol, html: (r) => fmtCompact(r.weekVol), align: 'right' },
    {
      key: 'comp',
      label: () => t('flip.col_comp'),
      title: () => t('flip.tip_comp'),
      get: (r) => r.compBuy + r.compSell,
      html: (r) => `${esc(fmtInt(r.compBuy))}<span class="muted"> / </span>${esc(fmtInt(r.compSell))}`,
      align: 'right',
    },
    {
      key: 'uph',
      label: () => t('flip.col_uph'),
      title: () => t('flip.tip_uph'),
      get: (r) => r.tp.unitsPerHour,
      html: (r) => esc(fmtCompact(r.tp.unitsPerHour)),
      align: 'right',
    },
    {
      key: 'capital',
      label: () => t('flip.col_capital'),
      title: () => t('flip.tip_capital'),
      get: (r) => r.tp.capitalUsed,
      html: (r) => esc(fmtCompact(r.tp.capitalUsed)),
      align: 'right',
    },
    {
      key: 'fill',
      label: () => t('flip.col_fill'),
      title: () => t('flip.tip_fill'),
      get: (r) => r.tp.fillHours,
      html: (r) => esc(fmtHours(r.tp.fillHours)),
      align: 'right',
    },
    {
      key: 'pph',
      label: () => t('flip.col_pph'),
      title: () => t('flip.tip_pph'),
      get: (r) => r.profitPerHour,
      html: (r) => `<strong>${span(signCls(r.profitPerHour), fmtCoins(r.profitPerHour))}</strong>`,
      align: 'right',
    },
    {
      key: 'risk',
      label: () => t('flip.col_risk'),
      title: () => t('flip.tip_risk'),
      get: (r) => r.risk.score,
      html: (r) => riskBadge(r.risk),
      align: 'center',
    },
  ];

  /** Expensive part: only when snapshot / catalog / calc settings / history change. */
  function computed(s: AppState): FlipRow[] | null {
    if (!s.snapshot) return null;
    const catalog = s.catalog ?? (s.catalogError ? emptyCatalog() : null);
    if (!catalog) return null;
    const calc = calcKey(s.settings);
    if (memo && memo.snap === s.snapshot && memo.catalog === catalog && memo.calc === calc && memo.tick === s.historyTick) {
      return memo.rows;
    }
    const rows = computeFlips({ snap: s.snapshot, catalog, settings: s.settings, stats: (id) => ctx.history.stats(id) });
    memo = { snap: s.snapshot, catalog, calc, tick: s.historyTick, rows };
    return rows;
  }

  function render(): void {
    if (!root || !table) return;
    const s = ctx.store.get();
    syncExtras();

    if (s.catalogError && !s.catalog) {
      els.banner.textContent = t('common.catalogError', { err: s.catalogError });
      els.banner.hidden = false;
    } else els.banner.hidden = true;

    const all = computed(s);
    if (!all) {
      els.msg.textContent = !s.snapshot ? t('common.waitingData') : t('flip.loadingNames');
      els.msg.hidden = false;
      els.body.hidden = true;
      els.count.textContent = '';
      els.hiddenBtn.hidden = true;
      return;
    }
    els.msg.hidden = true;
    els.body.hidden = false;

    const catalog = s.catalog;
    const minM = prefs.minMargin / 100;
    const hideSusp = s.settings.hideSuspicious && !reveal;
    const shown: FlipRow[] = [];
    let hidden = 0;
    for (const r of all) {
      if (r.weekVol < prefs.minVol || r.margin < minM || r.profitPerHour < prefs.minPph) continue;
      if (prefs.q && !matchesQuery(catalog, r.id, prefs.q)) continue;
      if (r.risk.level === 'suspect' && s.settings.hideSuspicious) {
        hidden++;
        if (hideSusp) continue;
      }
      shown.push(r);
    }

    els.count.textContent = t('flip.count', { n: fmtInt(shown.length) });
    if (hidden > 0) {
      els.hiddenBtn.hidden = false;
      els.hiddenBtn.textContent = reveal ? t('common.hideHidden') : t('common.hiddenCount', { n: hidden });
      els.hiddenBtn.title = reveal ? t('common.hideHidden') : t('common.showHidden');
      els.hiddenBtn.setAttribute('aria-pressed', String(reveal));
    } else els.hiddenBtn.hidden = true;
    emptyText = hidden > 0 && hideSusp ? t('flip.emptyHidden', { n: hidden }) : t('flip.empty');
    table.setRows(shown);
  }

  const schedule = rafDebounce(render);

  function applyLabels(): void {
    for (const { el, key } of els.labels) el.textContent = t(key);
    els.inputs.q.placeholder = t('flip.searchPh');
    els.title.textContent = t('flip.title');
    els.intro.textContent = t('flip.intro');
    els.sortHint.textContent = t('common.sortHint');
    els.note.innerHTML = ['noteHow', 'notePph', 'noteSettings'].map((k) => `<p>${t('flip.' + k)}</p>`).join('');
  }

  function numInput(key: 'minVol' | 'minMargin' | 'minPph', step: string): HTMLInputElement {
    const inp = h('input', {
      type: 'number',
      inputmode: 'decimal',
      step,
      'data-filter': key,
      'data-testid': `flip-${key}`,
      value: String(prefs[key]),
    });
    inp.addEventListener('input', () => {
      const v = inp.value.trim() === '' ? 0 : Number(inp.value);
      prefs = { ...prefs, [key]: Number.isFinite(v) ? v : 0 };
      savePrefs();
      schedule();
    });
    return inp;
  }

  function field(labelKey: string, input: HTMLElement, helpKey?: string): HTMLElement {
    const lab = h('span', { class: 'field-label' });
    els.labels.push({ el: lab, key: labelKey });
    const help = helpKey ? h('span', { class: 'field-help' }) : null;
    if (help && helpKey) els.labels.push({ el: help, key: helpKey });
    return h('label', { class: 'field' }, lab, input, help);
  }

  function setQuery(q: string): void {
    prefs = { ...prefs, q };
    if (els.inputs.q.value !== q) els.inputs.q.value = q;
    savePrefs();
    schedule();
  }

  return {
    id: 'flip',
    mount(el, c, route) {
      root = el;
      ctx = c;
      reveal = false;
      if (route.query?.q != null) prefs = { ...prefs, q: route.query.q };

      const q = h('input', { type: 'search', autocomplete: 'off', spellcheck: 'false', 'data-testid': 'flip-q', value: prefs.q });
      q.addEventListener('input', () => setQuery(q.value));

      els = {
        banner: h('div', { class: 'banner banner-warn', role: 'status', hidden: true }),
        msg: h('div', { class: 'empty', role: 'status', 'data-testid': 'flip-msg' }),
        count: h('span', { 'data-testid': 'flip-count' }),
        hiddenBtn: h('button', { type: 'button', class: 'hidden-count', 'data-testid': 'flip-hidden', hidden: true }),
        sortHint: h('span'),
        body: h('div', { class: 'flip-body' }),
        labels: [],
        inputs: {
          q,
          minVol: numInput('minVol', '1000'),
          minMargin: numInput('minMargin', '0.5'),
          minPph: numInput('minPph', '10000'),
        },
        note: h('div', { class: 'note' }),
        title: h('h2'),
        intro: h('p', { class: 'muted small flip-intro' }),
      };
      els.hiddenBtn.addEventListener('click', () => {
        reveal = !reveal;
        render();
      });

      table = createTable<FlipRow>({
        columns,
        rowKey: (r) => r.id,
        sort: prefs.sort,
        onRowClick: (r) => ctx.navigate({ id: 'item', param: r.id }),
        rowClass: (r) => (r.risk.level === 'ok' ? '' : `risk-row-${r.risk.level}`),
        emptyText: () => emptyText || t('flip.empty'),
        onSortChange: (s) => {
          prefs = { ...prefs, sort: s };
          savePrefs();
        },
      });

      const filters = h(
        'div',
        { class: 'filters' },
        field('flip.search', q),
        field('flip.minVol', els.inputs.minVol),
        field('flip.minMargin', els.inputs.minMargin),
        field('flip.minPph', els.inputs.minPph),
      );
      const toolbar = h('div', { class: 'toolbar' }, h('div', null, els.count, els.hiddenBtn), h('div', null, els.sortHint));
      els.body.append(toolbar, table.el);

      const section = h(
        'section',
        { class: 'flip-view', 'data-testid': 'flip-view' },
        h('div', { class: 'card flip-head' }, h('div', null, els.title, els.intro), filters),
        els.banner,
        els.msg,
        els.body,
        els.note,
      );
      applyLabels();
      el.append(section);

      cleanups.push(
        ctx.store.subscribe((s, prev) => {
          if (
            s.snapshot !== prev.snapshot ||
            s.settings !== prev.settings ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.historyTick !== prev.historyTick
          ) {
            schedule();
          }
        }),
        onLangChange(() => {
          applyLabels();
          render();
        }),
      );
      render();
    },
    update(route: Route) {
      if (!root) return;
      const q = route.query?.q;
      if (q != null && q !== prefs.q) setQuery(q);
    },
    unmount() {
      for (const fn of cleanups.splice(0)) fn();
      table?.destroy();
      table = null;
      memo = null;
      sparkCache.clear();
      changeCache.clear();
      if (root) root.replaceChildren();
      root = null;
    },
  };
}
