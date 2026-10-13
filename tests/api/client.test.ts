import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBazaar } from '../../src/api/bazaarClient.ts';

const okBody = { success: true, lastUpdated: 1, products: {} };

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchBazaar', () => {
  it('returns the validated payload', async () => {
    const f = mockFetch(async () => new Response(JSON.stringify(okBody), { status: 200 }));
    await expect(fetchBazaar(undefined, 'http://x/bz', 1000)).resolves.toEqual(okBody);
    expect(f.mock.calls[0]![0]).toBe('http://x/bz');
  });

  it('non-2xx -> HTTP <status>', async () => {
    mockFetch(async () => new Response('nope', { status: 503 }));
    await expect(fetchBazaar(undefined, 'http://x', 1000)).rejects.toThrow('HTTP 503');
  });

  it('surfaces the Hypixel cause', async () => {
    mockFetch(async () => new Response(JSON.stringify({ success: false, cause: 'Invalid API key' }), { status: 200 }));
    await expect(fetchBazaar(undefined, 'http://x', 1000)).rejects.toThrow('Invalid API key');
  });

  it('invalid JSON -> descriptive error', async () => {
    mockFetch(async () => new Response('<html>', { status: 200 }));
    await expect(fetchBazaar(undefined, 'http://x', 1000)).rejects.toThrow(/not valid JSON/);
  });

  it('timeout covers a slow body', async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    mockFetch(async (_u, init) => {
      const res = new Response('{}', { status: 200 });
      // headers arrive immediately, the body never does (until abort)
      Object.defineProperty(res, 'json', {
        value: () =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => {
              sawAbort = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      });
      return res;
    });
    const p = fetchBazaar(undefined, 'http://x', 5000);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(sawAbort).toBe(true);
  });

  it('timeout even when the body ignores the signal', async () => {
    vi.useFakeTimers();
    mockFetch(async () => {
      const res = new Response('{}', { status: 200 });
      Object.defineProperty(res, 'json', { value: () => new Promise(() => {}) });
      return res;
    });
    const p = fetchBazaar(undefined, 'http://x', 5000);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it('caller abort propagates', async () => {
    mockFetch((_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))));
    const ctl = new AbortController();
    const p = fetchBazaar(ctl.signal, 'http://x', 5000);
    ctl.abort(new Error('user abort'));
    await expect(p).rejects.toThrow('user abort');
  });

  it('network failure rejects', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchBazaar(undefined, 'http://x', 1000)).rejects.toThrow('Failed to fetch');
  });
});
