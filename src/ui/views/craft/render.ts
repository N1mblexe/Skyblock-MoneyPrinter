// Craft view: kit table columns and the detail panel body (steps, ingredient + output market lines, throughput notes).
import { RISK } from '../../../config.ts';
import { t } from '../../../i18n/index.ts';
import type { AhPrice, Catalog, CraftRow, IngredientLine, Product, Recipe, Settings } from '../../../types/contracts.ts';
import { itemCell, riskBadge, sourceBadge } from '../../cells.ts';
import { esc } from '../../dom.ts';
import { fmtCoins, fmtHours, fmtInt, fmtList, fmtPct, locale } from '../../format.ts';
import type { KitColumn } from '../../kit/index.ts';
import { batchCrafts, fewOrders, fmtRate, ownFlipMargin, slippage } from './helpers.ts';

export interface RenderEnv {
  catalog(): Catalog | null;
  /** display + calc settings (store) */
  settings(): Settings;
  /** bazaar product from the current snapshot */
  product(id: string): Product | undefined;
  /** AH lowest BIN for an off-bazaar output (only when the AH scan is on) */
  ah(id: string): AhPrice | null;
  /** recipe lookup by key (for viaRecipe) */
  recipe(key: string): Recipe | undefined;
  watched(id: string): boolean;
}

const isUnpriced = (r: CraftRow) => r.unpriced.length > 0;
const signCls = (n: number | null | undefined) => (n == null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const nameOf = (env: RenderEnv, id: string) => env.catalog()?.name(id) ?? id;
const dash = '—';

function forgeBadge(recipe: Recipe): string {
  if (recipe.kind !== 'forge') return '';
  const d = recipe.durationSec != null && recipe.durationSec > 0 ? fmtHours(recipe.durationSec / 3600) : '';
  const label = d ? t('craft.forgeBadge', { d }) : t('craft.kindForge');
  return `<span class="badge craft-forge">${esc(label)}</span>`;
}

/** Forge / NPC / AH / off-bazaar badges for the output. */
export function outputBadges(r: CraftRow): string {
  let s = forgeBadge(r.recipe);
  if (!isUnpriced(r) && r.valueSource === 'npc')
    s += `<span class="badge src-npc" title="${esc(t('craft.npcValueTitle'))}">${esc(t('craft.badgeNpc'))}</span>`;
  if (!isUnpriced(r) && r.valueSource === 'ah')
    s += `<span class="badge craft-src-ah" title="${esc(t('craft.ahValueTitle'))}">${esc(t('craft.badgeAh'))}</span>`;
  if (r.outputOffBazaar) s += `<span class="badge craft-off" title="${esc(t('craft.offTitle'))}">${esc(t('craft.badgeOff'))}</span>`;
  return s;
}

function inputsList(env: RenderEnv, recipe: Recipe): string {
  return recipe.inputs.map((i) => `${fmtInt(i.qty)}× ${nameOf(env, i.id)}`).join(' + ');
}

function bottleneck(r: CraftRow): IngredientLine | undefined {
  return r.lines.find((l) => l.bottleneck);
}

const outBott = (r: CraftRow) => !isUnpriced(r) && Number.isFinite(r.outCraftsPerHour) && r.outCraftsPerHour <= r.inCraftsPerHour;
const inBott = (r: CraftRow) => !isUnpriced(r) && Number.isFinite(r.inCraftsPerHour) && r.inCraftsPerHour < r.outCraftsPerHour;

export function craftColumns(env: RenderEnv): KitColumn<CraftRow>[] {
  const coins = (v: (r: CraftRow) => number) => (r: CraftRow) => (isUnpriced(r) ? null : v(r));
  return [
    {
      key: 'name',
      label: () => t('craft.colOutput'),
      get: (r) => r.name,
      cls: 'name-cell craft-name',
      priority: 0,
      csv: (r) => r.id,
      html: (r) => {
        const sub = isUnpriced(r) ? t('craft.unpricedList', { ids: fmtList(r.unpriced) }) : inputsList(env, r.recipe);
        const cnt = r.recipe.outCount > 1 ? `<span class="craft-n">${esc(fmtInt(r.recipe.outCount))}×</span> ` : '';
        return (
          `<span class="craft-line1">${cnt}<a href="#/item/${encodeURIComponent(r.id)}">${esc(r.name)}</a>${outputBadges(r)}</span>` +
          `<span class="id-sub craft-sub${isUnpriced(r) ? ' craft-unpriced-ids' : ''}" title="${esc(`${r.id} · ${sub}`)}">${esc(sub)}</span>`
        );
      },
    },
    {
      key: 'count',
      label: () => t('craft.colOutCount'),
      get: (r) => r.recipe.outCount,
      align: 'right',
      priority: 3,
      defaultHidden: true,
      html: (r) => esc(fmtInt(r.recipe.outCount)),
    },
    {
      key: 'cost',
      label: () => t('craft.colCost'),
      get: coins((r) => r.cost),
      align: 'right',
      priority: 2,
      html: (r) => (isUnpriced(r) ? dash : esc(fmtCoins(r.cost))),
    },
    {
      key: 'value',
      label: () => t('craft.colValue'),
      get: coins((r) => r.value),
      align: 'right',
      priority: 2,
      html: (r) => (isUnpriced(r) ? dash : esc(fmtCoins(r.value))),
    },
    {
      key: 'profit',
      label: () => t('craft.colProfit'),
      get: coins((r) => r.profit),
      align: 'right',
      priority: 2,
      html: (r) => (isUnpriced(r) ? dash : `<span class="${signCls(r.profit)}">${esc(fmtCoins(r.profit))}</span>`),
    },
    {
      key: 'margin',
      label: () => t('craft.colMargin'),
      get: (r) => r.margin,
      align: 'right',
      priority: 1,
      html: (r) => (r.margin == null ? dash : `<span class="${signCls(r.margin)}">${esc(fmtPct(r.margin))}</span>`),
    },
    {
      key: 'outRate',
      label: () => t('craft.colOutRate'),
      title: () => t('craft.colOutRateTitle'),
      get: (r) => r.outCraftsPerHour,
      align: 'right',
      priority: 3,
      html: (r) => `<span${outBott(r) ? ' class="bott"' : ''}>${esc(fmtRate(r.outCraftsPerHour))}</span>`,
    },
    {
      key: 'inRate',
      label: () => t('craft.colInRate'),
      title: () => t('craft.colInRateTitle'),
      get: (r) => r.inCraftsPerHour,
      align: 'right',
      priority: 3,
      html: (r) => {
        const b = bottleneck(r);
        const title = b ? ` title="${esc(t('craft.bottleneckTitle', { name: b.name }))}"` : '';
        return `<span${inBott(r) ? ' class="bott"' : ''}${title}>${esc(fmtRate(r.inCraftsPerHour))}</span>`;
      },
    },
    {
      key: 'limited',
      label: () => t('craft.colLimited'),
      title: () => t('craft.colLimitedTitle'),
      get: (r) => (isUnpriced(r) ? null : t(`craft.why_${r.tp.limitedBy}`)),
      csv: (r) => (isUnpriced(r) ? null : r.tp.limitedBy),
      priority: 3,
      html: (r) => (isUnpriced(r) ? dash : `<span class="craft-why craft-why-${esc(r.tp.limitedBy)}">${esc(t(`craft.why_${r.tp.limitedBy}`))}</span>`),
    },
    {
      key: 'slots',
      label: () => t('craft.colSlots'),
      title: () => t('craft.colSlotsTitle'),
      get: (r) => (isUnpriced(r) ? null : (r.tp.slots ?? 0)),
      align: 'right',
      priority: 3,
      html: (r) => {
        if (isUnpriced(r)) return dash;
        const n = r.tp.slots ?? 0;
        return `<span${r.tp.limitedBy === 'slots' ? ' class="bott"' : ''}>${esc(fmtInt(n))}</span>`;
      },
    },
    {
      key: 'pph',
      label: () => t('craft.colProfitHour'),
      title: () => t('craft.colProfitHourTitle'),
      get: coins((r) => r.profitPerHour),
      align: 'right',
      priority: 1,
      html: (r) => (isUnpriced(r) ? dash : `<strong class="${signCls(r.profitPerHour)}">${esc(fmtCoins(r.profitPerHour))}</strong>`),
    },
    {
      key: 'risk',
      label: () => t('craft.colRisk'),
      get: (r) => r.risk.score,
      csv: (r) => r.risk.level,
      align: 'center',
      priority: 1,
      html: (r) => riskBadge(r.risk),
    },
  ];
}

/** Row action: ★ watch toggle for the output. */
export function watchButton(env: RenderEnv, r: CraftRow): string {
  const on = env.watched(r.id);
  const label = t(on ? 'craft.unwatchName' : 'craft.watchName', { name: r.name });
  return `<button type="button" class="btn btn-ghost btn-sm craft-star${on ? ' on' : ''}" data-action="watch" aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(label)}">★</button>`;
}

// ---------------------------------------------------------------- detail panel

const taxPct = (tax: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 3 }).format(tax * 100);
const signedPct = (x: number) => (x > 0 ? '+' : '') + fmtPct(x, 2);

function viaText(env: RenderEnv, key: string | undefined): string {
  if (!key) return '';
  const rec = env.recipe(key);
  if (!rec) return '';
  let s = t('craft.craftFrom', { inputs: inputsList(env, rec) });
  if (rec.outCount > 1) s = t('craft.craftFromOut', { from: s, n: fmtInt(rec.outCount) });
  return `<span class="craft-via small">${esc(s)}</span>`;
}

function outSourceBadge(r: CraftRow, s: Settings): string {
  if (isUnpriced(r)) return `<span class="badge risk-suspect">${esc(t('craft.noPrice'))}</span>`;
  if (r.valueSource === 'npc') return sourceBadge('npc');
  if (r.valueSource === 'ah') return `<span class="badge craft-src-ah">${esc(t('craft.srcAh'))}</span>`;
  return s.sellMode === 'insta'
    ? `<span class="badge src-insta">${esc(t('craft.srcInstaSell'))}</span>`
    : `<span class="badge src-order">${esc(t('craft.srcSellOffer'))}</span>`;
}

/** Market cells shared by ingredient and output rows: bid/ask pair, then weekly volumes, order counts, own flip margin. */
function marketCells(p: Product | undefined, s: Settings, npcSell: number | undefined): { bidAsk: string; rest: string } {
  if (!p) return { bidAsk: `<td class="num">${dash}</td>`, rest: `<td class="num">${dash}</td>`.repeat(3) };
  const fm = ownFlipMargin(p, s.taxRate, npcSell);
  return {
    bidAsk: `<td class="num">${esc(p.bid == null ? dash : fmtCoins(p.bid))} / ${esc(p.ask == null ? dash : fmtCoins(p.ask))}</td>`,
    rest:
      `<td class="num">${esc(fmtInt(p.instaBuysWeek))} / ${esc(fmtInt(p.instaSellsWeek))}</td>` +
      `<td class="num">${esc(fmtInt(p.quick.buyOrders))} / ${esc(fmtInt(p.quick.sellOrders))}</td>` +
      `<td class="num"><span class="${signCls(fm)}">${esc(fm == null ? dash : fmtPct(fm))}</span></td>`,
  };
}

function fewChip(p: Product | undefined): string {
  if (!fewOrders(p)) return '';
  return ` <span class="chip craft-few" title="${esc(t('craft.fewOrdersTitle', { n: RISK.fewOrders }))}">${esc(t('craft.fewOrders'))}</span>`;
}

function linesTable(env: RenderEnv, r: CraftRow): string {
  const s = env.settings();
  const cat = env.catalog();
  const missing = new Set(r.unpriced);
  const ing = r.lines
    .map((l) => {
      const priced = !missing.has(l.id);
      const p = env.product(l.id);
      const src = priced ? sourceBadge(l.source) : `<span class="badge risk-suspect">${esc(t('craft.noPrice'))}</span>`;
      const rate = priced ? `<span${l.bottleneck ? ' class="bott"' : ''}>${esc(fmtRate(l.craftsPerHour))}</span>` : dash;
      const m = marketCells(p, s, cat?.items[l.id]?.npcSell);
      return `<tr class="craft-l-in${l.bottleneck ? ' craft-bott-row' : ''}" data-line="${esc(l.id)}">
        <th scope="row" class="name-cell"><span class="craft-role">${esc(t('craft.roleIn'))}</span> ${itemCell(l.id, l.name, true)}${fewChip(p)}${viaText(env, l.viaRecipe)}</th>
        <td>${src}</td>
        <td class="num">${esc(fmtInt(l.qty))}</td>
        ${m.bidAsk}
        <td class="num">${priced ? esc(fmtCoins(l.unit)) : dash}</td>
        <td class="num">${priced ? esc(fmtCoins(l.total)) : dash}</td>
        ${m.rest}
        <td class="num">${rate}</td>
      </tr>`;
    })
    .join('');
  const op = r.outputOffBazaar ? undefined : env.product(r.id);
  const n = r.recipe.outCount;
  const unit = !isUnpriced(r) && n > 0 ? r.value / n : null;
  const ah = r.valueSource === 'ah' ? env.ah(r.id) : null;
  const om = marketCells(op, s, cat?.items[r.id]?.npcSell);
  const ahNote = ah ? `<span class="craft-via small">${esc(t('craft.ahListings', { price: fmtCoins(ah.price), count: fmtInt(ah.count) }))}</span>` : '';
  const out = `<tr class="craft-l-out" data-line="${esc(r.id)}">
      <th scope="row" class="name-cell"><span class="craft-role craft-role-out">${esc(t('craft.roleOut'))}</span> ${itemCell(r.id, r.name, true)}${fewChip(op)}${ahNote}</th>
      <td>${outSourceBadge(r, s)}</td>
      <td class="num">${esc(fmtInt(n))}</td>
      ${om.bidAsk}
      <td class="num">${unit == null ? dash : esc(fmtCoins(unit))}</td>
      <td class="num">${isUnpriced(r) ? dash : esc(fmtCoins(r.value))}</td>
      ${om.rest}
      <td class="num"><span${outBott(r) ? ' class="bott"' : ''}>${esc(fmtRate(r.outCraftsPerHour))}</span></td>
    </tr>`;
  const th = (k: string, cls = '', title?: string) =>
    `<th scope="col"${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(t(title))}"` : ''}>${esc(t(k))}</th>`;
  return `<div class="craft-ing-wrap" tabindex="0" role="region" aria-label="${esc(t('craft.linesTitle'))}"><table class="tbl-plain craft-ing">
    <thead><tr>
      ${th('craft.colItem')}${th('craft.colSrc')}${th('craft.colQty', 'num')}
      ${th('craft.colBidAsk', 'num', 'craft.colBidAskTitle')}${th('craft.colUsed', 'num', 'craft.colUsedTitle')}${th('craft.colTotal', 'num')}
      ${th('craft.colWeek', 'num', 'craft.colWeekTitle')}${th('craft.colOrders', 'num', 'craft.colOrdersTitle')}
      ${th('craft.colFlip', 'num', 'craft.colFlipTitle')}${th('craft.colRate', 'num')}
    </tr></thead>
    <tbody>${ing}${out}</tbody>
  </table></div>`;
}

function stepsHtml(env: RenderEnv, r: CraftRow): string {
  const s = env.settings();
  const li: string[] = [];
  const buys = r.lines
    .map(
      (l) =>
        `<li>${t('craft.stepBuy', {
          qty: esc(fmtInt(l.qty)),
          name: esc(l.name),
          unit: esc(fmtCoins(l.unit)),
          src: sourceBadge(l.source),
          total: esc(fmtCoins(l.total)),
        })}</li>`,
    )
    .join('');
  const total = r.lines.length > 1 ? `<p class="craft-total">${t('craft.totalCost', { cost: esc(fmtCoins(r.cost)) })}</p>` : '';
  const how = t(s.costMode === 'insta' ? 'craft.howInsta' : 'craft.howOrder');
  li.push(`${esc(t('craft.stepBuyHead', { how }))}<ul class="craft-buys">${buys}</ul>${total}`);
  const n = esc(fmtInt(r.recipe.outCount));
  const name = esc(r.name);
  if (r.recipe.kind === 'forge') {
    const d = r.recipe.durationSec ? fmtHours(r.recipe.durationSec / 3600) : '?';
    li.push(t('craft.stepForge', { d: esc(d), slots: esc(fmtInt(s.forgeSlots)), n, name }));
  } else li.push(t('craft.stepCraft', { n, name }));
  const value = esc(fmtCoins(r.value));
  const tax = esc(taxPct(s.taxRate));
  if (r.valueSource === 'npc') li.push(t('craft.stepSellNpc', { value }));
  else if (r.valueSource === 'ah') {
    const ah = env.ah(r.id);
    const unit = r.recipe.outCount > 0 ? r.value / r.recipe.outCount : r.value;
    li.push(t('craft.stepSellAh', { price: esc(fmtCoins(ah?.price ?? unit)), count: esc(ah ? fmtInt(ah.count) : '?'), value }));
  } else if (s.sellMode === 'insta') li.push(t('craft.stepSellInsta', { tax, value }));
  else li.push(t('craft.stepSellOffer', { tax, value }));
  li.push(t('craft.stepProfit', { cls: signCls(r.profit), profit: esc(fmtCoins(r.profit)), margin: esc(fmtPct(r.margin)) }));
  return `<ol class="craft-steps">${li.map((x) => `<li>${x}</li>`).join('')}</ol>`;
}

/** Slippage in insta modes: first unit vs batch average (from the snapshot's book via walkBook). */
function slippageHtml(env: RenderEnv, r: CraftRow): string {
  const s = env.settings();
  const instaBuy = s.costMode === 'insta';
  const instaSell = s.sellMode === 'insta' && r.valueSource === 'bazaar';
  if (!instaBuy && !instaSell) return '';
  const crafts = batchCrafts(r);
  const out: string[] = [];
  const line = (key: string, name: string, sl: NonNullable<ReturnType<typeof slippage>>, sell: boolean) => {
    const one = sell ? sl.one * (1 - s.taxRate) : sl.one;
    const batch = sell ? sl.batch * (1 - s.taxRate) : sl.batch;
    let txt = esc(
      t(key, { name, one: fmtCoins(one), qty: fmtInt(sl.qty), batch: fmtCoins(batch), pct: signedPct(sl.pct) }),
    );
    if (sl.filled < sl.qty) txt += ' ' + esc(t('craft.slipShort', { filled: fmtInt(sl.filled) }));
    const bad = Math.abs(sl.pct) >= 0.01;
    out.push(`<li${bad ? ' class="craft-slip-bad"' : ''}>${txt}</li>`);
  };
  if (instaBuy) {
    for (const l of r.lines) {
      if (l.source !== 'insta') continue;
      const p = env.product(l.id);
      const sl = p ? slippage(p.asks, l.qty * crafts) : null;
      if (sl) line('craft.slipBuy', l.name, sl, false);
    }
  }
  if (instaSell) {
    const p = env.product(r.id);
    const sl = p ? slippage(p.bids, r.recipe.outCount * crafts) : null;
    if (sl) line('craft.slipSell', r.name, sl, true);
  }
  const body = out.length ? `<ul class="craft-notes">${out.join('')}</ul>` : '';
  return `<section class="craft-sec craft-slip"><h3>${esc(t('craft.slipTitle'))}</h3><p class="muted small">${esc(t('craft.slipMode'))}</p>${body}</section>`;
}

function notesHtml(env: RenderEnv, r: CraftRow): string {
  const s = env.settings();
  const notes: string[] = [];
  if (!isUnpriced(r)) {
    const b = bottleneck(r);
    if (b && inBott(r)) notes.push(esc(t('craft.bottIn', { name: b.name, n: fmtRate(r.inCraftsPerHour) })));
    else if (Number.isFinite(r.outCraftsPerHour)) notes.push(esc(t('craft.bottOut', { n: fmtRate(r.outCraftsPerHour) })));
    else notes.push(esc(t('craft.bottNone')));

    const why = r.tp.limitedBy;
    const long = t(`craft.whyLong_${why}`, {
      capital: fmtCoins(s.capital),
      slots: fmtInt(why === 'slots' ? s.orderSlots : s.forgeSlots),
      limit: fmtInt(s.npcDailyLimit),
    });
    notes.push(t('craft.limitedLine', { why: esc(t(`craft.why_${why}`)), long: esc(long) }));
    if (r.tp.unitsPerHour > 0 && r.profitPerHour > 0) {
      notes.push(esc(t('craft.tpLine', { cph: fmtRate(r.tp.unitsPerHour), batch: fmtRate(r.tp.batchQty), capital: fmtCoins(r.tp.capitalUsed) })));
    } else notes.push(esc(t('craft.tpZero')));
    if (r.tp.batchQty > 0 && (r.tp.buyHours != null || r.tp.sellHours != null)) {
      const model = t(s.fillModel === 'pipelined' ? 'craft.modelPipelined' : 'craft.modelSequential');
      notes.push(esc(t('craft.hoursLine', { buy: fmtHours(r.tp.buyHours ?? 0), sell: fmtHours(r.tp.sellHours ?? 0), model })));
    }
    if (r.tp.slots != null && r.tp.slots > 0) notes.push(esc(t('craft.slotsLine', { n: fmtInt(r.tp.slots), total: fmtInt(s.orderSlots) })));
  }
  if (r.recipe.kind === 'forge' && r.recipe.durationSec && r.recipe.durationSec > 0) {
    const cap = (Math.max(0, s.forgeSlots) * 3600) / r.recipe.durationSec;
    notes.push(esc(t('craft.forgeLine', { slots: fmtInt(s.forgeSlots), d: fmtHours(r.recipe.durationSec / 3600), cap: fmtRate(cap) })));
  }
  if (r.lines.some((l) => l.source === 'npc' && !r.unpriced.includes(l.id))) {
    notes.push(`<span class="craft-npc-limit">${esc(t('craft.npcLimit', { limit: fmtInt(s.npcDailyLimit) }))}</span>`);
  }
  if (r.recipe.req) notes.push(`<span class="craft-req">${esc(t('craft.reqLine', { req: r.recipe.req.replace(/^requires:\s*/i, '') }))}</span>`);
  return `<section class="craft-sec"><h3>${esc(t('craft.notesTitle'))}</h3><ul class="craft-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul></section>`;
}

/** Detail panel body for one craft row. */
export function craftDetail(env: RenderEnv, r: CraftRow): string {
  const s = env.settings();
  const on = env.watched(r.id);
  const unpriced = isUnpriced(r);
  const kv = (k: string, v: string) => `<div><dt>${esc(t(k))}</dt><dd>${v}</dd></div>`;
  const summary = unpriced
    ? ''
    : `<dl class="kv craft-sum">
        ${kv('craft.dCost', esc(fmtCoins(r.cost)))}
        ${kv('craft.dValue', esc(fmtCoins(r.value)))}
        ${kv('craft.dProfit', `<span class="${signCls(r.profit)}">${esc(fmtCoins(r.profit))}</span>`)}
        ${kv('craft.dMargin', `<span class="${signCls(r.margin)}">${esc(fmtPct(r.margin))}</span>`)}
        ${kv('craft.dCph', esc(fmtRate(r.tp.unitsPerHour)))}
        ${kv('craft.dPph', `<strong class="${signCls(r.profitPerHour)}">${esc(fmtCoins(r.profitPerHour))}</strong>`)}
      </dl>`;
  const head = `<div class="craft-d-head">
      <span class="craft-d-badges">${outputBadges(r)} ${riskBadge(r.risk)}</span>
      <span class="craft-d-actions">
        <button type="button" class="btn btn-sm craft-watch${on ? ' on' : ''}" data-craft-watch aria-pressed="${on}">${esc(t(on ? 'craft.watching' : 'craft.watch'))}</button>
        <a class="btn btn-sm" href="#/item/${encodeURIComponent(r.id)}">${esc(t('craft.openItem'))}</a>
      </span>
    </div>`;

  let warn = '';
  if (unpriced) {
    const msgs = [esc(t('craft.cannotPrice', { ids: fmtList(r.unpriced) }))];
    if (r.outputOffBazaar && r.unpriced.includes(r.id)) msgs.push(esc(t(s.ahEnabled ? 'craft.offUnpriced' : 'craft.offUnpricedAhOff')));
    warn = `<div class="banner banner-warn craft-unpriced-msg">${msgs.join(' ')}</div>`;
  } else if (r.valueSource === 'ah') {
    warn = `<div class="banner banner-warn craft-ah-warn">${esc(t('craft.ahWarn'))}</div>`;
  }

  const steps = unpriced ? '' : `<section class="craft-sec"><h3>${esc(t('craft.stepsTitle'))}</h3>${stepsHtml(env, r)}</section>`;
  return `<div class="craft-detail">
    ${head}
    ${summary}
    ${warn}
    ${steps}
    <section class="craft-sec"><h3>${esc(t('craft.linesTitle'))}</h3>${linesTable(env, r)}</section>
    ${unpriced ? '' : slippageHtml(env, r)}
    ${notesHtml(env, r)}
  </div>`;
}
