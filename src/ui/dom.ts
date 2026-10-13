export type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape text for innerHTML templates. null/undefined => "". */
export function esc(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]!);
}

/** Create an element. Attrs starting with "on" (e.g. onclick) are event listeners; false/null attrs are skipped. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(c);
  }
  return el;
}

/** Coalesce calls into one per animation frame (falls back to setTimeout 0 without rAF). */
export function rafDebounce(fn: () => void): () => void {
  let pending = false;
  const run = () => {
    pending = false;
    fn();
  };
  return () => {
    if (pending) return;
    pending = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  };
}
