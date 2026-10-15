// "Sell or craft?" (#/sell): the items you own (saved in localStorage) and, for each, every way to cash them out,
// best first (src/domain/sell.ts). Recomputed when prices, the catalog, settings or the AH scan change.
import { LS_SELL } from '../../../config.ts';
import { resolveUserInput } from '../../../domain/search.ts';
import { sellOptions, type SellOption, type SellResult } from '../../../domain/sell.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import { idStr, loadList, lsSet } from '../../../storage/local.ts';
import type { Catalog, View, ViewContext } from '../../../types/contracts.ts';
import { esc, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtHours, fmtInt } from '../../format.ts';
import { fmtQty } from '../craft/helpers.ts';
import './sell.css';

export interface SellEntry {
  id: string;
  qty: number;
}

const parseEntry = (x: Record<string, unknown>): SellEntry | null =>
  idStr(x.id) && typeof x.qty === 'number' && Number.isFinite(x.qty) && x.qty > 0 ? { id: x.id, qty: x.qty } : null;

export const loadSellList = (): SellEntry[] => loadList(LS_SELL, parseEntry, (e) => e.id);
export const saveSellList = (list: readonly SellEntry[]): void => lsSet(LS_SELL, list);

const nameOf = (cat: Catalog | null, id: string) => cat?.name(id) ?? id;

function methodLabel(o: SellOption, cat: Catalog | null): string {
  return o.method === 'craft' ? t('sell.m_craft', { name: nameOf(cat, o.craft!.toId) }) : t(`sell.m_${o.method}`);
}

function optionRow(o: SellOption, best: boolean, cat: Catalog | null): string {
  let sub = '';
  if (o.filled != null) sub = t('sell.partial', { n: fmtInt(o.filled) });
  if (o.craft) {
    const c = o.craft;
    sub = t('sell.craftLine', {
      path: c.path.map((id) => nameOf(cat, id)).join(' → '),
      made: fmtInt(c.made),
      count: c.made,
      used: fmtQty(c.used),
      left: fmtQty(c.leftover),
    });
    if (c.sideCost > 0) sub += ` · ${t('sell.craftSides', { cost: fmtCoins(c.sideCost * c.made) })}`;
  }
  const time = o.hours === 0 ? t('sell.now') : o.hours == null ? '—' : fmtHours(o.hours);
  return `<tr class="${best ? 'sell-best' : ''}" data-method="${o.method}">
    <th scope="row" class="name-cell">${esc(methodLabel(o, cat))}${best ? ` <span class="badge risk-ok">${esc(t('sell.best'))}</span>` : ''}${sub ? `<span class="id-sub">${esc(sub)}</span>` : ''}</th>
    <td class="num">${esc(fmtCoins(o.perItem))}</td>
    <td class="num"><strong>${esc(fmtCoins(o.net))}</strong></td>
    <td class="num">${esc(time)}</td>
  </tr>`;
}

function cardHtml(r: SellResult, cat: Catalog | null): string {
  const th = (k: string, cls = '') => `<th scope="col"${cls ? ` class="${cls}"` : ''}>${esc(t(k))}</th>`;
  const body = r.options.length
    ? `<div class="sell-wrap" tabindex="0" role="region" aria-label="${esc(r.name)}"><table class="tbl-plain sell-tbl">
        <thead><tr>${th('sell.colMethod')}${th('sell.colPerItem', 'num')}${th('sell.colTotal', 'num')}${th('sell.colTime', 'num')}</tr></thead>
        <tbody>${r.options.map((o, i) => optionRow(o, i === 0, cat)).join('')}</tbody>
      </table></div>`
    : `<p class="muted small">${esc(t('sell.nothing'))}</p>`;
  return `<section class="card sell-card" data-id="${esc(r.id)}" aria-labelledby="sell-h-${esc(r.id)}">
    <header class="sell-card-head">
      <h2 id="sell-h-${esc(r.id)}"><a href="#/item/${encodeURIComponent(r.id)}">${esc(r.name)}</a></h2>
      <label class="sell-qty"><span class="kit-sr">${esc(t('sell.qty'))}</span><input type="number" min="1" step="1" inputmode="numeric" value="${r.qty}" data-sell-qty="${esc(r.id)}" aria-label="${esc(`${t('sell.qty')}: ${r.name}`)}"></label>
      <button type="button" class="btn btn-ghost btn-sm" data-sell-remove="${esc(r.id)}" aria-label="${esc(t('sell.remove', { name: r.name }))}">×</button>
    </header>
    ${body}
  </section>`;
}

export function createSellView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let list: SellEntry[] = [];
  let datalistCatalog: Catalog | null = null;
  const subs: (() => void)[] = [];
  const $ = <E extends Element = HTMLElement>(sel: string) => root!.querySelector<E>(sel)!;

  function setList(next: SellEntry[]): void {
    list = next;
    saveSellList(list);
    render();
  }

  function applyLabels(): void {
    if (!root) return;
    $('h1').textContent = t('sell.title');
    $('.sell-intro').textContent = t('sell.intro');
    $('.sell-item-lbl').textContent = t('sell.item');
    $<HTMLInputElement>('[data-sell-item]').placeholder = t('sell.itemPh');
    $('.sell-qty-lbl').textContent = t('sell.qty');
    $('[data-sell-add]').textContent = t('sell.add');
    $('[data-sell-clear]').textContent = t('sell.clear');
  }

  function fillDatalist(cat: Catalog | null): void {
    if (!cat || cat === datalistCatalog) return;
    datalistCatalog = cat;
    const names = Object.values(cat.items)
      .filter((i) => i.bazaar || (i.npcSell ?? 0) > 0)
      .map((i) => i.name)
      .sort();
    $('#sell-items').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
  }

  function render(): void {
    if (!root || !ctx) return;
    const s = ctx.store.get();
    fillDatalist(s.catalog);
    const c = ctx.derived.calcCtx();
    const out = $('.sell-list');
    const total = $('.sell-total');
    $<HTMLButtonElement>('[data-sell-clear]').hidden = list.length === 0;
    if (!list.length) {
      out.innerHTML = `<div class="empty card">${esc(t('sell.empty'))}</div>`;
      total.textContent = '';
      return;
    }
    if (!c || !s.catalog) {
      out.innerHTML = `<div class="empty card">${esc(t('sell.waiting'))}</div>`;
      total.textContent = '';
      return;
    }
    const results = list.map((e) => sellOptions(c, e.id, e.qty));
    out.innerHTML = results.map((r) => cardHtml(r, s.catalog)).join('');
    total.textContent = t('sell.total', { value: fmtCoins(results.reduce((n, r) => n + (r.options[0]?.net ?? 0), 0)) });
  }

  const schedule = rafDebounce(render);

  function add(): void {
    if (!ctx) return;
    const cat = ctx.store.get().catalog;
    const input = $<HTMLInputElement>('[data-sell-item]');
    const qtyInput = $<HTMLInputElement>('[data-sell-newqty]');
    const text = input.value.trim();
    const id = cat && text ? resolveUserInput(cat, text) : null;
    const qty = Number(qtyInput.value);
    if (!id) {
      ctx.toast(t('sell.unknown', { text }), 'err');
      input.focus();
      return;
    }
    if (!(qty > 0)) {
      ctx.toast(t('sell.badQty'), 'err');
      qtyInput.focus();
      return;
    }
    const rest = list.filter((e) => e.id !== id);
    setList([{ id, qty: Math.floor(qty) }, ...rest]);
    input.value = '';
    input.focus();
  }

  return {
    id: 'sell',
    mount(el, c) {
      root = el;
      ctx = c;
      list = loadSellList();
      el.innerHTML = `<div class="sell-view">
        <header class="sell-head"><h1 tabindex="-1"></h1><p class="sell-intro muted small"></p></header>
        <form class="sell-form card" novalidate>
          <label class="field"><span class="field-label sell-item-lbl"></span><input type="text" list="sell-items" autocomplete="off" data-sell-item data-testid="sell-item"></label>
          <label class="field"><span class="field-label sell-qty-lbl"></span><input type="number" min="1" step="1" inputmode="numeric" value="1" data-sell-newqty data-testid="sell-qty"></label>
          <button type="submit" class="btn" data-sell-add data-testid="sell-add"></button>
          <datalist id="sell-items"></datalist>
        </form>
        <div class="sell-bar"><strong class="sell-total" role="status" data-testid="sell-total"></strong><button type="button" class="btn btn-ghost btn-sm" data-sell-clear hidden></button></div>
        <div class="sell-list"></div>
      </div>`;
      const form = $<HTMLFormElement>('.sell-form');
      const onSubmit = (ev: Event) => {
        ev.preventDefault();
        add();
      };
      form.addEventListener('submit', onSubmit);
      const onClick = (ev: MouseEvent) => {
        const target = ev.target instanceof Element ? ev.target : null;
        const rm = target?.closest<HTMLElement>('[data-sell-remove]');
        if (rm) setList(list.filter((e) => e.id !== rm.dataset.sellRemove));
        if (target?.closest('[data-sell-clear]')) setList([]);
      };
      const onChange = (ev: Event) => {
        const inp = ev.target instanceof HTMLInputElement && ev.target.dataset.sellQty ? ev.target : null;
        if (!inp) return;
        const qty = Math.floor(Number(inp.value));
        if (!(qty > 0)) {
          inp.setAttribute('aria-invalid', 'true');
          return;
        }
        inp.removeAttribute('aria-invalid');
        setList(list.map((e) => (e.id === inp.dataset.sellQty ? { ...e, qty } : e)));
      };
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      subs.push(() => {
        form.removeEventListener('submit', onSubmit);
        el.removeEventListener('click', onClick);
        el.removeEventListener('change', onChange);
      });
      subs.push(
        c.store.subscribe((s, prev) => {
          if (s.snapshot !== prev.snapshot || s.catalog !== prev.catalog || s.settings !== prev.settings || s.ah !== prev.ah || s.election !== prev.election)
            schedule();
        }),
      );
      subs.push(
        onLangChange(() => {
          applyLabels();
          render();
        }),
      );
      applyLabels();
      render();
    },
    unmount() {
      for (const off of subs.splice(0)) off();
      if (root) root.textContent = '';
      root = null;
      ctx = null;
      datalistCatalog = null;
    },
  };
}

