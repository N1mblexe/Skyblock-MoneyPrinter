// Alert rules editor: rules grouped by item, edited in place. Rebuilds only when the set of rules changes;
// otherwise patches values (never the control that has focus) so typing is not interrupted by store updates.
import { metricValue } from '../../../domain/alerts.ts';
import { getLang, t } from '../../../i18n/index.ts';
import { fmtMetric } from '../../../state/alertsRunner.ts';
import type { AlertMetric, AlertRule, ViewContext } from '../../../types/contracts.ts';
import { esc } from '../../dom.ts';
import { fmtAge, locale } from '../../format.ts';
import { parseNumberInput } from '../../kit/index.ts';
import { METRICS, isRatio, ruleText } from './alertText.ts';
import { MAX_COOLDOWN_MIN, suggestRule } from './model.ts';

export interface RulesEditor {
  el: HTMLElement;
  /** sync with the store (cheap when nothing structural changed) */
  render(force?: boolean): void;
  /** focus one control of a rule (default: the threshold input) and scroll it into view */
  focusRule(key: string, field?: string): void;
  destroy(): void;
}

type Field = 'metric' | 'op' | 'value' | 'cooldown' | 'enabled';

/** Escape a value for a double-quoted attribute selector. */
const q = (v: string) => v.replace(/["\\]/g, '\\$&');

/** Threshold as shown in the input: percent for ratio metrics, no grouping, locale decimal separator. */
export function displayValue(metric: AlertMetric, v: number): string {
  const n = isRatio(metric) ? v * 100 : v;
  return new Intl.NumberFormat(locale(), { useGrouping: false, maximumFractionDigits: 4 }).format(n);
}

/** Parse the threshold input back to a stored value (ratio for % metrics); null when invalid. */
export function parseValue(metric: AlertMetric, raw: string): number | null {
  const n = parseNumberInput(raw);
  if (n == null) return null;
  return isRatio(metric) ? n / 100 : n;
}

export function createRulesEditor(ctx: ViewContext, opts: { addRule(id: string): void }): RulesEditor {
  const el = document.createElement('div');
  el.className = 'wr-list';
  el.dataset.testid = 'watch-rules';
  let sig = '';

  const rules = () => ctx.store.get().alerts;
  const name = (id: string) => ctx.store.get().catalog?.name(id) ?? id;

  function patchRule(key: string, patch: Partial<AlertRule>): void {
    ctx.store.set((s) => ({ alerts: s.alerts.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  }

  /** ids with rules: watchlist order first, then the rest by name */
  function groups(list: readonly AlertRule[]): { id: string; rules: AlertRule[] }[] {
    const by = new Map<string, AlertRule[]>();
    for (const r of list) {
      const g = by.get(r.id);
      if (g) g.push(r);
      else by.set(r.id, [r]);
    }
    const order = ctx.store.get().watchlist.map((w) => w.id).filter((id) => by.has(id));
    const inList = new Set(order);
    const rest = [...by.keys()].filter((id) => !inList.has(id)).sort((a, b) => name(a).localeCompare(name(b)));
    return [...order, ...rest].map((id) => ({ id, rules: by.get(id)! }));
  }

  function current(r: AlertRule): number | null {
    const c = ctx.derived.calcCtx();
    return c ? metricValue(r.metric, r.id, c) : null;
  }

  function nowHtml(r: AlertRule): string {
    const v = current(r);
    if (v == null) return esc(t('watch.nowNA'));
    const met = r.op === 'lt' ? v < r.value : v > r.value;
    return esc(t('watch.now', { v: fmtMetric(r.metric, v) })) + (met ? ` <span class="badge wr-met">${esc(t('watch.met'))}</span>` : '');
  }

  const firedHtml = (r: AlertRule) => (r.lastFiredAt != null ? esc(t('watch.lastFired', { age: fmtAge(Date.now() - r.lastFiredAt) })) : '');

  function ruleHtml(r: AlertRule, n: number, itemName: string): string {
    const metricOpts = METRICS.map((m) => `<option value="${m}"${m === r.metric ? ' selected' : ''}>${esc(t(`alerts.m_${m}`))}</option>`).join('');
    const opOpts = (['lt', 'gt'] as const).map((o) => `<option value="${o}"${o === r.op ? ' selected' : ''}>${esc(t(`watch.op_${o}`))}</option>`).join('');
    const unit = isRatio(r.metric) ? t('watch.unitPct') : t('watch.unitCoins');
    return (
      `<div class="wr-rule${r.enabled ? '' : ' wr-off'}" data-rule="${esc(r.key)}" role="group" aria-label="${esc(t('watch.ruleAria', { name: itemName, n }))}">` +
      `<label class="wr-f"><span class="wr-l">${esc(t('watch.f_metric'))}</span><select data-f="metric">${metricOpts}</select></label>` +
      `<label class="wr-f"><span class="wr-l">${esc(t('watch.f_op'))}</span><select data-f="op">${opOpts}</select></label>` +
      `<label class="wr-f wr-val"><span class="wr-l">${esc(t('watch.f_value'))}</span><span class="wr-in">` +
      `<input data-f="value" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(displayValue(r.metric, r.value))}">` +
      `<span class="wr-unit" data-unit>${esc(unit)}</span></span></label>` +
      `<label class="wr-f wr-cd"><span class="wr-l">${esc(t('watch.f_cooldown'))}</span>` +
      `<input data-f="cooldown" type="number" min="0" max="${MAX_COOLDOWN_MIN}" step="1" inputmode="numeric" value="${r.cooldownMin}"></label>` +
      `<label class="wr-on"><input type="checkbox" data-f="enabled"${r.enabled ? ' checked' : ''}><span>${esc(t('watch.f_enabled'))}</span></label>` +
      `<span class="wr-now num" data-now>${nowHtml(r)}</span>` +
      `<span class="wr-fired muted small" data-fired>${firedHtml(r)}</span>` +
      `<button type="button" class="btn btn-ghost btn-sm btn-danger wr-del" data-act="del" aria-label="${esc(t('watch.delRule', { rule: ruleText(r) }))}">${esc(t('watch.del'))}</button>` +
      `</div>`
    );
  }

  function build(gs: { id: string; rules: AlertRule[] }[]): void {
    if (!gs.length) {
      el.innerHTML = `<p class="empty wr-empty">${esc(t('watch.rulesEmpty'))}</p>`;
      return;
    }
    const watched = new Set(ctx.store.get().watchlist.map((w) => w.id));
    el.innerHTML = gs
      .map(({ id, rules: rs }) => {
        const nm = name(id);
        const hid = `wr-h-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
        return (
          `<section class="wr-group" data-id="${esc(id)}" aria-labelledby="${esc(hid)}">` +
          `<h3 class="wr-head" id="${esc(hid)}"><a href="#/item/${encodeURIComponent(id)}">${esc(nm)}</a>` +
          `<span class="id-sub">${esc(id)}</span>` +
          (watched.has(id) ? '' : ` <span class="badge wr-unwatched">${esc(t('watch.notWatched'))}</span>`) +
          `</h3>` +
          `<div class="wr-rules">${rs.map((r, i) => ruleHtml(r, i + 1, nm)).join('')}</div>` +
          `<button type="button" class="btn btn-sm wr-add" data-act="add" data-id="${esc(id)}" aria-label="${esc(t('watch.addRuleFor', { name: nm }))}">+ ${esc(t('watch.addRule'))}</button>` +
          `</section>`
        );
      })
      .join('');
  }

  function patch(list: readonly AlertRule[]): void {
    const active = document.activeElement;
    for (const r of list) {
      const row = el.querySelector<HTMLElement>(`[data-rule="${q(r.key)}"]`);
      if (!row) continue;
      row.classList.toggle('wr-off', !r.enabled);
      const set = (f: Field, apply: (x: HTMLInputElement & HTMLSelectElement) => void) => {
        const c = row.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-f="${f}"]`);
        if (c && c !== active) apply(c);
      };
      set('metric', (c) => (c.value = r.metric));
      set('op', (c) => (c.value = r.op));
      set('value', (c) => {
        // keep what the user typed if it already means the stored value
        if (parseValue(r.metric, c.value) !== r.value) c.value = displayValue(r.metric, r.value);
        c.removeAttribute('aria-invalid');
      });
      set('cooldown', (c) => (c.value = String(r.cooldownMin)));
      set('enabled', (c) => (c.checked = r.enabled));
      const unit = row.querySelector<HTMLElement>('[data-unit]');
      if (unit) unit.textContent = isRatio(r.metric) ? t('watch.unitPct') : t('watch.unitCoins');
      const now = row.querySelector<HTMLElement>('[data-now]');
      const html = nowHtml(r);
      if (now && now.innerHTML !== html) now.innerHTML = html;
      const fired = row.querySelector<HTMLElement>('[data-fired]');
      if (fired) fired.innerHTML = firedHtml(r);
      const del = row.querySelector<HTMLElement>('[data-act="del"]');
      del?.setAttribute('aria-label', t('watch.delRule', { rule: ruleText(r) }));
    }
  }

  function render(force = false): void {
    const list = rules();
    const gs = groups(list);
    const watched = ctx.store.get().watchlist.map((w) => w.id).join(',');
    const next = [getLang(), watched, ...gs.map((g) => `${g.id}:${g.rules.map((r) => r.key).join(',')}`)].join('|');
    if (force || next !== sig) {
      // remember focus to restore it after the rebuild
      const a = document.activeElement as HTMLElement | null;
      const row = a && el.contains(a) ? a.closest<HTMLElement>('[data-rule]') : null;
      const grp = a && el.contains(a) ? a.closest<HTMLElement>('[data-id]') : null;
      const f = a?.dataset.f ?? a?.dataset.act;
      sig = next;
      build(gs);
      if (row?.dataset.rule && f && el.querySelector(`[data-rule="${q(row.dataset.rule)}"]`)) focusRule(row.dataset.rule, f);
      else if (grp?.dataset.id) {
        const g = el.querySelector<HTMLElement>(`section[data-id="${q(grp.dataset.id)}"]`);
        (g?.querySelector<HTMLElement>('[data-act="add"]') ?? null)?.focus();
      }
    }
    patch(list);
  }

  function focusRule(key: string, field = 'value'): void {
    const row = el.querySelector<HTMLElement>(`[data-rule="${q(key)}"]`);
    const c = row?.querySelector<HTMLElement>(`[data-f="${field}"], [data-act="${field}"]`);
    if (!c) return;
    c.focus();
    if (c instanceof HTMLInputElement && c.type === 'text') c.select();
    c.scrollIntoView?.({ block: 'nearest' });
  }

  function onChange(ev: Event): void {
    const c = ev.target as HTMLInputElement & HTMLSelectElement;
    const f = c.dataset?.f as Field | undefined;
    const key = c.closest<HTMLElement>('[data-rule]')?.dataset.rule;
    const r = key ? rules().find((x) => x.key === key) : undefined;
    if (!f || !r) return;
    switch (f) {
      case 'metric': {
        const metric = c.value as AlertMetric;
        if (!METRICS.includes(metric) || metric === r.metric) return;
        // a coin threshold means nothing as a percent (and vice versa): start from the current value
        const s = suggestRule(metric, current({ ...r, metric }));
        patchRule(r.key, { metric, op: s.op, value: s.value });
        // the threshold input follows the new metric even though the metric select keeps focus
        const inp = c.closest('[data-rule]')?.querySelector<HTMLInputElement>('[data-f="value"]');
        if (inp) inp.value = displayValue(metric, s.value);
        return;
      }
      case 'op':
        if (c.value === 'lt' || c.value === 'gt') patchRule(r.key, { op: c.value });
        return;
      case 'value': {
        const v = parseValue(r.metric, c.value);
        if (v == null) {
          c.setAttribute('aria-invalid', 'true');
          ctx.toast(t('watch.badValue'), 'warn');
          return;
        }
        c.removeAttribute('aria-invalid');
        if (v !== r.value) patchRule(r.key, { value: v });
        return;
      }
      case 'cooldown': {
        const n = parseNumberInput(c.value);
        if (n == null || n < 0 || n > MAX_COOLDOWN_MIN) {
          c.value = String(r.cooldownMin);
          ctx.toast(t('watch.badValue'), 'warn');
          return;
        }
        const v = Math.round(n);
        c.value = String(v);
        if (v !== r.cooldownMin) patchRule(r.key, { cooldownMin: v });
        return;
      }
      case 'enabled':
        patchRule(r.key, { enabled: c.checked });
        return;
    }
  }

  function onClick(ev: MouseEvent): void {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b || !el.contains(b)) return;
    if (b.dataset.act === 'add' && b.dataset.id) opts.addRule(b.dataset.id);
    else if (b.dataset.act === 'del') {
      const key = b.closest<HTMLElement>('[data-rule]')?.dataset.rule;
      if (!key) return;
      // focus target after the rebuild: the next rule's delete button, else the group's add button
      const row = b.closest<HTMLElement>('[data-rule]')!;
      const nextKey = (row.nextElementSibling as HTMLElement | null)?.dataset.rule ?? (row.previousElementSibling as HTMLElement | null)?.dataset.rule;
      const groupId = row.closest<HTMLElement>('section[data-id]')?.dataset.id;
      ctx.store.set((s) => ({ alerts: s.alerts.filter((r) => r.key !== key) }));
      render();
      const target =
        (nextKey ? el.querySelector<HTMLElement>(`[data-rule="${q(nextKey)}"] [data-act="del"]`) : null) ??
        (groupId ? el.querySelector<HTMLElement>(`section[data-id="${q(groupId)}"] [data-act="add"]`) : null) ??
        el.parentElement?.querySelector<HTMLElement>('h2[tabindex]') ??
        null;
      target?.focus();
      ctx.toast(t('watch.ruleDeleted'), 'info');
    }
  }

  el.addEventListener('change', onChange);
  el.addEventListener('click', onClick);

  return {
    el,
    render,
    focusRule,
    destroy() {
      el.removeEventListener('change', onChange);
      el.removeEventListener('click', onClick);
      el.remove();
    },
  };
}
