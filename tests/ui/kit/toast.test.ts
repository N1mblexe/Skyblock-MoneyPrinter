// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, toast, TOAST_MAX, TOAST_MS } from '../../../src/ui/kit/toast.ts';

afterEach(() => {
  clearToasts();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const region = () => document.querySelector<HTMLElement>('.kit-toasts')!;
const msgs = () => [...document.querySelectorAll('.kit-toast-msg')].map((e) => e.textContent);

describe('toast', () => {
  it('stacks toasts in one polite live region, newest last, capped', () => {
    toast('one');
    toast('two', 'ok');
    expect(document.querySelectorAll('.kit-toasts')).toHaveLength(1);
    expect(region().getAttribute('aria-live')).toBe('polite');
    expect(msgs()).toEqual(['one', 'two']);
    expect(document.querySelector('.kit-toast-ok')).not.toBeNull();
    for (let i = 0; i < TOAST_MAX + 2; i++) toast(`n${i}`, 'warn');
    expect(msgs()).toHaveLength(TOAST_MAX);
    expect(msgs().at(-1)).toBe(`n${TOAST_MAX + 1}`);
  });

  it('auto-dismisses after 4s (8s for err), pauses on hover; dismiss button', () => {
    vi.useFakeTimers();
    toast('info');
    toast('bad', 'err');
    vi.advanceTimersByTime(TOAST_MS.info + 1);
    expect(msgs()).toEqual(['bad']);
    const err = document.querySelector<HTMLElement>('.kit-toast-err')!;
    err.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(TOAST_MS.err * 2);
    expect(msgs()).toEqual(['bad']);
    err.dispatchEvent(new Event('mouseleave'));
    vi.advanceTimersByTime(TOAST_MS.err + 1);
    expect(msgs()).toEqual([]);

    const dismiss = toast('x');
    const btn = document.querySelector<HTMLButtonElement>('.kit-toast-x')!;
    expect(btn.getAttribute('aria-label')).toBe('Bildirimi kapat');
    btn.click();
    expect(msgs()).toEqual([]);
    dismiss(); // idempotent
    toast('y');
    dismiss();
    expect(msgs()).toEqual(['y']);
  });

  it('recreates the region if it was removed', () => {
    toast('a');
    document.body.innerHTML = '';
    toast('b');
    expect(region().isConnected).toBe(true);
    expect(msgs()).toEqual(['b']);
  });
});
