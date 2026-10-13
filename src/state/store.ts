import type { Store } from '../types/contracts.ts';

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const subs = new Set<(s: S, prev: S) => void>();
  return {
    get: () => state,
    set(p) {
      const patch = typeof p === 'function' ? p(state) : p;
      const keys = Object.keys(patch) as (keyof S)[];
      if (!keys.some((k) => !Object.is(patch[k], state[k]))) return;
      const prev = state;
      state = { ...state, ...patch };
      for (const fn of [...subs]) fn(state, prev);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
