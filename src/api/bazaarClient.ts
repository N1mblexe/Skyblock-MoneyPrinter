import { API_BAZAAR, FETCH_TIMEOUT_MS } from '../config.ts';
import type { RawBazaar } from '../types/api.ts';
import { validateRaw } from './normalize.ts';

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Bazaar request timed out after ${Math.round(ms / 100) / 10}s`);
    this.name = 'TimeoutError';
  }
}

/** Reject as soon as `signal` aborts, even if `p` never settles (covers body readers that ignore the signal). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Fetch the bazaar. Timeout (FETCH_TIMEOUT_MS) covers the whole request including body parsing.
 * Throws on network error, timeout, non-2xx, or invalid payload (validateRaw).
 * `signal` lets the caller abort as well (the caller's abort reason is rethrown as-is).
 */
export async function fetchBazaar(signal?: AbortSignal, url: string = API_BAZAAR, timeoutMs = FETCH_TIMEOUT_MS): Promise<RawBazaar> {
  const ctl = new AbortController();
  const timeoutErr = new TimeoutError(timeoutMs);
  const timer = setTimeout(() => ctl.abort(timeoutErr), timeoutMs);
  const onCallerAbort = () => ctl.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    // 'no-cache' revalidates with the CDN instead of reusing the browser's max-age=60 copy.
    const res = await raceAbort(fetch(url, { signal: ctl.signal, cache: 'no-cache' }), ctl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await raceAbort(res.json() as Promise<unknown>, ctl.signal);
    } catch (e) {
      if (ctl.signal.aborted) throw e;
      throw new Error(`Bazaar response is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    return validateRaw(body);
  } catch (e) {
    if (ctl.signal.aborted && ctl.signal.reason === timeoutErr) throw timeoutErr;
    if (e instanceof Error) throw e;
    throw new Error(String(e));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}
