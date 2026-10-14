// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hotkeyLabel, parseHotkey, registerHotkeys, SEQ_TIMEOUT_MS } from '../../../src/ui/kit/hotkeys.ts';

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
};

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('registerHotkeys', () => {
  it('fires single keys, mod combos, ? and Escape, preventing default', () => {
    const fns = { palette: vi.fn(), slash: vi.fn(), help: vi.fn(), esc: vi.fn(), r: vi.fn() };
    off = registerHotkeys({ 'mod+k': fns.palette, '/': fns.slash, '?': fns.help, Escape: fns.esc, r: fns.r });
    expect(press('k', { ctrlKey: true }).defaultPrevented).toBe(true);
    press('k', { metaKey: true });
    expect(fns.palette).toHaveBeenCalledTimes(2);
    press('k');
    expect(fns.palette).toHaveBeenCalledTimes(2);
    press('/');
    press('?', { shiftKey: true });
    press('Escape');
    press('R');
    press('r', { altKey: true });
    expect(fns.slash).toHaveBeenCalledTimes(1);
    expect(fns.help).toHaveBeenCalledTimes(1);
    expect(fns.esc).toHaveBeenCalledTimes(1);
    expect(fns.r).toHaveBeenCalledTimes(1);
    press('Shift');
  });

  it('handles sequences with a 1s timeout', () => {
    vi.useFakeTimers();
    const go = vi.fn();
    const goFlip = vi.fn();
    const g = vi.fn();
    off = registerHotkeys({ 'g o': go, 'g f': goFlip });
    press('g');
    press('o');
    expect(go).toHaveBeenCalledTimes(1);
    press('g');
    vi.advanceTimersByTime(SEQ_TIMEOUT_MS + 1);
    press('f');
    expect(goFlip).not.toHaveBeenCalled();
    press('g');
    press('x');
    press('f');
    expect(goFlip).not.toHaveBeenCalled();
    press('g');
    press('g');
    press('f');
    expect(goFlip).toHaveBeenCalledTimes(1);
    off();
    // a single key that is also a sequence prefix fires after the timeout
    off = registerHotkeys({ g, 'g o': go });
    press('g');
    expect(g).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SEQ_TIMEOUT_MS);
    expect(g).toHaveBeenCalledTimes(1);
    press('g');
    press('o');
    expect(go).toHaveBeenCalledTimes(2);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('is ignored while typing, except Escape and mod combos', () => {
    const fns = { r: vi.fn(), esc: vi.fn(), k: vi.fn(), go: vi.fn() };
    off = registerHotkeys({ r: fns.r, Escape: fns.esc, 'mod+k': fns.k, 'g o': fns.go });
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const sel = document.createElement('select');
    document.body.append(input, area, ce, box, sel);
    for (const el of [input, area, ce, sel]) {
      press('r', {}, el);
      press('g', {}, el);
      press('o', {}, el);
    }
    expect(fns.r).not.toHaveBeenCalled();
    expect(fns.go).not.toHaveBeenCalled();
    press('Escape', {}, input);
    press('k', { ctrlKey: true }, area);
    expect(fns.esc).toHaveBeenCalledTimes(1);
    expect(fns.k).toHaveBeenCalledTimes(1);
    press('r', {}, box); // checkboxes don't take text
    expect(fns.r).toHaveBeenCalledTimes(1);
    // already handled elsewhere
    const ev = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true });
    ev.preventDefault();
    document.body.dispatchEvent(ev);
    expect(fns.r).toHaveBeenCalledTimes(1);
  });

  it('unregister removes the listener', () => {
    const r = vi.fn();
    const stop = registerHotkeys({ r });
    stop();
    press('r');
    expect(r).not.toHaveBeenCalled();
  });

  it('parses and labels specs', () => {
    expect(parseHotkey('mod+shift+k')).toEqual([{ key: 'k', mod: true, alt: false, shift: true }]);
    expect(parseHotkey('g o')).toHaveLength(2);
    expect(parseHotkey('mod++')[0]).toMatchObject({ key: '+', mod: true });
    expect(parseHotkey(' ')[0]!.key).toBe(' ');
    expect(parseHotkey('alt+esc')[0]).toMatchObject({ key: 'escape', alt: true });
    expect(hotkeyLabel('mod+k', false)).toEqual(['Ctrl K']);
    expect(hotkeyLabel('mod+alt+shift+k', true)).toEqual(['⌘ ⌥ ⇧ K']);
    expect(hotkeyLabel('g o', false)).toEqual(['G', 'O']);
    expect(hotkeyLabel('Escape', false)).toEqual(['Esc']);
    expect(hotkeyLabel('space', false)).toEqual(['Space']);
    expect(hotkeyLabel('ArrowUp', false)).toEqual(['Arrowup']);
    expect(hotkeyLabel('alt+x', false)).toEqual(['Alt X']);
    expect(hotkeyLabel('shift+x', false)).toEqual(['Shift X']);
  });
});
