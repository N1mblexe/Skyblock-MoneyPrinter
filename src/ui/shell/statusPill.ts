import type { AppState, DataStatus, Store } from '../../types/contracts.ts';
import { onLangChange, t } from '../../i18n/index.ts';
import { ageStatus } from '../../state/status.ts';
import { fmtAge } from '../format.ts';

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
 * Status pill: status label + data age + next-refresh countdown + error text.
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
  const err = document.createElement('span');
  err.className = 'status-err';
  meta.append(age, next);
  el.append(pill, meta, err);

  function render(): void {
    const s = store.get();
    const now = Date.now();
    const st = displayStatus(s, now);
    setAttr(pill, 'class', `pill pill-${st}`);
    setAttr(pill, 'data-status', st);
    setText(pill, t(`common.st_${st}`));
    const tip = st === 'error' && s.lastError ? `${t('common.st_errorTitle')}: ${s.lastError}` : t(`common.st_${st}Title`);
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

    if (st === 'error' && s.lastError) {
      setText(err, shortErr(s.lastError));
      setAttr(err, 'title', s.lastError);
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
    if (s.status !== prev.status || s.snapshot !== prev.snapshot || s.lastError !== prev.lastError || s.nextPollAt !== prev.nextPollAt)
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
