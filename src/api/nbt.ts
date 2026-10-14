// Minimal Java NBT reader (big-endian, tag types 0-12) + Hypixel item_bytes helpers. Owner: market-apis package.

/** Plain JS value of an NBT tag. Longs become numbers (precision loss above 2^53 is fine for our use). */
export type NbtValue = number | string | NbtValue[] | NbtCompound | Int8Array | Int32Array | number[];
export interface NbtCompound {
  [key: string]: NbtValue;
}

const TAG = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 } as const;

const utf8 = new TextDecoder('utf-8');

class Reader {
  private pos = 0;
  private readonly view: DataView;
  constructor(private readonly buf: Uint8Array) {
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
    // Java "modified UTF-8" differs only for NUL and supplementary chars; plain UTF-8 is close enough here.
    return utf8.decode(this.buf.subarray(p, p + len));
  }
  len(): number {
    const n = this.i32();
    if (n < 0) throw new Error(`NBT: negative length ${n}`);
    return n;
  }

  payload(type: number, depth: number): NbtValue {
    if (depth > 512) throw new Error('NBT: nesting too deep');
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
        for (let i = 0; i < n; i++) out.push(this.payload(t, depth + 1));
        return out;
      }
      case TAG.COMPOUND: {
        const out: NbtCompound = {};
        for (;;) {
          const t = this.u8();
          if (t === TAG.END) return out;
          const name = this.str();
          out[name] = this.payload(t, depth + 1);
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

/** Parse uncompressed NBT. Returns the root compound's payload (its name is dropped); an empty root (TAG_End) gives {}. */
export function readNbt(bytes: Uint8Array): NbtCompound {
  const r = new Reader(bytes);
  const t = r.u8();
  if (t === TAG.END) return {};
  if (t !== TAG.COMPOUND) throw new Error(`NBT: root must be a compound, got tag ${t}`);
  r.str();
  return r.payload(TAG.COMPOUND, 0) as NbtCompound;
}

/** Decode standard base64 to bytes (atob exists in browsers, workers and Node >= 16). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Gunzip with DecompressionStream (browsers, workers and Node >= 18 share this one code path). */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const isCompound = (v: NbtValue | undefined): v is NbtCompound =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);

/** Decode an auction's item_bytes (base64 gzipped NBT) to the root compound `{i: [item, ...]}`. */
export async function decodeItemBytesRoot(b64: string): Promise<NbtCompound> {
  return readNbt(await gunzip(base64ToBytes(b64)));
}

/** First item's `tag.ExtraAttributes` of a decoded item_bytes root, or null. */
export function extraAttributes(root: NbtCompound): NbtCompound | null {
  const list = root.i;
  const item = Array.isArray(list) ? list[0] : undefined;
  const tag = isCompound(item) ? item.tag : undefined;
  const ea = isCompound(tag) ? tag.ExtraAttributes : undefined;
  return isCompound(ea) ? ea : null;
}

/** base64 -> gunzip -> NBT -> `i[0].tag.ExtraAttributes` (null when the item has none). */
export async function decodeItemBytes(b64: string): Promise<NbtCompound | null> {
  return extraAttributes(await decodeItemBytesRoot(b64));
}

/** Rarity order used by NEU pet ids `TYPE;INDEX` (COMMON=0 ... MYTHIC=5). */
export const PET_TIERS = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'] as const;

function petId(petInfo: NbtValue | undefined): string | null {
  let info: unknown = petInfo;
  if (typeof info === 'string') {
    try {
      info = JSON.parse(info);
    } catch {
      return null;
    }
  }
  if (typeof info !== 'object' || info === null) return null;
  const { type, tier } = info as { type?: unknown; tier?: unknown };
  if (typeof type !== 'string' || !type) return null;
  const idx = typeof tier === 'string' ? PET_TIERS.indexOf(tier.toUpperCase() as (typeof PET_TIERS)[number]) : -1;
  return idx < 0 ? type : `${type};${idx}`;
}

/**
 * SkyBlock id of an item, normalized to match catalog / bazaar ids:
 *  - PET: NEU style `TYPE;RARITYINDEX` from petInfo (COMMON=0 ... MYTHIC=5), e.g. `ENDER_DRAGON;4`, the same shape the
 *    catalog keeps for pets (`AMMONITE;4`). petInfo.tier is the pet's own tier: a Tier Boost held item raises only the
 *    displayed rarity, so a boosted EPIC dragon stays `ENDER_DRAGON;3`. Unknown tier -> `TYPE`; unreadable petInfo -> `PET`.
 *  - ENCHANTED_BOOK with exactly one enchant: `ENCHANTMENT_<NAME>_<LVL>` (bazaar id shape, e.g. ENCHANTMENT_ULTIMATE_WISE_5)
 *  - otherwise ExtraAttributes.id as is (null when missing)
 * Accepts either the decoded item_bytes root (`{i:[...]}`) or an ExtraAttributes compound.
 */
export function skyblockIdFromNbt(root: NbtCompound | null): string | null {
  if (!root) return null;
  const ea = 'i' in root ? extraAttributes(root) : root;
  if (!ea) return null;
  const id = ea.id;
  if (typeof id !== 'string' || !id) return null;
  if (id === 'PET') return petId(ea.petInfo) ?? id;
  if (id === 'ENCHANTED_BOOK') {
    const ench = ea.enchantments;
    if (isCompound(ench)) {
      const keys = Object.keys(ench);
      const lvl = ench[keys[0]!];
      if (keys.length === 1 && typeof lvl === 'number') return `ENCHANTMENT_${keys[0]!.toUpperCase()}_${lvl}`;
    }
  }
  return id;
}
