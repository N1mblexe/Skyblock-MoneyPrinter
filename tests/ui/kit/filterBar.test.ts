// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../src/i18n/common.ts';
import { dictKeys, setLang } from '../../../src/i18n/index.ts';
import '../../../src/ui/kit/i18n.ts';
import { createFilterBar, FILTER_DEBOUNCE_MS, parseNumberInput } from '../../../src/ui/kit/filterBar.ts';
import { bindQueryState } from '../../../src/ui/kit/queryState.ts';
import type { FilterSpec, QuerySchema } from '../../../src/ui/kit/types.ts';

const SCHEMA = {
  q: { kind: 'string', def: '' },
  minVol: { kind: 'number', def: null },
  risk: { kind: 'enum', def: 'all', values: ['all', 'ok'] },
  verified: { kind: 'bool', def: false },
  sort: { kind: 'sort', def: { key: 'v', dir: 'desc' } },
} as const satisfies QuerySchema;

const SPECS: FilterSpec[] = [
  { kind: 'search', key: 'q', label: () => 'Search', placeholder: () => 'type…' },
  { kind: 'number', key: 'minVol', label: () => 'Min vol', help: () => 'per week', suffix: 'coins' },
  { kind: 'segment', key: 'risk', label: () => 'Risk', options: [{ value: 'all', label: () => 'All' }, { value: 'ok', label: () => 'OK' }] },
  { kind: 'toggle', key: 'verified', label: () => 'Verified' },
];

function setup() {
  const setQuery = vi.fn();
  const qs = bindQueryState(SCHEMA, { id: 'flip' }, setQuery);
  const bar = createFilterBar(SPECS, qs);
  document.body.append(bar.el);
  const $ = <E extends HTMLElement>(s: string) => bar.el.querySelector<E>(s)!;
  return { qs, bar, setQuery, $ };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  setLang('tr');
  document.body.innerHTML = '';
});

describe('createFilterBar', () => {
  it('renders the four field kinds with labels', () => {
    const { $ } = setup();
    expect([...document.querySelectorAll('.field-label')].map((e) => e.textContent)).toEqual(['Search', 'Min vol', 'Risk', 'Verified']);
    expect($<HTMLInputElement>('input[type="search"]').placeholder).toBe('type…');
    expect($('.field-help').textContent).toBe('per week');
    expect($('.kit-fb-suffix').textContent).toBe('coins');
    expect($('.seg').getAttribute('aria-labelledby')).toBe($('.seg').previousElementSibling!.id);
    expect($('.seg button[data-value="all"]').getAttribute('aria-pressed')).toBe('true');
    expect($('.kit-fb-toggle').textContent).toBe('Filtreler');
    expect($<HTMLButtonElement>('.kit-fb-reset').disabled).toBe(true);
  });

  it('a pending number edit survives another field changing the state', () => {
    const { qs, $ } = setup();
    const num = $<HTMLInputElement>('input[data-filter="minVol"]');
    num.value = '500';
    num.dispatchEvent(new Event('input'));
    $<HTMLButtonElement>('.seg button[data-value="ok"]').click(); // state changes while minVol is still debouncing
    expect(num.value).toBe('500');
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    expect(qs.get()).toMatchObject({ minVol: 500, risk: 'ok' });
  });

  it('debounces search/number input, counts active filters, reset clears', () => {
    const { qs, $ } = setup();
    const search = $<HTMLInputElement>('input[type="search"]');
    search.value = 'gold';
    search.dispatchEvent(new Event('input'));
    expect(qs.get().q).toBe('');
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    expect(qs.get().q).toBe('gold');

    const num = $<HTMLInputElement>('input[inputmode="decimal"]');
    num.value = '1,5';
    num.dispatchEvent(new Event('input'));
    num.dispatchEvent(new Event('change'));
    expect(qs.get().minVol).toBe(1.5);
    num.value = 'abc';
    num.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    expect(num.getAttribute('aria-invalid')).toBe('true');
    expect(qs.get().minVol).toBe(1.5);

    $<HTMLButtonElement>('.seg button[data-value="ok"]').click();
    const box = $<HTMLInputElement>('input[type="checkbox"]');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    qs.set({ sort: { key: 'x', dir: 'asc' } }); // sort is not a filter
    expect(qs.activeCount()).toBe(4);
    expect($('.kit-fb-toggle').textContent).toBe('Filtreler (4)');
    expect($('.kit-fb-count').classList.contains('on')).toBe(true);
    expect($('.seg button[data-value="ok"]').getAttribute('aria-pressed')).toBe('true');

    search.value = 'typing';
    search.dispatchEvent(new Event('input'));
    $<HTMLButtonElement>('.kit-fb-reset').click();
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS * 2);
    expect(qs.activeCount()).toBe(0);
    expect(search.value).toBe('');
    expect(num.value).toBe('');
    expect(num.hasAttribute('aria-invalid')).toBe(false);
    expect(box.checked).toBe(false);
    expect($('.kit-fb-toggle').textContent).toBe('Filtreler');
  });

  it('reflects external state changes, toggles the mobile disclosure, relabels, destroys', () => {
    const { qs, bar, $ } = setup();
    qs.fromRoute({ id: 'flip', query: { q: 'url', minVol: '7' } });
    expect($<HTMLInputElement>('input[type="search"]').value).toBe('url');
    expect($<HTMLInputElement>('input[inputmode="decimal"]').value).toBe('7');
    const toggle = $<HTMLButtonElement>('.kit-fb-toggle');
    toggle.click();
    expect(bar.el.dataset.open).toBe('');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(bar.el.dataset.open).toBeUndefined();
    setLang('en');
    bar.refresh();
    expect($('.kit-fb-reset').textContent).toBe('Reset filters');
    expect(toggle.textContent).toBe('Filters (2)');
    bar.destroy();
    expect(bar.el.isConnected).toBe(false);
    qs.set({ q: 'after' });
    expect($<HTMLInputElement>('input[type="search"]').value).toBe('url');
  });

  it('parses typed numbers in both locales', () => {
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput(' 12 ')).toBe(12);
    expect(parseNumberInput('1,5')).toBe(1.5);
    expect(parseNumberInput('1.234,5')).toBe(1234.5);
    expect(parseNumberInput('1,234.5')).toBe(1234.5);
    expect(parseNumberInput('1 000')).toBe(1000);
    expect(parseNumberInput('x')).toBeUndefined();
  });

  it('kit dictionary has TR/EN parity', () => {
    const k = dictKeys('kit');
    expect(k.tr.length).toBeGreaterThan(0);
    expect(k.tr).toEqual(k.en);
  });
});
