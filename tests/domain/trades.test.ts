import { describe, expect, it } from 'vitest';
import { byItem, profitOf, startOfDay, summarize, totals } from '../../src/domain/journal.ts';
import { lostTop, orderStatus } from '../../src/domain/orders.ts';
import type { JournalEntry, MyOrder } from '../../src/types/contracts.ts';
import { makeProduct } from './helpers.ts';

const L = (price: number, amount: number, orders = 1) => ({ price, amount, orders });
// bids high -> low, asks low -> high; 168,000 insta-sells and insta-buys a week = 1,000 / hour
const p = makeProduct({
  id: 'X',
  bids: [L(100, 500, 2), L(99.9, 1000, 3)],
  asks: [L(105, 300, 1), L(105.1, 700, 2)],
  instaBuysWeek: 168_000,
  instaSellsWeek: 168_000,
});
const order = (o: Partial<MyOrder>): MyOrder => ({ key: 'k', id: 'X', side: 'buy', price: 100, qty: 100, placedAt: 0, ...o });

describe('orderStatus', () => {
  it('buy order: top, tied, outbid', () => {
    // alone at the best price (the 500 at 100 are 100 of mine + 400 others in 2 orders -> tied)
    expect(orderStatus(order({ price: 100, qty: 100 }), p)).toMatchObject({ kind: 'tied', best: 100, ahead: 400, reprice: 100.1 });
    expect(orderStatus(order({ price: 100, qty: 500 }), makeProduct({ ...p, bids: [L(100, 500, 1), L(99, 10)] }))).toMatchObject({ kind: 'top', ahead: 0, reprice: null });
    const out = orderStatus(order({ price: 99.9, qty: 100 }), p);
    expect(out).toMatchObject({ kind: 'outbid', best: 100, reprice: 100.1 });
    expect(out.ahead).toBe(500 + 900); // the better level, plus the others at my price
    expect(out.etaHours).toBeCloseTo((1400 + 100) / 1000, 9);
  });

  it('sell offer: top, undercut', () => {
    expect(orderStatus(order({ side: 'sell', price: 105, qty: 300 }), p)).toMatchObject({ kind: 'top', best: 105, ahead: 0, reprice: null });
    expect(orderStatus(order({ side: 'sell', price: 105.1, qty: 100 }), p)).toMatchObject({ kind: 'undercut', best: 105, ahead: 300 + 600, reprice: 104.9 });
  });

  it('a price better than the whole book is top; no product is unknown', () => {
    expect(orderStatus(order({ price: 120 }), p).kind).toBe('top');
    expect(orderStatus(order({}), undefined).kind).toBe('unknown');
  });

  it('lostTop fires only on top/tied -> outbid/undercut', () => {
    expect(lostTop('top', 'outbid')).toBe(true);
    expect(lostTop('tied', 'undercut')).toBe(true);
    expect(lostTop(undefined, 'outbid')).toBe(false);
    expect(lostTop('outbid', 'outbid')).toBe(false);
    expect(lostTop('top', 'tied')).toBe(false);
  });
});

const entry = (e: Partial<JournalEntry>): JournalEntry => ({ key: 'e', id: 'A', qty: 10, buy: 100, sell: 150, tax: 0.0125, fees: 0, at: 0, source: 'manual', ...e });

describe('journal math', () => {
  it('profit = qty × sell × (1 − tax) − qty × buy − fees', () => {
    expect(profitOf(entry({}))).toBeCloseTo(10 * 150 * 0.9875 - 1000, 9);
    expect(profitOf(entry({ tax: 0, fees: 50 }))).toBeCloseTo(1500 - 1000 - 50, 9);
  });

  it('totals, ROI and periods', () => {
    const now = new Date(2026, 9, 15, 15, 0).getTime();
    const es = [
      entry({ key: '1', at: now - 3600_000 }), // today
      entry({ key: '2', at: startOfDay(now) - 1 }), // yesterday, within 7 days
      entry({ key: '3', at: now - 30 * 24 * 3600_000, id: 'B', sell: 50 }), // a month ago, a loss
    ];
    const t = totals(es);
    expect(t.trades).toBe(3);
    expect(t.profit).toBeCloseTo(t.revenue - t.cost, 9);
    expect(t.roi).toBeCloseTo(t.profit / 3000, 9);
    const s = summarize(es, now);
    expect([s.today.trades, s.week.trades, s.all.trades]).toEqual([1, 2, 3]);
    expect(byItem(es).map((x) => x.id)).toEqual(['A', 'B']);
    expect(totals([]).roi).toBeNull();
  });
});
