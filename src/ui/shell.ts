// App shell (trading-terminal layout): sidebar nav / mobile bottom nav, top bar (palette search, status,
// mayor, AH scan, language, refresh, settings), settings drawer, global hotkeys, and the view container.
import type { AppState, Density, HistoryRepo, Lang, Route, RouteId, Store, Theme, ToastKind } from '../types/contracts.ts';
import { HOTKEYS, LS_VIEWPREFS, UI } from '../config.ts';
import { getLang, onLangChange, setLang, t } from '../i18n/index.ts';
import { lsGet, lsSet } from '../storage/local.ts';
import { esc } from './dom.ts';
import { createDrawer, currentPalette, openPalette, registerHotkeys, toast as kitToast, type Drawer, type HotkeyMap } from './kit/index.ts';
import { routeToHash } from './router.ts';
import { createDataPanel } from './shell/dataPanel.ts';
import { icon } from './shell/icons.ts';
import { createManualLoad } from './shell/manualLoad.ts';
import { createAhStatus, createMayorChip } from './shell/marketChips.ts';
import { PRIMARY_NAV, labelNav, markActive, navHotkey, navHtml, navLinkHtml, setWatchBadge, type NavId } from './shell/nav.ts';
import { actionsProvider, itemsProvider, pagesProvider, type PaletteAction } from './shell/palette.ts';
import { createSettingsForm } from './shell/settings.ts';
import { shortcutsHtml } from './shell/shortcuts.ts';
import { createStatusPill } from './shell/statusPill.ts';
import { NAV } from './views/index.ts';
import './shell/shell.css';

export { displayStatus } from './shell/statusPill.ts';
export { parseCoins, parseNum } from './shell/settings.ts';

export interface ShellContext {
  store: Store<AppState>;
  refresh(): Promise<void>;
  navigate(r: Route): void;
  /** manual paste/file load; return error message or null on success */
  manualLoad(text: string): string | null;
  /** price history (Data section: size + clear); the section degrades without it */
  history?: HistoryRepo;
  /** start an auction-house scan now (palette command; hidden without it) */
  scanAh?: () => void;
  /** toast function (defaults to the kit toast) */
  toast?: (msg: string, kind?: ToastKind) => void;
}

export interface ShellHandle {
  viewRoot: HTMLElement;
  destroy(): void;
  /** open the command palette (optional prefill) */
  openPalette?(query?: string): void;
  openSettings?(): void;
}

/** localStorage key for shell prefs ({collapsed}). */
export const LS_SHELL = LS_VIEWPREFS + 'shell';
/** Window event other views dispatch to open the settings drawer (planner's "change in settings"). */
export const OPEN_SETTINGS_EVENT = 'bm:open-settings';
/** Media query for the mobile layout (bottom nav). */
export const MOBILE_QUERY = `(max-width: ${UI.mobileBp - 0.02}px)`;

const LANGS: Lang[] = ['tr', 'en'];

/** Apply a theme setting to <html data-theme> (attribute removed for auto). */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** Apply the density setting to <html data-density>. */
export function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.density = density;
}

function mql(query: string): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
}

/** Effective theme for 'auto' (system preference). */
function effectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'auto') return theme;
  return mql('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}

const nextFrame = (fn: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
};

/**
 * Mount the shell into root. Applies settings.theme/density/lang, renders the nav (aria-current per store.route),
 * top bar and footer, and returns the element views mount into.
 */
export function mountShell(root: HTMLElement, ctx: ShellContext): ShellHandle {
  const { store } = ctx;
  const cleanups: (() => void)[] = [];
  const toast = ctx.toast ?? ((msg: string, kind?: ToastKind) => void kitToast(msg, kind));

  // apply settings before first render so labels come out in the right language
  const s0 = store.get();
  applyTheme(s0.settings.theme);
  applyDensity(s0.settings.density);
  setLang(s0.settings.lang);

  let collapsed = !!lsGet<{ collapsed?: boolean } | null>(LS_SHELL, null)?.collapsed;

  root.innerHTML = '';
  const skip = document.createElement('a');
  skip.className = 'skip-link';
  skip.href = '#view';
  const app = document.createElement('div');
  app.className = 'app';
  app.innerHTML =
    `<div class="sidebar" data-testid="sidebar">` +
    `<div class="sb-head"><a class="brand" href="${esc(routeToHash({ id: 'overview' }))}" data-testid="brand">` +
    `<span class="brand-mark" aria-hidden="true">B</span><span class="brand-text"><span class="brand-name"></span><span class="brand-sub"></span></span></a></div>` +
    `<nav class="sb-nav">${navHtml()}</nav>` +
    `<div class="sb-foot"><button type="button" class="sb-link sb-collapse" data-testid="sidebar-toggle">${icon('collapse')}<span class="sb-label"></span></button></div>` +
    `</div>` +
    `<div class="main-col">` +
    `<header class="topbar">` +
    `<a class="tb-brand" href="${esc(routeToHash({ id: 'overview' }))}"><span class="brand-mark" aria-hidden="true">B</span><span class="kit-sr tb-brand-lbl"></span></a>` +
    `<button type="button" class="tb-search" data-testid="palette-btn" aria-haspopup="dialog" aria-keyshortcuts="/ Control+K">` +
    `${icon('search')}<span class="tb-search-lbl"></span><span class="tb-search-kbd" aria-hidden="true"><kbd>/</kbd></span></button>` +
    `<div class="tb-status"></div>` +
    `<div class="tb-market"></div>` +
    `<div class="tb-spacer"></div>` +
    `<div class="seg seg-lang" role="group">${LANGS.map((l) => `<button type="button" data-lang="${l}" data-testid="lang-${l}">${l.toUpperCase()}</button>`).join('')}</div>` +
    `<button type="button" class="tb-btn refresh-btn" data-testid="refresh-btn" aria-keyshortcuts="R">${icon('refresh', 'ico refresh-ico')}<span class="refresh-lbl"></span></button>` +
    `<button type="button" class="tb-btn tb-icon settings-btn" data-testid="settings-btn" aria-haspopup="dialog">${icon('settings')}<span class="kit-sr settings-lbl"></span></button>` +
    `</header>` +
    `<div class="banner banner-err catalog-banner" role="alert" hidden></div>` +
    `<div class="manual-inline"></div>` +
    `<main class="view-root" id="view" tabindex="-1"></main>` +
    `<footer class="app-footer note"><p class="f1"></p><p class="f2"></p></footer>` +
    `</div>`;
  root.append(skip, app);

  const $ = <E extends Element = HTMLElement>(sel: string) => app.querySelector<E>(sel)!;
  const nav = $('nav.sb-nav');
  const brandName = $('.brand-name');
  const brandSub = $('.brand-sub');
  const collapseBtn = $<HTMLButtonElement>('.sb-collapse');
  const moreBtn = $<HTMLButtonElement>('.sb-more');
  const searchBtn = $<HTMLButtonElement>('.tb-search');
  const refreshBtn = $<HTMLButtonElement>('.refresh-btn');
  const refreshLbl = $('.refresh-lbl');
  const settingsBtn = $<HTMLButtonElement>('.settings-btn');
  const langSeg = $('.seg-lang');
  const banner = $('.catalog-banner');
  const manualInline = $('.manual-inline');
  const viewRoot = $('.view-root');
  const f1 = $('.f1');
  const f2 = $('.f2');

  // ---- top bar widgets
  const pill = createStatusPill(store);
  $('.tb-status').append(pill.el);
  const mayor = createMayorChip(store);
  const ahStat = createAhStatus(store);
  $('.tb-market').append(mayor.el, ahStat.el);
  cleanups.push(pill.destroy, mayor.destroy, ahStat.destroy);

  // ---- settings drawer (form + data section; the manual-load panel lives in Data unless needed inline)
  const form = createSettingsForm(store);
  const settingsDrawer = createDrawer({ title: () => t('common.settings'), side: 'right', onClose: () => form.flush() });
  settingsDrawer.el.classList.add('settings-drawer');
  settingsDrawer.el.dataset.testid = 'settings-drawer';
  const data = createDataPanel({ store, history: ctx.history, toast });
  settingsDrawer.body.append(form.el, data.el);
  const manual = createManualLoad((text) => ctx.manualLoad(text));
  data.manualSlot.append(manual.el);
  cleanups.push(() => settingsDrawer.destroy(), form.destroy, data.destroy, manual.destroy);

  // ---- shortcuts help + mobile "More" sheet
  const helpDrawer = createDrawer({ title: () => t('common.shortcuts'), side: 'right' });
  helpDrawer.el.classList.add('help-drawer');
  helpDrawer.el.dataset.testid = 'shortcuts-dialog';
  const moreSheet = createDrawer({
    title: () => t('shell.moreTitle'),
    side: 'bottom',
    onClose: () => moreBtn.setAttribute('aria-expanded', 'false'),
  });
  moreSheet.el.classList.add('more-sheet');
  moreSheet.el.dataset.testid = 'more-sheet';
  moreSheet.body.innerHTML =
    `<nav class="more-nav"><ul class="more-list">${NAV.filter((n) => !PRIMARY_NAV.includes(n.id))
      .map((n) => navLinkHtml(n, 'more'))
      .join('')}</ul></nav>` +
    `<div class="more-actions"><button type="button" class="btn more-settings" data-testid="more-settings">${icon('settings')}<span></span></button>` +
    `<button type="button" class="btn more-help">${icon('keyboard')}<span></span></button></div>`;
  cleanups.push(() => helpDrawer.destroy(), () => moreSheet.destroy());
  const drawers: Drawer[] = [moreSheet, helpDrawer, settingsDrawer];

  // ---- layout (desktop sidebar vs mobile bottom nav) + collapse
  const mobileMql = mql(MOBILE_QUERY);
  let mobile = !!mobileMql?.matches;
  function applyLayout(): void {
    app.dataset.layout = mobile ? 'mobile' : 'desktop';
    app.dataset.sidebar = collapsed && !mobile ? 'collapsed' : 'open';
    moreBtn.hidden = !mobile;
    for (const li of nav.querySelectorAll<HTMLElement>('.sb-item:not([data-primary])')) li.hidden = mobile;
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    const lbl = collapsed ? t('shell.expand') : t('shell.collapse');
    collapseBtn.querySelector('.sb-label')!.textContent = lbl;
    collapseBtn.title = lbl;
    nav.setAttribute('aria-label', mobile ? t('shell.primaryNav') : t('common.navAria'));
    labelNav(nav, collapsed && !mobile);
    if (!mobile && moreSheet.isOpen()) moreSheet.close();
  }
  const onMedia = (ev: MediaQueryListEvent) => {
    mobile = ev.matches;
    applyLayout();
  };
  if (mobileMql) {
    if (typeof mobileMql.addEventListener === 'function') mobileMql.addEventListener('change', onMedia);
    else mobileMql.addListener?.(onMedia);
    cleanups.push(() => {
      if (typeof mobileMql.removeEventListener === 'function') mobileMql.removeEventListener('change', onMedia);
      else mobileMql.removeListener?.(onMedia);
    });
  }
  function toggleSidebar(): void {
    collapsed = !collapsed;
    lsSet(LS_SHELL, { collapsed });
    applyLayout();
  }

  // ---- render
  let busy = false;

  function renderLabels(): void {
    const title = t('common.appTitle');
    const sp = title.indexOf(' ');
    brandName.innerHTML = sp > 0 ? `${esc(title.slice(0, sp))} <b>${esc(title.slice(sp + 1))}</b>` : esc(title);
    brandSub.textContent = t('shell.brandSub');
    $('.tb-brand-lbl').textContent = title;
    skip.textContent = t('common.skipToContent');
    searchBtn.querySelector('.tb-search-lbl')!.textContent = t('shell.search');
    searchBtn.setAttribute('aria-label', t('common.commandPalette'));
    searchBtn.title = `${t('common.commandPalette')} (/, Ctrl+K)`;
    refreshLbl.textContent = busy ? t('common.refreshing') : t('common.refresh');
    refreshBtn.title = `${t('common.refreshTitle')} (R)`;
    settingsBtn.querySelector('.settings-lbl')!.textContent = t('common.settings');
    settingsBtn.title = t('common.settings');
    langSeg.setAttribute('aria-label', t('common.language'));
    moreBtn.setAttribute('aria-label', t('common.more'));
    moreSheet.body.querySelector('.more-nav')!.setAttribute('aria-label', t('shell.moreTitle'));
    labelNav(moreSheet.body, false);
    moreSheet.body.querySelector('.more-settings span')!.textContent = t('common.settings');
    moreSheet.body.querySelector('.more-help span')!.textContent = t('common.shortcuts');
    f1.textContent = t('common.footer1');
    f2.textContent = t('common.footer2');
    applyLayout();
    renderBanner(store.get());
    setWatchBadge(app, store.get().watchlist.length);
    if (settingsDrawer.isOpen()) settingsDrawer.setTitle(t('common.settings'));
    if (moreSheet.isOpen()) moreSheet.setTitle(t('shell.moreTitle'));
    if (helpDrawer.isOpen()) {
      helpDrawer.setTitle(t('common.shortcuts'));
      helpDrawer.body.innerHTML = shortcutsHtml();
    }
  }

  function renderToggles(s: AppState): void {
    for (const b of langSeg.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.lang === s.settings.lang));
  }

  const activeId = (s: AppState): RouteId | null => (s.route.id === 'item' ? null : s.route.id);
  function renderActive(s: AppState): void {
    markActive(nav, activeId(s));
    markActive(moreSheet.body, activeId(s));
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

  const manualNeeded = (s: AppState) => s.status === 'error' && !s.snapshot;
  function maybeOpenManual(s: AppState, prev: AppState | null): void {
    if (manualNeeded(s) && !(prev && manualNeeded(prev))) {
      manualInline.append(manual.el);
      manual.open();
    }
  }

  // ---- actions
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

  const patchSettings = (p: Partial<AppState['settings']>) => store.set((s) => ({ settings: { ...s.settings, ...p } }));

  function openSettings(): void {
    moreSheet.close();
    if (!manualNeeded(store.get()) && manual.el.parentElement !== data.manualSlot) data.manualSlot.append(manual.el);
    data.refresh();
    settingsDrawer.open();
  }
  function openHelp(): void {
    moreSheet.close();
    helpDrawer.body.innerHTML = shortcutsHtml();
    helpDrawer.open();
  }
  function openMore(): void {
    moreSheet.open();
    moreBtn.setAttribute('aria-expanded', 'true');
  }

  function actions(): PaletteAction[] {
    const s = store.get();
    const list: PaletteAction[] = [
      { id: 'refresh', label: () => t('shell.act_refresh'), hint: 'R', run: () => void doRefresh() },
      {
        id: 'theme',
        label: () => t('shell.act_theme'),
        run: () => patchSettings({ theme: effectiveTheme(store.get().settings.theme) === 'dark' ? 'light' : 'dark' }),
      },
      { id: 'lang', label: () => t('shell.act_lang'), run: () => patchSettings({ lang: store.get().settings.lang === 'tr' ? 'en' : 'tr' }) },
      {
        id: 'density',
        label: () => t('shell.act_density'),
        run: () => patchSettings({ density: store.get().settings.density === 'compact' ? 'comfortable' : 'compact' }),
      },
      { id: 'settings', label: () => t('shell.act_settings'), run: openSettings },
      { id: 'shortcuts', label: () => t('shell.act_shortcuts'), hint: '?', run: openHelp },
    ];
    if (!mobile) list.push({ id: 'sidebar', label: () => t('shell.act_sidebar'), run: toggleSidebar });
    if (ctx.scanAh && s.settings.ahEnabled && !s.ahProgress) list.push({ id: 'ah', label: () => t('shell.act_ah'), run: () => ctx.scanAh?.() });
    return list;
  }

  const providers = [pagesProvider(ctx.navigate), actionsProvider(actions), itemsProvider(store, ctx.navigate)];
  function showPalette(query?: string): void {
    for (const d of drawers) d.close();
    mayor.close();
    openPalette({ providers, query, placeholder: t('common.paletteHint') });
  }

  // ---- events
  const onClick = (ev: MouseEvent) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const link = target.closest<HTMLElement>('[data-nav], .brand, .tb-brand');
    if (link) {
      if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      const id = (link.dataset.nav as NavId | undefined) ?? 'overview';
      moreSheet.close();
      ctx.navigate({ id });
      return;
    }
    const langBtn = target.closest<HTMLElement>('[data-lang]');
    if (langBtn && langSeg.contains(langBtn)) {
      const lang = langBtn.dataset.lang as Lang;
      store.set((s) => (s.settings.lang === lang ? {} : { settings: { ...s.settings, lang } }));
      return;
    }
    if (target.closest('.refresh-btn')) void doRefresh();
    else if (target.closest('.settings-btn, .more-settings')) openSettings();
    else if (target.closest('.more-help')) openHelp();
    else if (target.closest('.tb-search')) showPalette();
    else if (target.closest('.sb-collapse')) toggleSidebar();
    else if (target.closest('.sb-more')) openMore();
  };
  app.addEventListener('click', onClick);
  moreSheet.body.addEventListener('click', onClick);
  cleanups.push(() => {
    app.removeEventListener('click', onClick);
    moreSheet.body.removeEventListener('click', onClick);
  });

  // views ask for the settings drawer via a window event (no direct shell reference)
  const onOpenSettingsEvent = () => openSettings();
  window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsEvent);
  cleanups.push(() => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsEvent));

  // skip link: focus <main> without touching the hash (the router owns it)
  const onSkip = (ev: MouseEvent) => {
    ev.preventDefault();
    focusView(true);
  };
  skip.addEventListener('click', onSkip);
  cleanups.push(() => skip.removeEventListener('click', onSkip));

  // ---- global hotkeys (views bind their own s/e)
  const overlayOpen = () =>
    !!currentPalette() || drawers.some((d) => d.isOpen()) || !!document.querySelector('dialog[open], .kit-panel[data-mode="overlay"]:not([hidden])');
  const guard = (fn: () => void) => () => {
    if (!overlayOpen()) fn();
  };
  const hk: HotkeyMap = {};
  for (const k of HOTKEYS.palette) hk[k] = guard(() => showPalette());
  for (const k of HOTKEYS.refresh) hk[k] = guard(() => void doRefresh());
  for (const k of HOTKEYS.help) hk[k] = guard(openHelp);
  for (const n of NAV) hk[navHotkey(n.id)] = guard(() => ctx.navigate({ id: n.id }));
  cleanups.push(registerHotkeys(hk));

  // Escape: close shell overlays the kit does not handle itself (mayor popover; drawers without focus).
  // A separate listener, so Escape is only consumed when something actually closed (detail panels need it too).
  const onEsc = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return;
    let closed = mayor.close();
    for (const d of drawers) {
      if (d.isOpen()) {
        d.close();
        closed = true;
      }
    }
    if (closed) ev.preventDefault();
  };
  document.addEventListener('keydown', onEsc);
  cleanups.push(() => document.removeEventListener('keydown', onEsc));

  // ---- focus the view heading after navigation (never on the initial load)
  let ready = false;
  const readyTimer = setTimeout(() => (ready = true), 0);
  let alive = true;
  cleanups.push(() => {
    clearTimeout(readyTimer);
    alive = false;
  });
  function focusView(force = false, attempt = 0, before: Element | null = document.activeElement): void {
    nextFrame(() => {
      if (!alive) return;
      const active = document.activeElement;
      const visible = (el: Element) => !el.closest('[hidden]');
      // the view focused something itself since the navigation (not the previous page's still-focused h1)
      if (!force && active && active !== before && active !== viewRoot && viewRoot.contains(active) && visible(active)) return;
      if (!force && (currentPalette() || drawers.some((d) => d.isOpen()))) return;
      const h1 = [...viewRoot.querySelectorAll<HTMLElement>('h1')].find(visible) ?? null;
      if (!h1 && attempt === 0 && !force) {
        focusView(false, 1, before); // views that render on the next frame
        return;
      }
      const target = h1 ?? viewRoot;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
  }

  // ---- store sync
  const unsub = store.subscribe((s, prev) => {
    if (s.settings !== prev.settings) {
      if (s.settings.theme !== prev.settings.theme) applyTheme(s.settings.theme);
      if (s.settings.density !== prev.settings.density) applyDensity(s.settings.density);
      if (s.settings.lang !== getLang()) setLang(s.settings.lang); // triggers renderLabels via onLangChange
      renderToggles(s);
    }
    if (s.route !== prev.route) {
      renderActive(s);
      const moved = s.route.id !== prev.route.id || s.route.param !== prev.route.param;
      if (moved && ready) focusView();
    }
    if (s.watchlist !== prev.watchlist) setWatchBadge(app, s.watchlist.length);
    if (s.catalogError !== prev.catalogError) renderBanner(s);
    if (s.status !== prev.status || s.snapshot !== prev.snapshot) maybeOpenManual(s, prev);
  });
  cleanups.push(unsub);
  cleanups.push(onLangChange(renderLabels));

  renderLabels();
  renderToggles(s0);
  renderActive(s0);
  maybeOpenManual(s0, null);

  return {
    viewRoot,
    openPalette: showPalette,
    openSettings,
    destroy() {
      for (const fn of cleanups.reverse()) fn();
      skip.remove();
      app.remove();
    },
  };
}
