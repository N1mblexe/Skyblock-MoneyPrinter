// Craft view table columns and the expandable detail panel.
import { t } from '../../../i18n/index.ts';
import type { Catalog, CraftRow, IngredientLine, Recipe, Settings } from '../../../types/contracts.ts';
import { itemCell, riskBadge, sourceBadge } from '../../cells.ts';
import { esc } from '../../dom.ts';
import { fmtCoins, fmtHours, fmtInt, fmtPct, locale } from '../../format.ts';
import type { Column } from '../../table.ts';
import { fmtRate } from './helpers.ts';

export interface RenderEnv {
  catalog(): Catalog | null;
  settings(): Settings;
  /** recipe lookup by key (for viaRecipe) */
  recipe(key: string): Recipe | undefined;
}

const isUnpriced = (r: CraftRow) => r.unpriced.length > 0;
const signCls = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const nameOf = (env: RenderEnv, id: string) => env.catalog()?.name(id) ?? id;

function forgeBadge(recipe: Recipe): string {
  if (recipe.kind !== 'forge') return '';
  const d = recipe.durationSec != null && recipe.durationSec > 0 ? fmtHours(recipe.durationSec / 3600) : '';
  const label = d ? t('craft.forgeBadge', { d }) : t('craft.kindForge');
  return `<span class="badge craft-forge">${esc(label)}</span>`;
}

function inputsList(env: RenderEnv, recipe: Recipe): string {
  return recipe.inputs.map((i) => `${fmtInt(i.qty)}× ${nameOf(env, i.id)}`).join(' + ');
}

function bottleneck(r: CraftRow): IngredientLine | undefined {
  return r.lines.find((l) => l.bottleneck);
}

export function craftColumns(env: RenderEnv): Column<CraftRow>[] {
  const coins = (v: (r: CraftRow) => number) => (r: CraftRow) => (isUnpriced(r) ? null : v(r));
  return [
    {
      key: 'name',
      label: () => t('craft.colOutput'),
      get: (r) => r.name,
      cls: 'name-cell',
      html: (r) => {
        let s = itemCell(r.id, r.name, true);
        const badges = forgeBadge(r.recipe);
        if (badges) s += `<span class="craft-badges">${badges}</span>`;
        s += `<span class="craft-inputs">${esc(inputsList(env, r.recipe))}</span>`;
        if (r.recipe.req) s += `<span class="craft-req muted small">${esc(r.recipe.req)}</span>`;
        if (isUnpriced(r)) s += `<span class="craft-unpriced-ids small">${esc(t('craft.unpricedList', { ids: r.unpriced.join(', ') }))}</span>`;
        return s;
      },
    },
    {
      key: 'count',
      label: () => t('craft.colOutCount'),
      get: (r) => r.recipe.outCount,
      align: 'right',
      html: (r) => esc(fmtInt(r.recipe.outCount)),
    },
    {
      key: 'cost',
      label: () => t('craft.colCost'),
      get: coins((r) => r.cost),
      align: 'right',
      html: (r) => (isUnpriced(r) ? '—' : esc(fmtCoins(r.cost))),
    },
    {
      key: 'value',
      label: () => t('craft.colValue'),
      get: coins((r) => r.value),
      align: 'right',
      html: (r) => {
        if (isUnpriced(r)) return '—';
        const npc = r.valueSource === 'npc' ? `<span title="${esc(t('craft.npcValueTitle'))}">${sourceBadge('npc')}</span> ` : '';
        return npc + esc(fmtCoins(r.value));
      },
    },
    {
      key: 'profit',
      label: () => t('craft.colProfit'),
      get: coins((r) => r.profit),
      align: 'right',
      html: (r) => (isUnpriced(r) ? '—' : `<span class="${signCls(r.profit)}">${esc(fmtCoins(r.profit))}</span>`),
    },
    {
      key: 'margin',
      label: () => t('craft.colMargin'),
      get: (r) => r.margin,
      align: 'right',
      html: (r) => (r.margin == null ? '—' : `<span class="${signCls(r.margin)}">${esc(fmtPct(r.margin))}</span>`),
    },
    {
      key: 'outRate',
      label: () => t('craft.colOutRate'),
      title: () => t('craft.colOutRateTitle'),
      get: (r) => r.outCraftsPerHour,
      align: 'right',
      html: (r) => {
        const bott = !isUnpriced(r) && Number.isFinite(r.outCraftsPerHour) && r.outCraftsPerHour <= r.inCraftsPerHour;
        return `<span${bott ? ' class="bott"' : ''}>${esc(fmtRate(r.outCraftsPerHour))}</span>`;
      },
    },
    {
      key: 'inRate',
      label: () => t('craft.colInRate'),
      title: () => t('craft.colInRateTitle'),
      get: (r) => r.inCraftsPerHour,
      align: 'right',
      html: (r) => {
        const b = bottleneck(r);
        const bott = !isUnpriced(r) && Number.isFinite(r.inCraftsPerHour) && r.inCraftsPerHour < r.outCraftsPerHour;
        const title = b ? ` title="${esc(t('craft.bottleneckTitle', { name: b.name }))}"` : '';
        return `<span${bott ? ' class="bott"' : ''}${title}>${esc(fmtRate(r.inCraftsPerHour))}</span>`;
      },
    },
    {
      key: 'pph',
      label: () => t('craft.colProfitHour'),
      title: () => t('craft.colProfitHourTitle'),
      get: coins((r) => r.profitPerHour),
      align: 'right',
      html: (r) =>
        isUnpriced(r) ? '—' : `<strong class="${signCls(r.profitPerHour)}">${esc(fmtCoins(r.profitPerHour))}</strong>`,
    },
    {
      key: 'risk',
      label: () => t('craft.colRisk'),
      get: (r) => r.risk.score,
      align: 'center',
      html: (r) => riskBadge(r.risk),
    },
    {
      key: 'detail',
      label: () => t('craft.colDetail'),
      get: () => null,
      sortable: false,
      align: 'center',
      html: () => `<span class="craft-tog">${esc(t('craft.colDetail'))}<span class="craft-chev" aria-hidden="true">▾</span></span>`,
    },
  ];
}

const taxPct = (tax: number) =>
  new Intl.NumberFormat(locale(), { maximumFractionDigits: 3 }).format(tax * 100);

function viaText(env: RenderEnv, key: string | undefined): string {
  if (!key) return '';
  const rec = env.recipe(key);
  if (!rec) return '';
  let s = t('craft.craftFrom', { inputs: inputsList(env, rec) });
  if (rec.outCount > 1) s += ' ' + t('craft.craftFromOut', { n: fmtInt(rec.outCount) });
  return `<span class="craft-via small">${esc(s)}</span>`;
}

function ingredientTable(env: RenderEnv, r: CraftRow): string {
  const missing = new Set(r.unpriced);
  const body = r.lines
    .map((l) => {
      const priced = !missing.has(l.id);
      const src = priced ? sourceBadge(l.source) : `<span class="badge risk-suspect">${esc(t('craft.noPrice'))}</span>`;
      const rate = priced ? `<span${l.bottleneck ? ' class="bott"' : ''}>${esc(fmtRate(l.craftsPerHour))}</span>` : '—';
      return `<tr${l.bottleneck ? ' class="craft-bott-row"' : ''}>
        <td class="name-cell">${itemCell(l.id, l.name, true)}${viaText(env, l.viaRecipe)}</td>
        <td class="num">${esc(fmtInt(l.qty))}</td>
        <td>${src}</td>
        <td class="num">${priced ? esc(fmtCoins(l.unit)) : '—'}</td>
        <td class="num">${priced ? esc(fmtCoins(l.total)) : '—'}</td>
        <td class="num">${rate}</td>
      </tr>`;
    })
    .join('');
  return `<div class="craft-ing-wrap"><table class="tbl-plain craft-ing">
    <thead><tr>
      <th>${esc(t('craft.ingName'))}</th><th class="num">${esc(t('craft.ingQty'))}</th><th>${esc(t('craft.ingSrc'))}</th>
      <th class="num">${esc(t('craft.ingUnit'))}</th><th class="num">${esc(t('craft.ingTotal'))}</th><th class="num">${esc(t('craft.ingRate'))}</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/** Expanded detail: numbered steps, bottleneck/throughput notes, ingredient table. */
export function craftDetail(env: RenderEnv, r: CraftRow): string {
  const s = env.settings();
  const notes: string[] = [];
  let steps = '';

  if (isUnpriced(r)) {
    notes.push(esc(t('craft.cannotPrice', { ids: r.unpriced.join(', ') })));
  } else {
    const li: string[] = [];
    for (const l of r.lines) {
      li.push(
        t('craft.stepBuy', {
          qty: esc(fmtInt(l.qty)),
          name: esc(l.name),
          unit: esc(fmtCoins(l.unit)),
          src: sourceBadge(l.source),
          total: esc(fmtCoins(l.total)),
        }),
      );
    }
    if (r.lines.length > 1) li.push(t('craft.totalCost', { cost: esc(fmtCoins(r.cost)) }));
    const n = esc(fmtInt(r.recipe.outCount));
    const name = esc(r.name);
    if (r.recipe.kind === 'forge') {
      const d = r.recipe.durationSec ? fmtHours(r.recipe.durationSec / 3600) : '?';
      li.push(t('craft.stepForge', { d: esc(d), n, name }));
    } else {
      li.push(t('craft.stepCraft', { n, name }));
    }
    const value = esc(fmtCoins(r.value));
    const tax = esc(taxPct(s.taxRate));
    if (r.valueSource === 'npc') li.push(t('craft.stepSellNpc', { value }));
    else if (s.sellMode === 'insta') li.push(t('craft.stepSellInsta', { tax, value }));
    else li.push(t('craft.stepSellOffer', { tax, value }));
    li.push(
      t('craft.stepProfit', {
        cls: signCls(r.profit),
        profit: esc(fmtCoins(r.profit)),
        margin: esc(fmtPct(r.margin)),
      }),
    );
    steps = `<ol class="craft-steps">${li.map((x) => `<li>${x}</li>`).join('')}</ol>`;

    const b = bottleneck(r);
    if (b && Number.isFinite(r.inCraftsPerHour) && r.inCraftsPerHour < r.outCraftsPerHour) {
      notes.push(esc(t('craft.bottIn', { name: b.name, n: fmtRate(r.inCraftsPerHour) })));
    } else if (Number.isFinite(r.outCraftsPerHour)) {
      notes.push(esc(t('craft.bottOut', { n: fmtRate(r.outCraftsPerHour) })));
    } else {
      notes.push(esc(t('craft.bottNone')));
    }
    const why = t(`craft.why_${r.tp.limitedBy}`);
    if (r.tp.unitsPerHour > 0 && r.profitPerHour > 0) {
      notes.push(
        esc(
          t('craft.tpLine', {
            cph: fmtRate(r.tp.unitsPerHour),
            batch: fmtRate(r.tp.batchQty),
            capital: fmtCoins(r.tp.capitalUsed),
            why,
          }),
        ),
      );
    } else {
      notes.push(esc(t('craft.tpZero', { why })));
    }
  }
  if (r.recipe.req) notes.push(esc(t('craft.reqLine', { req: r.recipe.req.replace(/^requires:\s*/i, '') })));
  if (r.lines.some((l) => l.source === 'npc' && !r.unpriced.includes(l.id))) {
    notes.push(`<span class="craft-npc-limit">${esc(t('craft.npcLimit'))}</span>`);
  }

  return `<div class="detail-box craft-detail">
    ${steps}
    <div class="note">${notes.map((n) => `<p>${n}</p>`).join('')}</div>
    <h4 class="craft-ing-title">${esc(t('craft.ingTitle'))}</h4>
    ${ingredientTable(env, r)}
  </div>`;
}
