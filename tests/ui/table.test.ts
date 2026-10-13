// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/i18n/common.ts';
import { setLang } from '../../src/i18n/index.ts';
import { createTable, sortRows, type Column } from '../../src/ui/table.ts';
import { esc } from '../../src/ui/dom.ts';

interface R {
  id: string;
  name: string;
  v: number | null;
}

const cols: Column<R>[] = [
  { key: 'name', label: () => 'Name', get: (r) => r.name },
  { key: 'v', label: () => 'Value', get: (r) => r.v, align: 'right' },
];
const rows: R[] = [
  { id: 'a', name: 'Bravo', v: 2 },
  { id: 'b', name: 'alpha', v: null },
  { id: 'c', name: 'Charlie', v: 10 },
  { id: 'd', name: 'delta', v: -1 },
];

const keys = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('tbody tr[data-key]')].map((tr) => tr.dataset.key);
const clickHeader = (el: HTMLElement, key: string) =>
  el.querySelector<HTMLButtonElement>(`button[data-sort="${key}"]`)!.click();

afterEach(() => {
  setLang('tr');
  document.body.innerHTML = '';
});

describe('sortRows', () => {
  it('puts nulls last in both directions', () => {
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.id)).toEqual(['d', 'a', 'c', 'b']);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.id)).toEqual(['c', 'a', 'd', 'b']);
    expect(sortRows([{ v: NaN }, { v: 1 }], (r) => r.v, 'asc').map((r) => r.v)).toEqual([1, NaN]);
  });
  it('sorts strings case-insensitively', () => {
    expect(sortRows(rows, (r) => r.name, 'asc').map((r) => r.id)).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('createTable', () => {
  it('renders, sorts on header click with desc first for numbers, toggles, aria-sort', () => {
    const onSortChange = vi.fn();
    const tb = createTable<R>({ columns: cols, rowKey: (r) => r.id, onSortChange });
    document.body.append(tb.el);
    tb.setRows(rows);
    expect(tb.el.querySelector('.tbl-wrap > table')).not.toBeNull();
    expect(keys(tb.el)).toEqual(['a', 'b', 'c', 'd']);

    clickHeader(tb.el, 'v');
    expect(tb.getSort()).toEqual({ key: 'v', dir: 'desc' });
    expect(keys(tb.el)).toEqual(['c', 'a', 'd', 'b']);
    const th = tb.el.querySelector<HTMLElement>('button[data-sort="v"]')!.closest('th')!;
    expect(th.getAttribute('aria-sort')).toBe('descending');
    expect(th.textContent).toContain('▼');
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'v', dir: 'desc' });

    clickHeader(tb.el, 'v');
    expect(tb.getSort()).toEqual({ key: 'v', dir: 'asc' });
    expect(keys(tb.el)).toEqual(['d', 'a', 'c', 'b']);
    expect(tb.el.querySelector('button[data-sort="v"]')!.closest('th')!.getAttribute('aria-sort')).toBe('ascending');

    clickHeader(tb.el, 'name');
    expect(tb.getSort()).toEqual({ key: 'name', dir: 'asc' });
    expect(keys(tb.el)).toEqual(['b', 'a', 'c', 'd']);
    expect(tb.el.querySelector('button[data-sort="v"]')!.closest('th')!.getAttribute('aria-sort')).toBe('none');
  });

  it('applies initial sort and right-aligned num class', () => {
    const tb = createTable<R>({ columns: cols, rowKey: (r) => r.id, sort: { key: 'v', dir: 'desc' } });
    tb.setRows(rows);
    expect(keys(tb.el)).toEqual(['c', 'a', 'd', 'b']);
    expect(tb.el.querySelector('tbody tr td:nth-child(2)')!.classList.contains('num')).toBe(true);
    expect(tb.el.querySelector('tbody tr[data-key="b"] td:nth-child(2)')!.textContent).toBe('—');
  });

  it('caps at maxRows and shows "N of M" footer, translated on refresh', () => {
    const many: R[] = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, name: `n${i}`, v: i }));
    const tb = createTable<R>({ columns: cols, rowKey: (r) => r.id, maxRows: 10, sort: { key: 'v', dir: 'desc' } });
    tb.setRows(many);
    expect(keys(tb.el)).toHaveLength(10);
    expect(keys(tb.el)[0]).toBe('r24');
    const foot = tb.el.querySelector<HTMLElement>('.tbl-foot')!;
    expect(foot.hidden).toBe(false);
    expect(foot.textContent).toBe('25 satırın 10 tanesi gösteriliyor');
    setLang('en');
    tb.refresh();
    expect(foot.textContent).toBe('Showing 10 of 25 rows');
    tb.setRows(many.slice(0, 5));
    expect(foot.hidden).toBe(true);
  });

  it('shows empty text', () => {
    const tb = createTable<R>({ columns: cols, rowKey: (r) => r.id, emptyText: () => 'Nothing <here>' });
    tb.setRows([]);
    const td = tb.el.querySelector('td.empty')!;
    expect(td.textContent).toBe('Nothing <here>');
    expect(td.getAttribute('colspan')).toBe('2');
  });

  it('expand toggles a detail row that persists across setRows', () => {
    const tb = createTable<R>({ columns: cols, rowKey: (r) => r.id, expand: (r) => `<div class="x">detail ${esc(r.name)}</div>` });
    document.body.append(tb.el);
    tb.setRows(rows);
    const rowA = () => tb.el.querySelector<HTMLElement>('tr[data-key="a"]')!;
    rowA().querySelector('td')!.click();
    expect(rowA().classList.contains('open')).toBe(true);
    expect(rowA().getAttribute('aria-expanded')).toBe('true');
    const det = rowA().nextElementSibling as HTMLElement;
    expect(det.classList.contains('detail')).toBe(true);
    expect(det.hasAttribute('data-key')).toBe(false);
    expect(det.textContent).toBe('detail Bravo');
    expect(keys(tb.el)).toEqual(['a', 'b', 'c', 'd']);

    tb.setRows([...rows, { id: 'e', name: 'Echo', v: 1 }]);
    expect(rowA().classList.contains('open')).toBe(true);
    expect(tb.el.querySelectorAll('tr.detail')).toHaveLength(1);

    rowA().click();
    expect(rowA().classList.contains('open')).toBe(false);
    expect(tb.el.querySelectorAll('tr.detail')).toHaveLength(0);
    tb.setRows(rows);
    expect(tb.el.querySelectorAll('tr.detail')).toHaveLength(0);
  });

  it('calls onRowClick with the row, ignoring clicks on links inside', () => {
    const onRowClick = vi.fn();
    const linkCols: Column<R>[] = [...cols, { key: 'l', label: () => 'L', get: () => null, html: () => '<a href="#x">x</a>', sortable: false }];
    const tb = createTable<R>({ columns: linkCols, rowKey: (r) => r.id, onRowClick });
    document.body.append(tb.el);
    tb.setRows(rows);
    tb.el.querySelector<HTMLElement>('tr[data-key="c"] td')!.click();
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0]![0]).toBe(rows[2]);
    tb.el.querySelector<HTMLElement>('tr[data-key="c"] a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(tb.el.querySelector('table')!.classList.contains('tbl-clickable')).toBe(true);
    expect(tb.el.querySelectorAll('th button[data-sort]')).toHaveLength(2);
  });

  it('escapes default cells, labels and keys', () => {
    const evil: R[] = [{ id: 'x"><img src=x onerror=alert(1)>', name: '<script>alert(1)</script>', v: 1 }];
    const tb = createTable<R>({
      columns: [{ key: 'name', label: () => '<b>Name</b>', get: (r) => r.name, title: () => '"quoted"' }],
      rowKey: (r) => r.id,
    });
    tb.setRows(evil);
    expect(tb.el.querySelector('script')).toBeNull();
    expect(tb.el.querySelector('img')).toBeNull();
    expect(tb.el.querySelector('tbody td')!.textContent).toBe('<script>alert(1)</script>');
    expect(tb.el.querySelector('th')!.textContent).toContain('<b>Name</b>');
    expect(tb.el.querySelector('th')!.getAttribute('title')).toBe('"quoted"');
    expect(tb.el.querySelector<HTMLElement>('tbody tr')!.dataset.key).toBe(evil[0]!.id);
  });
});

describe('esc', () => {
  it('escapes all five characters', () => {
    expect(esc(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(esc(null)).toBe('');
    expect(esc(5)).toBe('5');
  });
});
