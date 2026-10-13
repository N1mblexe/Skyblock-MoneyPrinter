import type { AppState, CostMode, SellMode, Settings, Store, TaxRate } from '../types/contracts.ts';
import { onLangChange, t } from '../i18n/index.ts';
import { esc } from './dom.ts';
import { fmtInt } from './format.ts';

type FieldId = 'taxRate' | 'capital' | 'share' | 'cycleHours' | 'costMode' | 'sellMode' | 'forgeSlots' | 'hideSuspicious' | 'autoRefresh';

const TAXES: TaxRate[] = [0.0125, 0.01125, 0.01];

/** Parse a user-entered number, accepting "5.000.000", "5,000,000", "2,5" and plain "2.5". */
export function parseNum(raw: string): number {
  let s = raw.trim().replace(/[\s_']/g, '');
  if (!s) return NaN;
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  if (dots && commas) {
    // the later separator is the decimal one
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (commas) {
    s = commas > 1 || /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (dots > 1) {
    s = s.replace(/\./g, '');
  }
  return Number(s);
}

/** Parse a coin amount: grouping separators ignored, k/m/b suffixes ("5m" = 5,000,000, "2,5m" = 2,500,000). */
export function parseCoins(raw: string): number {
  const s = raw.trim().toLowerCase().replace(/[\s_']/g, '');
  const m = /^(.*?)([kmb])$/.exec(s);
  if (m) {
    const base = parseNum(m[1]!);
    const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1e9;
    return base * mult;
  }
  if (!/^[\d.,]+$/.test(s)) return NaN;
  return Number(s.replace(/[.,]/g, ''));
}

/** Global settings form bound to store.settings (tax, capital, share %, cycle hours, cost/sell modes, forge slots, hide suspicious, auto refresh). */
export function createSettingsPanel(store: Store<AppState>): { el: HTMLElement; destroy(): void } {
  const el = document.createElement('div');
  el.className = 'settings-grid';
  const timers = new Map<FieldId, ReturnType<typeof setTimeout>>();

  const patch = (p: Partial<Settings>) => store.set((s) => ({ settings: { ...s.settings, ...p } }));

  function field(id: FieldId, label: string, control: string, help?: string): string {
    return (
      `<label class="field" data-field="${id}"><span class="field-label">${esc(label)}</span>${control}` +
      (help ? `<span class="field-help">${esc(help)}</span>` : '') +
      `</label>`
    );
  }
  function check(id: FieldId, label: string, help: string): string {
    return (
      `<label class="field field-check" data-field="${id}"><span class="check-row"><input type="checkbox" name="${id}"><span class="field-label">${esc(label)}</span></span>` +
      `<span class="field-help">${esc(help)}</span></label>`
    );
  }
  const opt = (v: string, label: string) => `<option value="${esc(v)}">${esc(label)}</option>`;

  function build(): void {
    const taxLabels = [t('common.tax125'), t('common.tax1125'), t('common.tax100')];
    el.innerHTML =
      field('taxRate', t('common.tax'), `<select name="taxRate">${TAXES.map((v, i) => opt(String(v), taxLabels[i]!)).join('')}</select>`, t('common.taxHelp')) +
      field('capital', t('common.capital'), `<input name="capital" type="text" inputmode="numeric" autocomplete="off">`, t('common.capitalHelp')) +
      field('share', t('common.share'), `<input name="share" type="number" min="0.1" max="100" step="0.5">`, t('common.shareHelp')) +
      field('cycleHours', t('common.cycleHours'), `<input name="cycleHours" type="number" min="0.05" max="168" step="0.5">`, t('common.cycleHelp')) +
      field('costMode', t('common.costMode'), `<select name="costMode">${opt('order', t('common.costOrder'))}${opt('insta', t('common.costInsta'))}</select>`) +
      field('sellMode', t('common.sellMode'), `<select name="sellMode">${opt('offer', t('common.sellOffer'))}${opt('insta', t('common.sellInsta'))}</select>`) +
      field('forgeSlots', t('common.forgeSlots'), `<input name="forgeSlots" type="number" min="1" max="7" step="1">`, t('common.forgeHelp')) +
      check('hideSuspicious', t('common.hideSuspicious'), t('common.hideSuspiciousHelp')) +
      check('autoRefresh', t('common.autoRefresh'), t('common.autoRefreshHelp'));
    sync(true);
  }

  const input = (name: FieldId) => el.querySelector<HTMLInputElement & HTMLSelectElement>(`[name="${name}"]`)!;

  const fmtCapital = (n: number) => fmtInt(n);
  const trimNum = (n: number) => String(Math.round(n * 1000) / 1000);

  /** Push store values into controls (skipping the focused one unless forced). */
  function sync(force = false): void {
    const s = store.get().settings;
    const vals: Record<FieldId, string | boolean> = {
      taxRate: String(s.taxRate),
      capital: fmtCapital(s.capital),
      share: trimNum(s.share * 100),
      cycleHours: trimNum(s.cycleHours),
      costMode: s.costMode,
      sellMode: s.sellMode,
      forgeSlots: String(s.forgeSlots),
      hideSuspicious: s.hideSuspicious,
      autoRefresh: s.autoRefresh,
    };
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    for (const [k, v] of Object.entries(vals) as [FieldId, string | boolean][]) {
      const c = input(k);
      if (!c || (!force && c === active)) continue;
      if (typeof v === 'boolean') c.checked = v;
      else if (c.value !== v) c.value = v;
      c.removeAttribute('aria-invalid');
    }
  }

  /** Validate a control and return the settings patch, or null when invalid. */
  function read(name: FieldId, c: HTMLInputElement & HTMLSelectElement): Partial<Settings> | null {
    switch (name) {
      case 'taxRate': {
        const v = Number(c.value) as TaxRate;
        return TAXES.includes(v) ? { taxRate: v } : null;
      }
      case 'capital': {
        const v = parseCoins(c.value);
        return Number.isFinite(v) && v >= 0 && v <= 1e13 ? { capital: Math.round(v) } : null;
      }
      case 'share': {
        const v = parseNum(c.value);
        return Number.isFinite(v) && v > 0 && v <= 100 ? { share: v / 100 } : null;
      }
      case 'cycleHours': {
        const v = parseNum(c.value);
        return Number.isFinite(v) && v >= 0.05 && v <= 168 ? { cycleHours: v } : null;
      }
      case 'forgeSlots': {
        const v = parseNum(c.value);
        return Number.isInteger(v) && v >= 1 && v <= 7 ? { forgeSlots: v } : null;
      }
      case 'costMode':
        return c.value === 'order' || c.value === 'insta' ? { costMode: c.value as CostMode } : null;
      case 'sellMode':
        return c.value === 'offer' || c.value === 'insta' ? { sellMode: c.value as SellMode } : null;
      case 'hideSuspicious':
        return { hideSuspicious: c.checked };
      case 'autoRefresh':
        return { autoRefresh: c.checked };
    }
  }

  function commit(c: HTMLInputElement & HTMLSelectElement): void {
    const name = c.name as FieldId;
    const p = read(name, c);
    if (!p) {
      c.setAttribute('aria-invalid', 'true');
      c.title = t('common.invalid');
      return;
    }
    c.removeAttribute('aria-invalid');
    c.removeAttribute('title');
    patch(p);
  }

  const onInput = (ev: Event) => {
    const c = ev.target as HTMLInputElement & HTMLSelectElement;
    if (!c?.name || c.tagName === 'SELECT' || (c as HTMLInputElement).type === 'checkbox') return;
    const name = c.name as FieldId;
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => commit(c), 400));
  };
  const onChange = (ev: Event) => {
    const c = ev.target as HTMLInputElement & HTMLSelectElement;
    if (!c?.name) return;
    clearTimeout(timers.get(c.name as FieldId));
    commit(c);
    if (c.name === 'capital' && !c.hasAttribute('aria-invalid')) c.value = fmtCapital(store.get().settings.capital);
  };
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);

  build();
  const unsub = store.subscribe((s, prev) => {
    if (s.settings !== prev.settings) sync();
  });
  const unLang = onLangChange(() => build());

  return {
    el,
    destroy() {
      for (const tm of timers.values()) clearTimeout(tm);
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onChange);
      unsub();
      unLang();
      el.remove();
    },
  };
}
