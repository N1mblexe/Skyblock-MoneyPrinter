import type { Catalog, ItemInfo } from '../types/contracts.ts';
import { deriveName, neuToBazaarId } from './ids.ts';

const TR_MAP: Record<string, string> = { ı: 'i', İ: 'i', I: 'i' };

/** Lowercase, strip diacritics (incl. Turkish ı/İ/ş/ğ/ç/ö/ü), '_' -> ' ', collapse spaces. */
export function normalizeText(s: string): string {
  return s
    .replace(/[ıİI]/g, (c) => TR_MAP[c]!)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const nameOf = (catalog: Catalog | null, id: string) => (catalog ? catalog.name(id) : deriveName(id));

/** True if q (any case) matches the item's name or id. Empty q matches everything. */
export function matchesQuery(catalog: Catalog | null, id: string, q: string): boolean {
  const nq = normalizeText(q);
  if (!nq) return true;
  return normalizeText(nameOf(catalog, id)).includes(nq) || normalizeText(id).includes(nq);
}

/** 0 exact, 1 prefix, 2 word-prefix, 3 substring, Infinity no match. */
function rank(text: string, nq: string): number {
  if (text === nq) return 0;
  if (text.startsWith(nq)) return 1;
  const at = text.indexOf(nq);
  if (at < 0) return Infinity;
  if (text.includes(' ' + nq) || text.includes(':' + nq)) return 2;
  return 3;
}

/** Ranked search over catalog items: exact > prefix > word-prefix > substring; ties by name. */
export function searchItems(catalog: Catalog, q: string, limit = 50, filter?: (i: ItemInfo) => boolean): ItemInfo[] {
  const nq = normalizeText(q);
  const hits: { item: ItemInfo; r: number; name: string }[] = [];
  for (const item of Object.values(catalog.items)) {
    if (filter && !filter(item)) continue;
    const name = item.name || catalog.name(item.id);
    const r = nq ? Math.min(rank(normalizeText(name), nq), rank(normalizeText(item.id), nq)) : 0;
    if (r === Infinity) continue;
    hits.push({ item, r, name });
  }
  hits.sort((a, b) => a.r - b.r || a.name.localeCompare(b.name) || a.item.id.localeCompare(b.item.id));
  return hits.slice(0, Math.max(0, limit)).map((h) => h.item);
}

/** Resolve user text (exact display name, bazaar id, or NEU id) to a bazaar product id; null if none. */
export function resolveUserInput(catalog: Catalog, text: string, bazaarIds?: ReadonlySet<string>): string | null {
  const t = text.trim();
  if (!t) return null;
  const set = bazaarIds ?? new Set(Object.values(catalog.items).filter((i) => i.bazaar).map((i) => i.id));

  const upper = t.toUpperCase();
  for (const cand of [upper, upper.replace(/\s+/g, '_')]) if (set.has(cand)) return cand;

  const nt = normalizeText(t);
  for (const id of set) if (normalizeText(catalog.name(id)) === nt) return id;

  try {
    const id = neuToBazaarId(upper, set);
    if (set.has(id)) return id;
  } catch {
    // ids.ts not ready / unparseable input: fall through
  }
  return null;
}
