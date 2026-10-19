// Planner: #/plan. Allocates capital, order slots and shared market volume across opportunities (domain/optimizer
// allocate()). Inputs live in the URL (bindQueryState); capital / slots / max share / attention fall back to
// settings / OPTIMIZER. allocate() costs ~50-150 ms on ~3,000 opportunities: it runs in the plan worker
// (state/planClient.ts), input changes are debounced and results memoized on (opportunities identity, kinds, options).
import { LS_VIEWPREFS, OPTIMIZER } from '../../../config.ts';
import type { AllocateOptions } from '../../../domain/optimizer.ts';
import { msgText, onLangChange } from '../../../i18n/index.ts';
import { createPlanClient, type PlanClient } from '../../../state/planClient.ts';
import type { AppState, Opportunity, PlanResult, Route, View, ViewContext } from '../../../types/contracts.ts';
import { itemCell, riskBadge, riskFlagText } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtInt, fmtPct } from '../../format.ts';
import {
  bindQueryState,
  createDetailPanel,
  createFilterBar,
  createKitTable,
  type DetailPanel,
  type FilterBar,
  type KitColumn,
  type KitTableHandle,
  type QueryState,
} from '../../kit/index.ts';
import { filterKinds, KINDS, PLAN_SCHEMA, planCaps, planOptions, planRows, sourceHref, type PlanQuery, type PlanRow } from './model.ts';
import './plan.css';

/** Input debounce before re-running allocate() (ms). */
export const PLAN_DEBOUNCE_MS = 300;
/** Window event the shell may listen to for opening the settings drawer. */
export const OPEN_SETTINGS_EVENT = 'bm:open-settings';

const KIND_LABEL = { flip: 'kindFlip', craft: 'kindCraft', forge: 'kindForge', chain: 'kindChain', book: 'kindBook', npc: 'kindNpc', kat: 'kindKat', ahflip: 'kindAhflip' } as const;

interface Memo {
  opps: readonly Opportunity[];
  key: string;
  opts: AllocateOptions;
  filtered: readonly Opportunity[];
  res: PlanResult;
  rows: PlanRow[];
  suspectN: number;
}

export function createPlanView(): View {
  let ctx: ViewContext | null = null;
  let qs!: QueryState<PlanQuery>;
  let bar: FilterBar | null = null;
  let table: KitTableHandle<PlanRow> | null = null;
  let panel: DetailPanel | null = null;
  let root: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let memo: Memo | null = null;
  /** the plan requested from the client and not answered yet */
  let pending: { opps: readonly Opportunity[]; key: string } | null = null;
  /** the last kind filter (kept so the worker is sent the same array while only the options change) */
  let filt: { opps: readonly Opportunity[]; key: string; out: readonly Opportunity[] } | null = null;
  let client: PlanClient | null = null;
  let selected: string | null = null;
  /** rows last handed to the table (skip re-rendering identical results) */
  let shownRows: PlanRow[] | null = null;
  const cleanups: (() => void)[] = [];

  // keys without a namespace are 'plan.' keys; 'common.x' etc. pass through
  const t = (k: string, p?: Record<string, string | number>) => ctx!.t(k.includes('.') ? k : `plan.${k}`, p);
  const st = (): AppState => ctx!.store.get();

  // persistent pieces
  let titleEl!: HTMLElement;
  let introEl!: HTMLElement;
  let fillText!: HTMLElement;
  let settingsBtn!: HTMLButtonElement;
  let msgEl!: HTMLElement;
  let summaryEl!: HTMLElement;
  let computingEl!: HTMLElement;
  let suspectEl!: HTMLElement;
  let disclaimerEl!: HTMLElement;

  // ---------------------------------------------------------------- compute
  const keyOf = (v: PlanQuery, o: AllocateOptions) =>
    JSON.stringify([KINDS.map((k) => v[k]), v.ah, o.capital, o.slots, o.maxShare, o.excludeSuspect, o.attention]);

  function wanted(): { opps: readonly Opportunity[]; v: PlanQuery; opts: AllocateOptions; key: string } {
    const opps = ctx!.derived.opportunities();
    const v = qs.get();
    const opts = planOptions(v, st().settings, planCaps(ctx!.derived.calcCtx(), opps));
    return { opps, v, opts, key: keyOf(v, opts) };
  }

  const isStale = () => {
    const w = wanted();
    return !memo || memo.opps !== w.opps || memo.key !== w.key;
  };

  function filtered(opps: readonly Opportunity[], v: PlanQuery): readonly Opportunity[] {
    const key = JSON.stringify([KINDS.map((k) => v[k]), v.ah]);
    if (!filt || filt.opps !== opps || filt.key !== key) filt = { opps, key, out: filterKinds(opps, v) };
    return filt.out;
  }

  /**
   * Ask the plan client for the wanted plan (once per inputs). Returns true when the plan is in `memo` now (inline
   * client); otherwise `memo` is set, and the view redrawn, when the worker answers.
   */
  function compute(): boolean {
    const w = wanted();
    if (memo && memo.opps === w.opps && memo.key === w.key) {
      pending = null; // an answer still in flight is for other inputs now
      return true;
    }
    if (pending && pending.opps === w.opps && pending.key === w.key) return false;
    const req = (pending = { opps: w.opps, key: w.key });
    const list = filtered(w.opps, w.v);
    let sync = true;
    client!.request(list, w.opts, (res) => {
      if (pending !== req) return;
      pending = null;
      memo = {
        opps: w.opps,
        key: w.key,
        opts: w.opts,
        filtered: list,
        res,
        rows: planRows(res, w.opts),
        suspectN: w.opts.excludeSuspect ? list.reduce((n, o) => n + (o.risk.level === 'suspect' ? 1 : 0), 0) : 0,
      };
      if (!sync && ctx) {
        setComputing(false);
        draw();
      }
    });
    sync = false;
    return memo?.key === w.key && memo.opps === w.opps;
  }

  function setComputing(on: boolean): void {
    computingEl.hidden = !on;
    table?.el.setAttribute('aria-busy', String(on));
  }

  /** Recompute after `delay` ms (input debounce); the "computing" state shows until the plan is in. */
  function requestCompute(delay: number): void {
    setComputing(true);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!ctx) return;
      if (compute()) {
        setComputing(false);
        draw();
      }
    }, delay);
  }

  /** Store changed: recompute (next tick, so "computing" paints) only when the plan's inputs changed. */
  function onStoreChange(): void {
    if (!ctx) return;
    if (timer) return; // a pending compute will draw
    if (st().snapshot && st().catalog && isStale()) requestCompute(0);
    else draw();
  }

  // ---------------------------------------------------------------- rendering
  function relabel(): void {
    titleEl.textContent = t('title');
    introEl.textContent = t('intro');
    settingsBtn.textContent = t('openSettings');
    computingEl.textContent = t('computing');
    summaryEl.setAttribute('aria-label', t('summaryAria'));
    disclaimerEl.textContent = t('disclaimer');
    bar?.el.setAttribute('aria-label', t('inputsAria'));
  }

  function meter(label: string, used: number, avail: number, fmt: (n: number) => string, testid: string): string {
    const finite = avail > 0 && Number.isFinite(avail);
    const ratio = finite ? Math.min(1, used / avail) : 0;
    const text = t('ofAvail', { used: fmt(used), avail: finite ? fmt(avail) : t('unlimited') });
    const range = finite
      ? `aria-valuemin="0" aria-valuemax="${avail}" aria-valuenow="${Math.min(used, avail)}"`
      : `aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"`;
    return (
      `<div class="plan-stat plan-stat-meter"><span class="plan-stat-l">${esc(label)}</span>` +
      `<span class="plan-stat-v num">${esc(text)}</span>` +
      `<div class="plan-bar${ratio >= 0.999 ? ' is-full' : ''}" data-testid="${testid}" role="meter" aria-label="${esc(label)}" ${range} aria-valuetext="${esc(text)}">` +
      `<span class="plan-bar-fill" style="width:${(ratio * 100).toFixed(1)}%"></span></div></div>`
    );
  }

  function renderSummary(m: Memo): void {
    const { res, opts } = m;
    const capAvail = opts.capital > 0 ? opts.capital : Infinity;
    const hints: string[] = [];
    if (res.allocations.length && Number.isFinite(capAvail) && res.capitalUsed >= capAvail * 0.999) hints.push(t('capitalFull'));
    if (res.allocations.length && res.slotsUsed >= opts.slots) hints.push(t('slotsFull'));
    summaryEl.innerHTML =
      `<div class="plan-stat plan-stat-pph"><span class="plan-stat-l">${esc(t('pph'))}</span>` +
      `<span class="plan-stat-v num ${res.profitPerHour > 0 ? 'pos' : ''}" data-testid="plan-pph">${esc(fmtCoins(res.profitPerHour))}</span></div>` +
      meter(t('capitalUsed'), res.capitalUsed, capAvail, fmtCoins, 'plan-cap-bar') +
      meter(t('slotsUsed'), res.slotsUsed, opts.slots, fmtInt, 'plan-slot-bar') +
      `<div class="plan-stat"><span class="plan-stat-l">${esc(t('positions'))}</span>` +
      `<span class="plan-stat-v num" data-testid="plan-positions">${esc(fmtInt(res.allocations.length))}</span>` +
      `<span class="small muted">${esc(t('oppsCount', { n: fmtInt(m.filtered.length) }))}</span></div>` +
      (hints.length ? `<p class="plan-hints small muted">${hints.map(esc).join(' ')}</p>` : '');
  }

  function renderSuspect(m: Memo): void {
    suspectEl.hidden = m.suspectN === 0;
    if (!m.suspectN) return;
    suspectEl.innerHTML =
      `<span>${esc(t('suspectHidden', { n: m.suspectN }))}</span> ` +
      `<button type="button" class="hidden-count" data-testid="plan-include-suspect">${esc(t('showSuspect'))}</button>`;
  }

  function renderSettingsLine(): void {
    const fm = st().settings.fillModel;
    fillText.textContent = t('fillModel', { v: ctx!.t(fm === 'pipelined' ? 'common.fillPipelined' : 'common.fillSequential') });
  }

  function draw(): void {
    if (!ctx || !table) return;
    const s = st();
    renderSettingsLine();
    bar?.refresh(); // help texts show the current settings defaults
    let msg = '';
    if (!s.snapshot) msg = t('waiting');
    else if (!s.catalog) msg = s.catalogError ? t('catalogError', { err: msgText(s.catalogError) }) : t('catalogLoading');
    msgEl.hidden = !msg;
    msgEl.textContent = msg;
    summaryEl.hidden = !!msg;
    table.el.hidden = !!msg;
    if (msg) {
      suspectEl.hidden = true;
      panel?.close();
      return;
    }
    if (timer) return; // results are about to change; keep showing the previous ones
    if (isStale() && !compute()) setComputing(true); // the worker answers later; keep showing the previous plan
    const m = memo;
    if (!m) {
      summaryEl.hidden = true;
      return;
    }
    renderSummary(m);
    renderSuspect(m);
    if (shownRows !== m.rows) {
      shownRows = m.rows;
      table.setRows(m.rows);
    }
    if (selected) {
      const row = m.rows.find((r) => r.key === selected);
      if (row) {
        table.setSelected(row.key);
        panel?.open(row.opp.name, detailHtml(row, m));
      } else panel?.close();
    }
  }

  // ---------------------------------------------------------------- why / detail
  const pctOf = (o: AllocateOptions) => Math.round(Math.min(1, Math.max(0, o.maxShare)) * 1000) / 10;

  function whyShort(r: PlanRow, o: AllocateOptions): string {
    const rank = r.rank === 1 ? t('whyBest') : t('whyRank', { n: r.rank });
    return `${rank} · ${t(`why_${whyKey(r)}`, { pct: pctOf(o) })}`;
  }

  function whyLong(r: PlanRow, o: AllocateOptions): string {
    return t(`whyLong_${whyKey(r)}`, { pct: pctOf(o), n: fmtInt(Math.floor(r.opp.maxUnits)), res: r.market ? marketName(r.market) : '' });
  }

  /** "Wheat insta-sells" for `WHEAT:bid` (a ResourceKey). */
  function marketName(key: string): string {
    if (key === 'forge') return t('res_forge');
    const i = key.lastIndexOf(':');
    const id = key.slice(0, i);
    return t(`res_${key.slice(i + 1)}`, { name: st().catalog?.name(id) ?? id });
  }

  /** A Kat run's volume bound is Kat itself: one pet per upgrade. */
  const whyKey = (r: PlanRow): string => (r.opp.kind === 'kat' && r.bound === 'volume' ? 'kat' : r.bound);

  function kindBadge(k: Opportunity['kind']): string {
    return `<span class="badge plan-kind plan-kind-${k}">${esc(t(KIND_LABEL[k]))}</span>`;
  }

  function detailHtml(r: PlanRow, m: Memo): string {
    const kv = (rows: [string, string, string][]) =>
      `<dl class="kv">${rows.map(([k, v, key]) => `<dt>${esc(k)}</dt><dd data-k="${key}">${v}</dd>`).join('')}</dl>`;
    const o = r.opp;
    const a = r.alloc;
    // the pipelined overlap is in unitCost already (planInputs): the coins tied up exceed the buy cost when it applied
    const buyCost = o.buyCost != null && o.buyCost > 0 ? o.buyCost : o.unitCost;
    const doubled = o.unitCost > buyCost * (1 + 1e-9);
    const flags = o.risk.flags.length
      ? `<ul class="plan-flags">${o.risk.flags.map((f) => `<li><span class="mono small muted">${esc(f)}</span> ${esc(riskFlagText(f))}</li>`).join('')}</ul>`
      : `<p class="note small">${esc(t('dRiskNone'))}</p>`;
    const tab = t(`tab_${o.kind}`);
    return (
      `<div class="plan-detail" data-testid="plan-detail">` +
      `<p class="plan-detail-badges">${kindBadge(o.kind)} ${riskBadge(o.risk)} <span class="id-sub">${esc(o.id)}</span></p>` +
      `<p class="plan-detail-links"><a class="btn btn-sm" data-testid="plan-source" href="${esc(sourceHref(o))}">${esc(t('openSource', { tab }))} →</a> ` +
      // a Kat run's id is an AH pet key: no item page, and the journal logs items, not a buy + upgrade + sell run
      (o.kind === 'kat'
        ? ''
        : `<a class="btn btn-sm btn-ghost" href="#/item/${encodeURIComponent(o.id)}">${esc(t('openItem'))} →</a> ` +
          // sell is the net per unit (after tax and fees), so the journal entry is logged untaxed
          `<a class="btn btn-sm btn-ghost" data-testid="plan-log" href="#/trades?${new URLSearchParams({ view: 'journal', add: o.id, qty: String(Math.max(1, Math.round(a.units))), buy: String(Math.round(buyCost * 10) / 10), sell: String(Math.round((buyCost + o.profitPerUnit) * 10) / 10), tax: '0', src: 'plan' })}">${esc(t('logTrade'))} →</a>`) +
      `</p>` +
      `<h3>${esc(t('detailAlloc'))}</h3>` +
      kv([
        [t('dUnits'), esc(fmtInt(a.units)), 'units'],
        [t('dCapital'), esc(fmtCoins(a.capital)), 'capital'],
        [t('dCapitalShare'), esc(r.capitalShare == null ? '—' : fmtPct(r.capitalShare)), 'capitalShare'],
        [t('dSlots'), esc(fmtInt(a.slots)), 'slots'],
        [t('dPph'), esc(fmtCoins(a.profitPerHour)), 'pph'],
        [t('dProfitShare'), esc(fmtPct(r.profitShare)), 'profitShare'],
        [t('dPerCoin'), esc(fmtPct(r.perCoin, 2)), 'perCoin'],
      ]) +
      `<p class="note small" data-testid="plan-why-long">${t('whyLine', { why: esc(t('dWhy')), short: esc(whyShort(r, m.opts)), long: esc(whyLong(r, m.opts)) })}</p>` +
      `<h3>${esc(t('detailOpp'))}</h3>` +
      kv([
        [t('dUnitCost'), esc(fmtCoins(o.unitCost)), 'unitCost'],
        [t('dProfitUnit'), esc(fmtCoins(o.profitPerUnit)), 'profitPerUnit'],
        [t('dMargin'), esc(fmtPct(buyCost > 0 ? o.profitPerUnit / buyCost : null)), 'margin'],
        [t('dUph'), esc(fmtInt(o.unitsPerHour)), 'unitsPerHour'],
        [t('dMaxUnits'), esc(fmtInt(o.maxUnits)), 'maxUnits'],
        [t('dOppSlots'), esc(fmtInt(o.slots)), 'oppSlots'],
        [t('dOppPph'), esc(fmtCoins(o.profitPerUnit * o.unitsPerHour)), 'oppPph'],
      ]) +
      (doubled ? `<p class="note small">${esc(t('dUnitCostPipe'))}</p>` : '') +
      `<h3>${esc(t('dRiskFlags'))}</h3>${flags}</div>`
    );
  }

  function openDetail(r: PlanRow): void {
    if (!memo || !table || !panel) return;
    selected = r.key;
    table.setSelected(r.key);
    panel.open(r.opp.name, detailHtml(r, memo));
  }

  // ---------------------------------------------------------------- table
  function columns(): KitColumn<PlanRow>[] {
    const o = () => memo?.opts ?? planOptions(qs.get(), st().settings);
    return [
      {
        key: 'item',
        label: () => t('colItem'),
        get: (r) => r.opp.name,
        html: (r) => itemCell(r.opp.id, r.opp.name, r.opp.kind !== 'kat'),
        csv: (r) => r.opp.id,
        cls: 'name-cell',
        priority: 0,
      },
      { key: 'kind', label: () => t('colKind'), get: (r) => t(KIND_LABEL[r.opp.kind]), html: (r) => kindBadge(r.opp.kind), priority: 1 },
      { key: 'units', label: () => t('colUnits'), get: (r) => r.alloc.units, html: (r) => esc(fmtInt(r.alloc.units)), align: 'right', priority: 2 },
      { key: 'capital', label: () => t('colCapital'), get: (r) => r.alloc.capital, html: (r) => esc(fmtCoins(r.alloc.capital)), align: 'right', priority: 1 },
      { key: 'slots', label: () => t('colSlots'), get: (r) => r.alloc.slots, html: (r) => esc(fmtInt(r.alloc.slots)), align: 'right', priority: 3 },
      {
        key: 'pph',
        label: () => t('colPph'),
        get: (r) => r.alloc.profitPerHour,
        html: (r) => `<span class="pos">${esc(fmtCoins(r.alloc.profitPerHour))}</span>`,
        align: 'right',
        priority: 1,
      },
      {
        key: 'share',
        label: () => t('colShare'),
        get: (r) => r.profitShare,
        html: (r) => esc(fmtPct(r.profitShare)),
        csv: (r) => Math.round(r.profitShare * 10_000) / 10_000,
        align: 'right',
        priority: 2,
      },
      { key: 'risk', label: () => t('colRisk'), get: (r) => r.opp.risk.score, html: (r) => riskBadge(r.opp.risk), csv: (r) => t(`risk.${r.opp.risk.level}`), priority: 2 },
      {
        key: 'why',
        label: () => t('colWhy'),
        title: () => t('colWhyTitle'),
        get: (r) => r.rank,
        html: (r) => `<span class="plan-why" data-bound="${r.bound}" title="${esc(whyLong(r, o()))}">${esc(whyShort(r, o()))}</span>`,
        csv: (r) => whyShort(r, o()),
        priority: 3,
      },
    ];
  }

  function watchBtn(r: PlanRow): string {
    // the watchlist holds bazaar / AH item ids, not Kat runs
    if (r.opp.kind === 'kat') return '';
    const on = ctx!.watch.has(r.opp.id);
    const label = on ? t('unwatch') : t('watch');
    return `<button type="button" class="btn btn-ghost btn-sm plan-star" data-action="watch" aria-pressed="${on}" aria-label="${esc(
      t(on ? 'common.unwatchItem' : 'common.watchItem', { name: r.opp.name }),
    )}" title="${esc(label)}">${on ? '★' : '☆'}</button>`;
  }

  // ---------------------------------------------------------------- build
  function build(el: HTMLElement, c: ViewContext, route: Route): void {
    qs = bindQueryState(PLAN_SCHEMA, route, c.setQuery, LS_VIEWPREFS + 'plan');
    const set = () => st().settings;
    bar = createFilterBar(
      [
        { kind: 'number', key: 'capital', label: () => t('capital'), help: () => t('fromSettings', { v: fmtCoins(set().capital) }) },
        { kind: 'number', key: 'slots', label: () => t('slots'), help: () => t('fromSettings', { v: fmtInt(set().orderSlots) }) },
        {
          kind: 'number',
          key: 'share',
          label: () => t('share'),
          help: () => t('fromDefault', { v: fmtInt(OPTIMIZER.maxShareOfCapitalPerItem * 100) }),
          suffix: '%',
        },
        {
          kind: 'number',
          key: 'attention',
          label: () => t('attention'),
          help: () => `${t('fromDefault', { v: fmtCoins(OPTIMIZER.attentionPerPosition) })}. ${t('attentionHelp')}`,
        },
        { kind: 'toggle', key: 'suspect', label: () => t('suspect') },
        ...KINDS.map((k) => ({ kind: 'toggle' as const, key: k, label: () => t(KIND_LABEL[k]) })),
        { kind: 'toggle', key: 'ah', label: () => t('includeAh') },
      ],
      qs,
    );
    bar.el.setAttribute('role', 'group');

    panel = createDetailPanel({ returnFocus: () => table?.el.querySelector<HTMLElement>('[tabindex="0"]') ?? null });
    table = createKitTable<PlanRow>({
      columns: columns(),
      rowKey: (r) => r.key,
      sort: qs.get().sort,
      onSortChange: (sort) => qs.set({ sort }),
      onActivate: openDetail,
      columnsKey: 'plan',
      toolbar: { columns: true, exportName: 'plan' },
      rowActions: watchBtn,
      onRowAction: (action, r) => {
        if (action === 'watch') ctx?.watch.toggle(r.opp.id);
      },
      emptyText: () => (memo && memo.filtered.length === 0 ? t('emptyNoOpps') : t('empty')),
    });
    cleanups.push(
      panel.onClose(() => {
        selected = null;
        table?.setSelected(null);
      }),
    );

    titleEl = h('h1', { class: 'plan-title' });
    introEl = h('p', { class: 'note small plan-intro' });
    fillText = h('span');
    settingsBtn = h('button', { type: 'button', class: 'link', 'data-testid': 'plan-settings' });
    settingsBtn.addEventListener('click', () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT)));
    const settingsLine = h('p', { class: 'small muted plan-settings-line', 'data-testid': 'plan-fill' }, fillText, ' · ', settingsBtn);
    computingEl = h('span', { class: 'plan-computing small', role: 'status', hidden: true, 'data-testid': 'plan-computing' });
    msgEl = h('p', { class: 'banner banner-info plan-msg', hidden: true, 'data-testid': 'plan-msg' });
    summaryEl = h('section', { class: 'plan-summary', 'data-testid': 'plan-summary' });
    suspectEl = h('p', { class: 'small muted plan-suspect', hidden: true });
    suspectEl.addEventListener('click', (ev) => {
      if ((ev.target as Element).closest?.('[data-testid="plan-include-suspect"]')) qs.set({ suspect: false });
    });
    disclaimerEl = h('p', { class: 'note small plan-disclaimer', 'data-testid': 'plan-disclaimer' });

    const head = h('header', { class: 'plan-head' }, h('div', { class: 'plan-head-row' }, titleEl, computingEl), introEl);
    const view = h(
      'div',
      { class: 'plan-view kit-split', 'data-testid': 'plan-view' },
      head,
      bar.el,
      settingsLine,
      msgEl,
      summaryEl,
      suspectEl,
      table.el,
      disclaimerEl,
      panel.el,
    );
    el.append(view);
    root = view;

    cleanups.push(
      qs.onChange((v) => {
        const cur = table!.getSort();
        if (!cur || cur.key !== v.sort.key || cur.dir !== v.sort.dir) table!.setSort(v.sort);
        if (st().snapshot && st().catalog && isStale()) requestCompute(PLAN_DEBOUNCE_MS);
      }),
    );
  }

  const schedule = rafDebounce(onStoreChange);

  return {
    id: 'plan',
    mount(el, c, route) {
      ctx = c;
      client = createPlanClient();
      build(el, c, route);
      relabel();
      draw(); // first plan synchronously

      cleanups.push(
        c.store.subscribe((s, prev) => {
          if (
            s.snapshot !== prev.snapshot ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.settings !== prev.settings ||
            s.historyTick !== prev.historyTick ||
            s.ah !== prev.ah ||
            s.ahSales !== prev.ahSales ||
            s.election !== prev.election
          ) {
            schedule();
          }
          if (s.watchlist !== prev.watchlist) table?.refresh();
        }),
        onLangChange(() => {
          relabel();
          bar?.refresh();
          table?.refresh();
          draw();
        }),
      );
    },
    update(route: Route) {
      qs.fromRoute(route);
    },
    unmount() {
      if (timer) clearTimeout(timer);
      timer = null;
      client?.dispose();
      client = null;
      pending = null;
      filt = null;
      for (const fn of cleanups.splice(0)) fn();
      panel?.destroy();
      bar?.destroy();
      table?.destroy();
      root?.remove();
      panel = null;
      bar = null;
      table = null;
      root = null;
      memo = null;
      shownRows = null;
      selected = null;
      ctx = null;
    },
  };
}
