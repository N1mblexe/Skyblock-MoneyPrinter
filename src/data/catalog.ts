import { CATALOG_URL } from '../config.ts';
import { deriveName } from '../domain/ids.ts';
import { LocalizedError } from '../i18n/errors.ts';
import type { BookRule, Catalog, CatalogFile, ItemInfo, KatStep, PetLeveling, Recipe, ShopOffer } from '../types/contracts.ts';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const posInt = (v: unknown): v is number => posNum(v) && Number.isInteger(v);
const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const nonNeg = (v: unknown): v is number => finNum(v) && v >= 0;

/** Throw a descriptive Error unless `x` is a v1/v2 catalog file. */
export function validateCatalogFile(x: unknown): CatalogFile {
  if (!isObj(x)) throw new LocalizedError('err.catNotObject');
  if (x.v !== 1 && x.v !== 2) throw new LocalizedError('err.catVersion', { v: String(JSON.stringify(x.v)) });
  if (!isObj(x.items)) throw new LocalizedError('err.catNoItems');
  if (!Array.isArray(x.recipes)) throw new LocalizedError('err.catNoRecipes');
  return x as unknown as CatalogFile;
}

export async function loadCatalog(url: string = CATALOG_URL): Promise<Catalog> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new LocalizedError('err.catRequest', { url, detail: e instanceof Error ? e.message : String(e) });
  }
  if (!res.ok) throw new LocalizedError('err.catHttp', { status: res.status, url });
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new LocalizedError('err.catBadJson', { url, detail: e instanceof Error ? e.message : String(e) });
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
    if (str(e.c)) info.category = e.c;
    if (e.ah === 1) info.auctionable = true;
    const shard = parseShard(e.sh);
    if (shard) info.shard = shard;
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
      kind: e.k === 'forge' ? 'forge' : e.k === 'shop' ? 'shop' : 'craft',
    };
    if (r.kind === 'shop' && typeof e.s === 'string' && e.s) r.shop = e.s;
    if (posNum(e.d)) r.durationSec = e.d;
    if (typeof e.r === 'string' && e.r) r.req = e.r;
    recipes.push(r);
    push(byOutput, r.output, r);
    for (const id of new Set(inputs.map((x) => x.id))) push(byInput, id, r);
  });

  const meta: Catalog['meta'] = { generatedAt: typeof f.generatedAt === 'string' ? f.generatedAt : '' };
  if (f.neuCommit) meta.neuCommit = f.neuCommit;
  if (posNum(f.itemsApiUpdated)) meta.itemsApiUpdated = f.itemsApiUpdated;

  const books = parseBooks(f.books);

  return {
    meta,
    items,
    recipes,
    byOutput,
    byInput,
    name: (id: string) => items[id]?.name || deriveName(id),
    shops: parseShops(f.shops),
    bookRule: (base: string) => books.get(base) ?? null,
    kat: parseKat(f.kat),
    petLeveling: parsePetLeveling(f.petLeveling),
    petNames: parsePetNames(f.petNames),
    untradeable: new Set(Array.isArray(f.untradeable) ? f.untradeable.filter(str) : []),
    george: parseGeorge(f.george),
  };
}

/** George's pet prices: `TYPE;IDX` -> coins, positive numbers only. */
function parseGeorge(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(x)) return out;
  for (const [k, v] of Object.entries(x)) if (posNum(v)) out[k] = v;
  return out;
}

function parseShard(x: unknown): ItemInfo['shard'] | undefined {
  if (!isObj(x) || !str(x.r)) return undefined;
  const family = Array.isArray(x.f) ? x.f.filter(str) : [];
  const out: NonNullable<ItemInfo['shard']> = { rarity: x.r, family };
  if (str(x.a)) out.alignment = x.a;
  return out;
}

/** v2 `shops` -> ShopOffer[] (malformed entries dropped; v1 -> []). */
function parseShops(x: unknown): ShopOffer[] {
  if (!Array.isArray(x)) return [];
  const out: ShopOffer[] = [];
  for (const e of x as unknown[]) {
    if (!isObj(e) || !str(e.s) || !str(e.cur) || !str(e.o) || !posNum(e.cq) || !posNum(e.oq)) continue;
    out.push({ shop: e.s, currency: e.cur, costQty: e.cq, output: e.o, outQty: e.oq });
  }
  return out;
}

/** v2 `books` -> base -> BookRule: curated anvil max `m` (verified) wins over enchanting-table max `t` (unverified). */
function parseBooks(x: unknown): Map<string, BookRule> {
  const out = new Map<string, BookRule>();
  if (!isObj(x)) return out;
  for (const [base, r] of Object.entries(x)) {
    if (!isObj(r)) continue;
    if (posInt(r.m)) out.set(base, { maxLevel: r.m, verified: true });
    else if (posInt(r.t)) out.set(base, { maxLevel: r.t, verified: false });
  }
  return out;
}

/** `[[id, qty], ...]` -> {id, qty}[] (bad pairs dropped). */
function parsePairs(x: unknown): { id: string; qty: number }[] {
  if (!Array.isArray(x)) return [];
  const out: { id: string; qty: number }[] = [];
  for (const pair of x as unknown[]) if (Array.isArray(pair) && str(pair[0]) && posNum(pair[1])) out.push({ id: pair[0], qty: pair[1] });
  return out;
}

/** v2 `kat` ({p, f, t, c, s: seconds, i?: [[id, qty]]}[]) -> KatStep[] (malformed entries dropped; absent -> []). */
function parseKat(x: unknown): KatStep[] {
  if (!Array.isArray(x)) return [];
  const out: KatStep[] = [];
  for (const e of x as unknown[]) {
    if (!isObj(e) || !str(e.p) || !nonNegInt(e.f) || !nonNegInt(e.t) || e.t <= e.f || !nonNeg(e.c) || !nonNeg(e.s)) continue;
    if (e.i !== undefined && !Array.isArray(e.i)) continue;
    out.push({ pet: e.p, from: e.f, to: e.t, coins: e.c, hours: e.s / 3600, items: parsePairs(e.i) });
  }
  return out;
}

/** v2 `petLeveling` ({o: offsets, l: levels, c: {PET: {l?, a?, m?}}}) -> PetLeveling; null when absent or `l` is unusable. */
function parsePetLeveling(x: unknown): PetLeveling | null {
  if (!isObj(x) || !Array.isArray(x.l) || !x.l.length || !x.l.every(posNum)) return null;
  const offsets: PetLeveling['offsets'] = {};
  if (isObj(x.o)) for (const [k, v] of Object.entries(x.o)) if (nonNegInt(v)) offsets[k] = v;
  const custom: PetLeveling['custom'] = {};
  if (isObj(x.c)) {
    for (const [pet, v] of Object.entries(x.c)) {
      if (!isObj(v)) continue;
      const c: PetLeveling['custom'][string] = {};
      if (Array.isArray(v.l) && v.l.length && v.l.every(posNum)) {
        c.levels = v.l as number[];
        if (v.a === 1) c.append = true;
      }
      if (posInt(v.m)) c.maxLevel = v.m;
      if (c.levels || c.maxLevel) custom[pet] = c;
    }
  }
  return { offsets, levels: x.l as number[], custom };
}

/** v2 `petNames` -> pet type -> display name (non-string values dropped). */
function parsePetNames(x: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(x)) for (const [k, v] of Object.entries(x)) if (str(v)) out[k] = v;
  return out;
}
