import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Joins hosted switch probe results with server-side evidence from the same
 * machine clock: each switch's click time against the start of the target
 * node's trace spans and, optionally, against events in a JSON-lines Hub log.
 *
 * Streaming RPC spans measure the lifetime of a subscription, so only their
 * start times are used. Both sides are read from files the processes already
 * write; nothing is added to the application for this.
 */

/** Node trace span name to the label used in the joined output. */
export const NODE_SPAN_LABELS: Readonly<Record<string, string>> = {
  "ws.rpc.orchestration.subscribeShell": "node.shell",
  "ws.rpc.orchestration.subscribeThreadWindow": "node.thread",
  "relay.channel.open": "node.channelOpen",
  "relay.channel.open.advertise": "node.channelAdvertise",
  "relay.rpc.first_response": "node.firstResponse",
};

export const DEFAULT_HUB_EVENT = "relay.connection.authenticated";
export const DEFAULT_HUB_ROUTE = "client";

/** What the join reads from a probe result run. */
export interface CorrelatedProbeRun {
  readonly kind: string;
  /** `<environmentId>:<threadId>` of the clicked inbox row. */
  readonly rowKey: string;
  readonly clickEpochMs: number;
  readonly firstFrame?: number | null;
  readonly route?: number | null;
  readonly content?: number | null;
  readonly writable?: number | null;
}

export interface CorrelatedNode {
  readonly label: string;
  /** Span start times (epoch ms, ascending) by span name. */
  readonly spanStarts: ReadonlyMap<string, readonly number[]>;
}

export interface CorrelatedRun {
  readonly kind: string;
  readonly node: string | null;
  /** Milliseconds from the click; null when the event did not occur before the next click. */
  readonly offsets: Readonly<Record<string, number | null>>;
}

export interface HubEventFilter {
  readonly event: string;
  /** Only lines whose `route` field equals this (lines without the field always match). */
  readonly route: string | null;
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Start time (epoch ms) of a trace line when it is a span of one of `names`. */
export function parseSpanStartLine(
  line: string,
  names: readonly string[],
): { readonly name: string; readonly startMs: number } | null {
  // Trace files are large; skip the JSON parse for lines that cannot match.
  if (!names.some((name) => line.includes(name))) return null;
  const record = parseJsonObject(line);
  if (!record) return null;
  const { name, startTimeUnixNano } = record;
  if (typeof name !== "string" || !names.includes(name)) return null;
  const startNanos = Number(startTimeUnixNano);
  return Number.isFinite(startNanos) ? { name, startMs: startNanos / 1e6 } : null;
}

/** Epoch ms of a Hub log line that is the configured event, or null. */
export function parseHubEventLine(line: string, filter: HubEventFilter): number | null {
  if (!line.includes(filter.event)) return null;
  const record = parseJsonObject(line);
  if (!record || record.event !== filter.event) return null;
  if (filter.route !== null && record.route !== undefined && record.route !== filter.route) {
    return null;
  }
  const time = typeof record.time === "string" ? Date.parse(record.time) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

async function* readLines(file: string): AsyncGenerator<string> {
  const lines = readline.createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) yield line;
}

/**
 * A trace file and the backups the server rotated it into (`<file>.1`,
 * `<file>.2`, ...), which hold the spans of earlier switches on a long run.
 */
export function traceFilesOf(traceFile: string): string[] {
  const directory = path.dirname(traceFile);
  const name = path.basename(traceFile);
  const backups = existsSync(directory)
    ? readdirSync(directory).filter(
        (entry) => entry.startsWith(`${name}.`) && /^\d+$/u.test(entry.slice(name.length + 1)),
      )
    : [];
  return [...backups.map((entry) => path.join(directory, entry)), traceFile].filter((file) =>
    existsSync(file),
  );
}

export async function readSpanStarts(
  traceFile: string,
  names: readonly string[] = Object.keys(NODE_SPAN_LABELS),
): Promise<ReadonlyMap<string, readonly number[]>> {
  const starts = new Map<string, number[]>();
  for (const file of traceFilesOf(traceFile)) {
    for await (const line of readLines(file)) {
      const span = parseSpanStartLine(line, names);
      if (!span) continue;
      const list = starts.get(span.name) ?? [];
      list.push(span.startMs);
      starts.set(span.name, list);
    }
  }
  for (const list of starts.values()) list.sort((left, right) => left - right);
  return starts;
}

export async function readHubEventTimes(
  hubLogFile: string,
  filter: HubEventFilter,
): Promise<readonly number[]> {
  const times: number[] = [];
  for await (const line of readLines(hubLogFile)) {
    const time = parseHubEventLine(line, filter);
    if (time !== null) times.push(time);
  }
  return times.toSorted((left, right) => left - right);
}

/** Rounded offset of the first time in `[click, before)`, or null. */
export function firstOffsetWithin(
  times: readonly number[],
  click: number,
  before: number,
): number | null {
  const match = times.find((time) => time >= click && time < before);
  return match === undefined ? null : Math.round(match - click);
}

function roundOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * For every run, the offsets from its click to the browser-side marks, to the
 * first matching Hub event and to the first span start per name on the node
 * that owns the clicked thread. An event only counts when it happens before
 * the next click, so a late event of one switch is not credited to the next.
 */
export function correlateRuns(input: {
  readonly runs: readonly CorrelatedProbeRun[];
  readonly nodes: ReadonlyMap<string, CorrelatedNode>;
  readonly hubEvents: readonly number[];
}): CorrelatedRun[] {
  const clicks = input.runs.map((run) => run.clickEpochMs).toSorted((left, right) => left - right);
  return input.runs.map((run) => {
    const environmentId = run.rowKey.split(":")[0] ?? "";
    const node = input.nodes.get(environmentId) ?? null;
    const before = clicks.find((click) => click > run.clickEpochMs) ?? Number.POSITIVE_INFINITY;
    const offsets: Record<string, number | null> = {
      firstFrame: roundOrNull(run.firstFrame),
      route: roundOrNull(run.route),
      "hub.stream": firstOffsetWithin(input.hubEvents, run.clickEpochMs, before),
    };
    for (const [spanName, label] of Object.entries(NODE_SPAN_LABELS)) {
      offsets[label] = firstOffsetWithin(
        node?.spanStarts.get(spanName) ?? [],
        run.clickEpochMs,
        before,
      );
    }
    offsets.content = roundOrNull(run.content);
    offsets.writable = roundOrNull(run.writable);
    return { kind: run.kind, node: node?.label ?? null, offsets };
  });
}

/** Maps environment id to node for each node home; the id comes from the home's identity file. */
export async function loadCorrelatedNodes(
  nodeDirs: readonly string[],
): Promise<ReadonlyMap<string, CorrelatedNode>> {
  const nodes = new Map<string, CorrelatedNode>();
  for (const nodeDir of nodeDirs) {
    const identityFile = path.join(nodeDir, "userdata", "hub-identity.json");
    if (!existsSync(identityFile)) continue;
    const identity = parseJsonObject(readFileSync(identityFile, "utf8"));
    const environmentId = identity?.environmentId;
    if (typeof environmentId !== "string") continue;
    nodes.set(environmentId, {
      label: path.basename(nodeDir),
      spanStarts: await readSpanStarts(
        path.join(nodeDir, "userdata", "logs", "server.trace.ndjson"),
      ),
    });
  }
  return nodes;
}

/** The `node<n>` homes below a fixture directory, in numeric order. */
export function discoverNodeDirs(fixtureDir: string): string[] {
  return readdirSync(fixtureDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^node\d+$/u.test(entry.name))
    .map((entry) => entry.name)
    .toSorted((left, right) => Number(left.slice(4)) - Number(right.slice(4)))
    .map((name) => path.join(fixtureDir, name));
}

export function formatCorrelationTable(rows: readonly CorrelatedRun[]): string {
  const columns = [
    "firstFrame",
    "route",
    "hub.stream",
    ...Object.values(NODE_SPAN_LABELS),
    "content",
    "writable",
  ];
  const cell = (value: number | null | undefined) =>
    value === null || value === undefined ? "-" : String(value);
  return [
    `| kind | node | ${columns.join(" | ")} |`,
    `| --- | --- | ${columns.map(() => "---:").join(" | ")} |`,
    ...rows.map(
      (row) =>
        `| ${row.kind} | ${row.node ?? "-"} | ${columns.map((column) => cell(row.offsets[column])).join(" | ")} |`,
    ),
  ].join("\n");
}

export interface HostedCorrelateOptions {
  /** A `hosted-switch` result file. */
  readonly probeFile: string;
  readonly nodeDirs: readonly string[];
  readonly hubLog: string | null;
  readonly hubEvent: string;
  readonly hubRoute: string | null;
}

export async function runHostedCorrelate(
  options: HostedCorrelateOptions,
): Promise<CorrelatedRun[]> {
  const probe = parseJsonObject(readFileSync(options.probeFile, "utf8"));
  const runs = probe?.runs;
  if (!Array.isArray(runs)) throw new Error("The probe result has no runs to correlate.");
  const hubEvents = options.hubLog
    ? await readHubEventTimes(options.hubLog, { event: options.hubEvent, route: options.hubRoute })
    : [];
  return correlateRuns({
    runs: (runs as CorrelatedProbeRun[]).filter(
      (run) => typeof run.rowKey === "string" && typeof run.clickEpochMs === "number",
    ),
    nodes: await loadCorrelatedNodes(options.nodeDirs),
    hubEvents,
  });
}
