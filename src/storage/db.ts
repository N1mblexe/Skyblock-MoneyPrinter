import { LocalizedError } from '../i18n/errors.ts';

const toError = (e: unknown, fallback: LocalizedError): Error => (e instanceof Error ? e : e ? new Error(String(e)) : fallback);

/** Open an IndexedDB database, running `upgrade` on version change. */
export function openDb(name: string, version: number, upgrade: (db: IDBDatabase, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') throw new LocalizedError('err.idbUnavailable');
      req = indexedDB.open(name, version);
    } catch (e) {
      reject(toError(e, new LocalizedError('err.idbOpen', { name })));
      return;
    }
    req.onupgradeneeded = (ev) => {
      try {
        upgrade(req.result, ev.oldVersion);
      } catch (e) {
        req.transaction?.abort();
        reject(toError(e, new LocalizedError('err.idbUpgrade')));
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab wants a newer schema: get out of its way.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(toError(req.error, new LocalizedError('err.idbOpen', { name })));
    req.onblocked = () => reject(new LocalizedError('err.idbBlocked', { name }));
  });
}

/** Promisify an IDBRequest. */
export function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(toError(req.error, new LocalizedError('err.idbRequest')));
  });
}

/** Resolve when a transaction completes, reject on error/abort. */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(toError(tx.error, new LocalizedError('err.idbTx')));
    tx.onabort = () => reject(toError(tx.error, new LocalizedError('err.idbTxAbort')));
  });
}
