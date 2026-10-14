import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { pickAuctions, trimBazaar, type RawAuction } from '../../scripts/lib/fixtures.ts';
import type { RawBazaar, RawOrder, RawProduct } from '../../src/types/api.ts';

const fx = (p: string) => fileURLToPath(new URL(`../fixtures/${p}`, import.meta.url));
const orders = (n: number): RawOrder[] => Array.from({ length: n }, (_, i) => ({ amount: 1, pricePerUnit: 10 + i, orders: 1 }));
const product = (id: string, n: number): RawProduct =>
  ({ product_id: id, sell_summary: orders(n), buy_summary: orders(n), quick_status: { productId: id } }) as unknown as RawProduct;

describe('trimBazaar', () => {
  const raw: RawBazaar = { success: true, lastUpdated: 123, products: { A: product('A', 8), B: product('B', 2) } };

  it('cuts books to N levels without touching the input', () => {
    const t = trimBazaar(raw, 5);
    expect(t.lastUpdated).toBe(123);
    expect(t.products.A!.sell_summary).toHaveLength(5);
    expect(t.products.A!.buy_summary).toHaveLength(5);
    expect(t.products.B!.sell_summary).toHaveLength(2);
    expect(raw.products.A!.sell_summary).toHaveLength(8);
  });

  it('optionally keeps only some ids', () => {
    expect(Object.keys(trimBazaar(raw, 1, new Set(['B', 'Z'])).products)).toEqual(['B']);
  });
});

describe('pickAuctions', () => {
  const a = (i: number, bin: boolean, name: string, pad = 0): RawAuction => ({ uuid: `u${i}`, item_name: name, item_bytes: 'H4sI' + 'x'.repeat(pad), bin });
  const page: RawAuction[] = [
    a(0, false, 'Hat'),
    a(1, true, 'Sword'),
    a(2, true, 'Sword'),
    a(3, true, '[Lvl 1] Bee'),
    a(4, true, 'Enchanted Book'),
    { uuid: 'nobytes', item_name: 'Ghost', bin: true },
    a(5, true, 'Helmet', 2000),
    a(6, false, 'Boots'),
    a(7, true, 'Enchanted Book'),
  ];

  it('prefers pets / books / distinct names and keeps page order', () => {
    const out = pickAuctions(page, { bin: 4, nonBin: 1, maxBytes: 1e6 });
    expect(out.map((x) => x.uuid)).toEqual(['u0', 'u1', 'u3', 'u4', 'u7']);
  });

  it('fills with duplicates when distinct names run out and never takes auctions without item_bytes', () => {
    const out = pickAuctions(page, { bin: 10, nonBin: 10, maxBytes: 1e6 });
    expect(out.map((x) => x.uuid)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
  });

  it('drops the largest auctions to fit the byte budget', () => {
    const out = pickAuctions(page, { bin: 10, nonBin: 10, maxBytes: 600 });
    expect(out.some((x) => x.uuid === 'u5')).toBe(false);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(600);
  });
});

describe('committed smoke fixtures', () => {
  it('smoke/bazaar.json.gz has every product with ≤5 levels per side', () => {
    const raw = JSON.parse(gunzipSync(readFileSync(fx('smoke/bazaar.json.gz'))).toString('utf8')) as RawBazaar;
    expect(raw.success).toBe(true);
    const ps = Object.values(raw.products);
    expect(ps.length).toBeGreaterThan(1000);
    expect(ps.every((p) => p.sell_summary.length <= 5 && p.buy_summary.length <= 5)).toBe(true);
  });

  it('ah-page.json is small and has BIN auctions with item_bytes plus non-BIN ones', () => {
    const buf = readFileSync(fx('ah-page.json'));
    expect(buf.length).toBeLessThanOrEqual(150 * 1024);
    const page = JSON.parse(buf.toString('utf8')) as { success: boolean; auctions: RawAuction[]; totalAuctions: number };
    expect(page.success).toBe(true);
    expect(page.totalAuctions).toBe(page.auctions.length);
    expect(page.auctions.filter((x) => x.bin && typeof x.item_bytes === 'string').length).toBeGreaterThanOrEqual(5);
    expect(page.auctions.some((x) => !x.bin)).toBe(true);
  });

  it('election.json is a live election snapshot', () => {
    const e = JSON.parse(readFileSync(fx('election.json'), 'utf8')) as { success: boolean; mayor: { name: string; perks: unknown[] } };
    expect(e.success).toBe(true);
    expect(typeof e.mayor.name).toBe('string');
    expect(Array.isArray(e.mayor.perks)).toBe(true);
  });
});
