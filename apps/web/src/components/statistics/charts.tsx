/**
 * Small SVG charts for the Statistics page.
 *
 * The page renders one multi-series area chart, horizontal project bars and
 * daily code-change bars. A charting library (and its state store per chart)
 * is far more than that needs, so these draw plain SVG like ActivityHeatmap:
 * nice-number y ticks, non-overlapping date ticks, monotone curves, and a
 * pointer-tracking tooltip that reuses the shared tooltip body.
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  chartColor,
  ChartTooltipContent,
  type ChartTooltipPayloadItem,
} from "~/components/ui/chart";
import {
  formatDayLabel,
  formatDuration,
  formatInteger,
  formatTokens,
} from "~/lib/statisticsFormat";
import { cn } from "~/lib/utils";

import type { DayPoint, ProjectAggregate } from "../settings/statistics/selectors";

// ── Scales ──────────────────────────────────────────────────────────────────

/** Digits before the decimal point: 87 → 2, 0.75 → 0. */
function digitCount(value: number): number {
  return value === 0 ? 1 : Math.floor(Math.log10(Math.abs(value))) + 1;
}

function round(value: number): number {
  // Drop binary noise such as 0.30000000000000004.
  return Number(value.toPrecision(12));
}

function formatStep(rough: number, allowDecimals: boolean, correction: number): number {
  if (!(rough > 0)) return 0;
  const digits = digitCount(rough);
  const magnitude = 10 ** digits;
  const scale = digits !== 1 ? 0.05 : 0.1;
  const step = round(
    (Math.ceil(round(rough / magnitude / scale)) + correction) * scale * magnitude,
  );
  return allowDecimals ? step : Math.ceil(step);
}

/**
 * Exactly `count` round ticks covering [min, max], as Recharts' default numeric
 * axis computes them (steps of 0.05 or 0.1 of a power of ten, 0 kept on the
 * axis), so axes read the same as before.
 */
export function niceTicks(
  min: number,
  max: number,
  options: { readonly count?: number; readonly allowDecimals?: boolean } = {},
): number[] {
  const count = Math.max(2, options.count ?? 5);
  const allowDecimals = options.allowDecimals ?? true;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  if (low === high) {
    const middleIndex = Math.floor((count - 1) / 2);
    const middle = low === 0 ? middleIndex : allowDecimals ? low : Math.floor(low);
    return Array.from({ length: count }, (_, index) => middle + index - middleIndex);
  }
  for (let correction = 0; ; correction += 1) {
    const step = formatStep((high - low) / (count - 1), allowDecimals, correction);
    if (!(step > 0)) return [low, high];
    const middle =
      low <= 0 && high >= 0 ? 0 : round((low + high) / 2 - (((low + high) / 2) % step));
    let below = Math.ceil(round((middle - low) / step));
    let above = Math.ceil(round((high - middle) / step));
    const used = below + above + 1;
    if (used > count) continue;
    if (used < count) {
      if (high > 0) above += count - used;
      else below += count - used;
    }
    return Array.from({ length: below + above + 1 }, (_, index) =>
      round(middle + (index - below) * step),
    );
  }
}

/** Indexes of category labels that fit without overlapping, keeping the last one. */
export function visibleTickIndexes(
  labels: readonly string[],
  spacing: number,
  minGap: number,
): number[] {
  if (labels.length === 0) return [];
  const widest = labels.reduce((max, label) => Math.max(max, estimateTextWidth(label)), 0);
  const step = Math.max(1, Math.ceil((widest + minGap) / Math.max(1, spacing)));
  const first = (labels.length - 1) % step;
  const indexes: number[] = [];
  for (let index = first; index < labels.length; index += step) indexes.push(index);
  return indexes;
}

/** Width of a 12px UI-font label; close enough to space axis ticks. */
function estimateTextWidth(label: string): number {
  return label.length * 6.6;
}

// ── Paths ───────────────────────────────────────────────────────────────────

type Point = readonly [x: number, y: number];

function sign(value: number): number {
  return value < 0 ? -1 : 1;
}

/** Fritsch–Carlson tangents, as d3's curveMonotoneX: no overshoot between points. */
function monotoneTangents(points: readonly Point[]): number[] {
  const count = points.length;
  const secants: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const [x0, y0] = points[index]!;
    const [x1, y1] = points[index + 1]!;
    secants.push(x1 === x0 ? 0 : (y1 - y0) / (x1 - x0));
  }
  const tangents: number[] = Array.from({ length: count }, () => 0);
  for (let index = 1; index < count - 1; index += 1) {
    const h0 = points[index]![0] - points[index - 1]![0];
    const h1 = points[index + 1]![0] - points[index]![0];
    const s0 = secants[index - 1]!;
    const s1 = secants[index]!;
    const p = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
    tangents[index] =
      (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  if (count > 2) {
    // End tangents as d3's slope2: mirror the neighbouring tangent across the end secant.
    tangents[0] = (3 * secants[0]! - tangents[1]!) / 2;
    tangents[count - 1] = (3 * secants[count - 2]! - tangents[count - 2]!) / 2;
  }
  return tangents;
}

/** Cubic segments through `points` (after an initial move/line to the first point). */
function monotoneSegments(points: readonly Point[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) return `L${points[1]![0]},${points[1]![1]}`;
  const tangents = monotoneTangents(points);
  let path = "";
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x0, y0] = points[index]!;
    const [x1, y1] = points[index + 1]!;
    const third = (x1 - x0) / 3;
    path += `C${x0 + third},${y0 + tangents[index]! * third},${x1 - third},${y1 - tangents[index + 1]! * third},${x1},${y1}`;
  }
  return path;
}

function linePath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  const [x, y] = points[0]!;
  return `M${x},${y}${monotoneSegments(points)}`;
}

/** Area between `top` and `bottom` (same x positions), both drawn as monotone curves. */
function areaPath(top: readonly Point[], bottom: readonly Point[]): string {
  if (top.length < 2) return "";
  const reversed = bottom.toReversed();
  const [bx, by] = reversed[0]!;
  return `${linePath(top)}L${bx},${by}${monotoneSegments(reversed)}Z`;
}

/** Contiguous index runs where `value` is present (a gap splits the curve). */
function presentRuns(length: number, present: (index: number) => boolean): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (let index = 0; index < length; index += 1) {
    if (present(index)) run.push(index);
    else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

// ── Frame ───────────────────────────────────────────────────────────────────

function useElementSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number, height: number) =>
      setSize((previous) =>
        previous.width === Math.round(width) && previous.height === Math.round(height)
          ? previous
          : { width: Math.round(width), height: Math.round(height) },
      );
    const bounds = element.getBoundingClientRect();
    update(bounds.width, bounds.height);
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) update(rect.width, rect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

interface HoverState {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

function ChartFrame({
  className,
  label,
  children,
  tooltip,
  hover,
}: {
  readonly className: string;
  readonly label: string;
  readonly children: (size: { readonly width: number; readonly height: number }) => ReactNode;
  readonly tooltip: ReactNode;
  readonly hover: HoverState | null;
}) {
  const [ref, size] = useElementSize();
  const { width } = size;
  return (
    <div ref={ref} data-slot="chart" className={cn("relative w-full text-xs", className)}>
      {width > 0 && size.height > 0 ? (
        <svg
          role="img"
          aria-label={label}
          width={width}
          height={size.height}
          className="absolute inset-0 overflow-visible outline-none"
        >
          {children(size)}
        </svg>
      ) : null}
      {hover !== null && tooltip !== null ? (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: hover.x,
            top: hover.y,
            transform: `translate(${hover.x > width / 2 ? "calc(-100% - 12px)" : "12px"}, 12px)`,
          }}
        >
          {tooltip}
        </div>
      ) : null}
    </div>
  );
}

const AXIS_TEXT = "fill-muted-foreground";
const GRID_LINE = "stroke-border/50";

function YAxisTicks({
  ticks,
  scale,
  left,
  right,
  format,
  dashed,
}: {
  readonly ticks: readonly number[];
  readonly scale: (value: number) => number;
  readonly left: number;
  readonly right: number;
  readonly format: (value: number) => string;
  readonly dashed?: boolean;
}) {
  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={left}
            x2={right}
            y1={scale(tick)}
            y2={scale(tick)}
            className={GRID_LINE}
            strokeDasharray={dashed ? "3 5" : undefined}
          />
          <text x={left - 6} y={scale(tick)} dy="0.355em" textAnchor="end" className={AXIS_TEXT}>
            {format(tick)}
          </text>
        </g>
      ))}
    </g>
  );
}

function XAxisTicks({
  labels,
  position,
  y,
  minGap,
  spacing,
}: {
  readonly labels: readonly string[];
  readonly position: (index: number) => number;
  readonly y: number;
  readonly minGap: number;
  readonly spacing: number;
}) {
  return (
    <g>
      {visibleTickIndexes(labels, spacing, minGap).map((index) => (
        <text
          key={index}
          x={position(index)}
          y={y}
          dy="0.71em"
          textAnchor="middle"
          className={AXIS_TEXT}
        >
          {labels[index]}
        </text>
      ))}
    </g>
  );
}

// ── Area chart ──────────────────────────────────────────────────────────────

export interface AreaSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  /** One value per date; null leaves a gap. */
  readonly values: readonly (number | null)[];
}

function isPresent(value: number | null | undefined): value is number {
  return value !== null && value !== undefined;
}

/** Overlapping (not stacked) area series over days, each filled down to zero. */
export function SeriesAreaChart({
  dates,
  series,
  className,
  yAxisWidth = 38,
  formatYTick,
  formatValue,
  dashedGrid = false,
  label,
  marginTop = 8,
  marginRight = 8,
}: {
  readonly dates: readonly string[];
  readonly series: readonly AreaSeries[];
  readonly className: string;
  readonly yAxisWidth?: number;
  readonly formatYTick: (value: number) => string;
  readonly formatValue: (value: number) => string;
  readonly dashedGrid?: boolean;
  readonly label: string;
  readonly marginTop?: number;
  readonly marginRight?: number;
}) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const labels = useMemo(() => dates.map(formatDayLabel), [dates]);
  const max = series.reduce(
    (acc, entry) => entry.values.reduce<number>((inner, value) => Math.max(inner, value ?? 0), acc),
    0,
  );
  const ticks = niceTicks(0, max);
  const top = ticks.at(-1) ?? 1;
  const hovered = hover === null ? null : hover.index;

  const tooltip =
    hovered === null ? null : (
      <ChartTooltipContent
        active
        label={dates[hovered]}
        labelFormatter={(value) => formatDayLabel(String(value))}
        formatter={(value) => formatValue(Number(value) || 0)}
        payload={series.flatMap((entry): ChartTooltipPayloadItem[] => {
          const value = entry.values[hovered];
          return isPresent(value)
            ? [{ name: entry.label, value, color: entry.color, dataKey: entry.key }]
            : [];
        })}
      />
    );

  return (
    <ChartFrame className={className} label={label} hover={hover} tooltip={tooltip}>
      {({ width, height }) => {
        const left = 4 + yAxisWidth;
        const right = width - marginRight;
        const bottom = Math.max(marginTop + 1, height - 24);
        const plotWidth = Math.max(1, right - left);
        const spacing = dates.length > 1 ? plotWidth / (dates.length - 1) : plotWidth;
        const xAt = (index: number) =>
          dates.length > 1 ? left + index * spacing : left + plotWidth / 2;
        const yAt = (value: number) => bottom - (value / top) * (bottom - marginTop);
        const onPointer = (event: PointerEvent<SVGRectElement>) => {
          const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
          if (!bounds || dates.length === 0) return;
          const x = event.clientX - bounds.left;
          const index = Math.min(dates.length - 1, Math.max(0, Math.round((x - left) / spacing)));
          setHover({ index, x, y: event.clientY - bounds.top });
        };
        return (
          <>
            <YAxisTicks
              ticks={ticks}
              scale={yAt}
              left={left}
              right={right}
              format={formatYTick}
              dashed={dashedGrid}
            />
            <XAxisTicks
              labels={labels}
              position={xAt}
              y={bottom + 8}
              minGap={28}
              spacing={spacing}
            />
            {hovered !== null ? (
              <line
                x1={xAt(hovered)}
                x2={xAt(hovered)}
                y1={marginTop}
                y2={bottom}
                className="stroke-border"
              />
            ) : null}
            {series.map((entry) =>
              presentRuns(dates.length, (index) => isPresent(entry.values[index])).map((run) => {
                const topPoints = run.map((index): Point => [
                  xAt(index),
                  yAt(entry.values[index]!),
                ]);
                const baseline = run.map((index): Point => [xAt(index), yAt(0)]);
                return (
                  <g key={`${entry.key}-${run[0]}`}>
                    <path
                      d={areaPath(topPoints, baseline)}
                      fill={entry.color}
                      fillOpacity={0.08}
                      stroke="none"
                    />
                    <path
                      d={linePath(topPoints)}
                      fill="none"
                      stroke={entry.color}
                      strokeWidth={1.75}
                    />
                  </g>
                );
              }),
            )}
            {hovered !== null
              ? series.map((entry) =>
                  isPresent(entry.values[hovered]) ? (
                    <circle
                      key={entry.key}
                      cx={xAt(hovered)}
                      cy={yAt(entry.values[hovered]!)}
                      r={4}
                      fill={entry.color}
                      stroke="var(--background)"
                      strokeWidth={2}
                    />
                  ) : null,
                )
              : null}
            <rect
              x={left}
              y={marginTop}
              width={plotWidth}
              height={Math.max(0, bottom - marginTop)}
              fill="transparent"
              onPointerMove={onPointer}
              onPointerDown={onPointer}
              onPointerLeave={() => setHover(null)}
            />
          </>
        );
      }}
    </ChartFrame>
  );
}

// ── Project bars ────────────────────────────────────────────────────────────

function truncateLabel(value: string, max = 14): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function ProjectBars({
  data,
  metric = "tokens",
}: {
  data: ReadonlyArray<ProjectAggregate>;
  metric?: "tokens" | "turns" | "activeMs" | "files";
}) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const valueOf = (entry: ProjectAggregate) =>
    metric === "tokens"
      ? entry.totalTokens
      : metric === "turns"
        ? entry.turns
        : metric === "activeMs"
          ? entry.activeMs
          : entry.filesChanged;
  const format = (value: number) =>
    metric === "tokens"
      ? formatTokens(value)
      : metric === "activeMs"
        ? formatDuration(value)
        : formatInteger(value);
  const rows = [...data]
    .toSorted((left, right) => valueOf(right) - valueOf(left))
    .slice(0, 6)
    .map((entry, index) => ({ name: entry.title, value: valueOf(entry), fill: chartColor(index) }));

  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground text-xs">
        No project activity yet.
      </div>
    );
  }

  const top =
    niceTicks(
      0,
      rows.reduce((max, row) => Math.max(max, row.value), 0),
    ).at(-1) ?? 1;
  const hoveredRow = hover === null ? undefined : rows[hover.index];
  return (
    <ChartFrame
      className="h-[220px]"
      label="Projects"
      hover={hover}
      tooltip={
        hoveredRow === undefined ? null : (
          <ChartTooltipContent
            active
            hideLabel
            formatter={(value) => format(Number(value) || 0)}
            payload={[{ name: hoveredRow.name, value: hoveredRow.value, color: hoveredRow.fill }]}
          />
        )
      }
    >
      {({ width, height }) => {
        const left = 4 + 96;
        const right = width - 16;
        const band = (height - 8) / rows.length;
        const barHeight = Math.min(26, band * 0.8);
        const plotWidth = Math.max(1, right - left);
        return (
          <>
            {rows.map((row, index) => {
              const y = 4 + index * band;
              const barWidth = (row.value / top) * plotWidth;
              const hovered = hover?.index === index;
              const onPointer = (event: PointerEvent<SVGGElement>) => {
                const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                if (!bounds) return;
                setHover({ index, x: event.clientX - bounds.left, y: event.clientY - bounds.top });
              };
              return (
                <g
                  key={row.name}
                  onPointerMove={onPointer}
                  onPointerDown={onPointer}
                  onPointerLeave={() => setHover(null)}
                >
                  <rect
                    x={left}
                    y={y}
                    width={plotWidth}
                    height={band}
                    className={hovered ? "fill-muted/50" : undefined}
                    fill={hovered ? undefined : "transparent"}
                  />
                  <text
                    x={left - 8}
                    y={y + band / 2}
                    dy="0.355em"
                    textAnchor="end"
                    className={AXIS_TEXT}
                  >
                    {truncateLabel(row.name)}
                  </text>
                  {barWidth > 0 ? (
                    <path
                      d={roundedBar(
                        left,
                        y + (band - barHeight) / 2,
                        barWidth,
                        barHeight,
                        "right",
                        4,
                      )}
                      fill={row.fill}
                    />
                  ) : null}
                </g>
              );
            })}
          </>
        );
      }}
    </ChartFrame>
  );
}

/** A bar rectangle with its outer end rounded. */
function roundedBar(
  x: number,
  y: number,
  width: number,
  height: number,
  side: "right" | "top" | "bottom",
  radius: number,
): string {
  if (side === "right") {
    const r = Math.min(radius, width, height / 2);
    return `M${x},${y}H${x + width - r}A${r},${r},0,0,1,${x + width},${y + r}V${y + height - r}A${r},${r},0,0,1,${x + width - r},${y + height}H${x}Z`;
  }
  const r = Math.min(radius, height, width / 2);
  return side === "top"
    ? `M${x},${y + height}V${y + r}A${r},${r},0,0,1,${x + r},${y}H${x + width - r}A${r},${r},0,0,1,${x + width},${y + r}V${y + height}Z`
    : `M${x},${y}V${y + height - r}A${r},${r},0,0,0,${x + r},${y + height}H${x + width - r}A${r},${r},0,0,0,${x + width},${y + height - r}V${y}Z`;
}

// ── Code changes ────────────────────────────────────────────────────────────

export function CodeChangesChart({ data }: { data: ReadonlyArray<DayPoint> }) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const labels = useMemo(() => data.map((point) => formatDayLabel(point.date)), [data]);
  const maxAdded = data.reduce((max, point) => Math.max(max, point.additions), 0);
  const maxRemoved = data.reduce((max, point) => Math.max(max, point.deletions), 0);
  const ticks = niceTicks(-maxRemoved, maxAdded);
  const low = ticks[0] ?? 0;
  const high = ticks.at(-1) ?? 1;
  const hoveredPoint = hover === null ? undefined : data[hover.index];
  return (
    <ChartFrame
      className="h-[200px]"
      label="Code changes"
      hover={hover}
      tooltip={
        hoveredPoint === undefined ? null : (
          <ChartTooltipContent
            active
            label={hoveredPoint.date}
            labelFormatter={(value) => formatDayLabel(String(value))}
            formatter={(value) => formatInteger(Math.abs(Number(value) || 0))}
            payload={[
              { name: "Added", value: hoveredPoint.additions, color: "var(--success)" },
              { name: "Removed", value: -hoveredPoint.deletions, color: "var(--destructive)" },
            ]}
          />
        )
      }
    >
      {({ width, height }) => {
        const marginTop = 8;
        const left = 4 + 38;
        const right = width - 8;
        const bottom = height - 24;
        const plotWidth = Math.max(1, right - left);
        const band = data.length > 0 ? plotWidth / data.length : plotWidth;
        // Two grouped bars per day (added up, removed down), 4px apart.
        const barWidth = Math.max(1, Math.min(18, (band * 0.8 - 4) / 2));
        const yAt = (value: number) =>
          marginTop + ((high - value) / (high - low || 1)) * (bottom - marginTop);
        const zero = yAt(0);
        const center = (index: number) => left + band * (index + 0.5);
        const onPointer = (event: PointerEvent<SVGRectElement>) => {
          const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
          if (!bounds || data.length === 0) return;
          const x = event.clientX - bounds.left;
          const index = Math.min(data.length - 1, Math.max(0, Math.floor((x - left) / band)));
          setHover({ index, x, y: event.clientY - bounds.top });
        };
        return (
          <>
            <YAxisTicks
              ticks={ticks}
              scale={yAt}
              left={left}
              right={right}
              format={(value) => formatTokens(Math.abs(value))}
            />
            <XAxisTicks
              labels={labels}
              position={center}
              y={bottom + 8}
              minGap={28}
              spacing={band}
            />
            {hover !== null ? (
              <rect
                x={left + band * hover.index}
                y={marginTop}
                width={band}
                height={bottom - marginTop}
                className="fill-muted/50"
              />
            ) : null}
            {data.map((point, index) => {
              const groupLeft = center(index) - barWidth - 2;
              const added = zero - yAt(point.additions);
              const removed = yAt(-point.deletions) - zero;
              return (
                <g key={point.date}>
                  {added > 0 ? (
                    <path
                      d={roundedBar(groupLeft, zero - added, barWidth, added, "top", 2)}
                      fill="var(--success)"
                    />
                  ) : null}
                  {removed > 0 ? (
                    <path
                      d={roundedBar(groupLeft + barWidth + 4, zero, barWidth, removed, "bottom", 2)}
                      fill="var(--destructive)"
                    />
                  ) : null}
                </g>
              );
            })}
            <rect
              x={left}
              y={marginTop}
              width={plotWidth}
              height={Math.max(0, bottom - marginTop)}
              fill="transparent"
              onPointerMove={onPointer}
              onPointerDown={onPointer}
              onPointerLeave={() => setHover(null)}
            />
          </>
        );
      }}
    </ChartFrame>
  );
}
