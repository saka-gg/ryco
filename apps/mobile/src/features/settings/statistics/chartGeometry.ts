export interface PlotPoint {
  readonly x: number;
  readonly y: number;
}
/** Monotone cubic Hermite interpolation: smooth curves without overshooting daily extrema. */
export function monotonePath(points: readonly PlotPoint[]): string {
  if (!points.length) return "";
  if (points.length === 1) return `M${points[0]!.x},${points[0]!.y}`;
  const slopes = points
    .slice(1)
    .map((point, index) => (point.y - points[index]!.y) / (point.x - points[index]!.x));
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0]!;
    if (index === points.length - 1) return slopes.at(-1)!;
    const before = slopes[index - 1]!;
    const after = slopes[index]!;
    if (before * after <= 0) return 0;
    const h0 = points[index]!.x - points[index - 1]!.x;
    const h1 = points[index + 1]!.x - points[index]!.x;
    const average = (before * h1 + after * h0) / (h0 + h1);
    return (
      (Math.sign(before) + Math.sign(after)) *
      Math.min(Math.abs(before), Math.abs(after), Math.abs(average) / 2)
    );
  });
  // Same one-sided endpoint slopes used by the desktop's monotone curve.
  if (points.length > 2) {
    tangents[0] = (3 * slopes[0]! - tangents[1]!) / 2;
    tangents[points.length - 1] = (3 * slopes.at(-1)! - tangents.at(-2)!) / 2;
  }
  let path = `M${points[0]!.x},${points[0]!.y}`;
  for (let index = 1; index < points.length; index++) {
    const before = points[index - 1]!;
    const after = points[index]!;
    const third = (after.x - before.x) / 3;
    path += `C${before.x + third},${before.y + third * tangents[index - 1]!} ${after.x - third},${after.y - third * tangents[index]!} ${after.x},${after.y}`;
  }
  return path;
}
/** Matches Recharts' default adaptive five-tick domain, including a zero tick. */
export function chartDomain(min: number, max: number): { min: number; max: number; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min))
    return { min: 0, max: 4, step: 1 };
  const rough = (max - min) / 4;
  const digits = Math.floor(Math.log10(rough)) + 1;
  const magnitude = 10 ** digits;
  const unit = magnitude * (digits === 1 ? 0.1 : 0.05);
  let multiplier = Math.ceil(rough / unit - 1e-10);
  for (;;) {
    const step = Number((multiplier * unit).toPrecision(12));
    const below = Math.ceil(-Math.min(0, min) / step - 1e-10);
    const above = Math.ceil(Math.max(0, max) / step - 1e-10);
    if (below + above <= 4) return { min: -below * step, max: (4 - below) * step, step };
    multiplier++;
  }
}
export function chartCeiling(value: number): number {
  return chartDomain(0, value).max;
}
export function closestPoint(x: number, left: number, width: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(((x - left) / width) * (count - 1))));
}
