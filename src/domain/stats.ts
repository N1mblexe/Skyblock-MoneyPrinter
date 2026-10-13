// Small robust statistics helpers (final from Wave 0; package C may add more).

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/** Median absolute deviation. */
export function mad(xs: readonly number[], med = median(xs)): number {
  return median(xs.map((x) => Math.abs(x - med)));
}

/** Robust z-score; NaN when mad is 0 or not finite. */
export function robustZ(x: number, med: number, madv: number): number {
  return madv > 0 && Number.isFinite(madv) ? (0.6745 * (x - med)) / madv : NaN;
}

/** Relative change (b - a) / a; null when a <= 0 or not finite. */
export function pctChange(a: number, b: number): number | null {
  return a > 0 && Number.isFinite(a) && Number.isFinite(b) ? (b - a) / a : null;
}
