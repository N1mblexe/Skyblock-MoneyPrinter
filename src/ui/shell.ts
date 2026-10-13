import type { AppState, Lang, Route, RouteId, Store, Theme } from '../types/contracts.ts';
import '../i18n/common.ts';
import { getLang, onLangChange, setLang, t } from '../i18n/index.ts';
import { TAB_ORDER } from './views/index.ts';
import { routeToHash } from './router.ts';
import { esc } from './dom.ts';
import { createStatusPill } from './statusPill.ts';
import { createSettingsPanel } from './settingsPanel.ts';
import { createManualLoad } from './manualLoad.ts';

export interface ShellContext {
  store: Store<AppState>;
  refresh(): Promise<void>;
  navigate(r: Route): void;
  /** manual paste/file load; return error message or null on success */
  manualLoad(text: string): string | null;
}

const LANGS: Lang[] = ['tr', 'en'];
const THEMES: Theme[] = ['auto', 'light', 'dark'];
const THEME_KEY: Record<Theme, string> = { auto: 'themeAuto', light: 'themeLight', dark: 'themeDark' };

/** Apply a theme setting to <html data-theme> (attribute removed for auto). */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/**
 * Header (title, status pill, refresh button, TR/EN toggle, theme toggle), catalog error banner,
 * manual load panel, settings panel, tab nav (flip/craft/fusion/npc; active per store.route), and the view container.
 * Applies settings.theme to <html data-theme> and settings.lang via setLang.
 */
export function mountShell(root: HTMLElement, ctx: ShellContext): { viewRoot: HTMLElement; destroy(): void } {
  const { store } = ctx;
  const cleanups: (() => void)[] = [];

  // apply settings before first render so labels come out in the right language
  const s0 = store.get();
  applyTheme(s0.settings.theme);
  setLang(s0.settings.lang);

  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML =
    `<header class="app-header">` +
    `<div class="brand"><h1 class="app-title"></h1><p class="sub"></p></div>` +
    `<div class="app-actions">` +
    `<div class="status-slot"></div>` +
    `<button type="button" class="btn btn-primary refresh-btn" data-testid="refresh-btn"><span class="refresh-ico" aria-hidden="true">↻</span><span class="refresh-lbl"></span></button>` +
    `<div class="seg seg-lang" role="group">${LANGS.map((l) => `<button type="button" data-lang="${l}" data-testid="lang-${l}">${l.toUpperCase()}</button>`).join('')}</div>` +
    `<div class="seg seg-theme" role="group">${THEMES.map((th) => `<button type="button" data-theme-set="${th}"></button>`).join('')}</div>` +
    `</div>` +
    `</header>` +
    `<div class="banner banner-err catalog-banner" role="alert" hidden></div>` +
    `<div class="manual-slot"></div>` +
    `<details class="panel settings-panel"><summary></summary><div class="panel-body settings-slot"></div></details>` +
    `<nav class="tabs" role="tablist"></nav>` +
    `<main class="view-root" id="view"></main>` +
    `<footer class="app-footer note"><p class="f1"></p><p class="f2"></p></footer>`;
  root.append(wrap);

  const $ = <E extends Element = HTMLElement>(sel: string) => wrap.querySelector<E>(sel)!;
  const titleEl = $('.app-title');
  const subEl = $('.sub');
  const refreshBtn = $<HTMLButtonElement>('.refresh-btn');
  const refreshLbl = $('.refresh-lbl');
  const langSeg = $('.seg-lang');
  const themeSeg = $('.seg-theme');
  const banner = $('.catalog-banner');
  const settingsDetails = $<HTMLDetailsElement>('.settings-panel');
  const tabsNav = $('.tabs');
  const viewRoot = $('.view-root');
  const f1 = $('.f1');
  const f2 = $('.f2');

  // status pill
  const pill = createStatusPill(store);
  $('.status-slot').replaceWith(pill.el);
  cleanups.push(pill.destroy);

  // manual load
  const manual = createManualLoad((text) => ctx.manualLoad(text));
  $('.manual-slot').replaceWith(manual.el);
  cleanups.push(manual.destroy);

  // settings
  const settings = createSettingsPanel(store);
  $('.settings-slot').append(settings.el);
  cleanups.push(settings.destroy);
  try {
    if (typeof matchMedia === 'function' && matchMedia('(min-width: 900px)').matches) settingsDetails.open = true;
  } catch {
    /* ignore */
  }

  // tabs
  tabsNav.innerHTML = TAB_ORDER.map(
    (id) => `<a class="tab" role="tab" href="${esc(routeToHash({ id }))}" data-tab="${id}" data-testid="tab-${id}"></a>`,
  ).join('');

  let busy = false;

  function renderLabels(): void {
    const title = t('common.appTitle');
    const sp = title.indexOf(' ');
    titleEl.innerHTML = sp > 0 ? `${esc(title.slice(0, sp))} <span>${esc(title.slice(sp + 1))}</span>` : esc(title);
    subEl.textContent = t('common.subtitle');
    refreshLbl.textContent = busy ? t('common.refreshing') : t('common.refresh');
    refreshBtn.title = t('common.refreshTitle');
    langSeg.setAttribute('aria-label', t('common.language'));
    themeSeg.setAttribute('aria-label', t('common.theme'));
    for (const b of themeSeg.querySelectorAll<HTMLButtonElement>('button')) {
      const th = b.dataset.themeSet as Theme;
      b.textContent = t(`common.${THEME_KEY[th]}`);
      b.title = t(`common.${THEME_KEY[th]}Title`);
    }
    settingsDetails.querySelector('summary')!.textContent = t('common.settingsTitle');
    tabsNav.setAttribute('aria-label', t('common.tabsAria'));
    for (const a of tabsNav.querySelectorAll<HTMLElement>('.tab')) a.textContent = t(`common.tab_${a.dataset.tab}`);
    f1.textContent = t('common.footer1');
    f2.textContent = t('common.footer2');
    renderBanner(store.get());
  }

  function renderToggles(s: AppState): void {
    for (const b of langSeg.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.lang === s.settings.lang));
    for (const b of themeSeg.querySelectorAll<HTMLButtonElement>('button'))
      b.setAttribute('aria-pressed', String(b.dataset.themeSet === s.settings.theme));
  }

  function renderTabs(s: AppState): void {
    const active: RouteId | null = s.route.id === 'item' ? null : s.route.id;
    for (const a of tabsNav.querySelectorAll<HTMLElement>('.tab')) {
      const on = a.dataset.tab === active;
      a.setAttribute('aria-selected', String(on));
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  function renderBanner(s: AppState): void {
    if (s.catalogError) {
      banner.textContent = t('common.catalogError', { err: s.catalogError });
      banner.hidden = false;
    } else {
      banner.textContent = '';
      banner.hidden = true;
    }
  }

  function maybeOpenManual(s: AppState, prev: AppState | null): void {
    const need = s.status === 'error' && !s.snapshot;
    const before = prev ? prev.status === 'error' && !prev.snapshot : false;
    if (need && !before) manual.open();
  }

  // events
  const onClick = (ev: MouseEvent) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const langBtn = target.closest<HTMLElement>('[data-lang]');
    if (langBtn && langSeg.contains(langBtn)) {
      const lang = langBtn.dataset.lang as Lang;
      store.set((s) => (s.settings.lang === lang ? {} : { settings: { ...s.settings, lang } }));
      return;
    }
    const themeBtn = target.closest<HTMLElement>('[data-theme-set]');
    if (themeBtn && themeSeg.contains(themeBtn)) {
      const theme = themeBtn.dataset.themeSet as Theme;
      store.set((s) => (s.settings.theme === theme ? {} : { settings: { ...s.settings, theme } }));
      return;
    }
    const tab = target.closest<HTMLElement>('.tab');
    if (tab && tabsNav.contains(tab)) {
      if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      ctx.navigate({ id: tab.dataset.tab as RouteId });
      return;
    }
    if (target.closest('.refresh-btn')) void doRefresh();
  };
  wrap.addEventListener('click', onClick);
  cleanups.push(() => wrap.removeEventListener('click', onClick));

  async function doRefresh(): Promise<void> {
    if (busy) return;
    busy = true;
    refreshBtn.disabled = true;
    refreshBtn.classList.add('busy');
    refreshBtn.setAttribute('aria-busy', 'true');
    refreshLbl.textContent = t('common.refreshing');
    try {
      await ctx.refresh();
    } catch (e) {
      console.warn('refresh failed', e);
    } finally {
      busy = false;
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('busy');
      refreshBtn.removeAttribute('aria-busy');
      refreshLbl.textContent = t('common.refresh');
    }
  }

  // store sync
  const unsub = store.subscribe((s, prev) => {
    if (s.settings !== prev.settings) {
      if (s.settings.theme !== prev.settings.theme) applyTheme(s.settings.theme);
      if (s.settings.lang !== getLang()) setLang(s.settings.lang); // triggers renderLabels via onLangChange
      renderToggles(s);
    }
    if (s.route !== prev.route) renderTabs(s);
    if (s.catalogError !== prev.catalogError) renderBanner(s);
    if (s.status !== prev.status || s.snapshot !== prev.snapshot) maybeOpenManual(s, prev);
  });
  cleanups.push(unsub);
  const unLang = onLangChange(renderLabels);
  cleanups.push(unLang);

  renderLabels();
  renderToggles(s0);
  renderTabs(s0);
  maybeOpenManual(s0, null);

  return {
    viewRoot,
    destroy() {
      for (const fn of cleanups.reverse()) fn();
      wrap.remove();
    },
  };
}
