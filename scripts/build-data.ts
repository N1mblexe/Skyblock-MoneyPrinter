// npm run data [-- --offline]  ->  public/data/catalog.json (CatalogFile)
// Sources: Hypixel bazaar (product ids), Hypixel items API (names/tiers/NPC sell/category/auctionable),
// NEU repo tarball (recipes, NPC shops, SkyMart, enchanting-table levels, attribute shards), scripts/data/book-rules.json.
// Cache: .cache/ or $BAZAAR_CACHE_DIR. With --offline nothing is fetched and nothing is written to the cache.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CatalogFile, CatalogItemEntry, CatalogRecipeEntry } from '../src/types/contracts.ts';
import type { RawBazaar, RawItem, RawItems } from '../src/types/api.ts';
import { deriveName, neuToBazaarId, stripFormatting } from '../src/domain/ids.ts';
import { readTar } from './lib/untar.ts';
import { extractNpcOffers, extractRecipes, extractShopOffers, type NeuItem, type ShopOfferRaw } from './lib/neu.ts';
import { CACHE_FILES, cacheDir, cachePath } from './lib/cache.ts';
import {
  buildBookRules,
  buildShops,
  extractShardMeta,
  itemApiFlags,
  mergeExtraRecipes,
  parseBookRules,
  parseExtraRecipes,
  shopDisplayName,
  skymartOffers,
  tableMaxLevels,
  type ItemsApiFlags,
} from './lib/catalogV2.ts';

const URLS = {
  bazaar: 'https://api.hypixel.net/v2/skyblock/bazaar',
  items: 'https://api.hypixel.net/v2/resources/skyblock/items',
  neu: 'https://codeload.github.com/NotEnoughUpdates/NotEnoughUpdates-REPO/tar.gz/refs/heads/master',
  commit: 'https://api.github.com/repos/NotEnoughUpdates/NotEnoughUpdates-REPO/commits/master',
};
const CACHE = {
  bazaar: cachePath(CACHE_FILES.bazaar),
  items: cachePath(CACHE_FILES.items),
  neu: cachePath(CACHE_FILES.neu),
  commit: cachePath(CACHE_FILES.commit),
};
const OUT = 'public/data/catalog.json';
const BOOK_RULES = 'scripts/data/book-rules.json';
const EXTRA_RECIPES = 'scripts/data/extra-recipes.json';
const SUBCRAFT_DEPTH = 3;
const LIMITS = {
  bazaarRecipes: 440, forge: 100, nb: 400, ns: 2000, bytes: 600 * 1024, priceableTarget: 380,
  copperToBazaar: 7, shards: 100, booksT: 30,
};
/** NEU constants read for v2 (path suffix inside the tarball). */
const NEU_CONSTANTS = ['bazaarstocks', 'attribute_shards', 'enchants', 'skymart'] as const;
type NeuConstant = (typeof NEU_CONSTANTS)[number];
const CONSTANT_RE = new RegExp(`^[^/]+/constants/(${NEU_CONSTANTS.join('|')})\\.json$`);

const OFFLINE = process.argv.includes('--offline');

// ------------------------------------------------------------------ fetching
async function fetchBuf(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<Buffer> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'bazaar-masasi-build-data', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

async function cached(name: string, url: string, file: string, timeoutMs: number): Promise<Buffer> {
  if (!OFFLINE) {
    try {
      const buf = await fetchBuf(url, timeoutMs);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buf);
      console.log(`  ${name}: fetched ${(buf.length / 1024).toFixed(0)} KB`);
      return buf;
    } catch (e) {
      if (!existsSync(file)) throw new Error(`${name}: fetch failed and no cache at ${file}: ${(e as Error).message}`);
      console.warn(`  ${name}: fetch failed (${(e as Error).message}); using cache ${file}`);
    }
  }
  if (!existsSync(file)) throw new Error(`${name}: --offline but no cache at ${file}`);
  const buf = readFileSync(file);
  console.log(`  ${name}: cache ${file} (${(buf.length / 1024).toFixed(0)} KB)`);
  return buf;
}

async function fetchCommit(): Promise<string | undefined> {
  if (!OFFLINE) {
    try {
      const j = JSON.parse((await fetchBuf(URLS.commit, 15_000, { accept: 'application/vnd.github+json' })).toString('utf8')) as { sha?: string };
      if (j.sha) {
        mkdirSync(dirname(CACHE.commit), { recursive: true });
        writeFileSync(CACHE.commit, j.sha);
        return j.sha;
      }
    } catch (e) {
      console.warn(`  neu commit: lookup failed (${(e as Error).message}), non-fatal`);
    }
  }
  return existsSync(CACHE.commit) ? readFileSync(CACHE.commit, 'utf8').trim() || undefined : undefined;
}

// ------------------------------------------------------------------ helpers
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const PET_TIERS = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];
const cleanName = (s: string) => stripFormatting(s).replace(/\[Lvl \{LVL\}\]\s*/g, '').replace(/\s+/g, ' ').trim();
/** NEU display name for an item file; pets ("[Lvl {LVL}] Bee", id BEE;4) get their rarity appended. */
const neuItemName = (it: NeuItem) => {
  const n = cleanName(it.displayname ?? '');
  const pet = /;(\d)$/.exec(it.internalname);
  return pet && it.displayname?.includes('{LVL}') && PET_TIERS[Number(pet[1])] ? `${n} (${PET_TIERS[Number(pet[1])]})` : n;
};

async function main() {
  console.log(`build-data${OFFLINE ? ' (offline)' : ''}: fetching sources… (cache dir ${cacheDir()})`);
  const [bzBuf, itemsBuf, neuBuf, apiCommit] = await Promise.all([
    cached('bazaar', URLS.bazaar, CACHE.bazaar, 60_000),
    cached('items', URLS.items, CACHE.items, 60_000),
    cached('neu', URLS.neu, CACHE.neu, 180_000),
    fetchCommit(),
  ]);

  // ---------------------------------------------------------------- bazaar + items API
  const bazaar = JSON.parse(bzBuf.toString('utf8')) as RawBazaar;
  if (!bazaar.success || !bazaar.products) throw new Error('bazaar: success=false');
  const bz = new Set(Object.keys(bazaar.products));
  const itemsApi = JSON.parse(itemsBuf.toString('utf8')) as RawItems;
  if (!itemsApi.success || !Array.isArray(itemsApi.items)) throw new Error('items API: success=false');
  const api = new Map<string, RawItem & ItemsApiFlags>(itemsApi.items.map((it) => [it.id, it]));
  console.log(`  bazaar products: ${bz.size}, items API: ${api.size}`);

  // ---------------------------------------------------------------- NEU tarball
  const tar = readTar(neuBuf, (p) => /^[^/]+\/items\/[^/]+\.json$/.test(p) || CONSTANT_RE.test(p));
  const neuCommit = tar.globalComment && /^[0-9a-f]{40}$/.test(tar.globalComment) ? tar.globalComment : apiCommit;
  const neuItems: NeuItem[] = [];
  const constants = new Map<NeuConstant, unknown>();
  const aliases = new Map<string, string>(); // NEU id -> bazaar id (from constants/bazaarstocks.json)
  let parseErrors = 0;
  for (const e of tar.entries) {
    try {
      const j = JSON.parse(e.data.toString('utf8')) as unknown;
      const c = CONSTANT_RE.exec(e.path);
      if (c) {
        constants.set(c[1] as NeuConstant, j);
        if (c[1] === 'bazaarstocks')
          for (const s of j as { stock?: string; id?: string }[]) if (s.stock && s.id && bz.has(s.stock)) aliases.set(s.id, s.stock);
      } else {
        const it = j as NeuItem;
        if (typeof it.internalname === 'string' && it.internalname) neuItems.push(it);
      }
    } catch {
      parseErrors++;
    }
  }
  console.log(`  NEU: ${tar.total} files in tarball, ${neuItems.length} item JSONs, ${aliases.size} bazaarstocks aliases, ${parseErrors} parse errors, commit ${neuCommit ?? '?'}`);
  for (const k of NEU_CONSTANTS) if (!constants.has(k)) console.warn(`  NEU: constants/${k}.json missing`);

  const neuDisplay = new Map<string, string>();
  for (const it of neuItems) if (it.displayname) neuDisplay.set(it.internalname, it.displayname);

  // ---------------------------------------------------------------- id normalization
  const ruleHits = new Map<string, number>();
  const aliasDisagree: string[] = [];
  const normMemo = new Map<string, string>();
  const norm = (neuId: string): string => {
    const hit = normMemo.get(neuId);
    if (hit !== undefined) return hit;
    const byRule = neuToBazaarId(neuId, bz, neuDisplay.get(neuId));
    const alias = aliases.get(neuId);
    let out = byRule;
    let rule: string;
    if (bz.has(neuId)) rule = '1 bazaar-id';
    else if (alias && alias !== byRule) {
      out = alias;
      rule = 'alias (bazaarstocks)';
      aliasDisagree.push(`${neuId} -> rule ${byRule} / alias ${alias}`);
    } else if (/;\d+$/.test(neuId)) rule = neuId.startsWith('ATTRIBUTE_SHARD_') ? (bz.has(out) ? '2 shard' : '2 shard (miss)') : bz.has(out) ? '2 enchantment' : '2 ;N non-bazaar';
    else if (/-\d+$/.test(neuId)) rule = bz.has(out) ? '3 dash' : '3 dash non-bazaar';
    else rule = '4 other';
    inc(ruleHits, rule);
    normMemo.set(neuId, out);
    return out;
  };

  // ---------------------------------------------------------------- recipes
  type R = CatalogRecipeEntry & { key: string };
  const all: R[] = [];
  const seen = new Set<string>();
  let rawCount = 0;
  for (const it of neuItems) {
    for (const raw of extractRecipes(it)) {
      rawCount++;
      const o = norm(raw.output);
      const merged = new Map<string, number>();
      for (const s of raw.inputs) inc(merged, norm(s.id), s.qty);
      const i = [...merged].map(([id, q]) => [id, round(q)] as [string, number]).sort((a, b) => a[0].localeCompare(b[0]));
      const key = `${raw.kind}|${o}|${raw.count}|${i.map(([id, q]) => `${id}*${q}`).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r: R = { key, o, c: raw.count, i, k: raw.kind };
      if (raw.kind === 'forge' && raw.duration) r.d = raw.duration;
      if (raw.req) r.r = raw.req;
      all.push(r);
    }
  }
  // hand-kept recipes for outputs NEU has none for (scripts/data/extra-recipes.json)
  const extra = mergeExtraRecipes(parseExtraRecipes(JSON.parse(readFileSync(EXTRA_RECIPES, 'utf8')) as unknown), (id) => all.some((r) => r.o === id));
  for (const x of extra.added) {
    all.push({ key: `craft|${x.output}|${x.outCount}|${x.inputs.map(([id, q]) => `${id}*${q}`).join(',')}`, o: x.output, c: x.outCount, i: x.inputs, k: 'craft' });
  }
  if (extra.added.length) console.log(`  extra recipes added: ${extra.added.map((x) => x.output).join(', ')}`);
  if (extra.skipped.length) console.warn(`  extra recipes skipped (NEU has a recipe now): ${extra.skipped.join(', ')}`);
  const byOut = new Map<string, R[]>();
  for (const r of all) byOut.set(r.o, [...(byOut.get(r.o) ?? []), r]);

  // ---------------------------------------------------------------- NPC buy prices (coin-only shops, cheapest)
  const nb = new Map<string, number>();
  let offers = 0;
  for (const it of neuItems) {
    for (const off of extractNpcOffers(it)) {
      offers++;
      const id = norm(off.result);
      const p = off.coins / off.qty;
      if (!(nb.get(id)! <= p)) nb.set(id, p);
    }
  }

  nb.set('SKYBLOCK_COIN', 1); // forge recipes may cost coins directly

  // ---------------------------------------------------------------- v2: currency shops (single-cost, non-coin) + SkyMart
  const sellable = (id: string) => bz.has(id) || (api.get(id)?.npc_sell_price ?? 0) > 0;
  const rawShops: ShopOfferRaw[] = [];
  for (const it of neuItems) rawShops.push(...extractShopOffers(it));
  const skymart = skymartOffers(constants.get('skymart'));
  const shops = buildShops([...rawShops, ...skymart], {
    norm,
    keep: sellable,
    shopName: (neuId) => shopDisplayName(neuId, neuDisplay.get(neuId)),
  });

  // ---------------------------------------------------------------- v2: books (table max from NEU, anvil max curated)
  const curated = parseBookRules(JSON.parse(readFileSync(BOOK_RULES, 'utf8')) as unknown);
  const books = buildBookRules(bz, tableMaxLevels(constants.get('enchants')), curated);
  const curatedMissing = [...curated.keys()].filter((b) => !books[b]);

  // ---------------------------------------------------------------- v2: attribute shard metadata
  const shardMeta = extractShardMeta(constants.get('attribute_shards'), bz);

  // ---------------------------------------------------------------- selection
  // every recipe with a bazaar output, plus every forge recipe (forge view; value may come from NPC sell)
  const included = new Set<R>(all.filter((r) => bz.has(r.o) || r.k === 'forge'));
  const bazaarOutput = all.filter((r) => bz.has(r.o)).length;
  let frontier = [...included];
  const subcraftedIds = new Set<string>();
  for (let depth = 1; depth <= SUBCRAFT_DEPTH && frontier.length; depth++) {
    const next: R[] = [];
    for (const r of frontier) {
      for (const [id] of r.i) {
        if (bz.has(id) || nb.has(id) || subcraftedIds.has(id)) continue;
        subcraftedIds.add(id);
        for (const sub of byOut.get(id) ?? []) {
          if (included.has(sub)) continue;
          included.add(sub);
          next.push(sub);
        }
      }
    }
    frontier = next;
  }
  const recipes = [...included].sort((a, b) => a.o.localeCompare(b.o) || a.k.localeCompare(b.k) || a.key.localeCompare(b.key));
  const inclByOut = new Map<string, R[]>();
  for (const r of recipes) inclByOut.set(r.o, [...(inclByOut.get(r.o) ?? []), r]);

  // priceability at build time (bazaar / nb / sub-craft within depth)
  const memo = new Map<string, boolean>();
  const priceable = (id: string, depth: number, stack: Set<string>): boolean => {
    if (bz.has(id) || nb.has(id)) return true;
    if (depth >= SUBCRAFT_DEPTH || stack.has(id)) return false;
    const mk = `${id}@${depth}`;
    const m = memo.get(mk);
    if (m !== undefined) return m;
    stack.add(id);
    const ok = (inclByOut.get(id) ?? []).some((r) => r.i.every(([x]) => priceable(x, depth + 1, stack)));
    stack.delete(id);
    memo.set(mk, ok);
    return ok;
  };
  const bzRecipes = recipes.filter((r) => bz.has(r.o));
  const fullyPriceable = bzRecipes.filter((r) => r.i.every(([x]) => priceable(x, 0, new Set([r.o])))).length;

  // unresolved ingredient ids (not bazaar, no nb, no included recipe)
  const unresolved = new Map<string, number>();
  for (const r of recipes) for (const [id] of r.i) if (!bz.has(id) && !nb.has(id) && !inclByOut.has(id)) inc(unresolved, id);

  // ---------------------------------------------------------------- items
  const neuNameById = new Map<string, string>();
  for (const it of neuItems) {
    if (!it.displayname) continue;
    const n = neuItemName(it);
    if (!n || /^enchanted book$/i.test(n)) continue;
    const id = norm(it.internalname);
    if (!neuNameById.has(id)) neuNameById.set(id, n);
  }
  const ids = new Set<string>(bz);
  for (const r of recipes) {
    ids.add(r.o);
    for (const [id] of r.i) ids.add(id);
  }
  for (const id of nb.keys()) ids.add(id);
  for (const s of shops) ids.add(s.cur).add(s.o);
  for (const it of api.values()) if (typeof it.npc_sell_price === 'number' && it.npc_sell_price > 0) ids.add(it.id);

  const items: Record<string, CatalogItemEntry> = {};
  const nameSrc = new Map<string, number>();
  for (const id of [...ids].sort()) {
    const a = api.get(id);
    const apiName = a?.name ? cleanName(a.name) : '';
    const neuName = neuNameById.get(id) ?? '';
    const n = id === 'SKYBLOCK_COIN' ? 'Coins' : apiName || neuName || deriveName(id);
    inc(nameSrc, apiName ? 'items API' : neuName ? 'NEU' : 'derived');
    const e: CatalogItemEntry = { n };
    if (a?.tier) e.t = a.tier;
    if (typeof a?.npc_sell_price === 'number' && a.npc_sell_price > 0) e.ns = round(a.npc_sell_price);
    const b = nb.get(id);
    if (b !== undefined) e.nb = round(b);
    if (bz.has(id)) e.bz = 1;
    Object.assign(e, itemApiFlags(a));
    const sh = shardMeta.get(id);
    if (sh) e.sh = sh;
    items[id] = e;
  }

  const file: CatalogFile = {
    v: 2,
    generatedAt: new Date().toISOString(),
    ...(neuCommit ? { neuCommit } : {}),
    itemsApiUpdated: itemsApi.lastUpdated,
    items,
    recipes: recipes.map(({ key: _k, ...r }) => r),
    shops,
    books,
  };
  const json = JSON.stringify(file);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);

  // ---------------------------------------------------------------- report
  const entries = Object.entries(items);
  const stats = {
    rawRecipes: rawCount,
    uniqueRecipes: all.length,
    included: recipes.length,
    bazaarOutput,
    subcraft: recipes.filter((r) => !bz.has(r.o) && r.k === 'craft').length,
    forge: recipes.filter((r) => r.k === 'forge').length,
    forgeBazaarOutput: bzRecipes.filter((r) => r.k === 'forge').length,
    npcOffers: offers,
    items: entries.length,
    withNb: entries.filter(([, e]) => e.nb !== undefined).length,
    withNs: entries.filter(([, e]) => e.ns !== undefined).length,
    bazaarNamed: [...bz].filter((id) => items[id]?.n.trim()).length,
    fullyPriceable,
    withCategory: entries.filter(([, e]) => e.c !== undefined).length,
    auctionable: entries.filter(([, e]) => e.ah === 1).length,
    shards: entries.filter(([, e]) => e.sh !== undefined).length,
    shops: shops.length,
    copperToBazaar: shops.filter((s) => s.cur === 'SKYBLOCK_COPPER' && bz.has(s.o)).length,
    books: Object.keys(books).length,
    booksWithT: Object.values(books).filter((b) => b.t !== undefined).length,
    booksWithM: Object.values(books).filter((b) => b.m !== undefined).length,
    bytes: Buffer.byteLength(json),
  };
  const byCurrency = new Map<string, number>();
  for (const s of shops) inc(byCurrency, s.cur);
  console.log('\nID normalization (unique ids per rule):');
  for (const [k, v] of [...ruleHits].sort()) console.log(`  ${k.padEnd(24)} ${v}`);
  if (aliasDisagree.length) {
    console.log(`  bazaarstocks overrides (${aliasDisagree.length}):`);
    for (const s of aliasDisagree.slice(0, 30)) console.log(`    ${s}`);
  }
  console.log(`\nName sources: ${[...nameSrc].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`\nTop unresolved ingredient ids (not bazaar, no NPC price, no recipe) — ${unresolved.size} total:`);
  for (const [id, n] of [...unresolved].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${String(n).padStart(4)}  ${id}`);

  console.log(`\nShops by currency (${shops.length} offers from ${rawShops.length} npc_shop single-cost + ${skymart.length} SkyMart):`);
  for (const [k, v] of [...byCurrency].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  if (curatedMissing.length) console.warn(`  book-rules entries with no bazaar book: ${curatedMissing.join(', ')}`);

  console.log('\nSummary:');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`  wrote ${OUT} (${(stats.bytes / 1024).toFixed(1)} KB)`);

  const fails: string[] = [];
  if (stats.bazaarOutput < LIMITS.bazaarRecipes) fails.push(`bazaar-output recipes ${stats.bazaarOutput} < ${LIMITS.bazaarRecipes}`);
  if (stats.forge < LIMITS.forge) fails.push(`forge recipes ${stats.forge} < ${LIMITS.forge}`);
  if (stats.bazaarNamed !== bz.size) fails.push(`named bazaar ids ${stats.bazaarNamed} / ${bz.size}`);
  if (stats.withNb < LIMITS.nb) fails.push(`items with nb ${stats.withNb} < ${LIMITS.nb}`);
  if (stats.withNs < LIMITS.ns) fails.push(`items with ns ${stats.withNs} < ${LIMITS.ns}`);
  if (stats.bytes > LIMITS.bytes) fails.push(`size ${stats.bytes} > ${LIMITS.bytes}`);
  if (stats.copperToBazaar < LIMITS.copperToBazaar) fails.push(`copper offers to bazaar ids ${stats.copperToBazaar} < ${LIMITS.copperToBazaar}`);
  if (stats.shards < LIMITS.shards) fails.push(`shards with metadata ${stats.shards} < ${LIMITS.shards}`);
  if (stats.booksWithT < LIMITS.booksT) fails.push(`books with table max ${stats.booksWithT} < ${LIMITS.booksT}`);
  if (books.ENCHANTMENT_SHARPNESS?.m !== 5) fails.push(`books.ENCHANTMENT_SHARPNESS.m = ${books.ENCHANTMENT_SHARPNESS?.m} (expected 5)`);
  if (fullyPriceable < LIMITS.priceableTarget) console.warn(`  note: fully priceable ${fullyPriceable} < target ${LIMITS.priceableTarget} (not fatal)`);
  if (fails.length) {
    console.error(`\nACCEPTANCE FAILED:\n  ${fails.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nAcceptance: PASS');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
