// Settings drawer "Data" section: catalog/snapshot facts, price-history info + clear, the AH sales store (size +
// clear), settings backup.
import { downloadJson } from '../kit/download.ts';
import { msgOf, msgText, onLangChange, t } from '../../i18n/index.ts';
import { sanitizeSettings } from '../../state/appState.ts';
import type { AppState, HistoryRepo, Store, ToastKind } from '../../types/contracts.ts';
import { esc } from '../dom.ts';
import { fmtAge, fmtInt, fmtNum, locale } from '../format.ts';

export const SETTINGS_FILE = 'bazaar-masasi-settings.json';
/** how long the "click again to clear" state lasts */
export const CLEAR_CONFIRM_MS = 4000;

/** The realized AH sales store (api/ahSales.ts AhSalesPoller): its size and a way to empty it. */
export interface SalesStoreAccess {
  info(): Promise<{ sales: number; ids: number; coverageHours: number }>;
  clear(): Promise<void>;
}

export interface DataPanelOptions {
  store: Store<AppState>;
  history?: HistoryRepo;
  /** the AH sales store; the sales box is hidden without it */
  sales?: SalesStoreAccess;
  toast(msg: string, kind?: ToastKind): void;
}

export interface DataPanel {
  el: HTMLElement;
  /** where the manual-load panel lives while it is not needed inline */
  manualSlot: HTMLElement;
  /** re-read history info etc. (call when the drawer opens) */
  refresh(): void;
  destroy(): void;
}

function fmtDate(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Parse an exported settings file: either the settings object or {settings: {...}}. Returns null if unusable. */
export function parseSettingsFile(text: string, current: AppState['settings']): AppState['settings'] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw && typeof raw === 'object' && 'settings' in raw && typeof (raw as { settings: unknown }).settings === 'object')
    raw = (raw as { settings: unknown }).settings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return sanitizeSettings({ ...current, ...(raw as object) });
}

export function createDataPanel(opts: DataPanelOptions): DataPanel {
  const { store, history } = opts;
  const el = document.createElement('section');
  el.className = 'set-sec';
  el.dataset.sec = 'data';
  el.setAttribute('aria-labelledby', 'set-sec-data');
  el.innerHTML =
    `<h3 class="set-h" id="set-sec-data"></h3>` +
    `<dl class="kv data-kv" data-testid="data-info"></dl>` +
    `<div class="hist-box"><h4 class="set-h4 hist-h"></h4><dl class="kv hist-kv"></dl>` +
    `<button type="button" class="btn btn-sm btn-danger hist-clear" data-testid="history-clear"></button></div>` +
    `<div class="hist-box sales-box" data-testid="sales-store" hidden><h4 class="set-h4 sales-h"></h4><dl class="kv sales-kv"></dl>` +
    `<button type="button" class="btn btn-sm btn-danger sales-clear" data-testid="sales-clear"></button></div>` +
    `<div class="manual-home"></div>` +
    `<div class="backup"><h4 class="set-h4 backup-h"></h4><div class="backup-row">` +
    `<button type="button" class="btn btn-sm backup-export" data-testid="settings-export"></button>` +
    `<label class="btn btn-sm backup-import"><span class="backup-import-lbl"></span><input type="file" accept=".json,application/json" class="kit-sr" data-testid="settings-import"></label>` +
    `</div></div>`;
  const $ = <E extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<E>(sel)!;
  const dataKv = $('.data-kv');
  const histKv = $('.hist-kv');
  const clearBtn = $<HTMLButtonElement>('.hist-clear');
  let confirmUntil = 0;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  const salesBox = $('.sales-box');
  const salesKv = $('.sales-kv');
  const salesBtn = $<HTMLButtonElement>('.sales-clear');
  let salesInfo: Awaited<ReturnType<SalesStoreAccess['info']>> | null = null;
  /** info() failed (store unavailable) */
  let salesFailed = false;
  let salesConfirmUntil = 0;
  let salesTimer: ReturnType<typeof setTimeout> | null = null;
  let salesBusy = false;
  /** drops info() answers that arrive after a newer request */
  let salesSeq = 0;
  let alive = true;

  const row = (k: string, v: string, title?: string) => `<dt>${esc(k)}</dt><dd${title ? ` title="${esc(title)}"` : ''}>${esc(v)}</dd>`;

  function renderInfo(): void {
    const s = store.get();
    const c = s.catalog;
    let html = '';
    if (c) {
      html += row(t('shell.catalogGenerated'), fmtDate(c.meta.generatedAt));
      if (c.meta.neuCommit) html += row(t('shell.neuCommit'), c.meta.neuCommit.slice(0, 7), c.meta.neuCommit);
      if (c.meta.itemsApiUpdated) html += row(t('shell.itemsApi'), fmtDate(c.meta.itemsApiUpdated));
      html += row(t('shell.catalogItems'), fmtInt(Object.keys(c.items).length));
    } else {
      html += row(t('shell.catalog'), s.catalogError ? t('shell.catalogFailed') : t('shell.catalogPending'), s.catalogError ? msgText(s.catalogError) : undefined);
    }
    html += row(t('shell.products'), s.snapshot ? fmtInt(Object.keys(s.snapshot.products).length) : '—');
    if (s.snapshot) html += row(t('shell.snapshotAt'), fmtDate(s.snapshot.lastUpdated));
    dataKv.innerHTML = html;
  }

  function renderHistory(): void {
    $('.hist-h').textContent = t('shell.history');
    if (!history) {
      histKv.innerHTML = `<dt class="muted">${esc(t('shell.histUnavailable'))}</dt>`;
      clearBtn.hidden = true;
      return;
    }
    clearBtn.hidden = false;
    let info: ReturnType<HistoryRepo['info']> | null = null;
    try {
      info = history.info();
    } catch {
      info = null;
    }
    histKv.innerHTML = info
      ? row(t('shell.histRaw'), fmtInt(info.raw)) +
        row(t('shell.histQ15'), fmtInt(info.q15)) +
        row(t('shell.histOldest'), info.oldest == null ? '—' : t('shell.histOldestVal', { date: fmtDate(info.oldest), age: fmtAge(Date.now() - info.oldest) })) +
        row(t('shell.histPersistent'), info.persistent ? t('shell.yes') : t('shell.no'))
      : `<dt class="muted">${esc(t('shell.histUnavailable'))}</dt>`;
    const confirming = Date.now() < confirmUntil;
    clearBtn.textContent = confirming ? t('shell.histConfirm') : t('shell.histClear');
    clearBtn.classList.toggle('confirming', confirming);
    clearBtn.disabled = busy;
  }

  function renderSales(): void {
    const sales = opts.sales;
    salesBox.hidden = !sales;
    if (!sales) return;
    $('.sales-h').textContent = t('shell.salesStore');
    const i = salesInfo;
    salesKv.innerHTML = salesFailed
      ? `<dt class="muted">${esc(t('shell.salesUnavailable'))}</dt>`
      : !i
        ? `<dt class="muted">${esc(t('common.loading'))}</dt>`
        : row(t('shell.salesCount'), fmtInt(i.sales)) +
          row(t('shell.salesIds'), fmtInt(i.ids)) +
          row(t('shell.salesCoverage'), t('shell.salesCoverageVal', { h: fmtNum(i.coverageHours, 1) }));
    const confirming = Date.now() < salesConfirmUntil;
    salesBtn.textContent = confirming ? t('shell.salesConfirm') : t('shell.salesClear');
    salesBtn.classList.toggle('confirming', confirming);
    salesBtn.disabled = salesBusy || salesFailed;
  }

  /** re-read the sales store size (async) */
  function loadSales(): void {
    const sales = opts.sales;
    if (!sales) return;
    const seq = ++salesSeq;
    sales.info().then(
      (i) => {
        if (!alive || seq !== salesSeq) return;
        salesInfo = i;
        salesFailed = false;
        renderSales();
      },
      () => {
        if (!alive || seq !== salesSeq) return;
        salesFailed = true;
        renderSales();
      },
    );
  }

  async function clearSales(): Promise<void> {
    const sales = opts.sales;
    if (!sales || salesBusy) return;
    if (Date.now() >= salesConfirmUntil) {
      salesConfirmUntil = Date.now() + CLEAR_CONFIRM_MS;
      if (salesTimer) clearTimeout(salesTimer);
      salesTimer = setTimeout(() => {
        salesConfirmUntil = 0;
        renderSales();
      }, CLEAR_CONFIRM_MS);
      renderSales();
      return;
    }
    salesConfirmUntil = 0;
    if (salesTimer) clearTimeout(salesTimer);
    salesBusy = true;
    renderSales();
    try {
      await sales.clear();
      // the poller emits nothing on clear: drop the summary so no view keeps using the old sales
      store.set({ ahSales: null });
      opts.toast(t('shell.salesCleared'), 'ok');
    } catch (e) {
      opts.toast(t('shell.salesClearFail', { err: msgText(msgOf(e)) }), 'err');
    } finally {
      salesBusy = false;
      renderSales();
      loadSales();
    }
  }

  function renderLabels(): void {
    $('.set-h').textContent = t('shell.sec_data');
    $('.backup-h').textContent = t('shell.backup');
    $('.backup-export').textContent = t('shell.exportSettings');
    $('.backup-import-lbl').textContent = t('shell.importSettings');
    renderInfo();
    renderHistory();
    renderSales();
  }

  async function clearHistory(): Promise<void> {
    if (!history || busy) return;
    if (Date.now() >= confirmUntil) {
      confirmUntil = Date.now() + CLEAR_CONFIRM_MS;
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        confirmUntil = 0;
        renderHistory();
      }, CLEAR_CONFIRM_MS);
      renderHistory();
      return;
    }
    confirmUntil = 0;
    if (confirmTimer) clearTimeout(confirmTimer);
    busy = true;
    renderHistory();
    try {
      await history.clear();
      store.set((s) => ({ historyTick: s.historyTick + 1 }));
      opts.toast(t('shell.histCleared'), 'ok');
    } catch (e) {
      opts.toast(t('shell.histClearFail', { err: msgText(msgOf(e)) }), 'err');
    } finally {
      busy = false;
      renderHistory();
    }
  }

  function exportSettings(): void {
    const json = JSON.stringify(store.get().settings, null, 2);
    try {
      downloadJson(SETTINGS_FILE, json);
      opts.toast(t('shell.exported'), 'ok');
    } catch (e) {
      console.warn('settings export failed', e);
    }
  }

  function importText(text: string): void {
    const next = parseSettingsFile(text, store.get().settings);
    if (!next) {
      opts.toast(t('shell.importBad'), 'err');
      return;
    }
    store.set({ settings: next });
    opts.toast(t('shell.imported'), 'ok');
  }

  const onClick = (ev: MouseEvent) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (target?.closest('.hist-clear')) void clearHistory();
    else if (target?.closest('.sales-clear')) void clearSales();
    else if (target?.closest('.backup-export')) exportSettings();
  };
  const onChange = (ev: Event) => {
    const inp = ev.target as HTMLInputElement;
    if (!inp.matches?.('.backup-import input[type="file"]')) return;
    ev.stopPropagation();
    const f = inp.files?.[0];
    inp.value = '';
    if (f) f.text().then(importText, () => opts.toast(t('shell.importBad'), 'err'));
  };
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);

  const unsub = store.subscribe((s, prev) => {
    if (s.catalog !== prev.catalog || s.catalogError !== prev.catalogError || s.snapshot !== prev.snapshot) renderInfo();
    if (s.historyTick !== prev.historyTick) renderHistory();
    // a new sales summary means the store changed size
    if (s.ahSales !== prev.ahSales && s.ahSales) loadSales();
  });
  const unLang = onLangChange(renderLabels);
  // the sales store is read on refresh() (the drawer opening) and on new summaries, never at mount: the app wires
  // the poller after the shell, and boot shouldn't wait on IndexedDB for a closed drawer
  renderLabels();

  return {
    el,
    manualSlot: $('.manual-home'),
    refresh() {
      renderInfo();
      renderHistory();
      loadSales();
    },
    destroy() {
      alive = false;
      if (confirmTimer) clearTimeout(confirmTimer);
      if (salesTimer) clearTimeout(salesTimer);
      el.removeEventListener('click', onClick);
      el.removeEventListener('change', onChange);
      unsub();
      unLang();
      el.remove();
    },
  };
}
