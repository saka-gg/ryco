import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { normalizeSourcePath } from "./bundleGraph.ts";
import type { CpuProfileSummary } from "./model.ts";

/**
 * Boot CPU profiles for the external harness.
 *
 * The startup measures say how long boot took; a sampled CPU profile says
 * where the main thread spent it (module evaluation, schema decode, React
 * commits, …). The probe records one per iteration from navigation start until
 * a short tail after `primary-shell-painted`, writes the raw `.cpuprofile`
 * (loadable in DevTools or speedscope) and keeps a self-time summary in the
 * result. With a `RYCO_WEB_SOURCEMAP=hidden` build the summary names source
 * files instead of chunks.
 */

/** CDP `Profiler.Profile`, reduced to what the summary reads. */
export interface CdpCpuProfile {
  readonly nodes: ReadonlyArray<{
    readonly id: number;
    readonly callFrame: {
      readonly functionName: string;
      readonly url: string;
      readonly lineNumber: number;
      readonly columnNumber: number;
    };
  }>;
  readonly startTime: number;
  readonly endTime: number;
  readonly samples?: ReadonlyArray<number>;
  readonly timeDeltas?: ReadonlyArray<number>;
}

/** Maps a generated position (0-based line and column) of a script URL to its source. */
export type CpuProfileSourceResolver = (url: string, line: number, column: number) => string | null;

/** Microseconds between samples: fine enough to see sub-millisecond module evaluation. */
export const CPU_PROFILE_SAMPLING_INTERVAL_US = 100;
const IDLE = "(idle)";
const MICROSECONDS_PER_MS = 1000;

function scriptLabel(url: string): string {
  if (!url) return "(native)";
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").pop() || parsed.pathname;
  } catch {
    return url;
  }
}

export function summarizeCpuProfile(
  profile: CdpCpuProfile,
  options: { readonly top?: number; readonly resolveSource?: CpuProfileSourceResolver } = {},
): CpuProfileSummary {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const labels = new Map<number, string>();
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    // `(program)`, `(garbage collector)`, `(idle)` and `(root)` are VM states.
    const label = url
      ? (options.resolveSource?.(url, lineNumber, columnNumber) ?? scriptLabel(url))
      : functionName.startsWith("(")
        ? functionName
        : "(native)";
    labels.set(node.id, label);
  }

  // A sample stands for the interval until the next one; the last runs to the end.
  const selfMicros = new Map<string, number>();
  let elapsed = profile.startTime;
  for (let index = 0; index < samples.length; index += 1) {
    elapsed += deltas[index] ?? 0;
    const next = index + 1 < samples.length ? elapsed + (deltas[index + 1] ?? 0) : profile.endTime;
    const label = labels.get(samples[index]!) ?? "(unknown)";
    selfMicros.set(label, (selfMicros.get(label) ?? 0) + Math.max(0, next - elapsed));
  }

  const durationMs = Math.max(0, profile.endTime - profile.startTime) / MICROSECONDS_PER_MS;
  const idleMs = (selfMicros.get(IDLE) ?? 0) / MICROSECONDS_PER_MS;
  selfMicros.delete(IDLE);
  const ranked = [...selfMicros]
    .map(([source, micros]) => ({ source, selfMs: micros / MICROSECONDS_PER_MS }))
    .toSorted((left, right) => right.selfMs - left.selfMs);
  return {
    durationMs,
    busyMs: ranked.reduce((total, entry) => total + entry.selfMs, 0),
    idleMs,
    topSelfTime: ranked.slice(0, options.top ?? 20),
  };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Map([...BASE64].map((character, index) => [character, index]));

interface DecodedSegment {
  readonly column: number;
  readonly source: number;
}

/** Decodes a source map's `mappings` into per-line segments sorted by column. */
function decodeMappings(mappings: string): ReadonlyArray<ReadonlyArray<DecodedSegment>> {
  const lines: DecodedSegment[][] = [];
  let source = 0;
  for (const line of mappings.split(";")) {
    const segments: DecodedSegment[] = [];
    let column = 0;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const character of segment) {
        const digit = BASE64_VALUES.get(character) ?? 0;
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
      column += fields[0] ?? 0;
      if (fields.length >= 4) {
        source += fields[1]!;
        segments.push({ column, source });
      }
    }
    lines.push(segments);
  }
  return lines;
}

/**
 * Resolves profile frames of `/assets/<chunk>.js` to repository-relative
 * source paths through the hidden source maps in `assetsDir`. Frames without a
 * map (or outside the bundle) keep their chunk label.
 */
export function createDistSourceResolver(assetsDir: string): CpuProfileSourceResolver {
  const maps = new Map<
    string,
    {
      readonly sources: ReadonlyArray<string>;
      readonly lines: ReadonlyArray<ReadonlyArray<DecodedSegment>>;
    } | null
  >();
  const mapFor = (file: string) => {
    if (!maps.has(file)) {
      const mapPath = path.join(assetsDir, `${file}.map`);
      if (!existsSync(mapPath)) {
        maps.set(file, null);
      } else {
        const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
          readonly sources?: ReadonlyArray<string>;
          readonly mappings?: string;
        };
        maps.set(file, {
          sources: (map.sources ?? []).map(normalizeSourcePath),
          lines: decodeMappings(map.mappings ?? ""),
        });
      }
    }
    return maps.get(file) ?? null;
  };
  return (url, line, column) => {
    let file: string;
    try {
      file = path.posix.basename(new URL(url).pathname);
    } catch {
      return null;
    }
    if (!file.endsWith(".js")) return null;
    const map = mapFor(file);
    const segments = map?.lines[line];
    if (!map || !segments || segments.length === 0) return null;
    let match: DecodedSegment | null = null;
    for (const segment of segments) {
      if (segment.column > column) break;
      match = segment;
    }
    return map.sources[(match ?? segments[0]!).source] ?? null;
  };
}
