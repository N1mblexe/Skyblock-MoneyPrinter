// Realized AH sales per id, in their own IndexedDB database (AH_SALES_DB_NAME). Owner: s1/ahdata.
import { AH_SALES_DB_NAME } from '../config.ts';
import { openDb, reqP, txDone } from '../storage/db.ts';

export { AH_SALES_DB_NAME };
const DB_VERSION = 1;
const IDS = 'ids';
const META = 'meta';
const META_KEY = 'meta';

/** One sale: ms epoch, price per item, items (stack size). */
export interface AhSale {
  t: number;
  p: number;
  q: number;
}

/** The stored sales of one id (a base id like `HYPERION` / `ENDER_DRAGON;4`, or a pet band key like `LION;4@L49`). */
export interface AhSalesRecord {
  id: string;
  /** the newest AH_SALES.maxPrices sales, oldest first */
  sales: AhSale[];
  /** per hour with sales: [hour start (ms epoch), sales, items], oldest first */
  hours: [number, number, number][];
}

/** Feed state shared by every id. */
export interface AhSalesMeta {
  /** covered time: disjoint [start, end] ms ranges, oldest first (each response covers AH_SALES.windowSpanMs) */
  windows: [number, number][];
  /** auction ids of recent sales with their timestamp, for dedupe across responses */
  recent: [string, number][];
  /** the latest response lastUpdated values seen (CDN repeats are skipped) */
  updates: number[];
}

export interface AhSalesStore {
  load(): Promise<{ records: AhSalesRecord[]; meta: AhSalesMeta | null }>;
  /** write the changed records, delete `remove`, replace the meta record (one transaction) */
  save(put: readonly AhSalesRecord[], remove: readonly string[], meta: AhSalesMeta): Promise<void>;
  clear(): Promise<void>;
  /** true while sales go to IndexedDB, false once it fell back to memory */
  persistent(): boolean;
}

const isNumArray = (v: unknown, len: number): boolean => Array.isArray(v) && v.length === len && v.every((x) => typeof x === 'number');

export const isSalesRecord = (v: unknown): v is AhSalesRecord => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as AhSalesRecord;
  return (
    typeof r.id === 'string' &&
    Array.isArray(r.sales) &&
    r.sales.every((s) => typeof s === 'object' && s !== null && typeof s.t === 'number' && typeof s.p === 'number' && typeof s.q === 'number') &&
    Array.isArray(r.hours) &&
    r.hours.every((h) => isNumArray(h, 3))
  );
};

export const isSalesMeta = (v: unknown): v is AhSalesMeta => {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as AhSalesMeta;
  return (
    Array.isArray(m.windows) &&
    m.windows.every((w) => isNumArray(w, 2)) &&
    Array.isArray(m.recent) &&
    m.recent.every((r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'number') &&
    Array.isArray(m.updates) &&
    m.updates.every((u) => typeof u === 'number')
  );
};

/** Store backed by IndexedDB database `name`; degrades to memory when IndexedDB is unavailable or fails. */
export function createAhSalesStore(name: string = AH_SALES_DB_NAME): AhSalesStore {
  const mem = new Map<string, AhSalesRecord>();
  let memMeta: AhSalesMeta | null = null;
  let dbP: Promise<IDBDatabase | null> | null = null;
  let usingDb = true;

  function db(): Promise<IDBDatabase | null> {
    dbP ??= openDb(name, DB_VERSION, (d) => {
      if (!d.objectStoreNames.contains(IDS)) d.createObjectStore(IDS, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
    }).catch((e: unknown) => {
      if (typeof indexedDB !== 'undefined') console.warn('AH sales store: IndexedDB unavailable, using memory only', e);
      usingDb = false;
      return null;
    });
    return dbP;
  }

  const fromMem = () => ({ records: [...mem.values()].map((r) => structuredClone(r)), meta: memMeta && structuredClone(memMeta) });

  return {
    async load() {
      const d = await db();
      if (!d) return fromMem();
      try {
        const tx = d.transaction([IDS, META]);
        const [rows, meta] = await Promise.all([reqP(tx.objectStore(IDS).getAll()), reqP(tx.objectStore(META).get(META_KEY))]);
        return { records: (rows as unknown[]).filter(isSalesRecord), meta: isSalesMeta(meta) ? meta : null };
      } catch (e) {
        console.warn('AH sales store: load failed', e);
        return fromMem();
      }
    },
    async save(put, remove, meta) {
      for (const r of put) mem.set(r.id, structuredClone(r));
      for (const id of remove) mem.delete(id);
      memMeta = structuredClone(meta);
      const d = await db();
      if (!d) return;
      try {
        const tx = d.transaction([IDS, META], 'readwrite');
        const ids = tx.objectStore(IDS);
        for (const r of put) ids.put(r);
        for (const id of remove) ids.delete(id);
        tx.objectStore(META).put(meta, META_KEY);
        await txDone(tx);
      } catch (e) {
        console.warn('AH sales store: save failed, kept in memory', e);
      }
    },
    async clear() {
      mem.clear();
      memMeta = null;
      const d = await db();
      if (!d) return;
      try {
        const tx = d.transaction([IDS, META], 'readwrite');
        tx.objectStore(IDS).clear();
        tx.objectStore(META).clear();
        await txDone(tx);
      } catch (e) {
        console.warn('AH sales store: clear failed', e);
      }
    },
    persistent: () => usingDb,
  };
}

let shared: AhSalesStore | null = null;
/** The app-wide store on AH_SALES_DB_NAME. */
export const sharedAhSalesStore = (): AhSalesStore => (shared ??= createAhSalesStore());
