// Watchlist page, "Market alerts" section: rules over every opportunity (src/domain/oppAlerts.ts). Edits are committed
// on change; the list is rebuilt when the rules, the language or the hits change.
import { OPP_KINDS } from '../../../domain/oppAlerts.ts';
import { newTradeKey } from '../../../domain/journal.ts';
import { t } from '../../../i18n/index.ts';
import type { OppAlertRule, OppMetric, Opportunity, ViewContext } from '../../../types/contracts.ts';
import { esc } from '../../dom.ts';
import { fmtAge, fmtCoins, fmtPct } from '../../format.ts';
import { parseNumberInput } from '../../kit/index.ts';
import { sourceHref } from '../plan/model.ts';

const METRICS: readonly OppMetric[] = ['profitPerHour', 'profit', 'margin'];
const KIND_LABEL = { flip: 'plan.kindFlip', craft: 'plan.kindCraft', forge: 'plan.kindForge', chain: 'plan.kindChain', book: 'plan.kindBook', npc: 'plan.kindNpc', kat: 'plan.kindKat', ahflip: 'plan.kindAhflip' } as const;

/** A sensible first rule: clean flips above 1M coins per hour. */
export const newOppRule = (): OppAlertRule => ({
  key: newTradeKey('m'),
  scope: ['flip'],
  metric: 'profitPerHour',
  value: 1_000_000,
  maxRisk: 'ok',
  enabled: true,
  seen: [],
  hits: [],
});

const shown = (r: OppAlertRule) => (r.metric === 'margin' ? Math.round(r.value * 10_000) / 100 : r.value);
const fmtValue = (m: OppMetric, v: number) => (m === 'margin' ? fmtPct(v) : fmtCoins(v));

function ruleHtml(r: OppAlertRule, i: number): string {
  const id = (s: string) => `opp-${i}-${s}`;
  const kinds = OPP_KINDS.map(
    (k) =>
      `<label class="check-row"><input type="checkbox" data-opp-kind="${k}"${r.scope.includes(k) ? ' checked' : ''}><span>${esc(t(KIND_LABEL[k]))}</span></label>`,
  ).join('');
  const hits = r.hits.length
    ? `<ul class="opp-hits">${r.hits
        .slice(0, 5)
        .map(
          (h) =>
            `<li><a href="${esc(sourceHref({ kind: h.kind, id: h.id } as Opportunity))}">${esc(h.name)}</a> <span class="muted small">${esc(fmtValue(r.metric, h.value))} · ${esc(fmtAge(Date.now() - h.at))}</span></li>`,
        )
        .join('')}</ul>`
    : `<p class="muted small">${esc(t('watch.oppNoHits'))}</p>`;
  return `<div class="opp-rule" data-opp="${esc(r.key)}" role="group" aria-label="${esc(`${t('watch.oppTitle')} ${i + 1}`)}">
    <fieldset class="opp-kinds"><legend class="field-label">${esc(t('watch.oppKinds'))}</legend>${kinds}</fieldset>
    <div class="opp-line">
      <label class="field"><span class="field-label" id="${id('m')}">${esc(t('watch.oppMetric'))}</span>
        <select data-opp-metric aria-labelledby="${id('m')}">${METRICS.map((m) => `<option value="${m}"${m === r.metric ? ' selected' : ''}>${esc(t(`alerts.om_${m}`))}</option>`).join('')}</select></label>
      <label class="field"><span class="field-label">${esc(t('watch.oppValue'))}${r.metric === 'margin' ? ` (${esc(t('watch.oppPctHint'))})` : ''}</span>
        <input type="text" inputmode="decimal" data-opp-value value="${esc(String(shown(r)))}"></label>
      <label class="field"><span class="field-label">${esc(t('watch.oppRisk'))}</span>
        <select data-opp-risk><option value="ok"${r.maxRisk === 'ok' ? ' selected' : ''}>${esc(t('watch.oppRiskOk'))}</option><option value="caution"${r.maxRisk === 'caution' ? ' selected' : ''}>${esc(t('watch.oppRiskCaution'))}</option></select></label>
      <label class="check-row opp-on"><input type="checkbox" data-opp-enabled${r.enabled ? ' checked' : ''}><span>${esc(t('watch.oppEnabled'))}</span></label>
      <button type="button" class="btn btn-ghost btn-sm" data-opp-delete aria-label="${esc(t('watch.oppDelete'))}" title="${esc(t('watch.oppDelete'))}">×</button>
    </div>
    <div class="opp-hits-box"><span class="small muted">${esc(t('watch.oppHits'))}</span>${hits}</div>
  </div>`;
}

export interface OppAlertsEditor {
  el: HTMLElement;
  render(): void;
  destroy(): void;
}

export function createOppAlertsEditor(ctx: ViewContext): OppAlertsEditor {
  const el = document.createElement('div');
  el.className = 'opp-editor';

  const rules = () => ctx.store.get().oppAlerts;
  const patch = (key: string, p: Partial<OppAlertRule>) =>
    // a changed rule starts over: what already meets the new rule fires on the next snapshot
    ctx.store.set((s) => ({ oppAlerts: s.oppAlerts.map((r) => (r.key === key ? { ...r, ...p, seen: 'enabled' in p && Object.keys(p).length === 1 ? r.seen : [] } : r)) }));

  function render(): void {
    const rs = rules();
    el.innerHTML =
      (rs.length ? rs.map(ruleHtml).join('') : `<p class="muted">${esc(t('watch.oppEmpty'))}</p>`) +
      `<button type="button" class="btn btn-sm" data-opp-add data-testid="opp-add">${esc(t('watch.oppAdd'))}</button>`;
  }

  const onClick = (ev: MouseEvent) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (target?.closest('[data-opp-add]')) {
      ctx.store.set((s) => ({ oppAlerts: [...s.oppAlerts, newOppRule()] }));
      ctx.toast(t('watch.oppAdded'), 'ok');
      return;
    }
    const box = target?.closest<HTMLElement>('[data-opp]');
    if (box && target?.closest('[data-opp-delete]')) ctx.store.set((s) => ({ oppAlerts: s.oppAlerts.filter((r) => r.key !== box.dataset.opp) }));
  };

  const onChange = (ev: Event) => {
    const target = ev.target instanceof HTMLElement ? ev.target : null;
    const box = target?.closest<HTMLElement>('[data-opp]');
    const r = box && rules().find((x) => x.key === box.dataset.opp);
    if (!target || !box || !r) return;
    if (target.matches('[data-opp-kind]')) {
      const scope = [...box.querySelectorAll<HTMLInputElement>('[data-opp-kind]:checked')].map((c) => c.dataset.oppKind as OppAlertRule['scope'][number]);
      if (scope.length) patch(r.key, { scope });
      else (target as HTMLInputElement).checked = true; // at least one kind
    } else if (target.matches('[data-opp-metric]')) {
      const metric = (target as HTMLSelectElement).value as OppMetric;
      patch(r.key, { metric, value: metric === 'margin' ? 0.2 : r.metric === 'margin' ? 1_000_000 : r.value });
    } else if (target.matches('[data-opp-value]')) {
      const n = parseNumberInput((target as HTMLInputElement).value);
      if (n == null || !(n >= 0)) {
        target.setAttribute('aria-invalid', 'true');
        return;
      }
      patch(r.key, { value: r.metric === 'margin' ? n / 100 : n });
    } else if (target.matches('[data-opp-risk]')) patch(r.key, { maxRisk: (target as HTMLSelectElement).value === 'caution' ? 'caution' : 'ok' });
    else if (target.matches('[data-opp-enabled]')) patch(r.key, { enabled: (target as HTMLInputElement).checked });
  };

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  render();
  return {
    el,
    render,
    destroy() {
      el.removeEventListener('click', onClick);
      el.removeEventListener('change', onChange);
    },
  };
}
