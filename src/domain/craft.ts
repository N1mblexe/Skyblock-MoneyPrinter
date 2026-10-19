// Crafts, forges and shop trades priced end to end: each ingredient from the bazaar, an NPC shop, the AH or a
// sub-recipe (craft, forge or shop trade), the output sold where it nets the most per hour (sale.ts), throughput and
// planner inputs per row. One resolver per market core memoizes how every item is obtained; one pricer per context
// adds the throughput settings on top.
import { AH, CRAFT_RECURSION_DEPTH } from '../config.ts';
import type {
  CalcCtx,
  ConsInfo,
  CraftRow,
  IngredientLine,
  LeafLine,
  QuoteSource,
  Recipe,
  ResourceKey,
  ResourceUse,
  RiskFlag,
  RiskReport,
  Throughput,
} from '../types/contracts.ts';
import { coreOf, mergeCons, type MarketCore } from './market.ts';
import { afterTax, npcBuyRate, planInputs, sideRes, throughput, type PlanSpec, type RateCap, type ThroughputInput } from './pricing.ts';
import { combineRisk, INGREDIENT_FLAGS, reportFromFlags } from './risk.ts';
import { saleQuotes, type SaleQuote, type SaleVenue } from './sale.ts';

/** One bought input per unit of a resolved item: a LeafLine plus how fast it fills and how it is re-quoted. */
interface Leaf {
  id: string;
  /** units per unit of the resolved item */
  qty: number;
  unit: number;
  /** order / insta (bazaar), npc or ah */
  source: QuoteSource;
  res?: ResourceKey;
  /** units/hour of a timed leg (bazaar fill rate); Infinity for an instant leg */
  rate: number;
  /** units/hour cap of an instant leg (NPC shop limit, AH sales); Infinity when none */
  cap: number;
  /** limitedBy when the cap binds */
  bound: Throughput['limitedBy'];
  /** insta-buy: units on the asks; AH: listings seen */
  depth?: number;
  /** AH: fewer than AH.minCount listings */
  thin?: boolean;
  cons?: ConsInfo;
}

/** Units drawn from an NPC shop's daily limit that are not bought for coins (shop trades), per unit. */
interface ShopNeed {
  id: string;
  qty: number;
}

/** What a source buys per unit, sub-crafts flattened: one leaf per item and source. */
interface Expanded {
  leaves: Leaf[];
  /** shop-trade purchases (each draws on `${id}:npc`) */
  shops: ShopNeed[];
  /** units/hour the leaves and shop limits support (forge slots left out: a throughput setting) */
  perHour: number;
}

/** How one unit of an item is obtained. */
interface Resolved {
  unit: number;
  source: QuoteSource;
  /** recipe key when source === 'craft' */
  viaRecipe?: string;
  /** forge slot-hours per unit (forge sub-recipes) */
  forgeHours: number;
  /** sub-recipe: the chosen source of each input, per unit of the output */
  parts?: { res: Resolved; k: number }[];
  /** shop-trade sub-recipe: the item bought from the NPC */
  shopOut?: string;
  /** leaves, filled in when first needed (most sub-recipes lose to a cheaper one and are never expanded) */
  x?: Expanded;
  /** units/hour without merging shared leaves (unpriced rows: no expansion), filled in when first needed */
  ph?: number;
}

/** The cycle checks a sub-recipe computation made: every id looked up on the path, and those that were on it. */
interface Trace {
  checked: string[];
  hits: Set<string> | null;
}

interface CutEntry {
  checked: readonly string[];
  hits: ReadonlySet<string>;
  res: Resolved | null;
}

/** Ways to obtain an item directly (no sub-recipe); `best` is the cheapest of bazaar, NPC and AH. */
interface Direct {
  bazaar: Resolved | null;
  npc: Resolved | null;
  ah: Resolved | null;
  best: Resolved | null;
  /** the NPC up to its limit plus the bazaar for the rest; undefined until first asked */
  mix?: Resolved | null;
}

interface Resolver {
  direct(id: string): Direct;
  mix(d: Direct): Resolved | null;
  /** cheapest sub-recipe for one unit at this depth; `cut` = a cycle guard influenced it */
  sub(id: string, depth: number, visited: Set<string>): { res: Resolved | null; cut: boolean };
  expand(r: Resolved): Expanded;
  /** units/hour of a source: expanded when it is, else the slowest part (shared leaves not merged) */
  perHour(r: Resolved): number;
}

/**
 * Every catalog recipe, priced (unpriced rows included with unpriced[] set).
 *  inputs  the cheapest of a bazaar quote (core.buy: a buy order capped at the ask is an insta-buy), an instant NPC
 *          purchase capped at npcDailyLimit / 24 per hour, the AH lowest BINs (core.ahBuy, capped by the AH sales
 *          rate) and a sub-recipe (craft, forge or shop trade) up to CRAFT_RECURSION_DEPTH levels deep. The
 *          bottleneck ingredient then switches to another source (or NPC up to its limit + bazaar for the rest) when
 *          that earns more per hour.
 *  output  saleQuotes (bazaar after tax, AH after fees at its sales rate, NPC); the best net, or a faster venue when
 *          it earns more per hour. Shop-trade outputs are never valued at the NPC sell price (an NPC shop does not
 *          buy back above what it sells for).
 * Insta and AH legs are re-quoted once at the planned batch size; `plan` carries the planner inputs.
 */
export function computeCrafts(ctx: CalcCtx): CraftRow[] {
  const pricer = getPricer(ctx);
  return ctx.catalog.recipes.map((r) => pricer.price(r));
}

export interface PriceOptions {
  /** inputs bought as they are (bazaar, NPC or AH), never sub-crafted; a chain move uses it for its starting tier */
  directIds?: ReadonlySet<string>;
  /** inputs bought on the bazaar only (no NPC shop, AH or sub-craft) */
  bazaarIds?: ReadonlySet<string>;
}

export interface CraftPricer {
  /** Price any recipe (catalog or synthetic) the way computeCrafts does; memos are shared across calls. */
  price(recipe: Recipe, opts?: PriceOptions): CraftRow;
}

const pricers = new WeakMap<CalcCtx, CraftPricer>();
const resolvers = new WeakMap<MarketCore, Resolver>();

/**
 * One pricer per context, shared by crafts, chains, Kat and Sell or craft? (its memos don't depend on PriceOptions).
 * Contexts on one market core share the ingredient memo, so a throughput setting change re-prices no ingredient.
 */
export function getPricer(ctx: CalcCtx): CraftPricer {
  let p = pricers.get(ctx);
  if (!p) pricers.set(ctx, (p = createCraftPricer(ctx)));
  return p;
}

/** The coins pseudo-item recipes list as an input (NEU: forge fees and shop prices). */
const COINS = 'SKYBLOCK_COIN';
const fin = (x: number) => x > 0 && Number.isFinite(x);
const leafPerHour = (l: Leaf) => Math.min(l.rate, l.cap);
const sameMarket = (a: Leaf, b: Leaf) => a.id === b.id && a.source === b.source;

/** Add `l` scaled by k to `out`, merging with a leaf of the same item and source. */
function addLeaf(out: Leaf[], l: Leaf, k: number): void {
  const qty = l.qty * k;
  for (const o of out) {
    if (sameMarket(o, l)) {
      o.qty += qty;
      return;
    }
  }
  out.push({ ...l, qty });
}

function addShop(out: ShopNeed[], id: string, qty: number): void {
  for (const o of out) {
    if (o.id === id) {
      o.qty += qty;
      return;
    }
  }
  out.push({ id, qty });
}

function perHourOf(leaves: readonly Leaf[], shops: readonly ShopNeed[], npcRate: number): number {
  let r = Infinity;
  for (const l of leaves) if (l.qty > 0) r = Math.min(r, leafPerHour(l) / l.qty);
  for (const s of shops) if (s.qty > 0) r = Math.min(r, npcRate / s.qty);
  return r;
}

/** A single-leaf source. */
const single = (l: Leaf): Resolved => ({ unit: l.unit, source: l.source, forgeHours: 0, x: { leaves: [l], shops: [], perHour: leafPerHour(l) } });

function resolverOf(core: MarketCore): Resolver {
  let r = resolvers.get(core);
  if (!r) resolvers.set(core, (r = createResolver(core)));
  return r;
}

/** How items are obtained under one market core (it reads the market settings only, never throughput ones). */
function createResolver(core: MarketCore): Resolver {
  const { catalog, settings, snap } = core.ctx;
  const npcRate = npcBuyRate(settings.npcDailyLimit);
  const directMemo = new Map<string, Direct>();
  /** per depth: id -> cheapest sub-recipe no cycle guard influenced */
  const subMemo = Array.from({ length: CRAFT_RECURSION_DEPTH }, () => new Map<string, Resolved | null>());
  /** per depth: id -> results a cycle guard influenced, each valid while the ids it checked are on the path as then */
  const cutMemo = Array.from({ length: CRAFT_RECURSION_DEPTH }, () => new Map<string, CutEntry[]>());
  /** the cycle checks of the sub-recipe computations in progress (innermost last) */
  const traces: Trace[] = [];

  /** Is `id` on the path? Recorded for the computation in progress. */
  const check = (visited: Set<string>, id: string): boolean => {
    const on = visited.has(id);
    const t = traces.length > 0 ? traces[traces.length - 1] : undefined;
    if (t) {
      t.checked.push(id);
      if (on) (t.hits ??= new Set()).add(id);
    }
    return on;
  };
  const merge = (checked: readonly string[], hits: ReadonlySet<string>) => {
    const t = traces[traces.length - 1];
    if (!t) return;
    for (const id of checked) t.checked.push(id);
    if (hits.size > 0) for (const id of hits) (t.hits ??= new Set()).add(id);
  };

  const bazaar = (id: string): Resolved | null => {
    const s = core.buy(id);
    const q = s?.quote;
    if (!s || !q || !fin(q.price) || (q.source !== 'order' && q.source !== 'insta')) return null;
    const leaf: Leaf = { id, qty: 1, unit: q.price, source: q.source, rate: s.rate, cap: Infinity, bound: 'volume' };
    const res = sideRes(id, 'buy', q.source);
    if (res) leaf.res = res;
    if (q.source === 'insta') leaf.depth = s.depth ?? 0;
    if (s.cons) leaf.cons = s.cons;
    return single(leaf);
  };

  const npc = (id: string): Resolved | null => {
    // coins in a recipe (forge fees, shop prices) are paid as they are: no shop, no daily limit
    if (id === COINS) return single({ id, qty: 1, unit: 1, source: 'npc', rate: Infinity, cap: Infinity, bound: 'npcLimit' });
    const n = core.npcBuy(id);
    return n ? single({ id, qty: 1, unit: n.price, source: 'npc', res: `${id}:npc`, rate: Infinity, cap: n.rate, bound: 'npcLimit' }) : null;
  };

  // only auctionable items (the catalog says so, or unknown to it and not a bazaar product)
  const ah = (id: string): Resolved | null => {
    const info = catalog.items[id];
    const a = (info ? info.auctionable === true : !snap.products[id]) ? core.ahBuy(id) : null;
    if (!a || !fin(a.price)) return null;
    // the listings a batch can buy (those whose price is known) bound it like a book's depth
    return single({ id, qty: 1, unit: a.price, source: 'ah', rate: Infinity, cap: a.rate, bound: 'ahSales', depth: a.depth, thin: a.count < AH.minCount });
  };

  const direct = (id: string): Direct => {
    let d = directMemo.get(id);
    if (d) return d;
    const bz = bazaar(id);
    const n = npc(id);
    const a = ah(id);
    let best = bz;
    if (n && (!best || n.unit < best.unit)) best = n;
    if (a && (!best || a.unit < best.unit)) best = a;
    directMemo.set(id, (d = { bazaar: bz, npc: n, ah: a, best }));
    return d;
  };

  /** NPC up to its limit, the bazaar for the rest: split by the two rates (the NPC cap and the bazaar fill rate). */
  const mix = (d: Direct): Resolved | null => {
    if (d.mix !== undefined) return d.mix;
    const n = d.npc?.x!.leaves[0];
    const b = d.bazaar?.x!.leaves[0];
    if (!n || !b || !fin(b.rate) || !fin(n.cap)) return (d.mix = null);
    const share = n.cap / (n.cap + b.rate);
    const leaves = [
      { ...n, qty: share },
      { ...b, qty: 1 - share },
    ];
    return (d.mix = { unit: share * n.unit + (1 - share) * b.unit, source: 'mix', forgeHours: 0, x: { leaves, shops: [], perHour: n.cap + b.rate } });
  };

  const expand = (r: Resolved): Expanded => {
    if (r.x) return r.x;
    const leaves: Leaf[] = [];
    const shops: ShopNeed[] = [];
    for (const p of r.parts ?? []) {
      const c = expand(p.res);
      for (const l of c.leaves) addLeaf(leaves, l, p.k);
      for (const s of c.shops) addShop(shops, s.id, s.qty * p.k);
    }
    // a shop trade buys the output itself from the NPC: each unit draws on that shop's daily limit
    if (r.shopOut) addShop(shops, r.shopOut, 1);
    return (r.x = { leaves, shops, perHour: perHourOf(leaves, shops, npcRate) });
  };

  const perHour = (r: Resolved): number => {
    if (r.x) return r.x.perHour;
    if (r.ph != null) return r.ph;
    let ph = r.shopOut ? npcRate : Infinity;
    for (const p of r.parts ?? []) if (p.k > 0) ph = Math.min(ph, perHour(p.res) / p.k);
    return (r.ph = ph);
  };

  /** Cheapest of direct and sub-recipe at this depth. */
  const best = (id: string, depth: number, visited: Set<string>): { res: Resolved | null; cut: boolean } => {
    const d = direct(id).best;
    const s = sub(id, depth, visited);
    return { res: s.res && (!d || s.res.unit < d.unit) ? s.res : d, cut: s.cut };
  };

  /** One unit of r's output from its inputs, when cheaper than `than`. */
  const compose = (r: Recipe, depth: number, visited: Set<string>, than: number): { res: Resolved | null; cut: boolean } => {
    let sum = 0;
    let forge = r.kind === 'forge' && r.durationSec != null && r.durationSec > 0 ? r.durationSec / 3600 : 0;
    let cut = false;
    const subs: Resolved[] = [];
    for (const inp of r.inputs) {
      if (check(visited, inp.id)) return { res: null, cut: true };
      const s = best(inp.id, depth + 1, visited);
      if (s.cut) cut = true;
      if (!s.res) return { res: null, cut };
      sum += inp.qty * s.res.unit;
      forge += inp.qty * s.res.forgeHours;
      subs.push(s.res);
    }
    const unit = sum / r.outCount;
    if (!fin(unit) || !(unit < than)) return { res: null, cut };
    const parts = subs.map((res, i) => ({ res, k: r.inputs[i]!.qty / r.outCount }));
    const res: Resolved = { unit, source: 'craft', viaRecipe: r.key, forgeHours: forge / r.outCount, parts };
    if (r.kind === 'shop') res.shopOut = r.output;
    return { res, cut };
  };

  const sub = (id: string, depth: number, visited: Set<string>): { res: Resolved | null; cut: boolean } => {
    if (depth >= CRAFT_RECURSION_DEPTH) return { res: null, cut: false };
    if (check(visited, id)) return { res: null, cut: true };
    const hit = subMemo[depth]!.get(id);
    if (hit !== undefined) return { res: hit, cut: false };
    // a cut result holds while every id its computation checked is on the path exactly when it was then
    const entries = cutMemo[depth]!.get(id);
    if (entries) {
      for (const e of entries) {
        if (e.checked.every((c) => visited.has(c) === e.hits.has(c))) {
          merge(e.checked, e.hits);
          return { res: e.res, cut: true };
        }
      }
    }
    traces.push({ checked: [], hits: null });
    visited.add(id);
    let res: Resolved | null = null;
    let cut = false;
    for (const r of catalog.byOutput.get(id) ?? []) {
      if (!(r.outCount > 0)) continue;
      const c = compose(r, depth, visited, res ? res.unit : Infinity);
      if (c.cut) cut = true;
      if (c.res) res = c.res;
    }
    visited.delete(id);
    const t = traces.pop()!;
    if (cut) {
      const e: CutEntry = { checked: [...new Set(t.checked)], hits: t.hits ?? new Set(), res };
      if (entries) entries.push(e);
      else cutMemo[depth]!.set(id, [e]);
      merge(e.checked, e.hits);
    } else subMemo[depth]!.set(id, res);
    return { res, cut };
  };

  return { direct, mix, sub, expand, perHour };
}

/** Per-craft totals of one market: the first leaf and the units per craft. */
interface Group {
  leaf: Leaf;
  qty: number;
}

/** A priced recipe for one choice of ingredient sources and sale venue. */
interface Eval {
  chosen: Resolved[];
  sale: SaleQuote;
  cost: number;
  value: number;
  profit: number;
  groups: Group[];
  shops: ShopNeed[];
  forgeHours: number;
  lineRates: number[];
  inRate: number;
  outRate: number;
  input: ThroughputInput;
  tp: Throughput;
}

const pphOf = (e: Eval) => (e.profit > 0 ? e.tp.unitsPerHour * e.profit : 0);
/** Limits a faster ingredient source or sale venue can lift (capital and slots bind whatever the source). */
const SOURCE_BOUND: ReadonlySet<Throughput['limitedBy']> = new Set(['volume', 'npcLimit', 'ahSales', 'forge', 'depth']);
/** Sale venues by output: bazaar product or not, shop trade or not (an NPC shop does not buy back what it sells). */
const VENUES: Record<'bz' | 'off', Record<'any' | 'shop', readonly SaleVenue[]>> = {
  bz: { any: ['bazaar', 'ah', 'npc'], shop: ['bazaar', 'ah'] },
  off: { any: ['ah', 'npc'], shop: ['ah'] },
};
const argMin = (xs: readonly number[]) => {
  let b = -1;
  for (let i = 0; i < xs.length; i++) if (b < 0 || xs[i]! < xs[b]!) b = i;
  return b;
};

export function createCraftPricer(ctx: CalcCtx): CraftPricer {
  const { catalog, settings } = ctx;
  const { costMode, sellMode, taxRate } = settings;
  const core = coreOf(ctx);
  const rs = resolverOf(core);
  const npcRate = npcBuyRate(core.ctx.settings.npcDailyLimit);

  /** Every way to obtain an input as a top-level line. */
  const options = (id: string, root: string, opts: PriceOptions | undefined): Resolved[] => {
    const d = rs.direct(id);
    if (opts?.bazaarIds?.has(id)) return d.bazaar ? [d.bazaar] : [];
    const out: Resolved[] = [];
    for (const r of [d.bazaar, d.npc, d.ah, rs.mix(d)]) if (r) out.push(r);
    if (!opts?.directIds?.has(id)) {
      const s = rs.sub(id, 0, new Set([root])).res;
      if (s) out.push(s);
    }
    return out;
  };

  /** The cheapest source of a line: direct (bazaar, then NPC, then AH on ties), a sub-recipe only when cheaper. */
  const cheapest = (id: string, root: string, opts: PriceOptions | undefined): Resolved | null => {
    const d = rs.direct(id);
    if (opts?.bazaarIds?.has(id)) return d.bazaar;
    if (opts?.directIds?.has(id)) return d.best;
    const s = rs.sub(id, 0, new Set([root])).res;
    return s && (!d.best || s.unit < d.best.unit) ? s : d.best;
  };

  function evaluate(recipe: Recipe, chosen: Resolved[], sale: SaleQuote): Eval {
    const n = recipe.outCount;
    const groups: Group[] = [];
    const shops: ShopNeed[] = [];
    const lineRates: number[] = [];
    let cost = 0;
    let forgeHours = recipe.kind === 'forge' && recipe.durationSec != null && recipe.durationSec > 0 ? recipe.durationSec / 3600 : 0;
    for (let i = 0; i < recipe.inputs.length; i++) {
      const q = recipe.inputs[i]!.qty;
      const r = chosen[i]!;
      const x = rs.expand(r);
      cost += q * r.unit;
      forgeHours += q * r.forgeHours;
      lineRates.push(q > 0 ? x.perHour / q : Infinity);
      for (const l of x.leaves) {
        const g = groups.find((y) => sameMarket(y.leaf, l));
        if (g) g.qty += l.qty * q;
        else groups.push({ leaf: l, qty: l.qty * q });
      }
      for (const s of x.shops) addShop(shops, s.id, s.qty * q);
    }
    if (recipe.kind === 'shop') addShop(shops, recipe.output, n);

    let rBuy = Infinity;
    let depthCap: number | undefined;
    const caps: RateCap[] = [];
    const orderUnits: number[] = [];
    const minDepth = (x: number) => (depthCap = depthCap == null ? x : Math.min(depthCap, x));
    for (const { leaf: l, qty } of groups) {
      if (!(qty > 0)) continue;
      if (Number.isFinite(l.rate)) rBuy = Math.min(rBuy, l.rate / qty);
      if (Number.isFinite(l.cap)) caps.push({ perHour: l.cap / qty, bound: l.bound });
      if (l.depth != null) minDepth(l.depth / qty);
      if (l.source === 'order') orderUnits.push(qty);
    }
    for (const s of shops) if (s.qty > 0) caps.push({ perHour: npcRate / s.qty, bound: 'npcLimit' });
    let inRate = rBuy;
    for (const c of caps) inRate = Math.min(inRate, c.perHour);

    const value = n * sale.net;
    const outRate = sale.rate / n;
    if (sale.venue === 'bazaar') {
      if (sale.depth != null) minDepth(sale.depth / n);
      if (sellMode === 'offer') orderUnits.push(n);
    }
    const input: ThroughputInput = {
      rBuy,
      rSell: outRate,
      unitCost: cost,
      capital: settings.capital,
      cycleHours: settings.cycleHours,
      depthCap,
      forgeCap: forgeHours > 0 ? Math.max(0, settings.forgeSlots) / forgeHours : undefined,
      fillModel: settings.fillModel,
      orderSlots: settings.orderSlots,
      orderUnits,
      buyBound: 'volume',
      sellBound: sale.limitedBy === 'ahSales' ? 'ahSales' : 'volume',
      caps,
    };
    return { chosen, sale, cost, value, profit: value - cost, groups, shops, forgeHours, lineRates, inRate, outRate, input, tp: throughput(input) };
  }

  /** Cost and value per craft with `crafts` crafts traded at once: insta and AH legs walk their books. */
  function quoteAt(recipe: Recipe, e: Eval, crafts: number): { cost: number; value: number; prices: number[] } {
    const prices: number[] = [];
    let cost = 0;
    for (const { leaf: l, qty } of e.groups) {
      let p = l.unit;
      if (l.source === 'insta') p = core.buy(l.id, qty * crafts)?.quote.price ?? p;
      else if (l.source === 'ah') p = core.ahBuy(l.id, qty * crafts)?.price ?? p;
      prices.push(p);
      cost += qty * p;
    }
    let value = e.value;
    if (e.sale.venue === 'bazaar' && sellMode === 'insta') {
      const s = core.sell(recipe.output, recipe.outCount * crafts);
      if (s && fin(s.quote.price)) value = recipe.outCount * afterTax(s.quote.price, taxRate);
    }
    return { cost, value, prices };
  }

  const requotes = (e: Eval) => e.groups.some((g) => g.leaf.source === 'insta' || g.leaf.source === 'ah') || (e.sale.venue === 'bazaar' && sellMode === 'insta');

  /** Planner resources per craft: the leaves' markets, shop-trade limits, the bazaar output side, forge slot-hours. */
  function usesOf(recipe: Recipe, e: Eval): ResourceUse[] {
    const out: ResourceUse[] = [];
    const add = (key: ResourceKey, perUnit: number) => {
      const u = out.find((x) => x.key === key);
      if (u) u.perUnit += perUnit;
      else out.push({ key, perUnit });
    };
    for (const g of e.groups) if (g.leaf.res && g.qty > 0) add(g.leaf.res, g.qty);
    for (const s of e.shops) add(`${s.id}:npc`, s.qty);
    if (e.sale.venue === 'bazaar') add(sideRes(recipe.output, 'sell', sellMode === 'offer' ? 'order' : 'insta')!, recipe.outCount);
    if (e.forgeHours > 0) add('forge', e.forgeHours);
    return out;
  }

  /** Ingredient risk: INGREDIENT_FLAGS of each bazaar leaf on the side it is bought, AH_THIN of a thin AH leaf. */
  function leafFlags(e: Eval): RiskFlag[] {
    const flags = new Set<RiskFlag>();
    for (const { leaf: l } of e.groups) {
      if (l.source === 'order' || l.source === 'insta') {
        for (const f of core.risk(l.id, { buy: l.source })?.flags ?? []) if (INGREDIENT_FLAGS.has(f)) flags.add(f);
      } else if (l.thin) flags.add('AH_THIN');
    }
    return [...flags];
  }

  return { price: priceRecipe };

  function priceRecipe(recipe: Recipe, opts?: PriceOptions): CraftRow {
    const out = recipe.output;
    const offBazaar = !catalog.items[out]?.bazaar;
    const chosen = recipe.inputs.map((inp) => cheapest(inp.id, out, opts));
    const unpriced = recipe.inputs.filter((_, i) => !chosen[i]).map((i) => i.id);
    const venues = VENUES[offBazaar ? 'off' : 'bz'][recipe.kind === 'shop' ? 'shop' : 'any'];
    // the output is only quoted once every input is priced (an unpriced row lists the missing inputs)
    if (unpriced.length > 0) return unpricedRow(recipe, chosen, unpriced, offBazaar);
    const quotes = recipe.outCount > 0 ? saleQuotes(ctx, out, { venues }) : [];
    if (!quotes[0]) unpriced.push(out);
    if (unpriced.length > 0) return unpricedRow(recipe, chosen, unpriced, offBazaar);

    const ok = chosen as Resolved[];
    const base = evaluate(recipe, ok, quotes[0]!);
    let e = base;
    // source choice: a faster source for the bottleneck ingredient, or a faster sale venue, when it earns more per hour
    if (base.profit > 0 && SOURCE_BOUND.has(base.tp.limitedBy)) {
      const b = argMin(base.lineRates);
      if (b >= 0 && base.lineRates[b]! < base.outRate) {
        const inp = recipe.inputs[b]!;
        for (const alt of options(inp.id, out, opts)) {
          if (alt === ok[b] || !(base.profit + inp.qty * (ok[b]!.unit - alt.unit) > 0) || !(rs.expand(alt).perHour / inp.qty > base.lineRates[b]!)) continue;
          const c = evaluate(
            recipe,
            ok.map((r, i) => (i === b ? alt : r)),
            base.sale,
          );
          if (pphOf(c) > pphOf(e)) e = c;
        }
      }
      if (base.outRate <= base.inRate) {
        for (const q of quotes) {
          if (!(q.rate > base.sale.rate) || !(recipe.outCount * q.net > base.cost)) continue;
          const c = evaluate(recipe, ok, q);
          if (pphOf(c) > pphOf(e)) e = c;
        }
      }
    }

    // refine: re-quote insta and AH legs at the planned batch size
    let prices: number[] | null = null;
    let cost = e.cost;
    let value = e.value;
    let input = e.input;
    let tp = e.tp;
    const requote = requotes(e);
    if (requote && tp.batchQty > 0) {
      const q = quoteAt(recipe, e, Math.max(1, Math.ceil(tp.batchQty)));
      prices = q.prices;
      cost = q.cost;
      value = q.value;
      input = { ...input, unitCost: cost };
      tp = throughput(input);
    }
    const priceOf = (l: Leaf) => (prices ? prices[e.groups.findIndex((g) => sameMarket(g.leaf, l))]! : l.unit);

    const bott = argMin(e.lineRates);
    const lines = recipe.inputs.map((inp, i): IngredientLine => {
      const r = e.chosen[i]!;
      const x = rs.expand(r);
      const leaves: LeafLine[] = x.leaves.map((l) => {
        const y: LeafLine = { id: l.id, qty: l.qty * inp.qty, unit: priceOf(l), source: l.source };
        if (l.res) y.res = l.res;
        return y;
      });
      const unit = prices ? x.leaves.reduce((s, l) => s + l.qty * priceOf(l), 0) : r.unit;
      const line: IngredientLine = {
        id: inp.id,
        name: catalog.name(inp.id),
        qty: inp.qty,
        unit,
        total: unit * inp.qty,
        source: r.source,
        craftsPerHour: e.lineRates[i]!,
        bottleneck: i === bott && Number.isFinite(e.lineRates[i]!),
        leaves,
      };
      if (r.viaRecipe) line.viaRecipe = r.viaRecipe;
      return line;
    });

    const risks: RiskReport[] = [];
    if (e.sale.risk) risks.push(e.sale.risk);
    const flags = leafFlags(e);
    if (flags.length > 0) risks.push(reportFromFlags(flags));

    const profit = value - cost;
    const row: CraftRow = {
      recipe,
      id: out,
      name: catalog.name(out),
      cost,
      value,
      valueSource: e.sale.venue,
      profit,
      margin: cost > 0 ? profit / cost : null,
      outCraftsPerHour: e.outRate,
      inCraftsPerHour: e.inRate,
      tp,
      profitPerHour: tp.unitsPerHour * profit,
      lines,
      risk: combineRisk(risks),
      unpriced: [],
    };
    if (offBazaar) row.outputOffBazaar = true;
    const cons = consOf(e, recipe.outCount);
    if (cons) row.cons = cons;
    if (profit > 0 && cost > 0) {
      const spec: PlanSpec = { tp: input, profitPerUnit: profit, uses: usesOf(recipe, e) };
      if (requote) {
        spec.requote = (q) => {
          const r = quoteAt(recipe, e, q);
          return { profitPerUnit: r.value - r.cost, buyCost: r.cost };
        };
      }
      row.plan = planInputs(spec);
    }
    return row;
  }

  /** What conservatism changed, per craft: churn summed over the bought units and the output, the lowest rate factor. */
  function consOf(e: Eval, outCount: number): ConsInfo | undefined {
    const parts: ConsInfo[] = [];
    const scaled = (c: ConsInfo, k: number): ConsInfo => {
      const p: ConsInfo = {};
      if (c.rateMul != null) p.rateMul = c.rateMul;
      if (c.churn != null) p.churn = c.churn * k;
      return p;
    };
    for (const g of e.groups) if (g.leaf.cons) parts.push(scaled(g.leaf.cons, g.qty));
    const sc = e.sale.cons;
    if (sc) parts.push({ ...scaled(sc, outCount), ...(sc.sellRef != null ? { sellRef: sc.sellRef } : {}) });
    return mergeCons(...parts);
  }

  function unpricedRow(recipe: Recipe, chosen: (Resolved | null)[], unpriced: string[], offBazaar: boolean): CraftRow {
    const lines = recipe.inputs.map((inp, i): IngredientLine => {
      const r = chosen[i];
      const line: IngredientLine = {
        id: inp.id,
        name: catalog.name(inp.id),
        qty: inp.qty,
        unit: r?.unit ?? 0,
        total: r ? r.unit * inp.qty : 0,
        source: r?.source ?? costMode,
        craftsPerHour: r ? (inp.qty > 0 ? rs.perHour(r) / inp.qty : Infinity) : 0,
        bottleneck: false,
      };
      if (r?.viaRecipe) line.viaRecipe = r.viaRecipe;
      return line;
    });
    const rates = lines.map((l) => l.craftsPerHour);
    const bott = argMin(rates);
    if (bott >= 0 && Number.isFinite(rates[bott]!)) lines[bott]!.bottleneck = true;
    const outRisk = offBazaar ? null : core.risk(recipe.output, { sell: sellMode });
    const row: CraftRow = {
      recipe,
      id: recipe.output,
      name: catalog.name(recipe.output),
      cost: 0,
      value: 0,
      valueSource: 'bazaar',
      profit: 0,
      margin: null,
      outCraftsPerHour: 0,
      inCraftsPerHour: bott >= 0 ? rates[bott]! : Infinity,
      tp: throughput({ rBuy: 0, rSell: 0, unitCost: 0, capital: settings.capital, cycleHours: settings.cycleHours }),
      profitPerHour: 0,
      lines,
      risk: combineRisk(outRisk ? [outRisk] : []),
      unpriced,
    };
    if (offBazaar) row.outputOffBazaar = true;
    return row;
  }
}
