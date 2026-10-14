// Last AH lowest-BIN snapshot, in its own IndexedDB database (the history DB is never touched). Owner: market-apis package.
import { AH_DB_NAME } from '../config.ts';
import { openDb, reqP, txDone } from '../storage/db.ts';
import type { AhSnapshot } from '../types/contracts.ts';

export { AH_DB_NAME };
const DB_VERSION = 1;
const STORE = 'latest';
const KEY = 'snapshot';

export interface AhStore {
  saveAh(s: AhSnapshot): Promise<void>;
  loadAh(): Promise<AhSnapshot | null>;
  /** true while snapshots go to IndexedDB, false once it fell back to memory */
  persistent(): boolean;
}

const isSnapshot = (v: unknown): v is AhSnapshot =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as AhSnapshot).fetchedAt === 'number' &&
  typeof (v as AhSnapshot).lastUpdated === 'number' &&
  typeof (v as AhSnapshot).lowestBin === 'object' &&
  (v as AhSnapshot).lowestBin !== null;

/** Store backed by IndexedDB database `name`; degrades to memory when IndexedDB is unavailable or fails. */
export function createAhStore(name: string = AH_DB_NAME): AhStore {
  let mem: AhSnapshot | null = null;
  let dbP: Promise<IDBDatabase | null> | null = null;
  let usingDb = true;

  function db(): Promise<IDBDatabase | null> {
    dbP ??= openDb(name, DB_VERSION, (d) => {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    }).catch((e: unknown) => {
      if (typeof indexedDB !== 'undefined') console.warn('AH store: IndexedDB unavailable, using memory only', e);
      usingDb = false;
      return null;
    });
    return dbP;
  }

  return {
    async saveAh(s) {
      mem = s;
      const d = await db();
      if (!d) return;
      try {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(s, KEY);
        await txDone(tx);
      } catch (e) {
        console.warn('AH store: save failed, kept in memory', e);
      }
    },
    async loadAh() {
      const d = await db();
      if (!d) return mem;
      try {
        const v = await reqP(d.transaction(STORE).objectStore(STORE).get(KEY));
        return isSnapshot(v) ? v : mem;
      } catch (e) {
        console.warn('AH store: load failed', e);
        return mem;
      }
    },
    persistent: () => usingDb,
  };
}

let shared: AhStore | null = null;
const store = () => (shared ??= createAhStore());

/** Persist the last AH snapshot (memory-only when IndexedDB is unavailable). */
export function saveAh(s: AhSnapshot): Promise<void> {
  return store().saveAh(s);
}

/** Last persisted AH snapshot, or null. */
export function loadAh(): Promise<AhSnapshot | null> {
  return store().loadAh();
}
