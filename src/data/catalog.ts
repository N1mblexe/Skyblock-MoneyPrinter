import { CATALOG_URL } from '../config.ts';
import { deriveName } from '../domain/ids.ts';
import type { Catalog, CatalogFile, ItemInfo, Recipe } from '../types/contracts.ts';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Throw a descriptive Error unless `x` is a v1/v2 catalog file. */
export function validateCatalogFile(x: unknown): CatalogFile {
  if (!isObj(x)) throw new Error('Catalog is not a JSON object');
  if (x.v !== 1 && x.v !== 2) throw new Error(`Unsupported catalog version: ${JSON.stringify(x.v)} (expected 1 or 2)`);
  if (!isObj(x.items)) throw new Error('Catalog has no "items" object');
  if (!Array.isArray(x.recipes)) throw new Error('Catalog has no "recipes" array');
  return x as unknown as CatalogFile;
}

export async function loadCatalog(url: string = CATALOG_URL): Promise<Catalog> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Catalog request failed (${url}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status} (${url})`);
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(`Catalog is not valid JSON (${url}): ${e instanceof Error ? e.message : String(e)}`);
  }
  return catalogFromFile(validateCatalogFile(body));
}

function push(m: Map<string, Recipe[]>, k: string, r: Recipe): void {
  const a = m.get(k);
  if (a) a.push(r);
  else m.set(k, [r]);
}

/** Build runtime Catalog (ItemInfo map, Recipe[] with keys, byOutput/byInput indexes, name() with deriveName fallback). */
export function catalogFromFile(f: CatalogFile): Catalog {
  const items: Record<string, ItemInfo> = {};
  for (const [id, e] of Object.entries(f.items ?? {})) {
    if (!isObj(e)) continue;
    const info: ItemInfo = { id, name: typeof e.n === 'string' && e.n ? e.n : deriveName(id), bazaar: e.bz === 1 };
    if (typeof e.t === 'string' && e.t) info.tier = e.t;
    if (finNum(e.ns) && e.ns >= 0) info.npcSell = e.ns;
    if (posNum(e.nb)) info.npcBuy = e.nb;
    items[id] = info;
  }

  const recipes: Recipe[] = [];
  const byOutput = new Map<string, Recipe[]>();
  const byInput = new Map<string, Recipe[]>();
  (f.recipes ?? []).forEach((e, index) => {
    if (!isObj(e) || typeof e.o !== 'string' || !e.o || !Array.isArray(e.i)) return;
    const inputs: Recipe['inputs'] = [];
    for (const pair of e.i as unknown[]) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !posNum(pair[1])) continue;
      inputs.push({ id: pair[0], qty: pair[1] });
    }
    if (inputs.length === 0) return;
    const r: Recipe = {
      key: `${e.o}#${index}`,
      output: e.o,
      outCount: posNum(e.c) ? e.c : 1,
      inputs,
      kind: e.k === 'forge' ? 'forge' : 'craft',
    };
    if (posNum(e.d)) r.durationSec = e.d;
    if (typeof e.r === 'string' && e.r) r.req = e.r;
    recipes.push(r);
    push(byOutput, r.output, r);
    for (const id of new Set(inputs.map((x) => x.id))) push(byInput, id, r);
  });

  const meta: Catalog['meta'] = { generatedAt: typeof f.generatedAt === 'string' ? f.generatedAt : '' };
  if (f.neuCommit) meta.neuCommit = f.neuCommit;

  return {
    meta,
    items,
    recipes,
    byOutput,
    byInput,
    name: (id: string) => items[id]?.name || deriveName(id),
    // v2 fields: parsed by the catalog package (Wave 1)
    shops: [],
    bookRule: () => null,
  };
}
