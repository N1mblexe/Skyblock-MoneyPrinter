// Tiny NBT writer for synthetic item_bytes (test-only), shared by the api tests.
import { gzipSync } from 'node:zlib';

export type W = { t: number; v: unknown };
export const byte = (v: number): W => ({ t: 1, v });
export const short = (v: number): W => ({ t: 2, v });
export const int = (v: number): W => ({ t: 3, v });
export const long = (v: bigint): W => ({ t: 4, v });
export const float = (v: number): W => ({ t: 5, v });
export const double = (v: number): W => ({ t: 6, v });
export const bytes = (v: number[]): W => ({ t: 7, v });
export const str = (v: string): W => ({ t: 8, v });
export const list = (t: number, v: W[]): W => ({ t: 9, v: { t, items: v } });
export const comp = (v: Record<string, W>): W => ({ t: 10, v });
export const ints = (v: number[]): W => ({ t: 11, v });
export const longs = (v: bigint[]): W => ({ t: 12, v });

function enc(w: W, out: number[]): void {
  const b = (size: number, fn: (dv: DataView) => void) => {
    const dv = new DataView(new ArrayBuffer(size));
    fn(dv);
    out.push(...new Uint8Array(dv.buffer));
  };
  const s = (x: string) => {
    const u = new TextEncoder().encode(x);
    b(2, (d) => d.setUint16(0, u.length));
    out.push(...u);
  };
  const v = w.v as never;
  switch (w.t) {
    case 1: return b(1, (d) => d.setInt8(0, v));
    case 2: return b(2, (d) => d.setInt16(0, v));
    case 3: return b(4, (d) => d.setInt32(0, v));
    case 4: return b(8, (d) => d.setBigInt64(0, v));
    case 5: return b(4, (d) => d.setFloat32(0, v));
    case 6: return b(8, (d) => d.setFloat64(0, v));
    case 7: {
      const a = v as number[];
      b(4, (d) => d.setInt32(0, a.length));
      for (const x of a) b(1, (d) => d.setInt8(0, x));
      return;
    }
    case 8: return s(v);
    case 9: {
      const l = v as { t: number; items: W[] };
      out.push(l.t);
      b(4, (d) => d.setInt32(0, l.items.length));
      for (const it of l.items) enc(it, out);
      return;
    }
    case 10: {
      for (const [k, c] of Object.entries(v as Record<string, W>)) {
        out.push(c.t);
        s(k);
        enc(c, out);
      }
      out.push(0);
      return;
    }
    case 11: {
      const a = v as number[];
      b(4, (d) => d.setInt32(0, a.length));
      for (const x of a) b(4, (d) => d.setInt32(0, x));
      return;
    }
    case 12: {
      const a = v as bigint[];
      b(4, (d) => d.setInt32(0, a.length));
      for (const x of a) b(8, (d) => d.setBigInt64(0, x));
      return;
    }
  }
}

export function nbt(root: Record<string, W>, name = ''): Uint8Array {
  const out = [10];
  const u = new TextEncoder().encode(name);
  out.push(u.length >> 8, u.length & 255, ...u);
  enc(comp(root), out);
  return Uint8Array.from(out);
}

/** item_bytes-like base64 for one item with these ExtraAttributes. */
export function itemB64(ea: Record<string, W>): string {
  const root = nbt({ i: list(10, [comp({ id: short(403), Count: byte(1), tag: comp({ ExtraAttributes: comp(ea) }) })]) });
  return gzipSync(root).toString('base64');
}
