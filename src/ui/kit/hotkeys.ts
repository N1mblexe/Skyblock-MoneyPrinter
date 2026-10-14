// Global keyboard shortcuts: 'mod+k' (Ctrl or Cmd), '/', '?', 'Escape', single keys, and sequences
// like 'g o' (second key within SEQ_TIMEOUT_MS). Ignored while typing in text fields, except Escape and mod combos.
import type { HotkeyMap } from './types.ts';
import { isTypingTarget } from './util.ts';

/** Max gap between the keys of a sequence. */
export const SEQ_TIMEOUT_MS = 1000;

interface Chord {
  key: string;
  mod: boolean;
  alt: boolean;
  /** undefined = shift ignored (so '?' works on any layout) */
  shift?: boolean;
}

const ALIASES: Record<string, string> = { esc: 'escape', space: ' ', spacebar: ' ', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' };

/** Parse 'mod+shift+k' into a chord. */
export function parseChord(spec: string): Chord {
  const parts = spec.split('+');
  // a literal '+' key: 'mod++' or '+'
  let key = parts.pop()!;
  if (key === '' && parts.length && parts[parts.length - 1] === '') {
    parts.pop();
    key = '+';
  }
  const c: Chord = { key: '', mod: false, alt: false };
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (p === 'mod' || p === 'ctrl' || p === 'cmd' || p === 'meta') c.mod = true;
    else if (p === 'alt' || p === 'option') c.alt = true;
    else if (p === 'shift') c.shift = true;
  }
  const k = key.toLowerCase();
  c.key = ALIASES[k] ?? k;
  return c;
}

/** Parse 'g o' / 'mod+k' / ' ' style specs into a chord sequence. */
export function parseHotkey(spec: string): Chord[] {
  if (spec === ' ') return [parseChord(' ')];
  return spec.trim().split(/\s+/).map(parseChord);
}

function matches(c: Chord, ev: KeyboardEvent): boolean {
  if ((ev.ctrlKey || ev.metaKey) !== c.mod) return false;
  if (ev.altKey !== c.alt) return false;
  if (c.shift !== undefined && ev.shiftKey !== c.shift) return false;
  return ev.key.toLowerCase() === c.key;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Dead']);

/** Human label for a spec, e.g. 'mod+k' -> 'Ctrl K' (⌘ K on Apple), 'g o' -> 'G then O'. */
export function hotkeyLabel(spec: string, apple = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform ?? '')): string[] {
  return parseHotkey(spec).map((c) => {
    const parts: string[] = [];
    if (c.mod) parts.push(apple ? '⌘' : 'Ctrl');
    if (c.alt) parts.push(apple ? '⌥' : 'Alt');
    if (c.shift) parts.push(apple ? '⇧' : 'Shift');
    const k = c.key === 'escape' ? 'Esc' : c.key === ' ' ? 'Space' : c.key.length === 1 ? c.key.toUpperCase() : c.key[0]!.toUpperCase() + c.key.slice(1);
    parts.push(k);
    return parts.join(' ');
  });
}

/**
 * Register shortcuts on document (keydown). Each handler gets the event; matched keys are preventDefault()ed.
 * Events already defaultPrevented (e.g. Escape handled by an open dialog) are skipped. Returns unregister.
 */
export function registerHotkeys(map: HotkeyMap, target: Document | HTMLElement = document): () => void {
  const bindings = Object.entries(map).map(([spec, fn]) => ({ seq: parseHotkey(spec), fn }));
  let buf: KeyboardEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    buf = [];
    if (timer) clearTimeout(timer);
    timer = null;
  };

  function find(seq: KeyboardEvent[]): { exact?: (typeof bindings)[number]; prefix: boolean } {
    let exact: (typeof bindings)[number] | undefined;
    let prefix = false;
    for (const b of bindings) {
      if (b.seq.length < seq.length) continue;
      if (!seq.every((ev, i) => matches(b.seq[i]!, ev))) continue;
      if (b.seq.length === seq.length) exact ??= b;
      else prefix = true;
    }
    return { exact, prefix };
  }

  const onKey = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.defaultPrevented || e.isComposing || MODIFIER_KEYS.has(e.key)) return;
    if (isTypingTarget(e.target) && e.key !== 'Escape' && !(e.ctrlKey || e.metaKey)) {
      clear();
      return;
    }
    for (const cand of buf.length ? [[...buf, e], [e]] : [[e]]) {
      const { exact, prefix } = find(cand);
      // prefer completing a longer sequence; an exact single-key binding that is also a prefix waits
      if (exact && !prefix) {
        clear();
        e.preventDefault();
        exact.fn(e);
        return;
      }
      if (prefix) {
        buf = cand;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const pending = buf;
          clear();
          // timeout: fire an exact match for what was typed, if any
          const { exact: ex } = find(pending);
          if (ex) ex.fn(pending[pending.length - 1]!);
        }, SEQ_TIMEOUT_MS);
        return;
      }
    }
    clear();
  };
  target.addEventListener('keydown', onKey);
  return () => {
    clear();
    target.removeEventListener('keydown', onKey);
  };
}
