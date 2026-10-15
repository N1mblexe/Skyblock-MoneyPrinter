// Overview dashboard: compact cards summarising every tool, each linking to its full page.
import { LS_VIEWPREFS, OPTIMIZER, STATS } from '../../../config.ts';
import { msgText, onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, PlanResult, Route, View, ViewContext } from '../../../types/contracts.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtAge, fmtCoins, fmtCompact, fmtInt, fmtPct } from '../../format.ts';
import { bindQueryState, type QuerySchema, type QueryState, type QueryValues } from '../../kit/index.ts';
import { sparklineSvg } from '../../sparkline.ts';
import { logMessage } from '../watch/alertText.ts';
import './overview.css';
import { mostConsistent, movers, planSummary, topBooks, topCrafts, topFlips, type Mover, type MoverWindow } from './select.ts';

const SCHEMA = {
  mw: { kind: 'enum', def: '1h', values: ['1h', '24h'] },
} as const satisfies QuerySchema;

/** rows per top list */
export const TOP_N = 8;
/** rows per movers side */
export const MOVERS_N = 5;
export const WATCH_N = 8;
export const ALERTS_N = 6;
/** re-render period for ages ("data 40 s old") */
export const TICK_MS = 15_000;

type CardKey = 'flips' | 'crafts' | 'forges' | 'books' | 'movers' | 'consistent' | 'plan' | 'watch' | 'alerts' | 'election' | 'market';

interface Card {
  key: CardKey;
  /** full page for this card; null = no dedicated page (plain title) */
  href: string | null;
  desc: () => string;
  body: () => string;
}

interface CardEls {
  title: HTMLElement;
  desc: HTMLElement;
  body: HTMLElement;
}

const signCls = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n === 0 ? '' : n > 0 ? 'pos' : 'neg');
const span = (cls: string, txt: string) => (cls ? `<span class="${cls}">${esc(txt)}</span>` : esc(txt));
const signedPct = (n: number) => (n > 0 ? '+' : '') + fmtPct(n);
const itemLink = (id: string, name: string) => `<a class="ov-item" href="#/item/${encodeURIComponent(id)}">${esc(name)}</a>`;
const empty = (msg: string) => `<p class="ov-empty">${esc(msg)}</p>`;

/** Compact table: headers [label, numeric?], rows of cell HTML (cell 0 is the item). */
function mini(head: [string, boolean][], rows: string[][]): string {
  const th = head.map(([l, num]) => `<th scope="col"${num ? ' class="num"' : ''}>${esc(l)}</th>`).join('');
  const tr = rows.map((cells) => `<tr>${cells.map((c, i) => `<td${head[i]?.[1] ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('');
  return `<table class="ov-mini"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function kv(rows: [string, string, string?][]): string {
  return `<dl class="kv ov-kv">${rows.map(([k, v, key]) => `<dt>${esc(k)}</dt><dd${key ? ` data-k="${key}"` : ''}>${v}</dd>`).join('')}</dl>`;
}

export function createOverviewView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext;
  let qs: QueryState<QueryValues<typeof SCHEMA>>;
  const cleanups: (() => void)[] = [];
  const cardEls = new Map<CardKey, CardEls>();
  /** last body HTML per card */
  const bodyHtml = new Map<CardKey, string>();
  let planMemo: { opps: unknown; capital: number; slots: number; plan: PlanResult } | null = null;
  let segBtns: HTMLButtonElement[] = [];
  let segGroup: HTMLElement;
  let els: { title: HTMLElement; intro: HTMLElement; banner: HTMLElement };

  const st = (): AppState => ctx.store.get();
  const name = (id: string) => st().catalog?.name(id) ?? id;

  /** Message for cards that need the snapshot (and the catalog when `catalog`); null when ready. */
  function notReady(catalog: boolean): string | null {
    const s = st();
    if (!s.snapshot) return empty(t('overview.waiting'));
    if (catalog && !s.catalog) return empty(s.catalogError ? t('overview.noCatalog') : t('overview.loadingCatalog'));
    return null;
  }

  function plan(): PlanResult {
    const s = st();
    const opps = ctx.derived.opportunities();
    if (!planMemo || planMemo.opps !== opps || planMemo.capital !== s.settings.capital || planMemo.slots !== s.settings.orderSlots) {
      planMemo = { opps, capital: s.settings.capital, slots: s.settings.orderSlots, plan: planSummary(opps, s.settings) };
    }
    return planMemo.plan;
  }

  const H_ITEM = (): [string, boolean] => [t('overview.col_item'), false];
  const H_PPH = (): [string, boolean] => [t('overview.col_pph'), true];
  const H_MARGIN = (): [string, boolean] => [t('overview.col_margin'), true];

  const cards: Card[] = [
    {
      key: 'flips',
      href: '#/flip',
      desc: () => t('overview.d_flips', { n: TOP_N }),
      body: () => {
        const nr = notReady(true);
        if (nr) return nr;
        const rows = topFlips(ctx.derived.flips(), TOP_N);
        if (!rows.length) return empty(t('overview.e_flips'));
        return mini(
          [H_ITEM(), H_MARGIN(), H_PPH()],
          rows.map((r) => [itemLink(r.id, r.name), esc(fmtPct(r.margin)), `<strong>${span('pos', fmtCoins(r.profitPerHour))}</strong>`]),
        );
      },
    },
    {
      key: 'crafts',
      href: '#/craft',
      desc: () => t('overview.d_crafts', { n: TOP_N }),
      body: () => {
        const nr = notReady(true);
        if (nr) return nr;
        const rows = topCrafts(ctx.derived.crafts(), TOP_N, 'craft');
        if (!rows.length) return empty(t('overview.e_crafts'));
        return mini(
          [H_ITEM(), H_MARGIN(), H_PPH()],
          rows.map((r) => [itemLink(r.id, r.name), esc(fmtPct(r.margin)), `<strong>${span('pos', fmtCoins(r.profitPerHour))}</strong>`]),
        );
      },
    },
    {
      key: 'forges',
      href: '#/forge',
      desc: () => t('overview.d_forges', { n: TOP_N }),
      body: () => {
        const nr = notReady(true);
        if (nr) return nr;
        const rows = topCrafts(ctx.derived.crafts(), TOP_N, 'forge');
        if (!rows.length) return empty(t('overview.e_forges'));
        return mini(
          [H_ITEM(), H_MARGIN(), H_PPH()],
          rows.map((r) => [itemLink(r.id, r.name), esc(fmtPct(r.margin)), `<strong>${span('pos', fmtCoins(r.profitPerHour))}</strong>`]),
        );
      },
    },
    {
      key: 'books',
      href: '#/books',
      desc: () => t('overview.d_books'),
      body: () => {
        const nr = notReady(true);
        if (nr) return nr;
        const rows = topBooks(ctx.derived.books(), TOP_N);
        if (!rows.length) return empty(t('overview.e_books'));
        return mini(
          [H_ITEM(), H_MARGIN(), H_PPH()],
          rows.map((r) => [
            itemLink(r.id, r.name) + `<span class="id-sub">${esc(t('books.chainCell', { k: r.fromLevel, l: r.toLevel, n: r.count }))}</span>`,
            esc(fmtPct(r.margin)),
            `<strong>${span('pos', fmtCoins(r.profitPerHour))}</strong>`,
          ]),
        );
      },
    },
    {
      key: 'movers',
      href: null,
      desc: () => t('overview.d_movers', { vol: fmtCompact(STATS.moversMinWeekVol) }),
      body: () => {
        const nr = notReady(false);
        if (nr) return nr;
        const win = qs.get().mw as MoverWindow;
        const m = movers(ctx.derived.marketStats(), st().snapshot!, win, MOVERS_N);
        if (!m.known) return empty(t(win === '1h' ? 'overview.e_movers1h' : 'overview.e_movers24h'));
        const side = (key: string, list: Mover[]) =>
          `<div class="ov-side"><h3>${esc(t(key))}</h3>` +
          (list.length
            ? mini(
                [H_ITEM(), [t('overview.col_change'), true]],
                list.map((x) => [itemLink(x.id, name(x.id)), span(signCls(x.change), signedPct(x.change))]),
              )
            : empty(t('overview.e_moversSide'))) +
          `</div>`;
        return `<div class="ov-sides">${side('overview.moversUp', m.up)}${side('overview.moversDown', m.down)}</div>`;
      },
    },
    {
      key: 'consistent',
      href: '#/flip',
      desc: () => t('overview.d_consistent'),
      body: () => {
        const nr = notReady(true);
        if (nr) return nr;
        const rows = mostConsistent(ctx.derived.flips(), ctx.derived.marketStats(), TOP_N);
        if (!rows.length) return empty(t('overview.e_consistent', { n: STATS.consistencyMinPoints, h: STATS.consistencyMinPoints / 4 }));
        return mini(
          [H_ITEM(), [t('overview.col_consistency'), true], H_PPH()],
          rows.map((r) => [itemLink(r.row.id, r.row.name), esc(fmtPct(r.consistency, 0)), span('pos', fmtCoins(r.row.profitPerHour))]),
        );
      },
    },
    {
      key: 'plan',
      href: '#/plan',
      desc: () => t('overview.d_plan', { share: Math.round(OPTIMIZER.maxShareOfCapitalPerItem * 100) }),
      body: () => {
        const nr = notReady(true);
        if (nr) return nr;
        const p = plan();
        const s = st().settings;
        if (!p.allocations.length) return empty(t('overview.e_plan'));
        const top = [...p.allocations].sort((a, b) => b.profitPerHour - a.profitPerHour).slice(0, 3);
        return (
          kv([
            [t('overview.plan_pph'), `<strong class="pos" data-v="${p.profitPerHour}">${esc(fmtCoins(p.profitPerHour))}</strong>`, 'pph'],
            [
              t('overview.plan_capital'),
              `<span data-v="${p.capitalUsed}">${esc(t('overview.ofTotal', { a: fmtCompact(p.capitalUsed), b: fmtCompact(s.capital) }))}</span>`,
              'capital',
            ],
            [t('overview.plan_slots'), `<span data-v="${p.slotsUsed}">${esc(t('overview.ofTotal', { a: fmtInt(p.slotsUsed), b: fmtInt(s.orderSlots) }))}</span>`, 'slots'],
            [t('overview.plan_picks'), `<span data-v="${p.allocations.length}">${esc(fmtInt(p.allocations.length))}</span>`, 'picks'],
          ]) +
          `<h3 class="ov-sub">${esc(t('overview.plan_top'))}</h3>` +
          mini(
            [H_ITEM(), H_PPH()],
            top.map((a) => [itemLink(a.opp.id, a.opp.name), span('pos', fmtCoins(a.profitPerHour))]),
          ) +
          `<p class="ov-more"><a href="#/plan">${esc(t('overview.openPlan'))} →</a></p>`
        );
      },
    },
    {
      key: 'watch',
      href: '#/watch',
      desc: () => t('overview.d_watch'),
      body: () => {
        const s = st();
        if (!s.watchlist.length) return empty(t('overview.e_watch'));
        const ms = ctx.derived.marketStats();
        const list = s.watchlist.slice(0, WATCH_N);
        const rows = list.map((w) => {
          const p = s.snapshot?.products[w.id];
          const asks = ctx.history.recent(w.id).map((x) => x.ask);
          const ch = ms.get(w.id)?.change24h ?? ctx.history.stats(w.id)?.change24h ?? null;
          return [
            itemLink(w.id, name(w.id)),
            esc(fmtCoins(p?.ask ?? null)),
            `<span class="${signCls(ch)}">${sparklineSvg(asks, { w: 56, h: 18 })}</span>`,
            span(signCls(ch), ch == null ? fmtPct(null) : signedPct(ch)),
          ];
        });
        const more = s.watchlist.length - list.length;
        return (
          mini([H_ITEM(), [t('overview.col_price'), true], [t('overview.col_trend'), false], [t('overview.col_change'), true]], rows) +
          (more > 0 ? `<p class="ov-more"><a href="#/watch">${esc(t('overview.watchMore', { n: more }))}</a></p>` : '')
        );
      },
    },
    {
      key: 'alerts',
      href: '#/watch',
      desc: () => t('overview.d_alerts'),
      body: () => {
        const s = st();
        if (!s.alertLog.length) return empty(t(s.alerts.length ? 'overview.e_alerts' : 'overview.e_alertsNoRules'));
        const now = Date.now();
        return (
          `<ul class="ov-alert-list">` +
          s.alertLog
            .slice(0, ALERTS_N)
            .map(
              (e) =>
                `<li><span class="muted small ov-ago">${esc(t('overview.ago', { age: fmtAge(now - e.at) }))}</span>` +
                `<a href="#/item/${encodeURIComponent(e.id)}">${esc(logMessage(e, s.alerts, name(e.id)))}</a></li>`,
            )
            .join('') +
          `</ul>`
        );
      },
    },
    {
      key: 'election',
      href: null,
      desc: () => t('overview.d_election'),
      body: () => {
        const el = st().election;
        if (!el) return empty(t('overview.e_election'));
        const perks = (ps: { name: string; description: string }[]) =>
          `<ul class="ov-perks">${ps.map((p) => `<li><strong>${esc(p.name)}</strong> <span class="muted">${esc(p.description)}</span></li>`).join('')}</ul>`;
        let out = '';
        if (el.mayor) {
          out +=
            `<h3 class="ov-sub">${esc(t('common.mayor'))}: ${esc(el.mayor.name)}` +
            (el.year != null ? ` <span class="muted small">${esc(t('overview.year', { y: el.year }))}</span>` : '') +
            `</h3>` +
            perks(el.mayor.perks);
        } else out += empty(t('overview.noMayor'));
        if (el.minister) out += `<h3 class="ov-sub">${esc(t('common.minister'))}: ${esc(el.minister.name)}</h3>` + perks([el.minister.perk]);
        return out;
      },
    },
    {
      key: 'market',
      href: null,
      desc: () => t('overview.d_market'),
      body: () => {
        const s = st();
        const now = Date.now();
        const snap = s.snapshot;
        const ah = !s.settings.ahEnabled
          ? t('overview.ahOff')
          : s.ahProgress
            ? t('common.ahScanning', { p: s.ahProgress.page, n: s.ahProgress.totalPages })
            : s.ah
              ? t('overview.ago', { age: fmtAge(now - s.ah.fetchedAt) })
              : t('overview.ahNone');
        const info = ctx.history.info();
        const rows: [string, string, string?][] = [
          [t('overview.f_products'), esc(snap ? fmtInt(Object.keys(snap.products).length) : '—'), 'products'],
          [t('overview.f_dataAge'), esc(snap ? t('overview.ago', { age: fmtAge(now - snap.lastUpdated) }) : t('common.noData')), 'age'],
          [t('overview.f_source'), esc(snap ? t(`overview.src_${snap.source}`) : '—')],
          [t('overview.f_ah'), esc(ah), 'ah'],
        ];
        if (s.settings.ahEnabled && s.ah) rows.push([t('overview.f_ahItems'), esc(fmtInt(Object.keys(s.ah.lowestBin).length))]);
        rows.push([t('overview.f_history'), esc(fmtInt(info.raw + info.q15))]);
        rows.push([t('overview.f_watch'), esc(`${fmtInt(s.watchlist.length)} / ${fmtInt(s.alerts.length)}`)]);
        return kv(rows);
      },
    },
  ];

  function titleKey(k: CardKey): string {
    return `overview.c_${k}`;
  }

  function buildCard(c: Card): HTMLElement {
    const hid = `ov-${c.key}-h`;
    const title = c.href ? h('a', { href: c.href }) : h('span');
    const head = h('header', { class: 'ov-card-head' }, h('h2', { id: hid }, title));
    if (c.key === 'movers') head.append(segGroup);
    const desc = h('p', { class: 'ov-desc' });
    const body = h('div', { class: 'ov-body' });
    cardEls.set(c.key, { title, desc, body });
    return h('section', { class: `card ov-card ov-${c.key}`, 'aria-labelledby': hid, 'data-card': c.key }, head, desc, body);
  }

  function render(): void {
    if (!root) return;
    const s = st();
    if (s.catalogError && !s.catalog) {
      els.banner.textContent = t('common.catalogError', { err: msgText(s.catalogError) });
      els.banner.hidden = false;
    } else els.banner.hidden = true;
    const win = qs.get().mw;
    for (const b of segBtns) b.setAttribute('aria-pressed', String(b.dataset.mw === win));
    for (const c of cards) {
      const e = cardEls.get(c.key)!;
      const tt = t(titleKey(c.key));
      if (e.title.textContent !== tt) e.title.textContent = tt;
      const d = c.desc();
      if (e.desc.textContent !== d) e.desc.textContent = d;
      let html: string;
      try {
        html = c.body();
      } catch (err) {
        console.error('overview card failed', c.key, err);
        html = empty('—');
      }
      // only touch the DOM when the card changed (keeps focus on links across the periodic re-render)
      if (bodyHtml.get(c.key) !== html) {
        e.body.innerHTML = html;
        bodyHtml.set(c.key, html);
      }
    }
  }

  const schedule = rafDebounce(render);

  function applyLabels(): void {
    els.title.textContent = t('overview.title');
    els.intro.textContent = t('overview.intro');
    segGroup.setAttribute('aria-label', t('overview.moversWindow'));
    for (const b of segBtns) b.textContent = t(`overview.win_${b.dataset.mw}`);
  }

  return {
    id: 'overview',
    mount(el, c, route) {
      root = el;
      ctx = c;
      planMemo = null;
      cardEls.clear();
      bodyHtml.clear();
      qs = bindQueryState(SCHEMA, route, ctx.setQuery, LS_VIEWPREFS + 'overview');

      segBtns = SCHEMA.mw.values.map((v) => {
        const b = h('button', { type: 'button', 'data-mw': v, 'aria-pressed': 'false', 'data-testid': `ov-mw-${v}` });
        b.addEventListener('click', () => qs.set({ mw: v }));
        return b;
      });
      segGroup = h('div', { class: 'seg ov-seg', role: 'group' }, ...segBtns);

      els = {
        title: h('h1', { tabindex: '-1' }),
        intro: h('p', { class: 'muted small ov-intro' }),
        banner: h('div', { class: 'banner banner-warn', role: 'status', hidden: true }),
      };
      const grid = h('div', { class: 'ov-grid' }, ...cards.map(buildCard));
      const view = h('div', { class: 'overview-view', 'data-testid': 'overview-view' }, h('header', { class: 'ov-head' }, els.title, els.intro), els.banner, grid);
      applyLabels();
      el.append(view);

      const timer = setInterval(schedule, TICK_MS);
      cleanups.push(
        () => clearInterval(timer),
        qs.onChange(() => render()),
        ctx.store.subscribe((s, prev) => {
          if (
            s.snapshot !== prev.snapshot ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.settings !== prev.settings ||
            s.historyTick !== prev.historyTick ||
            s.ah !== prev.ah ||
            s.ahProgress !== prev.ahProgress ||
            s.watchlist !== prev.watchlist ||
            s.alerts !== prev.alerts ||
            s.alertLog !== prev.alertLog ||
            s.election !== prev.election
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
      qs.fromRoute(route);
    },
    unmount() {
      for (const fn of cleanups.splice(0)) fn();
      cardEls.clear();
      bodyHtml.clear();
      segBtns = [];
      planMemo = null;
      if (root) root.replaceChildren();
      root = null;
    },
  };
}
