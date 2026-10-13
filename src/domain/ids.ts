// Pure ID helpers shared by scripts/build-data.ts and the runtime. Owner: package A.

/** Strip Minecraft § formatting codes and trim. */
export function stripFormatting(s: string): string {
  return s.replace(/§./g, '').trim();
}

/** "Blue Jay" / "End-Stone  Protector" -> "BLUE_JAY" / "END_STONE_PROTECTOR". */
export function upperSnake(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Parse a NEU item stack string "ID:qty" (qty may be float, e.g. "8.0"; may be absent => 1).
 * Splits on the LAST ':' only if the suffix is numeric. "GOLDEN_APPLE-1:2" -> {id:"GOLDEN_APPLE-1", qty:2}.
 */
export function parseNeuStack(s: string): { id: string; qty: number } {
  const str = s.trim();
  const i = str.lastIndexOf(':');
  if (i > 0) {
    const suffix = str.slice(i + 1);
    if (/^\d+(\.\d+)?$/.test(suffix)) return { id: str.slice(0, i), qty: Number(suffix) };
  }
  return { id: str, qty: 1 };
}

const squash = (s: string) => s.replace(/_/g, '');

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Find the bazaar SHARD_* id for a shard name (UPPER_SNAKE, without SHARD_ prefix).
 * exact -> underscore-insensitive -> unique edit distance <= 2 -> unique containment (>=5 chars).
 */
function matchShard(name: string, bazaarIds: ReadonlySet<string>): string | null {
  const exact = `SHARD_${name}`;
  if (bazaarIds.has(exact)) return exact;
  const want = squash(name);
  if (!want) return null;
  const shards: [string, string][] = [];
  for (const id of bazaarIds) if (id.startsWith('SHARD_')) shards.push([id, squash(id.slice(6))]);
  const sq = shards.filter(([, s]) => s === want);
  if (sq.length === 1) return sq[0]![0];
  let best: string | null = null;
  let bestD = 3;
  let ties = 0;
  for (const [id, s] of shards) {
    const d = levenshtein(s, want, 2);
    if (d < bestD) {
      bestD = d;
      best = id;
      ties = 1;
    } else if (d === bestD) ties++;
  }
  if (bestD <= 2 && ties === 1 && want.length >= 6) return best;
  const contain = shards.filter(([, s]) => Math.min(s.length, want.length) >= 5 && (s.includes(want) || want.includes(s)));
  return contain.length === 1 ? contain[0]![0] : null;
}

/**
 * Map a NEU internal id to the bazaar product id when one applies:
 *  1. already in bazaarIds -> as is
 *  2. "X;N": ATTRIBUTE_SHARD_* -> "SHARD_" + UPPER_SNAKE(displayName minus " Shard") (fuzzy-matched against
 *     bazaar SHARD_* ids); else "ENCHANTMENT_X_N" (unless it is not a bazaar id and displayName says it is not an
 *     enchanted book, e.g. pets "AMMONITE;4" -> kept as is)
 *  3. "A-N" -> "A:N"
 *  4. otherwise canonical non-bazaar id ('-' -> ':')
 */
export function neuToBazaarId(neuId: string, bazaarIds: ReadonlySet<string>, displayName?: string): string {
  const id = neuId.trim();
  if (bazaarIds.has(id)) return id;
  const semi = /^(.+);(\d+)$/.exec(id);
  if (semi) {
    const base = semi[1]!;
    if (base.startsWith('ATTRIBUTE_SHARD_')) {
      const dn = displayName ? stripFormatting(displayName).replace(/\s+Shard$/i, '') : '';
      const name = upperSnake(dn);
      if (name) return matchShard(name, bazaarIds) ?? `SHARD_${name}`;
      return matchShard(base.slice('ATTRIBUTE_SHARD_'.length), bazaarIds) ?? id;
    }
    const ench = `ENCHANTMENT_${base}_${semi[2]}`;
    if (bazaarIds.has(ench)) return ench;
    // non-bazaar "X;N" that is clearly not an enchanted book (e.g. pets "AMMONITE;4"): keep the NEU id
    if (displayName && !/^enchanted book$/i.test(stripFormatting(displayName))) return id;
    return ench;
  }
  const dash = /^(.+)-(\d+)$/.exec(id);
  if (dash) return `${dash[1]}:${dash[2]}`;
  return id.replace(/-/g, ':');
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const title = (s: string) => s.toLowerCase().split('_').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/**
 * Human-readable fallback name. Package A may refine, but must keep these cases:
 *  ENCHANTMENT_LIFE_STEAL_2 -> "Life Steal II", ENCHANTMENT_ULTIMATE_WISE_1 -> "Ultimate Wise I",
 *  SHARD_BLUE_JAY -> "Blue Jay Shard", LOG:1 -> "Log (1)", ENCHANTED_GOLD -> "Enchanted Gold".
 * Refinements: ESSENCE_DRAGON -> "Dragon Essence"; empty id -> "?".
 */
export function deriveName(id: string): string {
  const colon = /^(.+):(\d+)$/.exec(id);
  if (colon) return `${deriveName(colon[1]!)} (${colon[2]})`;
  const ench = /^ENCHANTMENT_(.+)_(\d+)$/.exec(id);
  if (ench) {
    const n = Number(ench[2]);
    return `${title(ench[1]!)} ${ROMAN[n] ?? n}`;
  }
  if (id.startsWith('SHARD_')) return `${title(id.slice(6))} Shard`;
  if (id.startsWith('ESSENCE_') && id.length > 8) return `${title(id.slice(8))} Essence`;
  return title(id) || id || '?';
}
