// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDetailPanel } from '../../../src/ui/kit/panel.ts';
import { createDrawer } from '../../../src/ui/kit/drawer.ts';
import { focusables, isTypingTarget, trapTab } from '../../../src/ui/kit/util.ts';

function mockMedia(matches: boolean) {
  const listeners: (() => void)[] = [];
  const mq = { matches, addEventListener: (_: string, fn: () => void) => listeners.push(fn), removeEventListener: vi.fn() };
  vi.spyOn(window, 'matchMedia').mockReturnValue(mq as unknown as MediaQueryList);
  return { mq, fire: () => listeners.forEach((f) => f()) };
}
const esc = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('createDetailPanel', () => {
  it('docked: complementary, labelled, focus in on open and back on close, Esc closes', () => {
    mockMedia(true);
    const split = document.createElement('div');
    split.className = 'kit-split';
    const opener = document.createElement('button');
    split.append(opener);
    document.body.append(split);
    const p = createDetailPanel();
    split.append(p.el);
    const closed = vi.fn();
    const off = p.onClose(closed);
    opener.focus();
    p.open('Gold', '<p class="x">body</p>');
    expect(p.isOpen()).toBe(true);
    expect(p.el.hidden).toBe(false);
    expect(p.el.getAttribute('role')).toBe('complementary');
    expect(p.el.hasAttribute('aria-modal')).toBe(false);
    expect(document.getElementById(p.el.getAttribute('aria-labelledby')!)!.textContent).toBe('Gold');
    expect(split.classList.contains('kit-split--open')).toBe(true);
    expect(document.activeElement).toBe(p.el);
    expect(document.querySelector('.kit-backdrop')).toBeNull();
    // re-open swaps content but leaves focus alone
    const node = document.createElement('div');
    node.textContent = 'node body';
    opener.focus();
    p.open('Iron', node);
    expect(document.activeElement).toBe(opener);
    expect(p.el.querySelector('.kit-panel-body')!.textContent).toBe('node body');
    p.el.focus();
    esc(p.el);
    expect(p.isOpen()).toBe(false);
    expect(split.classList.contains('kit-split--open')).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(closed).toHaveBeenCalledTimes(1);
    p.close();
    expect(closed).toHaveBeenCalledTimes(1);
    off();
    p.open('x', 'y');
    p.el.querySelector<HTMLButtonElement>('.kit-x')!.click();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(p.el.querySelector('.kit-x')!.getAttribute('aria-label')).toBe('Kapat');
    p.destroy();
    expect(p.el.isConnected).toBe(false);
  });

  it('overlay below dockBp: modal dialog with backdrop, document Esc, returnFocus fallback, mode switch', () => {
    const m = mockMedia(false);
    const fallback = document.createElement('button');
    document.body.append(fallback);
    const p = createDetailPanel({ returnFocus: () => fallback });
    document.body.append(p.el);
    const gone = document.createElement('button');
    document.body.append(gone);
    gone.focus();
    p.open('T', '<button id="in">in</button>');
    expect(p.el.getAttribute('role')).toBe('dialog');
    expect(p.el.getAttribute('aria-modal')).toBe('true');
    const backdrop = document.querySelector<HTMLElement>('.kit-backdrop')!;
    expect(backdrop).not.toBeNull();
    gone.remove();
    // Tab is trapped
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(p.el.contains(document.activeElement)).toBe(true);
    esc(document);
    expect(p.isOpen()).toBe(false);
    expect(document.activeElement).toBe(fallback);
    expect(document.querySelector('.kit-backdrop')).toBeNull();

    p.open('T', 'b');
    document.querySelector<HTMLElement>('.kit-backdrop')!.click();
    expect(p.isOpen()).toBe(false);
    p.open('T', 'b');
    m.mq.matches = true;
    m.fire();
    expect(p.el.dataset.mode).toBe('dock');
    expect(document.querySelector('.kit-backdrop')).toBeNull();
    p.destroy();
  });
});

describe('createDrawer', () => {
  it('opens as a dialog, focuses inside, Esc / close button / backdrop close, focus returns', () => {
    const onClose = vi.fn();
    let title = 'Ayarlar';
    const d = createDrawer({ title: () => title, side: 'left', onClose });
    const field = document.createElement('input');
    d.body.append(field);
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    d.open();
    expect(d.isOpen()).toBe(true);
    expect(d.el.isConnected).toBe(true);
    expect(d.el.hasAttribute('open')).toBe(true);
    expect(d.el.dataset.side).toBe('left');
    expect(document.getElementById(d.el.getAttribute('aria-labelledby')!)!.textContent).toBe('Ayarlar');
    expect(document.activeElement).toBe(field);
    d.open(); // idempotent
    esc(field);
    expect(d.isOpen()).toBe(false);
    expect(d.el.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(onClose).toHaveBeenCalledTimes(1);

    title = 'Settings';
    d.open();
    expect(d.el.querySelector('h2')!.textContent).toBe('Settings');
    d.el.querySelector<HTMLButtonElement>('.kit-x')!.click();
    expect(onClose).toHaveBeenCalledTimes(2);
    d.open();
    d.el.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(d.isOpen()).toBe(false);
    d.open();
    d.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(d.isOpen()).toBe(false);
    d.open();
    d.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    d.setTitle('Other');
    expect(d.el.querySelector('h2')!.textContent).toBe('Other');
    d.destroy();
    expect(d.el.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(5);
  });

  it('falls back to the open attribute without showModal; static title', () => {
    const d = createDrawer({ title: 'T' });
    Object.defineProperty(d.el, 'showModal', { value: undefined });
    Object.defineProperty(d.el, 'close', { value: undefined });
    d.open();
    expect(d.el.hasAttribute('open')).toBe(true);
    expect(d.el.dataset.side).toBe('right');
    expect(document.activeElement).toBe(d.el.querySelector('.kit-x'));
    d.close();
    expect(d.el.hasAttribute('open')).toBe(false);
  });
});

describe('util', () => {
  it('trapTab wraps focus and isTypingTarget classifies', () => {
    const root = document.createElement('div');
    const a = document.createElement('button');
    const b = document.createElement('button');
    const h = document.createElement('button');
    h.hidden = true;
    root.append(a, b, h);
    document.body.append(root);
    expect(focusables(root)).toEqual([a, b]);
    b.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    expect(trapTab(root, ev)).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(trapTab(root, new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }))).toBe(true);
    expect(document.activeElement).toBe(b);
    a.focus();
    expect(trapTab(root, new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))).toBe(false);
    expect(trapTab(root, new KeyboardEvent('keydown', { key: 'x' }))).toBe(false);
    const empty = document.createElement('div');
    empty.tabIndex = -1;
    document.body.append(empty);
    expect(trapTab(empty, new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
  });
});
