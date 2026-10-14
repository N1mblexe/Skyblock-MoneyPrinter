import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AH_DB_NAME, createAhStore, loadAh, saveAh } from '../../src/api/ahStore.ts';
import { HISTORY_DB_NAME } from '../../src/config.ts';
import type { AhSnapshot } from '../../src/types/contracts.ts';

let n = 0;
const newName = () => `ah-test-${++n}-${Math.random()}`;
const snap = (t: number): AhSnapshot => ({ fetchedAt: t, lastUpdated: t - 5, lowestBin: { HYPERION: { price: 5e8, count: 3 } } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ahStore', () => {
  it('uses its own database, never the history DB', () => {
    expect(AH_DB_NAME).toBe('bazaar-masasi-ah');
    expect(AH_DB_NAME).not.toBe(HISTORY_DB_NAME);
  });

  it('round-trips the latest snapshot through IndexedDB', async () => {
    const name = newName();
    const a = createAhStore(name);
    expect(await a.loadAh()).toBeNull();
    await a.saveAh(snap(1));
    await a.saveAh(snap(2));
    expect(a.persistent()).toBe(true);
    // a fresh store (new page load) reads it back from disk
    expect(await createAhStore(name).loadAh()).toEqual(snap(2));
  });

  it('ignores a malformed stored value', async () => {
    const name = newName();
    const a = createAhStore(name);
    await a.loadAh(); // creates the DB
    const db = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
    });
    await new Promise<void>((res) => {
      const tx = db.transaction('latest', 'readwrite');
      tx.objectStore('latest').put({ fetchedAt: 'x' }, 'snapshot');
      tx.oncomplete = () => res();
    });
    db.close();
    expect(await createAhStore(name).loadAh()).toBeNull();
    for (const bad of [null, { fetchedAt: 1, lastUpdated: 1, lowestBin: null }]) {
      const s = createAhStore(name);
      const d = await new Promise<IDBDatabase>((res) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
      });
      await new Promise<void>((res) => {
        const tx = d.transaction('latest', 'readwrite');
        tx.objectStore('latest').put(bad, 'snapshot');
        tx.oncomplete = () => res();
      });
      d.close();
      expect(await s.loadAh()).toBeNull();
    }
  });

  it('degrades to memory when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const s = createAhStore(newName());
    expect(await s.loadAh()).toBeNull();
    await s.saveAh(snap(3));
    expect(await s.loadAh()).toEqual(snap(3));
    expect(s.persistent()).toBe(false);
  });

  it('warns and falls back to memory when opening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('SecurityError');
      },
    });
    const s = createAhStore(newName());
    await s.saveAh(snap(4));
    expect(await s.loadAh()).toEqual(snap(4));
    expect(warn).toHaveBeenCalled();
  });

  it('keeps the snapshot in memory when a transaction fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = createAhStore(newName());
    await s.loadAh();
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new Error('closed');
    });
    await s.saveAh(snap(5));
    expect(await s.loadAh()).toEqual(snap(5));
    expect(warn).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('module-level saveAh/loadAh share one default store', async () => {
    await saveAh(snap(6));
    expect(await loadAh()).toEqual(snap(6));
  });
});
