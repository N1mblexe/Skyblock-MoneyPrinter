import { describe, expect, it } from 'vitest';
import { evaluateOppAlerts, oppCandidates, oppMatches, type OppCandidate } from '../../src/domain/oppAlerts.ts';
import { parseOppRule } from '../../src/storage/local.ts';
import type { OppAlertRule } from '../../src/types/contracts.ts';
import { computeFlips } from '../../src/domain/flip.ts';
import { computeCrafts } from '../../src/domain/craft.ts';
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
    const cs = oppCandidates({ flips: computeFlips(c), crafts: computeCrafts(c), chains: [], books: [], npc: [] });
    expect(cs.some((x) => x.key.startsWith('flip:'))).toBe(true);
    expect(cs.some((x) => x.key.startsWith('craft:'))).toBe(true);
    for (const x of cs.filter((y) => y.kind === 'forge')) expect(x.key.startsWith('forge:')).toBe(true);
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
    expect(parseOppRule({ key: 'x', scope: ['flip'], metric: 'price', value: 5 })).toBeNull();
  });
});
