// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LS_VIEWPREFS } from '../../src/config.ts';
import { getLang } from '../../src/i18n/index.ts';
import { currentPalette } from '../../src/ui/kit/index.ts';
import { LS_SHELL } from '../../src/ui/shell.ts';
import { PRIMARY_NAV } from '../../src/ui/shell/nav.ts';
import { harness, key, mockMatchMedia, snap, teardown, tick, type Harness } from './shell/helpers.ts';

let h: Harness | null = null;
afterEach(() => {
  teardown(h);
  h = null;
});

const TR_NAV = ['Genel bakış', 'Flipler', 'Kitaplar', 'Müzayede flip', 'Craft', 'Forge', 'Fusion', 'NPC & Dükkanlar', 'Planlayıcı', 'Sat mı, craftla mı?', 'İzleme'];
const navTexts = (hh: Harness) => hh.qa('.sidebar [data-nav] .sb-label').map((e) => e.textContent);

describe('shell layout + nav', () => {
  it('renders grouped sidebar nav in Turkish with aria-current on the active route', () => {
    h = harness();
    const shell = h.mount();
    expect(navTexts(h)).toEqual(TR_NAV);
    expect(h.qa('.sb-gh').map((e) => e.textContent)).toEqual(['Piyasalar', 'Üretim', 'Ticaret', 'Araçlar']);
    expect(h.q('nav.sb-nav').getAttribute('aria-label')).toBe('Ana menü');
    expect(h.q('[data-testid="tab-overview"]').getAttribute('aria-current')).toBe('page');
    expect(h.qa('[aria-current="page"]')).toHaveLength(1);
    // keyboard hint per item
    expect(h.q('[data-testid="tab-flip"] .sb-kbd').textContent).toBe('gf');
    expect(h.q('[data-testid="tab-flip"]').getAttribute('aria-keyshortcuts')).toBe('g f');
    // view root, skip link, footer
    expect(shell.viewRoot.id).toBe('view');
    expect(shell.viewRoot.tagName).toBe('MAIN');
    expect(h.q('.skip-link').textContent).toBe('İçeriğe geç');
    expect(h.q('footer').textContent).toContain('macro');
    expect(h.q('[data-testid="status-pill"]').dataset.status).toBe('loading');
  });

  it('active route follows the store; item routes highlight nothing; clicks navigate', () => {
    h = harness();
    h.mount();
    h.store.set({ route: { id: 'npc' } });
    expect(h.q('[data-testid="tab-npc"]').getAttribute('aria-current')).toBe('page');
    expect(h.q('[data-testid="tab-overview"]').hasAttribute('aria-current')).toBe(false);
    h.store.set({ route: { id: 'item', param: 'X' } });
    expect(h.qa('.sidebar [aria-current]')).toHaveLength(0);
    h.q('[data-testid="tab-craft"]').click();
    expect(h.ctx.navigate).toHaveBeenCalledWith({ id: 'craft' });
    h.q('[data-testid="brand"]').click();
    expect(h.ctx.navigate).toHaveBeenLastCalledWith({ id: 'overview' });
    // modifier clicks are left to the browser (new tab)
    h.ctx.navigate.mockClear();
    h.q('[data-testid="tab-flip"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(h.ctx.navigate).not.toHaveBeenCalled();
  });

  it('watchlist badge counts watched items', () => {
    h = harness();
    h.mount();
    const badge = h.q('[data-testid="tab-watch"] .sb-badge');
    expect(badge.hidden).toBe(true);
    h.store.set({ watchlist: [{ id: 'A', addedAt: 0 }, { id: 'B', addedAt: 0 }] });
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2');
    expect(h.q('[data-testid="tab-watch"] .sb-badge-sr').textContent).toContain('2 izlenen ürün');
  });

  it('collapses the sidebar and remembers it', () => {
    h = harness();
    h.mount();
    const app = h.q('.app');
    const btn = h.q<HTMLButtonElement>('[data-testid="sidebar-toggle"]');
    expect(app.dataset.sidebar).toBe('open');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    btn.click();
    expect(app.dataset.sidebar).toBe('collapsed');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem(LS_SHELL)!)).toEqual({ collapsed: true });
    expect(LS_SHELL.startsWith(LS_VIEWPREFS)).toBe(true);
    // collapsed links get a tooltip with their label
    expect(h.q('[data-testid="tab-flip"]').title).toBe('Flipler');
    h.shell!.destroy();
    h.shell = null;
    h.mount();
    expect(h.q('.app').dataset.sidebar).toBe('collapsed');
  });

  it('switches TR/EN from the top bar and re-renders labels', () => {
    h = harness();
    h.mount();
    h.q('[data-testid="lang-en"]').click();
    expect(h.store.get().settings.lang).toBe('en');
    expect(getLang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(navTexts(h)).toEqual(['Overview', 'Flips', 'Books', 'AH flips', 'Craft', 'Forge', 'Fusion', 'NPC & Shops', 'Planner', 'Sell or craft?', 'Watchlist']);
    expect(h.qa('.sb-gh').map((e) => e.textContent)).toEqual(['Markets', 'Production', 'Trade', 'Tools']);
    expect(h.q('[data-testid="lang-en"]').getAttribute('aria-pressed')).toBe('true');
    expect(h.q('.refresh-lbl').textContent).toBe('Refresh');
    expect(h.q('.skip-link').textContent).toBe('Skip to content');
    expect(h.q('[data-testid="status-pill"]').textContent).toBe('Loading');
    expect(h.q('.brand-name').textContent).toBe('Bazaar Desk');
    h.q('[data-testid="lang-tr"]').click();
    expect(navTexts(h)[0]).toBe('Genel bakış');
  });

  it('applies initial lang, theme and density from settings', () => {
    h = harness();
    h.store.set((s) => ({ settings: { ...s.settings, lang: 'en', theme: 'dark', density: 'compact' } }));
    h.mount();
    expect(getLang()).toBe('en');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('compact');
    h.store.set((s) => ({ settings: { ...s.settings, theme: 'auto', density: 'comfortable' } }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.dataset.density).toBe('comfortable');
  });

  it('refresh button calls ctx.refresh with busy state', async () => {
    h = harness();
    let resolve!: () => void;
    h.ctx.refresh.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
    h.mount();
    const btn = h.q<HTMLButtonElement>('[data-testid="refresh-btn"]');
    btn.click();
    expect(h.ctx.refresh).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.textContent).toContain('Yenileniyor');
    btn.click();
    expect(h.ctx.refresh).toHaveBeenCalledTimes(1);
    resolve();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(btn.textContent).toContain('Yenile');
  });

  it('shows the catalog error banner', () => {
    h = harness();
    h.mount();
    const banner = h.q('.catalog-banner');
    expect(banner.hidden).toBe(true);
    h.store.set({ catalogError: 'HTTP 404' });
    expect(banner.hidden).toBe(false);
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('HTTP 404');
  });

  it('auto-opens the manual-load panel inline on error without a snapshot; paste goes to ctx.manualLoad', () => {
    h = harness();
    h.ctx.manualLoad.mockReturnValue('bad json');
    h.mount();
    // lives in the settings drawer until needed
    expect(h.root.querySelector('[data-testid="manual-load"]')).toBeNull();
    h.store.set({ status: 'error', lastError: 'Failed to fetch' });
    const panel = h.root.querySelector<HTMLDetailsElement>('.manual-inline [data-testid="manual-load"]')!;
    expect(panel).not.toBeNull();
    expect(panel.open).toBe(true);
    expect(h.q('[data-testid="status-pill"]').dataset.status).toBe('error');
    expect(h.q('.status-err').textContent).toBe('Failed to fetch');

    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', { value: { getData: () => '{"x":1}' } });
    panel.querySelector('.paste')!.dispatchEvent(ev);
    expect(h.ctx.manualLoad).toHaveBeenCalledWith('{"x":1}');
    expect(panel.querySelector('.msg')!.textContent).toBe('bad json');
    h.ctx.manualLoad.mockReturnValue(null);
    panel.querySelector('.paste')!.dispatchEvent(ev);
    expect(panel.querySelector('.msg')!.textContent).toBe('Veri yüklendi.');
  });

  it('moves focus to the view h1 after navigation, but not on the initial load', async () => {
    h = harness();
    const shell = h.mount();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    // initial route (router's first show) in the same task: no focus move
    h.store.set({ route: { id: 'flip' } });
    shell.viewRoot.innerHTML = '<h1>Flipler</h1>';
    await tick(60);
    expect(document.activeElement).toBe(outside);
    // a later navigation focuses the new view's h1
    h.store.set({ route: { id: 'craft' } });
    shell.viewRoot.innerHTML = '<h1>Craft</h1><input>';
    await tick(80);
    const h1 = shell.viewRoot.querySelector('h1')!;
    expect(document.activeElement).toBe(h1);
    expect(h1.getAttribute('tabindex')).toBe('-1');
    // query-only changes don't move focus
    outside.focus();
    h.store.set({ route: { id: 'craft', query: { q: 'x' } } });
    await tick(80);
    expect(document.activeElement).toBe(outside);
  });

  it('skip link focuses main without changing the hash', async () => {
    h = harness();
    const shell = h.mount();
    const before = location.hash;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.q('.skip-link').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await tick(60);
    expect(document.activeElement).toBe(shell.viewRoot);
    expect(location.hash).toBe(before);
  });

  it('destroy releases everything', () => {
    h = harness();
    h.mount();
    h.q('[data-testid="settings-btn"]').click();
    expect(document.querySelector('.settings-drawer')).not.toBeNull();
    h.shell!.destroy();
    h.shell = null;
    expect(h.root.children).toHaveLength(0);
    expect(document.querySelector('.kit-drawer')).toBeNull();
    h.store.set({ catalogError: 'x', election: null, ahProgress: { page: 1, totalPages: 2 } });
    key('r');
    key('g');
    key('f');
    expect(h.ctx.refresh).not.toHaveBeenCalled();
    expect(h.ctx.navigate).not.toHaveBeenCalled();
  });
});

describe('global hotkeys', () => {
  it('g-sequences navigate, r refreshes, ? opens the shortcuts dialog', () => {
    h = harness();
    h.mount();
    key('g');
    key('f');
    expect(h.ctx.navigate).toHaveBeenCalledWith({ id: 'flip' });
    key('g');
    key('w');
    expect(h.ctx.navigate).toHaveBeenLastCalledWith({ id: 'watch' });
    key('r');
    expect(h.ctx.refresh).toHaveBeenCalledTimes(1);
    key('?', { shiftKey: true });
    const dlg = h.q('[data-testid="shortcuts-dialog"]');
    expect(dlg.hasAttribute('open')).toBe(true);
    const text = dlg.textContent!;
    expect(text).toContain('Klavye kısayolları');
    for (const label of TR_NAV) expect(text).toContain(`${label} sayfasına git`);
    expect(text).toContain('Komut paletini aç');
    expect(text).toContain('CSV');
    // global hotkeys are inert while an overlay is open
    key('r');
    expect(h.ctx.refresh).toHaveBeenCalledTimes(1);
    // Escape closes
    key('Escape', {}, dlg);
    expect(dlg.hasAttribute('open')).toBe(false);
  });

  it('leaves s/e to the views (not consumed globally)', () => {
    h = harness();
    h.mount();
    expect(key('s').defaultPrevented).toBe(false);
    expect(key('e').defaultPrevented).toBe(false);
  });

  it('ignores hotkeys while typing', () => {
    h = harness();
    h.mount();
    const inp = document.createElement('input');
    document.body.append(inp);
    inp.focus();
    key('r', {}, inp);
    key('g', {}, inp);
    key('o', {}, inp);
    expect(h.ctx.refresh).not.toHaveBeenCalled();
    expect(h.ctx.navigate).not.toHaveBeenCalled();
  });
});

describe('command palette', () => {
  const products = { ENCHANTED_GOLD: {}, ENCHANTED_DIAMOND: {}, BOOSTER_COOKIE: {} } as never;
  const type = (hh: Harness, text: string) => {
    const input = hh.q<HTMLInputElement>('.kit-palette-input');
    input.value = text;
    input.dispatchEvent(new Event('input'));
    return input;
  };
  const groups = (hh: Harness) => hh.qa('.kp-glabel').map((g) => g.textContent);

  it('opens with "/" and Ctrl+K, finds an item and navigates to it', () => {
    h = harness({ snapshot: snap(Date.now(), products) });
    h.mount();
    key('/');
    expect(currentPalette()).not.toBeNull();
    expect(h.q<HTMLInputElement>('.kit-palette-input').placeholder).toBe('Ürün, sayfa veya komut ara…');
    // empty query: pages + commands
    expect(groups(h)).toEqual(['Sayfalar', 'Komutlar']);
    const input = type(h, 'enchanted gold');
    expect(groups(h)).toEqual(['Ürünler']);
    expect(h.q('.kp-opt .kp-hint').textContent).toBe('ENCHANTED_GOLD');
    key('Enter', {}, input);
    expect(currentPalette()).toBeNull();
    expect(h.ctx.navigate).toHaveBeenCalledWith({ id: 'item', param: 'ENCHANTED_GOLD' });

    key('k', { ctrlKey: true });
    expect(currentPalette()).not.toBeNull();
    currentPalette()!.close();
    h.q('[data-testid="palette-btn"]').click();
    expect(currentPalette()).not.toBeNull();
  });

  it('pages and commands run', () => {
    h = harness();
    h.mount();
    key('/');
    key('Enter', {}, type(h, 'kitap'));
    expect(h.ctx.navigate).toHaveBeenCalledWith({ id: 'books' });

    key('/');
    key('Enter', {}, type(h, 'yoğunluğu'));
    expect(h.store.get().settings.density).toBe('compact');
    expect(document.documentElement.dataset.density).toBe('compact');

    key('/');
    key('Enter', {}, type(h, 'english'));
    expect(h.store.get().settings.lang).toBe('en');

    key('/');
    key('Enter', {}, type(h, 'refresh'));
    expect(h.ctx.refresh).toHaveBeenCalledTimes(1);
  });

  it('offers the AH scan command only when the shell can trigger it', () => {
    h = harness();
    h.mount();
    key('/');
    type(h, 'şimdi tara');
    expect(h.qa('.kp-opt')).toHaveLength(0);
    currentPalette()!.close();
    h.shell!.destroy();

    h.ctx.scanAh = vi.fn();
    h.mount();
    key('/');
    key('Enter', {}, type(h, 'şimdi tara'));
    expect(h.ctx.scanAh).toHaveBeenCalledTimes(1);
  });
});

describe('mayor chip + AH status', () => {
  const election = {
    year: 412,
    mayor: { key: 'dungeons', name: 'Paul', perks: [{ name: 'Marauder', description: 'Dungeon reward chests are 20% cheaper.' }] },
    minister: { key: 'mining', name: 'Cole', perk: { name: 'Mining Fiesta', description: 'More mining.', minister: true } },
    fetchedAt: 0,
  };

  it('shows mayor, minister and perks', () => {
    h = harness();
    h.mount();
    const wrap = h.q('.mayor');
    expect(wrap.hidden).toBe(true);
    h.store.set({ election });
    expect(wrap.hidden).toBe(false);
    const chip = h.q<HTMLButtonElement>('[data-testid="mayor-chip"]');
    expect(chip.textContent).toBe('Paul · Cole');
    expect(chip.getAttribute('aria-label')).toBe('Belediye başkanı: Paul, Bakan: Cole');
    expect(chip.title).toContain('Marauder');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    chip.click();
    const pop = h.q('.mayor-pop');
    expect(pop.hidden).toBe(false);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(pop.textContent).toContain('Dungeon reward chests are 20% cheaper.');
    expect(pop.textContent).toContain('Mining Fiesta');
    expect(pop.textContent).toContain('SkyBlock yılı 412');
    key('Escape');
    expect(pop.hidden).toBe(true);
    // outside click also closes
    chip.click();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(pop.hidden).toBe(true);
  });

  it('shows AH scan progress, then the snapshot age', () => {
    h = harness();
    h.mount();
    const el = h.q('[data-testid="ah-status"]');
    expect(el.hidden).toBe(true);
    h.store.set({ ahProgress: { page: 3, totalPages: 40 } });
    expect(el.hidden).toBe(false);
    expect(el.dataset.state).toBe('scanning');
    expect(el.textContent).toContain('Müzayede taranıyor 3/40');
    const bar = el.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('40');
    h.store.set({ ahProgress: null, ah: { fetchedAt: Date.now() - 120_000, lastUpdated: 0, lowestBin: {}, failedPages: [5] } });
    expect(el.dataset.state).toBe('idle');
    expect(el.textContent).toContain('AH 2 dk');
    expect(el.title).toContain('1 sayfa okunamadı');
  });
});

describe('mobile layout', () => {
  it('turns the sidebar into a bottom nav with 4 primary items and a More sheet', () => {
    mockMatchMedia(true);
    h = harness();
    h.mount();
    expect(h.q('.app').dataset.layout).toBe('mobile');
    const visible = h.qa('.sidebar .sb-item').filter((li) => !li.hidden);
    expect(visible.map((li) => li.querySelector<HTMLElement>('[data-nav]')!.dataset.nav)).toEqual([...PRIMARY_NAV]);
    const more = h.q<HTMLButtonElement>('[data-testid="nav-more"]');
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe('Daha fazla');
    more.click();
    const sheet = h.q('[data-testid="more-sheet"]');
    expect(sheet.hasAttribute('open')).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect([...sheet.querySelectorAll<HTMLElement>('[data-nav]')].map((a) => a.dataset.nav)).toEqual(['books', 'ahflip', 'forge', 'fusion', 'npc', 'plan', 'sell']);
    // an active secondary route marks the More button
    h.store.set({ route: { id: 'plan' } });
    expect(more.classList.contains('has-current')).toBe(true);
    expect(sheet.querySelector('[data-nav="plan"]')!.getAttribute('aria-current')).toBe('page');
    sheet.querySelector<HTMLElement>('[data-testid="more-npc"]')!.click();
    expect(h.ctx.navigate).toHaveBeenCalledWith({ id: 'npc' });
    expect(sheet.hasAttribute('open')).toBe(false);
    // settings reachable from the sheet
    more.click();
    h.q('[data-testid="more-settings"]').click();
    expect(h.q('[data-testid="settings-drawer"]').hasAttribute('open')).toBe(true);
  });

  it('desktop shows every item and hides More', () => {
    mockMatchMedia(false);
    h = harness();
    h.mount();
    expect(h.q('.app').dataset.layout).toBe('desktop');
    expect(h.qa('.sidebar .sb-item').every((li) => !li.hidden)).toBe(true);
    expect(h.q('[data-testid="nav-more"]').hidden).toBe(true);
  });
});

