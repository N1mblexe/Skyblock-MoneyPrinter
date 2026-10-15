// Toasts: one shared aria-live="polite" region, newest at the bottom, auto-dismiss (paused on hover/focus).
import type { ToastKind } from '../../types/contracts.ts';
import { t } from '../../i18n/index.ts';
import './i18n.ts';

/** Auto-dismiss delay per kind (ms). */
export const TOAST_MS: Record<ToastKind, number> = { info: 4000, ok: 4000, warn: 4000, err: 8000 };
/** Older toasts beyond this are dropped. */
export const TOAST_MAX = 4;

let region: HTMLElement | null = null;
const dismissers = new WeakMap<Element, () => void>();

function ensureRegion(): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement('div');
  region.className = 'kit-toasts';
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-relevant', 'additions');
  document.body.append(region);
  return region;
}

/** Show a toast; returns a function that dismisses it early. */
export function toast(msg: string, kind: ToastKind = 'info'): () => void {
  const reg = ensureRegion();
  const el = document.createElement('div');
  el.className = `kit-toast kit-toast-${kind}`;
  const text = document.createElement('span');
  text.className = 'kit-toast-msg';
  text.textContent = msg;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'kit-toast-x';
  x.textContent = '×';
  x.setAttribute('aria-label', t('kit.dismiss'));
  x.title = t('common.close');
  el.append(text, x);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const start = () => {
    stop();
    timer = setTimeout(dismiss, TOAST_MS[kind] ?? TOAST_MS.info);
  };
  function dismiss(): void {
    stop();
    el.remove();
  }
  x.addEventListener('click', dismiss);
  el.addEventListener('mouseenter', stop);
  el.addEventListener('mouseleave', start);
  el.addEventListener('focusin', stop);
  el.addEventListener('focusout', start);
  dismissers.set(el, dismiss);

  reg.append(el);
  while (reg.children.length > TOAST_MAX) {
    const old = reg.firstElementChild!;
    (dismissers.get(old) ?? (() => old.remove()))();
  }
  start();
  return dismiss;
}

/** Remove every toast (tests / route teardown). */
export function clearToasts(): void {
  if (!region) return;
  for (const c of [...region.children]) (dismissers.get(c) ?? (() => c.remove()))();
}
