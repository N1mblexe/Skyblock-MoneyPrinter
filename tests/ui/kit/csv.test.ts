import { describe, expect, it } from 'vitest';
import { csvCell, csvFileName, csvNumber, toCsv } from '../../../src/ui/kit/csv.ts';

describe('csv', () => {
  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('cr\rlf')).toBe('"cr\rlf"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('')).toBe('');
  });

  it('formats numbers locale-independently with "." decimals', () => {
    expect(csvNumber(1234567.5)).toBe('1234567.5');
    expect(csvNumber(-0.125)).toBe('-0.125');
    expect(csvNumber(0.1 + 0.2)).toBe('0.3');
    expect(csvNumber(1e-9)).toBe('0');
    expect(csvNumber(42)).toBe('42');
    expect(csvNumber(NaN)).toBe('');
    expect(csvNumber(Infinity)).toBe('');
    expect(csvCell(1234.5)).toBe('1234.5');
  });

  it('guards formula-like text but keeps signed numbers', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('+3.5')).toBe('+3.5');
    expect(csvCell('-x')).toBe("'-x");
  });

  it('builds header + rows with CRLF', () => {
    const cols = [
      { label: () => 'Name', get: (r: { n: string; v: number }) => r.n },
      { label: () => 'Value, coins', get: (r: { n: string; v: number }) => r.v, csv: (r: { n: string; v: number }) => r.v * 2 },
      { label: () => 'Skip', get: () => null, csv: false as const },
    ];
    expect(toCsv(cols, [{ n: 'Gold "ingot"', v: 1.5 }])).toBe('Name,"Value, coins"\r\n"Gold ""ingot""",3\r\n');
    expect(toCsv(cols, [])).toBe('Name,"Value, coins"\r\n');
  });

  it('file name is name-YYYYMMDD-HHmm.csv', () => {
    expect(csvFileName('flips', new Date(2026, 0, 5, 7, 3))).toBe('flips-20260105-0703.csv');
  });
});
