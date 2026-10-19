import { AH_SALES } from '../../config.ts';
import type { AppState, DataStatus, Store } from '../../types/contracts.ts';
import { msgText, onLangChange, t } from '../../i18n/index.ts';
import { ageStatus } from '../../state/status.ts';
import { fmtAge, fmtNum } from '../format.ts';

/** Status actually displayed: freshness of the snapshot overrides a successful-fetch 'live'. */
export function displayStatus(s: AppState, now: number): DataStatus {
  switch (s.status) {
    case 'live':
    case 'stale':
    case 'old':
      return ageStatus(s.snapshot, now) ?? (s.status === 'live' ? 'loading' : s.status);
    default:
      return s.status;
  }
}

function shortErr(e: string): string {
  const one = e.replace(/\s+/g, ' ').trim();
  return one.length > 48 ? one.slice(0, 47) + '…' : one;
}

/** Assign only on change so the DOM (and any live region) is not touched by no-op renders. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
function setAttr(el: HTMLElement, name: string, value: string | null): void {
  if (value == null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * AH sales coverage text and tooltip (the auctions_ended feed), or null while the AH is off or nothing is loaded.
 * Below AH_SALES.minCoverageHours the text shows how far the feed still has to go before sales rates are used.
 */
export function salesCoverage(s: AppState): { text: string; title: string; low: boolean } | null {
  if (!s.settings.ahEnabled || !s.ahSales) return null;
  const cov = s.ahSales.coverageHours;
  const h = fmtNum(cov, 1);
  const min = AH_SALES.minCoverageHours;
  const low = !(cov >= min);
  return {
    text: t(low ? 'shell.salesCovLow' : 'shell.salesCov', { h, min }),
    title: t(low ? 'shell.salesCovLowTitle' : 'shell.salesCovTitle', { h, min, n: Object.keys(s.ahSales.byId).length }),
    low,
  };
}

/**
 * Status pill: status label + data age + next-refresh countdown + AH sales coverage + error text.
 * Only the label is a live region (role=status), and it is written only when the displayed status changes;
 * the age/countdown that tick every second sit outside it, so screen readers hear status changes only.
 */
export function createStatusPill(store: Store<AppState>): { el: HTMLElement; destroy(): void } {
  const el = document.createElement('div');
  el.className = 'status';

  const pill = document.createElement('span');
  pill.dataset.testid = 'status-pill';
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  pill.setAttribute('aria-atomic', 'true');
  const meta = document.createElement('span');
  meta.className = 'status-meta';
  const age = document.createElement('span');
  age.className = 'status-age';
  const next = document.createElement('span');
  next.className = 'status-next';
  const sales = document.createElement('span');
  sales.className = 'status-sales';
  sales.dataset.testid = 'status-sales';
  const err = document.createElement('span');
  err.className = 'status-err';
  meta.append(age, next, sales);
  el.append(pill, meta, err);

  function render(): void {
    const s = store.get();
    const now = Date.now();
    const st = displayStatus(s, now);
    setAttr(pill, 'class', `pill pill-${st}`);
    setAttr(pill, 'data-status', st);
    setText(pill, t(`common.st_${st}`));
    const tip = st === 'error' && s.lastError ? t('common.st_errorDetail', { err: msgText(s.lastError) }) : t(`common.st_${st}Title`);
    setAttr(pill, 'title', tip);

    let ageText = '';
    if (s.snapshot) ageText = t('common.dataAge', { age: fmtAge(now - s.snapshot.lastUpdated) });
    else if (st !== 'loading') ageText = t('common.noData');
    setText(age, ageText);
    age.hidden = !ageText;

    let nextText = '';
    if (s.nextPollAt != null) {
      const ms = s.nextPollAt - now;
      nextText = ms > 500 ? t('common.nextIn', { s: fmtAge(ms + 999) }) : t('common.nextNow');
    }
    setText(next, nextText);
    next.hidden = !nextText;

    const cov = salesCoverage(s);
    setText(sales, cov?.text ?? '');
    setAttr(sales, 'title', cov?.title ?? null);
    setAttr(sales, 'data-low', cov ? String(cov.low) : null);
    sales.hidden = !cov;

    if (st === 'error' && s.lastError) {
      setText(err, shortErr(msgText(s.lastError)));
      setAttr(err, 'title', msgText(s.lastError));
      err.hidden = false;
    } else {
      setText(err, '');
      setAttr(err, 'title', null);
      err.hidden = true;
    }
  }

  render();
  const timer = setInterval(render, 1000);
  const unsub = store.subscribe((s, prev) => {
    if (
      s.status !== prev.status ||
      s.snapshot !== prev.snapshot ||
      s.lastError !== prev.lastError ||
      s.nextPollAt !== prev.nextPollAt ||
      s.ahSales !== prev.ahSales ||
      s.settings.ahEnabled !== prev.settings.ahEnabled
    )
      render();
  });
  const unLang = onLangChange(render);

  return {
    el,
    destroy() {
      clearInterval(timer);
      unsub();
      unLang();
      el.remove();
    },
  };
}
