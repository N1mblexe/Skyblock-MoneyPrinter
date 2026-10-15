// Settings form for the drawer: Market / Display / Notifications sections bound to store.settings.
import { ORDER_SLOTS_MAX } from '../../config.ts';
import { onLangChange, t } from '../../i18n/index.ts';
import type { AppState, Density, Lang, Settings, Store, TaxRate, Theme } from '../../types/contracts.ts';
import { esc } from '../dom.ts';
import { fmtInt } from '../format.ts';

type Control = HTMLInputElement & HTMLSelectElement;
type FieldName =
  | 'taxRate'
  | 'capital'
  | 'share'
  | 'cycleHours'
  | 'costMode'
  | 'sellMode'
  | 'fillModel'
  | 'orderSlots'
  | 'npcDailyLimit'
  | 'forgeSlots'
  | 'hideSuspicious'
  | 'autoRefresh'
  | 'ahEnabled'
  | 'notify';

const TAXES: TaxRate[] = [0.0125, 0.01125, 0.01];
export const SETTINGS_DEBOUNCE_MS = 400;

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

const trimNum = (n: number) => String(Math.round(n * 1000) / 1000);
const intIn = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/** Validate a control's value and return the settings patch, or null when invalid. */
function read(name: FieldName, c: Control): Partial<Settings> | null {
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
      return intIn(v, 1, 7) ? { forgeSlots: v } : null;
    }
    case 'orderSlots': {
      const v = parseNum(c.value);
      return intIn(v, 1, ORDER_SLOTS_MAX) ? { orderSlots: v } : null;
    }
    case 'npcDailyLimit': {
      const v = parseNum(c.value);
      return intIn(v, 1, 1e7) ? { npcDailyLimit: v } : null;
    }
    case 'costMode':
      return c.value === 'order' || c.value === 'insta' ? { costMode: c.value } : null;
    case 'sellMode':
      return c.value === 'offer' || c.value === 'insta' ? { sellMode: c.value } : null;
    case 'fillModel':
      return c.value === 'sequential' || c.value === 'pipelined' ? { fillModel: c.value } : null;
    case 'hideSuspicious':
    case 'autoRefresh':
    case 'ahEnabled':
    case 'notify':
      return { [name]: c.checked };
  }
}

/** Control values for the current settings. */
function values(s: Settings): Record<FieldName, string | boolean> {
  return {
    taxRate: String(s.taxRate),
    capital: fmtInt(s.capital),
    share: trimNum(s.share * 100),
    cycleHours: trimNum(s.cycleHours),
    costMode: s.costMode,
    sellMode: s.sellMode,
    fillModel: s.fillModel,
    orderSlots: String(s.orderSlots),
    npcDailyLimit: String(s.npcDailyLimit),
    forgeSlots: String(s.forgeSlots),
    hideSuspicious: s.hideSuspicious,
    autoRefresh: s.autoRefresh,
    ahEnabled: s.ahEnabled,
    notify: s.notify,
  };
}

const SEGS: { key: 'lang' | 'theme' | 'density'; label: string; opts: [string, string][] }[] = [
  { key: 'lang', label: 'common.language', opts: [['tr', 'Türkçe'], ['en', 'English']] },
  {
    key: 'theme',
    label: 'common.theme',
    opts: [['auto', 'common.themeAuto'], ['dark', 'common.themeDark'], ['light', 'common.themeLight']],
  },
  { key: 'density', label: 'common.density', opts: [['comfortable', 'common.densityComfortable'], ['compact', 'common.densityCompact']] },
];

export type NotifyPermission = NotificationPermission | 'unsupported';

/** Current Notification permission ('unsupported' when the API is missing). */
export function notifyPermission(): NotifyPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export interface SettingsForm {
  el: HTMLElement;
  /** commit pending debounced inputs */
  flush(): void;
  destroy(): void;
}

/**
 * The settings form: Market (all calculation settings), Display (language, theme, density) and
 * Notifications (notify toggle + permission request). Text inputs commit 400 ms after typing or on change;
 * invalid values get aria-invalid and are not written.
 */
export function createSettingsForm(store: Store<AppState>): SettingsForm {
  const el = document.createElement('div');
  el.className = 'set-form';
  const timers = new Map<FieldName, ReturnType<typeof setTimeout>>();

  const patch = (p: Partial<Settings>) =>
    store.set((s) => {
      const changed = (Object.keys(p) as (keyof Settings)[]).some((k) => s.settings[k] !== p[k]);
      return changed ? { settings: { ...s.settings, ...p } } : {};
    });

  const helpId = (name: string) => `set-${name}-help`;
  function field(name: FieldName, label: string, control: string, help?: string): string {
    return (
      `<label class="field" data-field="${name}"><span class="field-label">${esc(label)}</span>${control}` +
      (help ? `<span class="field-help" id="${helpId(name)}">${esc(help)}</span>` : '') +
      `</label>`
    );
  }
  const desc = (name: string, help?: string) => (help ? ` aria-describedby="${helpId(name)}"` : '');
  function select(name: FieldName, label: string, opts: [string, string][], help?: string): string {
    const o = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    return field(name, label, `<select name="${name}"${desc(name, help)}>${o}</select>`, help);
  }
  function num(name: FieldName, label: string, attrs: string, help?: string): string {
    return field(name, label, `<input name="${name}" type="number" ${attrs}${desc(name, help)}>`, help);
  }
  function check(name: FieldName, label: string, help: string): string {
    return (
      `<label class="field field-check" data-field="${name}"><span class="check-row"><input type="checkbox" name="${name}"${desc(name, help)}>` +
      `<span class="field-label">${esc(label)}</span></span><span class="field-help" id="${helpId(name)}">${esc(help)}</span></label>`
    );
  }
  const section = (id: string, title: string, body: string) =>
    `<section class="set-sec" data-sec="${id}" aria-labelledby="set-sec-${id}"><h3 class="set-h" id="set-sec-${id}">${esc(title)}</h3>${body}</section>`;

  function segs(): string {
    return SEGS.map(({ key, label, opts }) => {
      const btns = opts
        .map(([v, l]) => `<button type="button" data-set="${key}" data-val="${v}" data-testid="set-${key}-${v}">${esc(l.includes('.') ? t(l) : l)}</button>`)
        .join('');
      const help = key === 'density' ? `<span class="field-help">${esc(t('shell.densityHelp'))}</span>` : '';
      return `<div class="field" data-field="${key}"><span class="field-label" id="set-seg-${key}">${esc(t(label))}</span><div class="seg" role="group" aria-labelledby="set-seg-${key}">${btns}</div>${help}</div>`;
    }).join('');
  }

  function build(): void {
    const taxLabels = [t('common.tax125'), t('common.tax1125'), t('common.tax100')];
    el.innerHTML =
      section(
        'market',
        t('shell.sec_market'),
        `<div class="settings-grid">` +
          select('taxRate', t('common.tax'), TAXES.map((v, i) => [String(v), taxLabels[i]!]), t('common.taxHelp')) +
          field('capital', t('common.capital'), `<input name="capital" type="text" inputmode="decimal" autocomplete="off" aria-describedby="${helpId('capital')}">`, t('common.capitalHelp')) +
          num('share', t('common.share'), 'min="0.1" max="100" step="0.5"', t('common.shareHelp')) +
          num('cycleHours', t('common.cycleHours'), 'min="0.05" max="168" step="0.5"', t('common.cycleHelp')) +
          select('costMode', t('common.costMode'), [['order', t('common.costOrder')], ['insta', t('common.costInsta')]]) +
          select('sellMode', t('common.sellMode'), [['offer', t('common.sellOffer')], ['insta', t('common.sellInsta')]]) +
          `<div class="set-wide">` +
          select('fillModel', t('common.fillModel'), [['sequential', t('common.fillSequential')], ['pipelined', t('common.fillPipelined')]], t('shell.fillHelp')) +
          `</div>` +
          num('orderSlots', t('common.orderSlots'), `min="1" max="${ORDER_SLOTS_MAX}" step="1"`, t('common.orderSlotsHelp')) +
          num('npcDailyLimit', t('common.npcDailyLimit'), 'min="1" step="1"', t('common.npcDailyLimitHelp')) +
          num('forgeSlots', t('common.forgeSlots'), 'min="1" max="7" step="1"', t('common.forgeHelp')) +
          `</div><div class="settings-checks">` +
          check('hideSuspicious', t('common.hideSuspicious'), t('common.hideSuspiciousHelp')) +
          check('autoRefresh', t('common.autoRefresh'), t('common.autoRefreshHelp')) +
          check('ahEnabled', t('common.ahEnabled'), t('common.ahEnabledHelp')) +
          `</div>`,
      ) +
      section('display', t('shell.sec_display'), `<div class="settings-segs">${segs()}</div>`) +
      section(
        'notify',
        t('shell.sec_notify'),
        check('notify', t('common.notify'), t('common.notifyHelp')) +
          `<div class="perm-row"><button type="button" class="btn btn-sm perm-btn" data-testid="notify-perm"></button><span class="perm-state small muted" role="status"></span></div>`,
      );
    sync(true);
    renderPerm();
  }

  const control = (name: string) => el.querySelector<Control>(`[name="${name}"]`);

  /** Push store values into controls (skipping the focused one unless forced). */
  function sync(force = false): void {
    const s = store.get().settings;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    for (const [k, v] of Object.entries(values(s)) as [FieldName, string | boolean][]) {
      const c = control(k);
      if (!c || (!force && c === active)) continue;
      if (typeof v === 'boolean') c.checked = v;
      else if (c.value !== v) c.value = v;
      c.removeAttribute('aria-invalid');
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-set]')) {
      const key = b.dataset.set as 'lang' | 'theme' | 'density';
      b.setAttribute('aria-pressed', String(s[key] === b.dataset.val));
    }
    renderPerm();
  }

  function renderPerm(): void {
    const btn = el.querySelector<HTMLButtonElement>('.perm-btn');
    const state = el.querySelector<HTMLElement>('.perm-state');
    if (!btn || !state) return;
    const p = notifyPermission();
    btn.textContent = t('shell.permAsk');
    btn.hidden = p !== 'default';
    let msg = t(`shell.perm_${p}`);
    if (store.get().settings.notify && p !== 'granted' && p !== 'unsupported') msg = `${t('shell.notifyNeedsPerm')} ${msg}`;
    state.textContent = msg;
    state.classList.toggle('warn-text', store.get().settings.notify && p !== 'granted');
  }

  function commit(c: Control): void {
    const name = c.name as FieldName;
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
    const c = ev.target as Control;
    if (!c?.name || c.tagName === 'SELECT' || (c as HTMLInputElement).type === 'checkbox') return;
    const name = c.name as FieldName;
    clearTimeout(timers.get(name));
    timers.set(
      name,
      setTimeout(() => {
        timers.delete(name);
        commit(c);
      }, SETTINGS_DEBOUNCE_MS),
    );
  };
  const onChange = (ev: Event) => {
    const c = ev.target as Control;
    if (!c?.name || !(c.name in values(store.get().settings))) return;
    clearTimeout(timers.get(c.name as FieldName));
    timers.delete(c.name as FieldName);
    commit(c);
    if (c.name === 'capital' && !c.hasAttribute('aria-invalid')) c.value = fmtInt(store.get().settings.capital);
  };
  const onClick = (ev: MouseEvent) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const seg = target?.closest<HTMLButtonElement>('[data-set]');
    if (seg) {
      const key = seg.dataset.set!;
      const val = seg.dataset.val!;
      if (key === 'lang') patch({ lang: val as Lang });
      else if (key === 'theme') patch({ theme: val as Theme });
      else if (key === 'density') patch({ density: val as Density });
      return;
    }
    if (target?.closest('.perm-btn') && typeof Notification !== 'undefined') {
      // must run inside the click handler: browsers only allow the prompt on a user gesture
      void Promise.resolve(Notification.requestPermission())
        .then((p) => {
          if (p === 'granted' && !store.get().settings.notify) patch({ notify: true });
        })
        .catch(() => {})
        .finally(renderPerm);
    }
  };
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);
  el.addEventListener('click', onClick);

  build();
  const unsub = store.subscribe((s, prev) => {
    if (s.settings !== prev.settings) sync();
  });
  const unLang = onLangChange(() => build());

  return {
    el,
    flush() {
      for (const [name, tm] of timers) {
        clearTimeout(tm);
        const c = control(name);
        if (c) commit(c);
      }
      timers.clear();
    },
    destroy() {
      for (const tm of timers.values()) clearTimeout(tm);
      timers.clear();
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onChange);
      el.removeEventListener('click', onClick);
      unsub();
      unLang();
      el.remove();
    },
  };
}
