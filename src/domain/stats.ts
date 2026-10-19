// Small robust statistics helpers: the one median / MAD implementation (typed-array, in place) and array wrappers.

/**
 * k-th smallest of a[0..n) (Wirth's selection, O(n) on average, reorders a): afterwards a[0..k) <= a[k].
 * a must not contain NaN.
 */
function select(a: Float64Array, n: number, k: number): number {
  let l = 0;
  let r = n - 1;
  while (l < r) {
    const x = a[k]!;
    let i = l;
    let j = r;
    do {
      while (a[i]! < x) i++;
      while (x < a[j]!) j--;
      if (i <= j) {
        const tmp = a[i]!;
        a[i] = a[j]!;
        a[j] = tmp;
        i++;
        j--;
      }
    } while (i <= j);
    if (j < k) l = i;
    if (k < i) r = j;
  }
  return a[k]!;
}

/** Median of a[0..n) by selection (reorders a), without a sort. NaN when n = 0. a must not contain NaN. */
export function medianInPlace(a: Float64Array, n: number): number {
  if (n <= 0) return NaN;
  const m = n >> 1;
  const hi = select(a, n, m);
  if (n % 2) return hi;
  let lo = -Infinity;
  for (let i = 0; i < m; i++) if (a[i]! > lo) lo = a[i]!;
  return (lo + hi) / 2;
}

/** [median, MAD] of a[0..n) (overwrites a). [NaN, NaN] when n = 0. */
export function medMadInPlace(a: Float64Array, n: number): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const med = medianInPlace(a, n);
  for (let i = 0; i < n; i++) a[i] = Math.abs(a[i]! - med);
  return [med, medianInPlace(a, n)];
}

/** Median of xs (not modified); NaN when empty. */
export function median(xs: readonly number[]): number {
  return medianInPlace(Float64Array.from(xs), xs.length);
}

/** Median absolute deviation. */
export function mad(xs: readonly number[], med = median(xs)): number {
  const a = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) a[i] = Math.abs(xs[i]! - med);
  return medianInPlace(a, a.length);
}

/** Robust z-score; NaN when mad is 0 or not finite. */
export function robustZ(x: number, med: number, madv: number): number {
  return madv > 0 && Number.isFinite(madv) ? (0.6745 * (x - med)) / madv : NaN;
}

/** Relative change (b - a) / a; null when a <= 0 or not finite. */
export function pctChange(a: number, b: number): number | null {
  return a > 0 && Number.isFinite(a) && Number.isFinite(b) ? (b - a) / a : null;
}
