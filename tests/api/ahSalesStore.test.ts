import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AH_SALES_DB_NAME,
  createAhSalesStore,
  isSalesMeta,
  isSalesRecord,
  sharedAhSalesStore,
  type AhSalesMeta,
  type AhSalesRecord,
} from '../../src/api/ahSalesStore.ts';
import { AH_DB_NAME, HISTORY_DB_NAME } from '../../src/config.ts';

let n = 0;
const newName = () => `ahsales-test-${++n}-${Math.random()}`;
const rec = (id: string, p = 1): AhSalesRecord => ({ id, sales: [{ t: 1, p, q: 1 }], hours: [[0, 1, 1]] });
const meta = (u = 1): AhSalesMeta => ({ windows: [[0, 60_000]], recent: [['a', 1]], updates: [u] });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sortById = (rs: AhSalesRecord[]) => [...rs].sort((a, b) => a.id.localeCompare(b.id));

/** Write raw values into a store's object stores (bypassing validation). */
async function rawPut(name: string, ids: unknown[], metaValue: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((res) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => res(r.result);
  });
  await new Promise<void>((res) => {
    const tx = db.transaction(['ids', 'meta'], 'readwrite');
    for (const v of ids) tx.objectStore('ids').put(v);
    tx.objectStore('meta').put(metaValue, 'meta');
    tx.oncomplete = () => res();
  });
  db.close();
}

describe('ahSalesStore', () => {
  it('uses its own database', () => {
    expect(AH_SALES_DB_NAME).toBe('bazaar-masasi-ahsales');
    expect(AH_SALES_DB_NAME).not.toBe(HISTORY_DB_NAME);
    expect(AH_SALES_DB_NAME).not.toBe(AH_DB_NAME);
  });

  it('round-trips one record per id plus the meta, with puts and deletes in one save', async () => {
    const name = newName();
    const a = createAhSalesStore(name);
    expect(await a.load()).toEqual({ records: [], meta: null });
    await a.save([rec('A'), rec('B'), rec('LION;4@L49')], [], meta(1));
    await a.save([rec('A', 5)], ['B'], meta(2));
    expect(a.persistent()).toBe(true);
    const back = await createAhSalesStore(name).load();
    expect(sortById(back.records)).toEqual([rec('A', 5), rec('LION;4@L49')]);
    expect(back.meta).toEqual(meta(2));
  });

  it('clear empties both stores', async () => {
    const name = newName();
    const a = createAhSalesStore(name);
    await a.save([rec('A')], [], meta());
    await a.clear();
    expect(await a.load()).toEqual({ records: [], meta: null });
    expect(await createAhSalesStore(name).load()).toEqual({ records: [], meta: null });
  });

  it('drops malformed stored values', async () => {
    const name = newName();
    await createAhSalesStore(name).load(); // creates the DB
    await rawPut(name, [rec('OK'), { id: 'BAD', sales: 'x', hours: [] }, { id: 'BAD2', sales: [{ t: 1 }], hours: [] }, { id: 'BAD3', sales: [], hours: [[1, 2]] }], { windows: 'x' });
    const back = await createAhSalesStore(name).load();
    expect(back.records).toEqual([rec('OK')]);
    expect(back.meta).toBeNull();
  });

  it('isSalesRecord / isSalesMeta', () => {
    expect(isSalesRecord(rec('A'))).toBe(true);
    for (const bad of [null, 5, { id: 1, sales: [], hours: [] }, { id: 'A', sales: [null], hours: [] }, { id: 'A', sales: [], hours: 'x' }, { id: 'A', sales: [], hours: [[1, 2, 'x']] }])
      expect(isSalesRecord(bad)).toBe(false);
    expect(isSalesMeta(meta())).toBe(true);
    expect(isSalesMeta({ windows: [], recent: [], updates: [] })).toBe(true);
    for (const bad of [
      null,
      'x',
      { windows: [[1]], recent: [], updates: [] },
      { windows: [], recent: [[1, 1]], updates: [] },
      { windows: [], recent: ['a'], updates: [] },
      { windows: [], recent: [], updates: ['1'] },
      { windows: [], recent: [], updates: null },
      { windows: [], recent: null, updates: [] },
    ])
      expect(isSalesMeta(bad)).toBe(false);
  });

  it('degrades to memory when IndexedDB is unavailable (copies, not live objects)', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const s = createAhSalesStore(newName());
    expect(await s.load()).toEqual({ records: [], meta: null });
    const r = rec('A');
    await s.save([r, rec('B')], [], meta());
    r.sales.push({ t: 2, p: 2, q: 2 });
    await s.save([], ['B'], meta(3));
    expect(await s.load()).toEqual({ records: [rec('A')], meta: meta(3) });
    expect(s.persistent()).toBe(false);
    await s.clear();
    expect(await s.load()).toEqual({ records: [], meta: null });
  });

  it('warns and falls back to memory when opening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('SecurityError');
      },
    });
    const s = createAhSalesStore(newName());
    await s.save([rec('A')], [], meta());
    expect(await s.load()).toEqual({ records: [rec('A')], meta: meta() });
    expect(warn).toHaveBeenCalled();
    expect(s.persistent()).toBe(false);
  });

  it('keeps data in memory when transactions fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = createAhSalesStore(newName());
    await s.load();
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new Error('closed');
    });
    await s.save([rec('A')], [], meta());
    expect(await s.load()).toEqual({ records: [rec('A')], meta: meta() });
    await s.clear();
    expect(warn).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('sharedAhSalesStore is one app-wide instance', () => {
    expect(sharedAhSalesStore()).toBe(sharedAhSalesStore());
  });
});
