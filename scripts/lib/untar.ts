// Minimal in-memory tar(.gz) reader: ustar + pax (x/g) + GNU long names (L/K).
import { gunzipSync } from 'node:zlib';

export interface TarEntry {
  path: string;
  data: Buffer;
}

export interface TarResult {
  entries: TarEntry[];
  /** pax global header "comment" (git archive puts the commit SHA here) */
  globalComment?: string;
  total: number;
}

const BLOCK = 512;

function cstr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, len: number): number {
  // GNU base-256 encoding for large sizes
  if ((buf[start]! & 0x80) !== 0) {
    let v = 0;
    for (let i = start + 1; i < start + len; i++) v = v * 256 + buf[i]!;
    return v;
  }
  const s = cstr(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp < 0) break;
    const len = parseInt(data.subarray(pos, sp).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.subarray(sp + 1, pos + len - 1).toString('utf8'); // drop trailing \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** Read a .tar or .tar.gz buffer, keeping only regular files whose path passes `filter`. */
export function readTar(input: Buffer, filter: (path: string) => boolean): TarResult {
  const buf = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
  const entries: TarEntry[] = [];
  let globalComment: string | undefined;
  let nextPath: string | undefined;
  let total = 0;
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const dataStart = off + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'g') {
      const pax = parsePax(data);
      if (pax.comment) globalComment = pax.comment;
      continue;
    }
    if (type === 'x') {
      const pax = parsePax(data);
      if (pax.path) nextPath = pax.path;
      continue;
    }
    if (type === 'L') {
      nextPath = cstr(data, 0, data.length);
      continue;
    }
    if (type === 'K') continue;

    let path = nextPath;
    nextPath = undefined;
    if (!path) {
      const name = cstr(h, 0, 100);
      const prefix = cstr(h, 345, 155);
      path = prefix ? `${prefix}/${name}` : name;
    }
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    total++;
    if (filter(path)) entries.push({ path, data: Buffer.from(data) });
  }
  return { entries, globalComment, total };
}
