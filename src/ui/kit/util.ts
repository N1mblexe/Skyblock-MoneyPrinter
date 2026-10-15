// Small DOM helpers shared by the kit widgets.

let seq = 0;
/** Unique DOM id with a prefix. */
export const uid = (prefix: string): string => `${prefix}-${++seq}`;

/** Trailing debounce with flush/cancel. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush(): void; cancel(): void; pending(): boolean } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const run = () => {
    timer = null;
    const a = last;
    last = null;
    if (a) fn(...a);
  };
  const d = (...a: A) => {
    last = a;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  d.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  d.pending = () => timer != null;
  d.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = null;
  };
  return d;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/** Tabbable descendants in DOM order (hidden ones excluded). */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !e.hidden && !e.closest('[hidden]'));
}

/** Keep Tab / Shift+Tab inside root. Call from a keydown handler; returns true when it handled the key. */
export function trapTab(root: HTMLElement, ev: KeyboardEvent): boolean {
  if (ev.key !== 'Tab') return false;
  const list = focusables(root);
  if (!list.length) {
    ev.preventDefault();
    root.focus();
    return true;
  }
  const first = list[0]!;
  const last = list[list.length - 1]!;
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !root.contains(active))) {
    ev.preventDefault();
    last.focus();
    return true;
  }
  if (!ev.shiftKey && (active === last || !root.contains(active))) {
    ev.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** true when the element takes typed text (text inputs, textarea, select, contenteditable). */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el.isContentEditable || el.getAttribute('contenteditable') === 'true';
}

/** window.matchMedia when available (null in non-browser environments). */
export function media(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}

/** Subscribe to a MediaQueryList change; returns an unsubscribe function. */
export function onMedia(mql: MediaQueryList | null, fn: () => void): () => void {
  if (!mql) return () => {};
  mql.addEventListener('change', fn);
  return () => mql.removeEventListener('change', fn);
}

/** Focus without scrolling when supported. */
export function focusEl(el: HTMLElement | null | undefined, preventScroll = false): void {
  if (!el) return;
  try {
    el.focus({ preventScroll });
  } catch {
    el.focus();
  }
}
