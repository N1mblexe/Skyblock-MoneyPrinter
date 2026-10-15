// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectPalette, currentPalette, openPalette } from '../../../src/ui/kit/palette.ts';
import type { PaletteItem, PaletteProvider } from '../../../src/ui/kit/types.ts';

const item = (id: string, group: string, run = vi.fn()): PaletteItem => ({ id, label: `L ${id}`, hint: id, group, run });

afterEach(() => {
  currentPalette()?.close();
  document.body.innerHTML = '';
});

const input = () => document.querySelector<HTMLInputElement>('.kit-palette-input')!;
const opts = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const press = (key: string) => input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const activeLabel = () => document.getElementById(input().getAttribute('aria-activedescendant')!)?.textContent;

describe('openPalette', () => {
  it('keyboard flow: filter, arrows (wrapping), Enter runs and closes, focus returns', () => {
    const runB = vi.fn();
    const items = [item('apple', 'Items'), item('flip', 'Pages'), item('banana', 'Items', runB)];
    const provider: PaletteProvider = (q) => items.filter((i) => i.id.includes(q));
    const onClose = vi.fn();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    openPalette({ providers: [provider], onClose, placeholder: 'Ara…' });
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().placeholder).toBe('Ara…');
    const lb = document.getElementById(input().getAttribute('aria-controls')!)!;
    expect(lb.getAttribute('role')).toBe('listbox');
    // grouped in first-seen order: Items (apple, banana), Pages (flip)
    expect(opts().map((o) => o.querySelector('.kp-label')!.textContent)).toEqual(['L apple', 'L banana', 'L flip']);
    expect([...lb.querySelectorAll('.kp-glabel')].map((g) => g.textContent)).toEqual(['Items', 'Pages']);
    expect(activeLabel()).toContain('L apple');
    expect(opts()[0]!.getAttribute('aria-selected')).toBe('true');

    press('ArrowDown');
    expect(activeLabel()).toContain('L banana');
    press('ArrowDown');
    press('ArrowDown');
    expect(activeLabel()).toContain('L apple');
    press('ArrowUp');
    expect(activeLabel()).toContain('L flip');
    press('PageUp');
    expect(activeLabel()).toContain('L apple');
    press('PageDown');
    expect(activeLabel()).toContain('L flip');
    press('Tab');
    expect(document.activeElement).toBe(input());

    input().value = 'ban';
    input().dispatchEvent(new Event('input'));
    expect(opts()).toHaveLength(1);
    expect(document.querySelector('[role="status"]')!.textContent).toBe('1 results');
    press('Enter');
    expect(runB).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.kit-palette-root')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    expect(currentPalette()).toBeNull();
  });

  it('Esc closes; empty results; mouse picks; only one palette at a time', () => {
    const run = vi.fn();
    const h = openPalette({ providers: [(q) => (q === 'zzz' ? [] : [item('a', 'G', run), item('b', 'G')])] });
    expect(openPalette({ providers: [] })).toBe(h);
    input().value = 'zzz';
    input().dispatchEvent(new Event('input'));
    expect(document.querySelector('.kp-empty')!.textContent).toBe('No results');
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
    press('ArrowDown');
    press('Enter');
    input().value = '';
    input().dispatchEvent(new Event('input'));
    opts()[1]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(activeLabel()).toContain('L b');
    opts()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(currentPalette()).toBeNull();

    openPalette({ providers: [() => [item('a', 'G')]] });
    press('Escape');
    expect(currentPalette()).toBeNull();
    openPalette({ providers: [() => [item('a', 'G')]] });
    const root = document.querySelector<HTMLElement>('.kit-palette-root')!;
    root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(currentPalette()).toBeNull();
  });

  it('collects at most `limit` results across providers and survives a throwing provider', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = (g: string, n: number): PaletteProvider => () => Array.from({ length: n }, (_, i) => item(`${g}${i}`, g));
    const bad: PaletteProvider = () => {
      throw new Error('x');
    };
    const out = collectPalette([many('A', 30), bad, many('B', 30), many('C', 5)], '', 50);
    expect(out).toHaveLength(50);
    expect(out.filter((i) => i.group === 'B')).toHaveLength(20);
    expect(out.some((i) => i.group === 'C')).toBe(false);
    openPalette({ providers: [many('A', 80)], query: 'pre' });
    expect(opts()).toHaveLength(50);
    expect(input().value).toBe('pre');
  });
});
