// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../../src/state/appState.ts';
import { parseCoins, parseNum, SETTINGS_DEBOUNCE_MS } from '../../../src/ui/shell/settings.ts';
import { harness, teardown, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  teardown(h);
  h = null;
});

function openDrawer(hh: Harness): HTMLElement {
  hh.mount();
  hh.q('[data-testid="settings-btn"]').click();
  return hh.q('[data-testid="settings-drawer"]');
}
const ctl = <E extends HTMLElement = HTMLInputElement>(hh: Harness, name: string) => hh.q<E>(`.settings-drawer [name="${name}"]`);
function change(hh: Harness, name: string, value: string | boolean): HTMLInputElement {
  const el = ctl(hh, name);
  if (typeof value === 'boolean') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el;
}

describe('parsing', () => {
  it('parseNum / parseCoins accept TR and EN grouping and k/m/b', () => {
    expect(parseNum('2,5')).toBe(2.5);
    expect(parseNum('2.5')).toBe(2.5);
    expect(parseNum('5.000.000')).toBe(5_000_000);
    expect(parseNum('1.234,5')).toBe(1234.5);
    expect(parseNum('')).toBeNaN();
    expect(parseCoins('12m')).toBe(12_000_000);
    expect(parseCoins('2,5m')).toBe(2_500_000);
    expect(parseCoins('1.5b')).toBe(1_500_000_000);
    expect(parseCoins('750k')).toBe(750_000);
    expect(parseCoins('3.500.000')).toBe(3_500_000);
    expect(parseCoins('abc')).toBeNaN();
  });
});

describe('settings drawer', () => {
  it('opens from the top bar with Market / Display / Notifications / Data sections', () => {
    h = harness();
    const dlg = openDrawer(h);
    expect(dlg.hasAttribute('open')).toBe(true);
    expect(dlg.querySelector('.kit-drawer-title')!.textContent).toBe('Ayarlar');
    expect([...dlg.querySelectorAll('.set-sec > .set-h')].map((e) => e.textContent)).toEqual(['Piyasa', 'Görünüm', 'Bildirimler', 'Veri']);
    // fill model help explains the 2x capital caveat
    const help = dlg.querySelector('[data-field="fillModel"] .field-help')!.textContent!;
    expect(help).toContain('2 kat sermaye');
    expect(help).toContain('yavaş');
    expect(ctl(h, 'fillModel').getAttribute('aria-describedby')).toBe('set-fillModel-help');
    // manual load lives in the Data section
    expect(dlg.querySelector('[data-sec="data"] [data-testid="manual-load"]')).not.toBeNull();
  });

  it("opens on the window 'bm:open-settings' event until destroyed", () => {
    h = harness();
    h.mount();
    window.dispatchEvent(new CustomEvent('bm:open-settings'));
    const dlg = h.q('[data-testid="settings-drawer"]');
    expect(dlg.hasAttribute('open')).toBe(true);
    h.q<HTMLButtonElement>('.settings-drawer .kit-x').click();
    expect(dlg.hasAttribute('open')).toBe(false);
    h.shell!.destroy();
    h.shell = null;
    window.dispatchEvent(new CustomEvent('bm:open-settings'));
    expect(document.querySelector('[data-testid="settings-drawer"]')).toBeNull();
  });

  it('writes validated values to the store, including the round-2 fields', () => {
    h = harness();
    openDrawer(h);
    const s = () => h!.store.get().settings;
    change(h, 'share', '10');
    expect(s().share).toBeCloseTo(0.1);
    change(h, 'capital', '12m');
    expect(s().capital).toBe(12_000_000);
    expect(ctl(h, 'capital').value).toBe('12.000.000');
    change(h, 'taxRate', '0.01125');
    expect(s().taxRate).toBe(0.01125);
    change(h, 'sellMode', 'insta');
    expect(s().sellMode).toBe('insta');
    change(h, 'fillModel', 'pipelined');
    expect(s().fillModel).toBe('pipelined');
    change(h, 'orderSlots', '21');
    expect(s().orderSlots).toBe(21);
    change(h, 'npcDailyLimit', '1280');
    expect(s().npcDailyLimit).toBe(1280);
    change(h, 'ahEnabled', false);
    expect(s().ahEnabled).toBe(false);
    change(h, 'conservative', !s().conservative);
    expect(s().conservative).toBe(!defaultSettings.conservative);
    change(h, 'notify', true);
    expect(s().notify).toBe(true);
    change(h, 'hideSuspicious', false);
    expect(s().hideSuspicious).toBe(false);
    change(h, 'taming', '25');
    expect(s().taming).toBe(25);
    expect(change(h, 'taming', '61').getAttribute('aria-invalid')).toBe('true');
    expect(change(h, 'taming', '2.5').getAttribute('aria-invalid')).toBe('true');
    expect(s().taming).toBe(25);
    change(h, 'taming', '0');
    expect(s().taming).toBe(0);
    // invalid values are flagged and not written
    const bad = change(h, 'orderSlots', '99');
    expect(s().orderSlots).toBe(21);
    expect(bad.getAttribute('aria-invalid')).toBe('true');
    expect(change(h, 'forgeSlots', '0').getAttribute('aria-invalid')).toBe('true');
    expect(s().forgeSlots).toBe(defaultSettings.forgeSlots);
    expect(change(h, 'npcDailyLimit', '1.5').getAttribute('aria-invalid')).toBe('true');
    // external change syncs into the form
    h.store.set((st) => ({ settings: { ...st.settings, cycleHours: 4, orderSlots: 7 } }));
    expect(ctl(h, 'cycleHours').value).toBe('4');
    expect(ctl(h, 'orderSlots').value).toBe('7');
  });

  it('debounces typing and flushes on close', () => {
    vi.useFakeTimers();
    h = harness();
    openDrawer(h);
    const el = ctl(h, 'cycleHours');
    el.value = '3';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.store.get().settings.cycleHours).toBe(defaultSettings.cycleHours);
    vi.advanceTimersByTime(SETTINGS_DEBOUNCE_MS);
    expect(h.store.get().settings.cycleHours).toBe(3);
    const slots = ctl(h, 'orderSlots');
    slots.value = '9';
    slots.dispatchEvent(new Event('input', { bubbles: true }));
    h.q<HTMLButtonElement>('.settings-drawer .kit-x').click();
    expect(h.store.get().settings.orderSlots).toBe(9);
  });

  it('display segments set language, theme and density', () => {
    h = harness();
    openDrawer(h);
    h.q('[data-testid="set-density-compact"]').click();
    expect(h.store.get().settings.density).toBe('compact');
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(h.q('[data-testid="set-density-compact"]').getAttribute('aria-pressed')).toBe('true');
    h.q('[data-testid="set-theme-dark"]').click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    h.q('[data-testid="set-lang-en"]').click();
    expect(h.store.get().settings.lang).toBe('en');
    // labels re-render in English, drawer stays usable
    expect(h.q('.settings-drawer [data-sec="market"] .set-h').textContent).toBe('Market');
    expect(h.q('.settings-drawer .kit-drawer-title').textContent).toBe('Settings');
    expect(h.q('.settings-drawer [data-field="orderSlots"] .field-label').textContent).toBe('Order slots');
  });

  it('the permission button calls Notification.requestPermission on click', async () => {
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    const N = Object.assign(function Notification() {}, { permission: 'default', requestPermission });
    vi.stubGlobal('Notification', N);
    h = harness();
    openDrawer(h);
    const btn = h.q<HTMLButtonElement>('[data-testid="notify-perm"]');
    expect(btn.hidden).toBe(false);
    expect(h.q('.perm-state').textContent).toContain('henüz');
    expect(requestPermission).not.toHaveBeenCalled();
    N.permission = 'granted';
    btn.click();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h!.store.get().settings.notify).toBe(true));
    expect(btn.hidden).toBe(true);
    expect(h.q('.perm-state').textContent).toContain('verildi');
  });

  it('reports unsupported notifications', () => {
    vi.stubGlobal('Notification', undefined);
    h = harness();
    openDrawer(h);
    expect(h.q<HTMLButtonElement>('[data-testid="notify-perm"]').hidden).toBe(true);
    expect(h.q('.perm-state').textContent).toContain('desteklemiyor');
  });
});
