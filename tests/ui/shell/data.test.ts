// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../../src/state/appState.ts';
import type { Catalog } from '../../../src/types/contracts.ts';
import { parseSettingsFile } from '../../../src/ui/shell/dataPanel.ts';
import { fakeHistory } from '../../helpers/fakes.ts';
import { harness, snap, teardown, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(() => {
  teardown(h);
  h = null;
});

const catalog = {
  meta: { generatedAt: '2026-10-01T12:00:00Z', neuCommit: 'abcdef1234567890', itemsApiUpdated: 1_790_000_000_000 },
  items: { A: { id: 'A', name: 'A', bazaar: true }, B: { id: 'B', name: 'B', bazaar: false } },
  name: (id: string) => id,
} as unknown as Catalog;

function openData(hh: Harness): HTMLElement {
  hh.mount();
  hh.q('[data-testid="settings-btn"]').click();
  return hh.q('.settings-drawer [data-sec="data"]');
}

describe('settings drawer: Data section', () => {
  it('shows catalog + snapshot facts with the short NEU commit', () => {
    h = harness({ catalog, snapshot: snap(Date.now(), { A: {} as never, C: {} as never }) });
    const sec = openData(h);
    const info = sec.querySelector('[data-testid="data-info"]')!;
    expect(info.textContent).toContain('abcdef1');
    expect(info.textContent).not.toContain('abcdef12');
    expect(info.querySelector('dd[title="abcdef1234567890"]')).not.toBeNull();
    expect(info.textContent).toContain('Items API');
    expect(info.textContent).toContain('Bazaar ürünü2');
    expect(info.textContent).toContain('Katalog eşyası2');
  });

  it('catalog pending / failed states', () => {
    h = harness();
    const sec = openData(h);
    expect(sec.textContent).toContain('yükleniyor');
    h.store.set({ catalogError: 'HTTP 500' });
    expect(sec.querySelector('[data-testid="data-info"]')!.textContent).toContain('yüklenemedi');
  });

  it('degrades without history', () => {
    h = harness();
    const sec = openData(h);
    expect(sec.textContent).toContain('Geçmiş bilgisi bu sürümde gösterilemiyor');
    expect(sec.querySelector<HTMLButtonElement>('[data-testid="history-clear"]')!.hidden).toBe(true);
  });

  it('shows history info and clears after a confirming second click', async () => {
    const clear = vi.fn(async () => {});
    h = harness();
    h.ctx.history = fakeHistory({ info: () => ({ raw: 120, q15: 40, oldest: Date.now() - 3 * 3600_000, persistent: true }), clear });
    const sec = openData(h);
    expect(sec.textContent).toContain('Ham kayıt120');
    expect(sec.textContent).toContain('15 dk kayıt40');
    expect(sec.textContent).toContain('3 sa');
    expect(sec.textContent).toContain('Kalıcı depolamaEvet');
    const btn = sec.querySelector<HTMLButtonElement>('[data-testid="history-clear"]')!;
    expect(btn.textContent).toBe('Geçmişi sil');
    btn.click();
    expect(clear).not.toHaveBeenCalled();
    expect(btn.textContent).toContain('tekrar tıkla');
    btn.click();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h!.ctx.toast).toHaveBeenCalledWith('Fiyat geçmişi silindi.', 'ok'));
    expect(h.store.get().historyTick).toBe(1);
  });

  it('exports settings as JSON', () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL: revoke });
    h = harness();
    const sec = openData(h);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    sec.querySelector<HTMLButtonElement>('[data-testid="settings-export"]')!.click();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(h.ctx.toast).toHaveBeenCalledWith('Ayarlar indirildi.', 'ok');
  });

  it('imports settings from a file (sanitized, merged over current)', async () => {
    h = harness();
    const sec = openData(h);
    const input = sec.querySelector<HTMLInputElement>('[data-testid="settings-import"]')!;
    const file = new File([JSON.stringify({ settings: { orderSlots: 20, fillModel: 'pipelined', capital: -5 } })], 's.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(h!.store.get().settings.orderSlots).toBe(20));
    expect(h.store.get().settings.fillModel).toBe('pipelined');
    expect(h.store.get().settings.capital).toBe(defaultSettings.capital);
    expect(h.ctx.toast).toHaveBeenCalledWith('Ayarlar yüklendi.', 'ok');
  });

  it('parseSettingsFile rejects junk', () => {
    expect(parseSettingsFile('nope', defaultSettings)).toBeNull();
    expect(parseSettingsFile('[1,2]', defaultSettings)).toBeNull();
    expect(parseSettingsFile('{"density":"compact"}', defaultSettings)!.density).toBe('compact');
  });
});
