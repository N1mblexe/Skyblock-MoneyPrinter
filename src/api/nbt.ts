// Minimal Java NBT reader (big-endian, tag types 0-12) + Hypixel item_bytes helpers. Owner: s1/ahdata.
import { gunzipSync } from 'fflate';
import { neuItemId, stripFormatting } from '../domain/ids.ts';

/** Plain JS value of an NBT tag. Longs become numbers (precision loss above 2^53 is fine for our use). */
export type NbtValue = number | string | NbtValue[] | NbtCompound | Int8Array | Int32Array | number[];
export interface NbtCompound {
  [key: string]: NbtValue;
}

/** readNbt options. */
export interface ReadNbtOptions {
  /**
   * Tags read past without building their values: `name` skips a tag of that name at any depth, `parent.child` only a
   * `child` directly inside a compound named `parent` (so `display.Lore` keeps `display.Name`). Skipped bytes are still
   * bounds-checked.
   */
  skip?: readonly string[];
}

const TAG = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 } as const;
/** payload width of the fixed-size tag types (0 for the others) */
const WIDTH: readonly number[] = [0, 1, 2, 4, 8, 4, 8, 0, 0, 0, 0, 0, 0];
const MAX_DEPTH = 512;

const utf8 = new TextDecoder('utf-8');

interface SkipRules {
  any: ReadonlySet<string>;
  inside: ReadonlyMap<string, ReadonlySet<string>>;
}

function skipRules(skip: readonly string[] | undefined): SkipRules | null {
  if (!skip?.length) return null;
  const any = new Set<string>();
  const inside = new Map<string, Set<string>>();
  for (const s of skip) {
    const dot = s.indexOf('.');
    if (dot < 0) {
      any.add(s);
      continue;
    }
    const parent = s.slice(0, dot);
    const set = inside.get(parent) ?? new Set<string>();
    set.add(s.slice(dot + 1));
    inside.set(parent, set);
  }
  return { any, inside };
}

class Reader {
  private pos = 0;
  private readonly view: DataView;
  constructor(
    private readonly buf: Uint8Array,
    private readonly rules: SkipRules | null = null,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): number {
    const p = this.pos;
    if (n < 0 || p + n > this.buf.length) throw new Error(`NBT: unexpected end of data at ${p} (+${n})`);
    this.pos += n;
    return p;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  i8(): number {
    return this.view.getInt8(this.need(1));
  }
  i16(): number {
    return this.view.getInt16(this.need(2));
  }
  u16(): number {
    return this.view.getUint16(this.need(2));
  }
  i32(): number {
    return this.view.getInt32(this.need(4));
  }
  i64(): number {
    return Number(this.view.getBigInt64(this.need(8)));
  }
  f32(): number {
    return this.view.getFloat32(this.need(4));
  }
  f64(): number {
    return this.view.getFloat64(this.need(8));
  }
  str(): string {
    const len = this.u16();
    const p = this.need(len);
    // Tag names and most values are short ASCII: build those directly (each TextDecoder call has a fixed cost).
    if (len <= 32) {
      let s = '';
      for (let i = p; i < p + len; i++) {
        const c = this.buf[i]!;
        if (c >= 0x80) return utf8.decode(this.buf.subarray(p, p + len));
        s += String.fromCharCode(c);
      }
      return s;
    }
    // Java "modified UTF-8" differs only for NUL and supplementary chars; plain UTF-8 is close enough here.
    return utf8.decode(this.buf.subarray(p, p + len));
  }
  len(): number {
    const n = this.i32();
    if (n < 0) throw new Error(`NBT: negative length ${n}`);
    return n;
  }

  private skipped(rules: SkipRules, parent: string, name: string): boolean {
    return rules.any.has(name) || rules.inside.get(parent)?.has(name) === true;
  }

  /** Read past one payload of `type` without building it. */
  skip(type: number, depth: number): void {
    if (depth > MAX_DEPTH) throw new Error('NBT: nesting too deep');
    const w = WIDTH[type] ?? 0;
    if (w) {
      this.need(w);
      return;
    }
    switch (type) {
      case TAG.BYTE_ARRAY:
        this.need(this.len());
        return;
      case TAG.STRING:
        this.need(this.u16());
        return;
      case TAG.LIST: {
        const t = this.u8();
        const n = this.len();
        const tw = WIDTH[t] ?? 0;
        if (tw) this.need(n * tw);
        else for (let i = 0; i < n; i++) this.skip(t, depth + 1);
        return;
      }
      case TAG.COMPOUND:
        for (;;) {
          const t = this.u8();
          if (t === TAG.END) return;
          this.need(this.u16());
          this.skip(t, depth + 1);
        }
      case TAG.INT_ARRAY:
        this.need(this.len() * 4);
        return;
      case TAG.LONG_ARRAY:
        this.need(this.len() * 8);
        return;
      default:
        throw new Error(`NBT: unknown tag type ${type}`);
    }
  }

  /** `name` is the tag's own name ('' for list elements and the root), for the `parent.child` skip rules. */
  payload(type: number, depth: number, name: string): NbtValue {
    if (depth > MAX_DEPTH) throw new Error('NBT: nesting too deep');
    switch (type) {
      case TAG.BYTE:
        return this.i8();
      case TAG.SHORT:
        return this.i16();
      case TAG.INT:
        return this.i32();
      case TAG.LONG:
        return this.i64();
      case TAG.FLOAT:
        return this.f32();
      case TAG.DOUBLE:
        return this.f64();
      case TAG.BYTE_ARRAY: {
        const n = this.len();
        const p = this.need(n);
        return Int8Array.from(this.buf.subarray(p, p + n), (b) => (b << 24) >> 24);
      }
      case TAG.STRING:
        return this.str();
      case TAG.LIST: {
        const t = this.u8();
        const n = this.len();
        const out: NbtValue[] = [];
        for (let i = 0; i < n; i++) out.push(this.payload(t, depth + 1, ''));
        return out;
      }
      case TAG.COMPOUND: {
        const out: NbtCompound = {};
        const rules = this.rules;
        for (;;) {
          const t = this.u8();
          if (t === TAG.END) return out;
          const key = this.str();
          if (rules && this.skipped(rules, name, key)) this.skip(t, depth + 1);
          else out[key] = this.payload(t, depth + 1, key);
        }
      }
      case TAG.INT_ARRAY: {
        const n = this.len();
        const a = new Int32Array(n);
        for (let i = 0; i < n; i++) a[i] = this.i32();
        return a;
      }
      case TAG.LONG_ARRAY: {
        const n = this.len();
        const a: number[] = [];
        for (let i = 0; i < n; i++) a.push(this.i64());
        return a;
      }
      default:
        throw new Error(`NBT: unknown tag type ${type}`);
    }
  }
}

/**
 * Parse uncompressed NBT. Returns the root compound's payload (its name is dropped); an empty root (TAG_End) gives {}.
 * `opts.skip` reads past the named tags without building them (see ReadNbtOptions).
 */
export function readNbt(bytes: Uint8Array, opts?: ReadNbtOptions): NbtCompound {
  const r = new Reader(bytes, skipRules(opts?.skip));
  const t = r.u8();
  if (t === TAG.END) return {};
  if (t !== TAG.COMPOUND) throw new Error(`NBT: root must be a compound, got tag ${t}`);
  r.str();
  return r.payload(TAG.COMPOUND, 0, '') as NbtCompound;
}

/** What the AH scan reads past: display (listings are named by item_name) and SkullOwner (texture blobs). */
export const SCAN_SKIP: readonly string[] = ['display', 'SkullOwner'];
/** What the sales feed reads past: it needs display.Name (pet levels) but not the Lore or the textures. */
export const SALES_SKIP: readonly string[] = ['display.Lore', 'SkullOwner'];

/** Decode standard base64 to bytes (atob exists in browsers, workers and Node >= 16). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Gunzip synchronously with fflate (one call per item: no stream, Blob or promise per auction). */
export function gunzipBytes(bytes: Uint8Array): Uint8Array {
  return gunzipSync(bytes);
}

/** Async wrapper of gunzipBytes, for callers that await (rejects instead of throwing). */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return gunzipBytes(bytes);
}

const isCompound = (v: NbtValue | undefined): v is NbtCompound =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);

/** Decode an auction's item_bytes (base64 gzipped NBT) to the root compound `{i: [item, ...]}`, synchronously. */
export function decodeRoot(b64: string, opts?: ReadNbtOptions): NbtCompound {
  return readNbt(gunzipBytes(base64ToBytes(b64)), opts);
}

/** Async decodeRoot (rejects instead of throwing). */
export async function decodeItemBytesRoot(b64: string, opts?: ReadNbtOptions): Promise<NbtCompound> {
  return decodeRoot(b64, opts);
}

const firstItem = (root: NbtCompound): NbtCompound | null => {
  const list = root.i;
  const item = Array.isArray(list) ? list[0] : undefined;
  return isCompound(item) ? item : null;
};

/** First item's `tag.ExtraAttributes` of a decoded item_bytes root, or null. */
export function extraAttributes(root: NbtCompound): NbtCompound | null {
  const tag = firstItem(root)?.tag;
  const ea = isCompound(tag) ? tag.ExtraAttributes : undefined;
  return isCompound(ea) ? ea : null;
}

/** base64 -> gunzip -> NBT -> `i[0].tag.ExtraAttributes` (null when the item has none). */
export async function decodeItemBytes(b64: string, opts?: ReadNbtOptions): Promise<NbtCompound | null> {
  return extraAttributes(decodeRoot(b64, opts));
}

/** Stack size of a decoded item_bytes root: `i[0].Count`, 1 when missing or not a positive integer. */
export function itemCount(root: NbtCompound): number {
  const c = firstItem(root)?.Count;
  return typeof c === 'number' && Number.isInteger(c) && c > 0 ? c : 1;
}

/** `i[0].tag.display.Name` of a decoded item_bytes root with § codes stripped, or '' (e.g. "[Lvl 100] Ender Dragon"). */
export function itemName(root: NbtCompound): string {
  const tag = firstItem(root)?.tag;
  const display = isCompound(tag) ? tag.display : undefined;
  const name = isCompound(display) ? display.Name : undefined;
  return typeof name === 'string' ? stripFormatting(name) : '';
}

/** Rarity order used by NEU pet ids `TYPE;INDEX` (COMMON=0 ... MYTHIC=5). */
export const PET_TIERS = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'] as const;

/** petInfo (a JSON string on live items, a compound in some dumps) as a plain object, or null. */
function parsePetInfo(petInfo: NbtValue | undefined): Record<string, unknown> | null {
  let info: unknown = petInfo;
  if (typeof info === 'string') {
    try {
      info = JSON.parse(info);
    } catch {
      return null;
    }
  }
  return typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : null;
}

function petId(info: Record<string, unknown> | null): string | null {
  if (!info) return null;
  const { type, tier } = info;
  if (typeof type !== 'string' || !type) return null;
  const idx = typeof tier === 'string' ? PET_TIERS.indexOf(tier.toUpperCase() as (typeof PET_TIERS)[number]) : -1;
  return idx < 0 ? type : `${type};${idx}`;
}

/** The petInfo fields the AH scan reads. */
export interface PetInfo {
  /** e.g. ENDER_DRAGON */
  type: string;
  /** the pet's own rarity, upper-cased ('' when missing); a Tier Boost does not change it */
  tier: string;
  /** total pet XP (0 when missing or not a finite number ≥ 0) */
  exp: number;
  /** held item id, e.g. PET_ITEM_TIER_BOOST */
  heldItem?: string;
  /** skin id, e.g. BLACK_CAT_PURRANORMAL */
  skin?: string;
}

/**
 * petInfo of a PET item; null for other items and for an unreadable petInfo or one without a type (the cases where
 * skyblockIdFromNbt falls back to `PET`). Accepts the same inputs as skyblockIdFromNbt.
 */
export function petInfoFromNbt(root: NbtCompound | null): PetInfo | null {
  return itemFromNbt(root).pet;
}

function petFields(info: Record<string, unknown> | null): PetInfo | null {
  if (!info) return null;
  const { type, tier, exp, heldItem, skin } = info;
  if (typeof type !== 'string' || !type) return null;
  return {
    type,
    tier: typeof tier === 'string' ? tier.toUpperCase() : '',
    exp: typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp : 0,
    ...(typeof heldItem === 'string' && heldItem ? { heldItem } : {}),
    ...(typeof skin === 'string' && skin ? { skin } : {}),
  };
}

/** NEU's internal id for RUNE / UNIQUE_RUNE / POTION items (src/domain/ids.ts `neuItemId`, shared with the catalog). */
export function neuItemIdForScan(id: string, ea: NbtCompound): string {
  return neuItemId(id, ea);
}

/**
 * SkyBlock id of an item, normalized to match catalog / bazaar ids:
 *  - PET: NEU style `TYPE;RARITYINDEX` from petInfo (COMMON=0 ... MYTHIC=5), e.g. `ENDER_DRAGON;4`, the same shape the
 *    catalog keeps for pets (`AMMONITE;4`). petInfo.tier is the pet's own tier: a Tier Boost held item raises only the
 *    displayed rarity, so a boosted EPIC dragon stays `ENDER_DRAGON;3`. Unknown tier -> `TYPE`; unreadable petInfo -> `PET`.
 *  - ENCHANTED_BOOK with exactly one enchant: `ENCHANTMENT_<NAME>_<LVL>` (bazaar id shape, e.g. ENCHANTMENT_ULTIMATE_WISE_5)
 *  - RUNE / UNIQUE_RUNE / POTION: NEU's ids (neuItemIdForScan), e.g. `MUSIC_RUNE;3`, `POTION_CRITICAL;4`,
 *    `POTION_AWKWARD`, `WATER_BOTTLE`
 *  - otherwise ExtraAttributes.id as is (null when missing)
 * Accepts either the decoded item_bytes root (`{i:[...]}`) or an ExtraAttributes compound.
 */
export function skyblockIdFromNbt(root: NbtCompound | null): string | null {
  return itemFromNbt(root).id;
}

/**
 * skyblockIdFromNbt and petInfoFromNbt in one pass (one ExtraAttributes lookup, one petInfo parse), for the AH scan.
 * Same inputs.
 */
export function itemFromNbt(root: NbtCompound | null): { id: string | null; pet: PetInfo | null } {
  const none = { id: null, pet: null };
  if (!root) return none;
  const ea = 'i' in root ? extraAttributes(root) : root;
  if (!ea) return none;
  const id = ea.id;
  if (typeof id !== 'string' || !id) return none;
  switch (id) {
    case 'PET': {
      const info = parsePetInfo(ea.petInfo);
      return { id: petId(info) ?? id, pet: petFields(info) };
    }
    case 'ENCHANTED_BOOK': {
      const ench = ea.enchantments;
      if (isCompound(ench)) {
        const keys = Object.keys(ench);
        const lvl = ench[keys[0]!];
        if (keys.length === 1 && typeof lvl === 'number') return { id: `ENCHANTMENT_${keys[0]!.toUpperCase()}_${lvl}`, pet: null };
      }
      return { id, pet: null };
    }
    case 'RUNE':
    case 'UNIQUE_RUNE':
    case 'POTION':
      return { id: neuItemIdForScan(id, ea), pet: null };
    default:
      return { id, pet: null };
  }
}
