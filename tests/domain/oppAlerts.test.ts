import { describe, expect, it } from 'vitest';
import { evaluateOppAlerts, oppCandidates, oppMatches, type OppCandidate } from '../../src/domain/oppAlerts.ts';
import { parseOppRule } from '../../src/storage/local.ts';
import type { OppAlertRule } from '../../src/types/contracts.ts';
import { computeFlips } from '../../src/domain/flip.ts';
import { computeCrafts } from '../../src/domain/craft.ts';
import type { AhFlipRow } from '../../src/domain/ahFlips.ts';
import type { KatRow } from '../../src/domain/kat.ts';
import { ctx } from './helpers.ts';

const risk = (level: 'ok' | 'caution' | 'suspect') => ({ level, score: 0, flags: [] });
const cand = (key: string, pph: number, level: 'ok' | 'caution' | 'suspect' = 'ok', kind: OppCandidate['kind'] = 'flip'): OppCandidate => ({
  key: `${kind}:${key}`,
  kind,
  id: key,
  name: key,
  profitPerHour: pph,
  profit: pph / 10,
  margin: 0.1,
  risk: risk(level),
});
const rule = (o: Partial<OppAlertRule> = {}): OppAlertRule => ({ key: 'r', scope: ['flip'], metric: 'profitPerHour', value: 1000, maxRisk: 'ok', enabled: true, seen: [], hits: [], ...o });

describe('market alerts', () => {
  it('matches by kind, metric threshold and risk', () => {
    const cs = [cand('A', 2000), cand('B', 500), cand('C', 3000, 'caution'), cand('D', 9000, 'ok', 'craft'), cand('E', 9000, 'suspect')];
    expect(oppMatches(rule(), cs).map((c) => c.id)).toEqual(['A']);
    expect(oppMatches(rule({ maxRisk: 'caution' }), cs).map((c) => c.id)).toEqual(['A', 'C']);
    expect(oppMatches(rule({ scope: ['flip', 'craft'] }), cs).map((c) => c.id)).toEqual(['A', 'D']);
    expect(oppMatches(rule({ metric: 'margin', value: 0.05 }), cs).map((c) => c.id)).toEqual(['A', 'B']);
  });

  it('fires only for rows that newly meet the rule; a row that leaves and comes back fires again', () => {
    let rs = [rule()];
    const step = (cs: OppCandidate[], now: number) => {
      const res = evaluateOppAlerts(rs, cs, now);
      rs = res.rules;
      return res.fired.get('r')?.map((c) => c.id) ?? [];
    };
    expect(step([cand('A', 2000), cand('B', 5000)], 1)).toEqual(['B', 'A']); // best first
    expect(rs[0]!.hits.map((h) => h.id)).toEqual(['B', 'A']);
    expect(rs[0]!.lastFiredAt).toBe(1);
    expect(step([cand('A', 2100), cand('B', 5000)], 2)).toEqual([]);
    expect(step([cand('B', 5000)], 3)).toEqual([]); // A dropped out
    expect(step([cand('A', 2000), cand('B', 5000)], 4)).toEqual(['A']); // and came back
    const same = evaluateOppAlerts(rs, [cand('A', 2000), cand('B', 5000)], 5);
    expect(same.rules[0]).toBe(rs[0]); // nothing changed: same object
    expect(evaluateOppAlerts([rule({ enabled: false })], [cand('A', 2000)], 6).fired.size).toBe(0);
  });

  it('candidates come from every page with planner-style keys', () => {
    const c = ctx();
    const cs = oppCandidates({ flips: computeFlips(c), crafts: computeCrafts(c), chains: [], books: [], npc: [], kat: [] });
    expect(cs.some((x) => x.key.startsWith('flip:'))).toBe(true);
    expect(cs.some((x) => x.key.startsWith('craft:'))).toBe(true);
    for (const x of cs.filter((y) => y.kind === 'forge')) expect(x.key.startsWith('forge:')).toBe(true);
  });

  it('Kat runs: priced rows only, keyed by run (one pet has several)', () => {
    const k = (key: string, o: Partial<KatRow> = {}) =>
      ({ key, id: key.split('>')[0], name: 'Ocelot', profitPerHour: 5000, profit: 100_000, margin: 0.1, risk: risk('ok'), unpriced: [], ...o }) as KatRow;
    const cs = oppCandidates({ flips: [], crafts: [], chains: [], books: [], npc: [], kat: [k('OCELOT;3>4:any'), k('OCELOT;3>5:any'), k('OCELOT;3>4:max', { unpriced: ['X'] })] });
    expect(cs.map((x) => [x.key, x.kind, x.id])).toEqual([
      ['kat:OCELOT;3>4:any', 'kat', 'OCELOT;3'],
      ['kat:OCELOT;3>5:any', 'kat', 'OCELOT;3'],
    ]);
    expect(oppMatches(rule({ scope: ['kat'], metric: 'profit', value: 50_000 }), cs)).toHaveLength(2);
    expect(oppMatches(rule({ metric: 'profit', value: 50_000 }), cs)).toHaveLength(0); // flips only
  });

  it('AH and George flips are candidates of kind ahflip', () => {
    const r = (key: string) => ({ key, id: key.split(':')[1]!, name: 'Bee', profitPerHour: 50, profit: 400, margin: 4, risk: risk('ok') }) as unknown as AhFlipRow;
    const cs = oppCandidates({ flips: [], crafts: [], chains: [], books: [], npc: [], kat: [], ahFlips: [r('ah:HYPERION'), r('george:BEE;1')] });
    expect(cs.map((x) => [x.key, x.kind, x.id])).toEqual([
      ['ahflip:ah:HYPERION', 'ahflip', 'HYPERION'],
      ['ahflip:george:BEE;1', 'ahflip', 'BEE;1'],
    ]);
    expect(oppMatches(rule({ scope: ['ahflip'], metric: 'profit', value: 100 }), cs)).toHaveLength(2);
    expect(parseOppRule({ key: 'a', scope: ['ahflip'], metric: 'profit', value: 1 })!.scope).toEqual(['ahflip']);
  });

  it('stored rules: invalid fields dropped, defaults filled', () => {
    expect(parseOppRule({ key: 'x', scope: ['flip', 'nope'], metric: 'profitPerHour', value: 5 })).toEqual({
      key: 'x',
      scope: ['flip'],
      metric: 'profitPerHour',
      value: 5,
      maxRisk: 'ok',
      enabled: true,
      seen: [],
      hits: [],
    });
    expect(parseOppRule({ key: 'x', scope: [], metric: 'profitPerHour', value: 5 })).toBeNull();
    // a saved Kat rule (and its hits) survives a reload
    const kat = parseOppRule({ key: 'k', scope: ['kat'], metric: 'profit', value: 1, hits: [{ key: 'kat:A;3>4:any', kind: 'kat', id: 'A;3', name: 'A', value: 2, at: 1 }] });
    expect(kat).toMatchObject({ scope: ['kat'], hits: [{ key: 'kat:A;3>4:any', kind: 'kat' }] });
    expect(parseOppRule({ key: 'x', scope: ['flip'], metric: 'price', value: 5 })).toBeNull();
  });
});
