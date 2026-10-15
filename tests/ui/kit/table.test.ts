// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '../../../src/i18n/index.ts';
import { LS_COLUMNS, UI } from '../../../src/config.ts';
import { createKitTable, cssRowHeight, type KitColumn, type KitTableOptions } from '../../../src/ui/kit/index.ts';

interface R {
  id: string;
  name: string;
  v: number | null;
}

const cols: KitColumn<R>[] = [
  { key: 'name', label: () => 'Name', get: (r) => r.name, priority: 0 },
  { key: 'v', label: () => 'Value', get: (r) => r.v, align: 'right', priority: 1 },
  { key: 'x', label: () => 'Extra', get: (r) => `x${r.id}`, priority: 3, defaultHidden: false },
];
const make = (n: number): R[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `Item ${i}`, v: i }));

function mount<T = R>(o: Partial<KitTableOptions<R>> & { rows?: R[] } = {}) {
  const { rows = make(5), ...rest } = o;
  const tb = createKitTable<R>({ columns: cols, rowKey: (r) => r.id, layout: 'table', ...rest });
  document.body.append(tb.el);
  tb.setRows(rows);
  return tb as unknown as ReturnType<typeof createKitTable<T>>;
}

const wrapOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.tbl-wrap')!;
const dataRows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-key]')];
const tabbable = (el: HTMLElement) => dataRows(el).filter((r) => r.getAttribute('tabindex') === '0');
const key = (target: HTMLElement, k: string, extra: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
const active = () => (document.activeElement as HTMLElement | null)?.dataset.key;

/** Mock layout metrics of the scroll container (happy-dom has no layout). */
function fakeViewport(wrap: HTMLElement, height: number) {
  let top = 0;
  Object.defineProperty(wrap, 'clientHeight', { configurable: true, get: () => height });
  Object.defineProperty(wrap, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  return {
    scroll(to: number) {
      top = to;
      wrap.dispatchEvent(new Event('scroll'));
    },
    get top() {
      return top;
    },
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  setLang('tr');
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-density');
  vi.restoreAllMocks();
});

describe('virtualization', () => {
  it('renders only visible + 2*overscan rows of 5,000 and follows the scroll position', () => {
    const tb = createKitTable<R>({ columns: cols, rowKey: (r) => r.id, layout: 'table', rowHeight: 30, onActivate: () => {} });
    document.body.append(tb.el);
    const vp = fakeViewport(wrapOf(tb.el), 300); // 10 visible rows
    tb.setRows(make(5000));
    const max = 10 + 2 * UI.overscan;
    expect(tb.el.classList.contains('tbl-virtual')).toBe(true);
    expect(dataRows(tb.el).length).toBeLessThanOrEqual(max);
    expect(dataRows(tb.el)[0]!.dataset.key).toBe('r0');
    expect(tb.el.querySelector('table')!.getAttribute('aria-rowcount')).toBe('5001');
    // spacer keeps the full scroll height
    const pads = tb.el.querySelectorAll<HTMLElement>('tr.vpad td');
    expect(pads).toHaveLength(1);
    expect(pads[0]!.style.height).toBe(`${(5000 - (10 + UI.overscan)) * 30}px`);

    vp.scroll(30 * 2500);
    const keys = dataRows(tb.el).map((r) => r.dataset.key);
    expect(keys.length).toBeLessThanOrEqual(max);
    expect(keys).toContain('r2500');
    expect(keys[0]).toBe(`r${2500 - UI.overscan}`);
    expect(dataRows(tb.el)[0]!.getAttribute('aria-rowindex')).toBe(String(2500 - UI.overscan + 2));
    expect(tb.el.querySelectorAll('tr.vpad')).toHaveLength(2);
    expect(tabbable(tb.el)).toHaveLength(1);

    // setRows keeps the window instead of rebuilding everything
    tb.setRows(make(5000).reverse());
    expect(dataRows(tb.el).length).toBeLessThanOrEqual(max);
    // the CSV still covers all rows
    expect(tb.toCsv().trim().split('\r\n')).toHaveLength(5001);
    // scrolling past the end clamps to the last window
    vp.scroll(30 * 10_000);
    expect(dataRows(tb.el).at(-1)!.dataset.key).toBe('r0');
  });

  it('does not virtualize small tables, with expand, or when disabled; caps legacy rows at maxRows', () => {
    const small = mount({ rows: make(UI.virtualizeAbove) });
    expect(small.el.classList.contains('tbl-virtual')).toBe(false);
    const exp = mount({ rows: make(500), expand: () => 'd', maxRows: 50 });
    expect(exp.el.classList.contains('tbl-virtual')).toBe(false);
    expect(dataRows(exp.el)).toHaveLength(50);
    const off = mount({ rows: make(400), virtualize: false });
    expect(dataRows(off.el)).toHaveLength(300);
    expect(off.el.querySelector('.tbl-foot')!.textContent).toBe('400 satırın 300 tanesi gösteriliyor');
    const forced = mount({ rows: make(20), virtualize: true, rowHeight: 20 });
    expect(forced.el.classList.contains('tbl-virtual')).toBe(true);
  });

  it('row height comes from --row-h / density when not given', () => {
    expect(cssRowHeight()).toBe(UI.rowH);
    document.documentElement.dataset.density = 'compact';
    expect(cssRowHeight()).toBe(UI.rowHCompact);
    document.documentElement.style.setProperty('--row-h', '40px');
    expect(cssRowHeight()).toBe(40);
    document.documentElement.style.removeProperty('--row-h');
    const tb = mount({ rows: make(300) });
    expect(tb.el.style.getPropertyValue('--kit-row-h')).toBe(`${UI.rowHCompact}px`);
  });

  it('sorting from the header resets the scroll and announces via onSortChange', () => {
    const onSortChange = vi.fn();
    const tb = createKitTable<R>({ columns: cols, rowKey: (r) => r.id, layout: 'table', rowHeight: 30, onSortChange });
    document.body.append(tb.el);
    const vp = fakeViewport(wrapOf(tb.el), 300);
    tb.setRows(make(1000));
    vp.scroll(9000);
    tb.el.querySelector<HTMLButtonElement>('button[data-sort="v"]')!.click();
    expect(vp.top).toBe(0);
    expect(onSortChange).toHaveBeenCalledWith({ key: 'v', dir: 'desc' });
    expect(dataRows(tb.el)[0]!.dataset.key).toBe('r999');
    expect(tb.el.querySelector('th[aria-sort="descending"]')).not.toBeNull();
  });
});

describe('roving tabindex and keyboard', () => {
  it('exactly one tabbable row; arrows, j/k, Home/End move focus; Enter activates', () => {
    const onActivate = vi.fn();
    const tb = mount({ rows: make(6), onActivate, rowActions: () => '<button type="button" data-action="star">*</button>' });
    expect(tabbable(tb.el).map((r) => r.dataset.key)).toEqual(['r0']);
    // inner buttons of non-tabbable rows leave the tab order
    expect(tb.el.querySelector('[data-key="r1"] button')!.getAttribute('tabindex')).toBe('-1');
    expect(tb.el.querySelector('[data-key="r0"] button')!.hasAttribute('tabindex')).toBe(false);

    const r0 = dataRows(tb.el)[0]!;
    r0.focus();
    key(r0, 'ArrowDown');
    expect(active()).toBe('r1');
    expect(tabbable(tb.el).map((r) => r.dataset.key)).toEqual(['r1']);
    expect(tb.el.querySelector('[data-key="r0"] button')!.getAttribute('tabindex')).toBe('-1');
    expect(tb.el.querySelector('[data-key="r1"] button')!.hasAttribute('tabindex')).toBe(false);
    key(document.activeElement as HTMLElement, 'j');
    expect(active()).toBe('r2');
    key(document.activeElement as HTMLElement, 'k');
    key(document.activeElement as HTMLElement, 'ArrowUp');
    expect(active()).toBe('r0');
    key(document.activeElement as HTMLElement, 'ArrowUp');
    expect(active()).toBe('r0');
    key(document.activeElement as HTMLElement, 'End');
    expect(active()).toBe('r5');
    key(document.activeElement as HTMLElement, 'PageUp');
    expect(active()).toBe('r0');
    key(document.activeElement as HTMLElement, 'PageDown');
    key(document.activeElement as HTMLElement, 'Home');
    expect(active()).toBe('r0');
    key(document.activeElement as HTMLElement, 'ArrowDown', { ctrlKey: true });
    expect(active()).toBe('r0');
    key(document.activeElement as HTMLElement, 'Enter');
    expect(onActivate).toHaveBeenCalledWith(make(6)[0]);
    expect(tabbable(tb.el)).toHaveLength(1);
    // the tab stop survives setRows
    key(document.activeElement as HTMLElement, 'ArrowDown');
    tb.setRows(make(6));
    expect(tabbable(tb.el).map((r) => r.dataset.key)).toEqual(['r1']);
    expect(active()).toBe('r1');
  });

  it('keyboard moves through a virtual window, scrolling it', () => {
    const tb = createKitTable<R>({ columns: cols, rowKey: (r) => r.id, layout: 'table', rowHeight: 30, onActivate: () => {} });
    document.body.append(tb.el);
    const vp = fakeViewport(wrapOf(tb.el), 300);
    tb.setRows(make(2000));
    const first = dataRows(tb.el)[0]!;
    first.focus();
    key(first, 'End');
    expect(active()).toBe('r1999');
    expect(vp.top).toBeGreaterThan(30 * 1980);
    expect(tabbable(tb.el).map((r) => r.dataset.key)).toEqual(['r1999']);
    key(document.activeElement as HTMLElement, 'Home');
    expect(active()).toBe('r0');
    expect(vp.top).toBe(0);
    // focus row scrolled away by the mouse: first rendered row becomes the tab stop
    vp.scroll(30 * 1000);
    expect(tabbable(tb.el)).toHaveLength(1);
    tb.scrollToKey('r1500');
    expect(dataRows(tb.el).some((r) => r.dataset.key === 'r1500')).toBe(true);
  });

  it('Space toggles expand, Enter/click without onActivate fall back to expand / onRowClick', () => {
    const tb = mount({ rows: make(3), expand: (r) => `<p>detail ${r.id}</p>` });
    const r1 = tb.el.querySelector<HTMLElement>('[data-key="r1"]')!;
    r1.focus();
    key(r1, ' ');
    expect(r1.getAttribute('aria-expanded')).toBe('true');
    expect(r1.nextElementSibling!.textContent).toBe('detail r1');
    key(r1, 'Enter');
    expect(r1.getAttribute('aria-expanded')).toBe('false');

    const onRowClick = vi.fn();
    const t2 = mount({ rows: make(3), onRowClick });
    const row = t2.el.querySelector<HTMLElement>('[data-key="r2"]')!;
    key(row, ' ');
    key(row, 'Enter');
    expect(onRowClick).toHaveBeenCalledTimes(2);

    // non-interactive tables: no row tab stops, the scroll region is focusable instead
    const plain = mount({ rows: make(3) });
    expect(tabbable(plain.el)).toHaveLength(0);
    expect(wrapOf(plain.el).tabIndex).toBe(0);
    key(dataRows(plain.el)[0]!, 'Enter');
  });

  it('row actions go to onRowAction without activating the row', () => {
    const onActivate = vi.fn();
    const onRowAction = vi.fn();
    const tb = mount({
      rows: make(3),
      onActivate,
      onRowAction,
      rowActions: (r) => `<button type="button" data-action="watch">★</button><a href="#/item/${r.id}">i</a>`,
    });
    tb.el.querySelector<HTMLElement>('[data-key="r2"] [data-action="watch"]')!.click();
    expect(onRowAction).toHaveBeenCalledWith('watch', make(3)[2]);
    expect(onActivate).not.toHaveBeenCalled();
    tb.el.querySelector<HTMLElement>('[data-key="r2"] a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onActivate).not.toHaveBeenCalled();
    tb.el.querySelector<HTMLElement>('[data-key="r2"] td')!.click();
    expect(onActivate).toHaveBeenCalledWith(make(3)[2]);
    expect(tb.el.querySelector('th.row-actions')!.textContent).toBe('İşlemler');
  });

  it('selectedKey highlights with aria-selected and setSelected moves it', () => {
    const tb = mount({ rows: make(4), selectedKey: 'r1', onActivate: () => {} });
    const sel = () => [...tb.el.querySelectorAll<HTMLElement>('[aria-selected="true"]')].map((r) => r.dataset.key);
    expect(sel()).toEqual(['r1']);
    expect(tb.el.querySelector('[data-key="r1"]')!.classList.contains('sel')).toBe(true);
    tb.setSelected('r3');
    expect(sel()).toEqual(['r3']);
    tb.setSelected(null);
    expect(sel()).toEqual([]);
    tb.setSelected(null);
    tb.setSelected('missing');
    expect(sel()).toEqual([]);
  });
});

describe('toolbar', () => {
  it('column chooser hides columns and persists them under LS_COLUMNS + columnsKey', () => {
    const tb = mount({ columnsKey: 'test', toolbar: { columns: true } });
    const btn = tb.el.querySelector<HTMLButtonElement>('[data-tool="columns"]')!;
    expect(btn.textContent).toBe('Sütunlar');
    btn.click();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const boxes = [...tb.el.querySelectorAll<HTMLInputElement>('.kit-pop input[data-col]')];
    // priority-0 column is not hideable
    expect(boxes.map((b) => b.dataset.col)).toEqual(['v', 'x']);
    boxes[0]!.checked = false;
    boxes[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(tb.getHiddenColumns()).toEqual(['v']);
    expect(JSON.parse(localStorage.getItem(LS_COLUMNS + 'test')!)).toEqual(['v']);
    expect([...tb.el.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Name', 'Extra']);
    expect(tb.toCsv().split('\r\n')[0]).toBe('Name,Extra');

    // a new table with the same key restores it
    const again = mount({ columnsKey: 'test', toolbar: { columns: true } });
    expect(again.getHiddenColumns()).toEqual(['v']);
    again.setHiddenColumns(['x', 'name', 'nope']);
    expect(again.getHiddenColumns()).toEqual(['x']);
    // "show all" link
    again.el.querySelector<HTMLButtonElement>('[data-tool="columns"]')!.click();
    again.el.querySelector<HTMLElement>('[data-cols-all]')!.click();
    expect(again.getHiddenColumns()).toEqual([]);
    // Escape closes and refocuses the button; outside click closes too
    const pop = again.el.querySelector<HTMLElement>('.kit-pop')!;
    key(pop.querySelector('input')!, 'Escape');
    expect(pop.hidden).toBe(true);
    again.el.querySelector<HTMLButtonElement>('[data-tool="columns"]')!.click();
    expect(pop.hidden).toBe(false);
    document.body.click();
    expect(pop.hidden).toBe(true);
  });

  it('defaultHidden applies without a stored value; never hides every column', () => {
    const c2: KitColumn<R>[] = [
      { key: 'a', label: () => 'A', get: (r) => r.id, hideable: true },
      { key: 'b', label: () => 'B', get: (r) => r.v, defaultHidden: true },
    ];
    const tb = createKitTable<R>({ columns: c2, rowKey: (r) => r.id, layout: 'table' });
    expect(tb.getHiddenColumns()).toEqual(['b']);
    tb.setHiddenColumns(['a', 'b']);
    expect(tb.getHiddenColumns()).toEqual(['b']);
  });

  it('CSV export button downloads a timestamped file; reset and extra slot', () => {
    const onReset = vi.fn();
    const extra = document.createElement('span');
    extra.textContent = 'count';
    const created: Blob[] = [];
    const createURL = vi.fn((b: Blob) => {
      created.push(b);
      return 'blob:x';
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createURL, revokeObjectURL: vi.fn() }));
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    const tb = mount({ toolbar: { exportName: 'flips', onReset, extra } });
    expect(tb.el.querySelector('.tbl-tools-extra')!.textContent).toBe('count');
    const csv = tb.el.querySelector<HTMLButtonElement>('[data-tool="csv"]')!;
    expect(csv.textContent).toBe('CSV indir');
    csv.click();
    expect(downloaded).toMatch(/^flips-\d{8}-\d{4}\.csv$/);
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe('text/csv;charset=utf-8');
    tb.el.querySelector<HTMLButtonElement>('[data-tool="reset"]')!.click();
    expect(onReset).toHaveBeenCalledTimes(1);
    setLang('en');
    tb.refresh();
    expect(csv.textContent).toBe('Download CSV');
    expect(tb.el.querySelector('[data-tool="reset"]')!.textContent).toBe('Reset filters');
    vi.unstubAllGlobals();
  });

  it('toCsv uses csv ?? get, skips csv:false columns, sorted rows', () => {
    const c2: KitColumn<R>[] = [
      { key: 'name', label: () => 'Name, full', get: (r) => r.name, csv: (r) => `${r.name} "q"` },
      { key: 'v', label: () => 'V', get: (r) => r.v },
      { key: 'act', label: () => 'Act', get: () => null, csv: false },
    ];
    const tb = createKitTable<R>({ columns: c2, rowKey: (r) => r.id, sort: { key: 'v', dir: 'desc' }, layout: 'table' });
    tb.setRows([
      { id: 'a', name: 'A', v: 1.5 },
      { id: 'b', name: 'B', v: null },
      { id: 'c', name: 'C', v: 1234567.25 },
    ]);
    expect(tb.toCsv()).toBe('"Name, full",V\r\n"C ""q""",1234567.25\r\n"A ""q""",1.5\r\n"B ""q""",\r\n');
  });
});

describe('card layout', () => {
  it('renders cards: priority 0 title, 1-2 as label/value, 3 hidden; paged with load more', () => {
    const onActivate = vi.fn();
    const tb = mount({ layout: 'cards', rows: make(UI.cardPage + 10), onActivate, rowActions: () => '<button data-action="w">w</button>' });
    expect(tb.el.dataset.layout).toBe('cards');
    expect(tb.el.querySelector('table')).toBeNull();
    const cards = tb.el.querySelectorAll<HTMLElement>('li.kcard');
    expect(cards).toHaveLength(UI.cardPage);
    const c0 = cards[0]!;
    expect(c0.querySelector('.kcard-title')!.textContent).toBe('Item 0');
    expect([...c0.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Value']);
    expect(c0.querySelector('dd')!.textContent).toBe('0');
    expect(c0.querySelector('.kcard-kv > div')!.classList.contains('num')).toBe(true);
    expect(c0.querySelector('.kcard-actions button')).not.toBeNull();
    expect(tabbable(tb.el)).toHaveLength(1);

    const more = tb.el.querySelector<HTMLButtonElement>('.kcards-more')!;
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe('10 tane daha göster');
    expect(tb.el.querySelector('.tbl-foot')!.textContent).toBe(`${UI.cardPage + 10} satırın ${UI.cardPage} tanesi gösteriliyor`);
    more.click();
    expect(tb.el.querySelectorAll('li.kcard')).toHaveLength(UI.cardPage + 10);
    expect(more.hidden).toBe(true);
    expect(active()).toBe(`r${UI.cardPage}`);
    key(document.activeElement as HTMLElement, 'Enter');
    expect(onActivate).toHaveBeenCalledWith(make(UI.cardPage + 10)[UI.cardPage]);
    tb.el.querySelectorAll<HTMLElement>('li.kcard')[1]!.click();
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('keyboard End loads more cards; sort select re-sorts; expand shows inside the card', () => {
    const onSortChange = vi.fn();
    const tb = mount({ layout: 'cards', rows: make(UI.cardPage * 2 + 1), onSortChange, expand: (r) => `<b>d${r.id}</b>` });
    const first = tb.el.querySelector<HTMLElement>('li.kcard')!;
    first.focus();
    key(first, 'End');
    expect(active()).toBe(`r${UI.cardPage * 2}`);
    expect(tb.el.querySelectorAll('li.kcard')).toHaveLength(UI.cardPage * 2 + 1);
    const sel = tb.el.querySelector<HTMLSelectElement>('select[data-cards-sort]')!;
    expect(sel.options[0]!.textContent).toBe('—');
    sel.value = 'v.desc';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'v', dir: 'desc' });
    expect(tb.el.querySelector<HTMLElement>('li.kcard')!.dataset.key).toBe(`r${UI.cardPage * 2}`);
    const card = tb.el.querySelector<HTMLElement>('li.kcard')!;
    card.focus();
    key(card, ' ');
    const open = tb.el.querySelector<HTMLElement>('li.kcard')!;
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(open.querySelector('.kcard-detail')!.textContent).toBe(`dr${UI.cardPage * 2}`);
    open.querySelector<HTMLElement>('.kcard-detail b')!.click(); // clicks inside the detail don't toggle
    expect(tb.el.querySelector('li.kcard')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('empty cards show the empty text; layout auto follows matchMedia', () => {
    const listeners: (() => void)[] = [];
    const mq = { matches: true, addEventListener: (_: string, fn: () => void) => listeners.push(fn), removeEventListener: vi.fn() };
    vi.spyOn(window, 'matchMedia').mockReturnValue(mq as unknown as MediaQueryList);
    const tb = createKitTable<R>({ columns: cols, rowKey: (r) => r.id, emptyText: () => 'none here' });
    document.body.append(tb.el);
    tb.setRows([]);
    expect(tb.el.dataset.layout).toBe('cards');
    expect(tb.el.querySelector('li.empty')!.textContent).toBe('none here');
    mq.matches = false;
    listeners.forEach((fn) => fn());
    expect(tb.el.dataset.layout).toBe('table');
    expect(tb.el.querySelector('td.empty')!.textContent).toBe('none here');
    listeners.forEach((fn) => fn()); // no change -> no-op
    tb.destroy();
    expect(mq.removeEventListener).toHaveBeenCalled();
    expect(tb.el.isConnected).toBe(false);
  });
});

describe('handle', () => {
  it('setSort re-sorts without firing onSortChange; getSort copies', () => {
    const onSortChange = vi.fn();
    const tb = mount({ rows: make(4), onSortChange });
    tb.setSort({ key: 'v', dir: 'desc' });
    expect(dataRows(tb.el).map((r) => r.dataset.key)).toEqual(['r3', 'r2', 'r1', 'r0']);
    expect(onSortChange).not.toHaveBeenCalled();
    expect(tb.getSort()).toEqual({ key: 'v', dir: 'desc' });
    tb.el.querySelector<HTMLButtonElement>('button[data-sort="name"]')!.click();
    expect(tb.getSort()).toEqual({ key: 'name', dir: 'asc' });
    tb.setSort({ key: 'unknown', dir: 'asc' });
    expect(dataRows(tb.el)).toHaveLength(4);
  });

  it('column width and title render on headers; non-sortable headers have no button', () => {
    const c2: KitColumn<R>[] = [
      { key: 'name', label: () => 'N', get: (r) => r.name, width: '12ch', title: () => 'tip' },
      { key: 'v', label: () => 'V', get: (r) => r.v, sortable: false, cls: 'muted' },
    ];
    const tb = createKitTable<R>({ columns: c2, rowKey: (r) => r.id, layout: 'table' });
    tb.setRows(make(1));
    const ths = tb.el.querySelectorAll<HTMLElement>('th');
    expect(ths[0]!.style.width).toBe('12ch');
    expect(ths[0]!.title).toBe('tip');
    expect(ths[1]!.querySelector('button')).toBeNull();
    expect(tb.el.querySelector('td.muted')).not.toBeNull();
  });
});
