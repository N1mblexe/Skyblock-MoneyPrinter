// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../src/i18n/index.ts';
import { fmtAge, fmtCoins, fmtCompact, fmtHours, fmtInt, fmtPct } from '../../src/ui/format.ts';

// Normalize narrow/no-break spaces that Intl may emit.
const n = (s: string) => s.replace(/[  ]/g, ' ');

afterEach(() => setLang('tr'));

describe('format (tr)', () => {
  it('coins', () => {
    setLang('tr');
    expect(fmtCoins(1234567.6)).toBe('1.234.568');
    expect(fmtCoins(5.25)).toBe('5,3');
    expect(fmtCoins(0.1)).toBe('0,1');
    expect(fmtCoins(10)).toBe('10');
    expect(fmtCoins(null)).toBe('—');
    expect(fmtCoins(undefined)).toBe('—');
    expect(fmtCoins(NaN)).toBe('—');
    expect(fmtCoins(Infinity)).toBe('∞');
    expect(n(fmtCoins(2.5e9))).toMatch(/^2,5 ?Mr$/);
  });
  it('pct / int / compact', () => {
    setLang('tr');
    expect(fmtPct(0.123)).toBe('%12,3');
    expect(fmtPct(0.0125, 2)).toBe('%1,25');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(Infinity)).toBe('∞');
    expect(fmtInt(71680)).toBe('71.680');
    expect(n(fmtCompact(1234567))).toBe('1,2 Mn');
  });
  it('age / hours', () => {
    setLang('tr');
    expect(fmtAge(12_400)).toBe('12 sn');
    expect(fmtAge(-5)).toBe('0 sn');
    expect(fmtAge(3 * 60_000 + 5000)).toBe('3 dk');
    expect(fmtAge(2 * 3600_000)).toBe('2 sa');
    expect(fmtAge(3 * 86400_000)).toBe('3 gün');
    expect(fmtHours(0.75)).toBe('45 dk');
    expect(fmtHours(2.5)).toBe('2,5 sa');
    expect(fmtHours(72)).toBe('3 gün');
    expect(fmtHours(0.001)).toBe('<1 dk');
    expect(fmtHours(Infinity)).toBe('∞');
    expect(fmtHours(NaN)).toBe('—');
  });
});

describe('format (en)', () => {
  it('switches locale with setLang', () => {
    setLang('en');
    expect(fmtCoins(1234567.6)).toBe('1,234,568');
    expect(fmtCoins(5.25)).toBe('5.3');
    expect(fmtPct(0.123)).toBe('12.3%');
    expect(fmtInt(71680)).toBe('71,680');
    expect(fmtCompact(1234567)).toBe('1.2M');
    expect(fmtCoins(2.5e9)).toBe('2.5B');
    expect(fmtAge(12_400)).toBe('12s');
    expect(fmtAge(3 * 60_000)).toBe('3m');
    expect(fmtAge(2 * 3600_000)).toBe('2h');
    expect(fmtHours(0.75)).toBe('45m');
    expect(fmtHours(2.5)).toBe('2.5h');
    expect(fmtHours(72)).toBe('3d');
    setLang('tr');
    expect(fmtPct(0.123)).toBe('%12,3');
  });
});
