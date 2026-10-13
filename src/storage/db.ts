const toError = (e: unknown, fallback: string): Error =>
  e instanceof Error ? e : new Error(e ? String(e) : fallback);

/** Open an IndexedDB database, running `upgrade` on version change. */
export function openDb(name: string, version: number, upgrade: (db: IDBDatabase, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
      req = indexedDB.open(name, version);
    } catch (e) {
      reject(toError(e, 'IndexedDB open failed'));
      return;
    }
    req.onupgradeneeded = (ev) => {
      try {
        upgrade(req.result, ev.oldVersion);
      } catch (e) {
        req.transaction?.abort();
        reject(toError(e, 'IndexedDB upgrade failed'));
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab wants a newer schema: get out of its way.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(toError(req.error, `IndexedDB open failed: ${name}`));
    req.onblocked = () => reject(new Error(`IndexedDB open blocked: ${name}`));
  });
}

/** Promisify an IDBRequest. */
export function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(toError(req.error, 'IndexedDB request failed'));
  });
}

/** Resolve when a transaction completes, reject on error/abort. */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(toError(tx.error, 'IndexedDB transaction failed'));
    tx.onabort = () => reject(toError(tx.error, 'IndexedDB transaction aborted'));
  });
}
