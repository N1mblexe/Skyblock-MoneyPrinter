/** Inline SVG polyline string (uses currentColor); fewer than 2 finite values => empty placeholder svg. */
export function sparklineSvg(values: readonly number[], opts?: { w?: number; h?: number; cls?: string }): string {
  const w = opts?.w ?? 80;
  const h = opts?.h ?? 20;
  const cls = opts?.cls ? `spark ${opts.cls}` : 'spark';
  const open = `<svg class="${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false">`;

  const pts: [number, number][] = [];
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) pts.push([i, v]);
  });
  if (pts.length < 2) return `<svg class="${cls} spark-empty" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false"></svg>`;

  const pad = 2;
  let min = Infinity;
  let max = -Infinity;
  for (const [, v] of pts) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const first = pts[0]![0];
  const last = pts[pts.length - 1]![0];
  const spanX = Math.max(1, last - first);
  const spanY = max - min;
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  const r = (n: number) => Math.round(n * 10) / 10;
  const xy = pts.map(([i, v]) => {
    const x = pad + ((i - first) / spanX) * iw;
    const y = spanY > 0 ? pad + (1 - (v - min) / spanY) * ih : h / 2;
    return [r(x), r(y)] as const;
  });
  const end = xy[xy.length - 1]!;
  return (
    open +
    `<polyline points="${xy.map((p) => `${p[0]},${p[1]}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${end[0]}" cy="${end[1]}" r="1.8" fill="currentColor"/></svg>`
  );
}
