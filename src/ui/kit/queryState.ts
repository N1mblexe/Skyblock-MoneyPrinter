// URL-backed view state (filters, sort). URL query wins over localStorage on mount; set() writes both.
import { lsGet, lsSet } from '../../storage/local.ts';
import type { Route } from '../../types/contracts.ts';
import type { QueryField, QuerySchema, QueryState, QueryValues, SetQueryFn, SortState } from './types.ts';

type Val = string | number | boolean | null | SortState;
type Enc = Record<string, string>;

/** URL token for an explicitly empty number field whose default is not null. */
const NONE = 'none';

/** Encode one value for the URL; undefined when it equals the default (kept out of the URL). */
export function encodeField(f: QueryField, v: Val): string | undefined {
  if (sameVal(f, v, f.def as Val)) return undefined;
  switch (f.kind) {
    case 'string':
    case 'enum':
      return v === '' ? undefined : String(v);
    case 'number':
      return v == null ? NONE : String(v);
    case 'bool':
      return v ? '1' : '0';
    case 'sort': {
      const s = v as SortState;
      return `${s.key}.${s.dir}`;
    }
  }
}

/** Parse one URL/localStorage string; invalid -> the field default. */
export function decodeField(f: QueryField, raw: string | undefined): Val {
  if (raw == null) return cloneDef(f);
  switch (f.kind) {
    case 'string':
      return raw;
    case 'number': {
      if (raw.trim() === '' || raw === NONE) return null;
      const n = Number(raw.replace(',', '.'));
      if (!Number.isFinite(n)) return f.def;
      if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) return f.def;
      return n;
    }
    case 'bool':
      return raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : f.def;
    case 'enum':
      return f.values.includes(raw) ? raw : f.def;
    case 'sort': {
      const m = /^(.+)\.(asc|desc)$/.exec(raw);
      if (!m || (f.keys && !f.keys.includes(m[1]!))) return cloneDef(f);
      return { key: m[1]!, dir: m[2] as SortState['dir'] };
    }
  }
}

function cloneDef(f: QueryField): Val {
  return f.kind === 'sort' ? { ...f.def } : (f.def as Val);
}

function sameVal(f: QueryField, a: Val, b: Val): boolean {
  if (f.kind === 'sort') {
    const x = a as SortState;
    const y = b as SortState;
    return x.key === y.key && x.dir === y.dir;
  }
  return a === b;
}

/**
 * Bind a view's state to the URL query (+ optional localStorage key).
 * Mount: if the route carries ANY schema key the URL is used alone (a shared link is reproduced exactly);
 * otherwise the last state from localStorage is restored and pushed to the URL.
 * Values equal to their default are left out of the URL (so string fields should default to '').
 * `activeCount()` ignores sort fields. URL writes from mount/fromRoute happen in a microtask.
 */
export function bindQueryState<S extends QuerySchema>(schema: S, route: Route, setQuery: SetQueryFn, lsKey?: string): QueryState<QueryValues<S>> {
  type V = QueryValues<S>;
  const fields = Object.entries(schema) as [string, QueryField][];
  const listeners = new Set<(v: V) => void>();
  const defaults = (): V => Object.fromEntries(fields.map(([k, f]) => [k, cloneDef(f)])) as V;
  const decodeAll = (src: Record<string, string | undefined>): V =>
    Object.fromEntries(fields.map(([k, f]) => [k, decodeField(f, src[k])])) as V;
  const hasAny = (q: Record<string, string> | undefined) => !!q && fields.some(([k]) => k in q);
  const encodeAll = (v: V): Record<string, string | undefined> =>
    Object.fromEntries(fields.map(([k, f]) => [k, encodeField(f, (v as Record<string, Val>)[k]!)]));

  let values: V;
  let pushUrl = false;
  if (hasAny(route.query)) values = decodeAll(route.query!);
  else {
    const stored = lsKey ? lsGet<unknown>(lsKey, null) : null;
    values = stored && typeof stored === 'object' && !Array.isArray(stored) ? decodeAll(stored as Enc) : defaults();
    pushUrl = true;
  }

  function persist(): void {
    if (!lsKey) return;
    const enc: Enc = {};
    for (const [k, v] of Object.entries(encodeAll(values))) if (v !== undefined) enc[k] = v;
    lsSet(lsKey, enc);
  }

  /** Replace values; returns the keys that changed. */
  function assign(next: V): string[] {
    const changed = fields.filter(([k, f]) => !sameVal(f, (values as Record<string, Val>)[k]!, (next as Record<string, Val>)[k]!)).map(([k]) => k);
    values = next;
    return changed;
  }

  function emit(): void {
    const snap = api.get();
    for (const fn of [...listeners]) fn(snap);
  }

  function pushAll(): void {
    const enc = encodeAll(values);
    if (Object.values(enc).some((v) => v !== undefined)) setQuery(enc);
  }

  const api: QueryState<V> = {
    get: () => {
      const out = { ...values } as Record<string, Val>;
      for (const [k, f] of fields) if (f.kind === 'sort') out[k] = { ...(out[k] as SortState) };
      return out as V;
    },
    set(patch) {
      const next = { ...values } as Record<string, Val>;
      for (const [k, v] of Object.entries(patch as Record<string, Val>)) {
        const f = schema[k];
        if (!f || v === undefined) continue;
        // validate through the codec so set() can't store what the URL couldn't
        next[k] = f.kind === 'string' ? String(v) : decodeField(f, encodeField(f, v) ?? undefined);
      }
      const changed = assign(next as V);
      if (!changed.length) return;
      const enc = encodeAll(values);
      setQuery(Object.fromEntries(changed.map((k) => [k, enc[k]])));
      persist();
      emit();
    },
    fromRoute(r) {
      if (!hasAny(r.query)) {
        // e.g. a nav link to the bare route: keep the current state, put it back in the URL
        queueMicrotask(pushAll);
        return;
      }
      if (assign(decodeAll(r.query!)).length) {
        persist();
        emit();
      }
    },
    reset() {
      const changed = assign(defaults());
      setQuery(Object.fromEntries(fields.map(([k]) => [k, undefined])));
      persist();
      if (changed.length) emit();
    },
    activeCount() {
      return fields.filter(([k, f]) => f.kind !== 'sort' && !sameVal(f, (values as Record<string, Val>)[k]!, cloneDef(f))).length;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  // deferred: the caller may call setQuery -> view.update -> fromRoute before this function has returned
  if (pushUrl) queueMicrotask(pushAll);
  return api;
}
