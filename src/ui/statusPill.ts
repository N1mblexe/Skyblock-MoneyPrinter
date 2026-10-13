import type { AppState, DataStatus, Store } from '../types/contracts.ts';
import { onLangChange, t } from '../i18n/index.ts';
import { ageStatus } from '../state/status.ts';
import { fmtAge } from './format.ts';

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

/** Status pill: status label + age of data (ticks every second) + next refresh countdown + lastError tooltip. */
export function createStatusPill(store: Store<AppState>): { el: HTMLElement; destroy(): void } {
  const el = document.createElement('div');
  el.className = 'status';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');

  const pill = document.createElement('span');
  pill.dataset.testid = 'status-pill';
  const meta = document.createElement('span');
  meta.className = 'status-meta';
  const age = document.createElement('span');
  age.className = 'status-age';
  const next = document.createElement('span');
  next.className = 'status-next';
  const err = document.createElement('span');
  err.className = 'status-err';
  meta.append(age, next);
  el.append(pill, meta, err);

  function render(): void {
    const s = store.get();
    const now = Date.now();
    const st = displayStatus(s, now);
    pill.className = `pill pill-${st}`;
    pill.dataset.status = st;
    pill.textContent = t(`common.st_${st}`);
    const tip = st === 'error' && s.lastError ? `${t('common.st_errorTitle')}: ${s.lastError}` : t(`common.st_${st}Title`);
    pill.title = tip;

    if (s.snapshot) {
      age.textContent = t('common.dataAge', { age: fmtAge(now - s.snapshot.lastUpdated) });
      age.hidden = false;
    } else {
      age.textContent = st === 'loading' ? '' : t('common.noData');
      age.hidden = !age.textContent;
    }

    if (s.nextPollAt != null) {
      const ms = s.nextPollAt - now;
      next.textContent = ms > 500 ? t('common.nextIn', { s: fmtAge(ms + 999) }) : t('common.nextNow');
      next.hidden = false;
    } else {
      next.textContent = '';
      next.hidden = true;
    }

    if (st === 'error' && s.lastError) {
      err.textContent = shortErr(s.lastError);
      err.title = s.lastError;
      err.hidden = false;
    } else {
      err.textContent = '';
      err.removeAttribute('title');
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
      s.nextPollAt !== prev.nextPollAt
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
