/// <reference types="node" />
/**
 * Pure helpers for `measure-renders.mts`: decoding what the in-app render
 * counter returns, medians over runs, the markdown tables, and the links,
 * inspector target and CLI command lines the driver uses. No I/O, so the tests
 * cover all of it.
 */
import type { RenderCount, RenderCounterReport } from "../src/devtools/renderCounter.ts";

export type { RenderCount, RenderCounterReport };

/** One measured run as the driver records it. */
export interface MeasureRun {
  readonly run: number;
  readonly report: RenderCounterReport;
  /** Stream mode: the thread the turn ran on. */
  readonly threadId?: string;
  /**
   * Stream mode: earlier runs of the same invocation on this thread. Each run
   * adds a turn, so a reused thread streams into a longer transcript.
   */
  readonly priorRunsOnThread?: number;
  /** Stream mode: the turn ended before the window did, so the window was partly idle. */
  readonly streamingEndedInWindow?: boolean;
  /** Stream mode: characters of reply the CLI printed; a failed turn prints only a line. */
  readonly replyChars?: number;
}

/** The file `--json` writes and `--compare` reads. */
export interface MeasureResults {
  readonly version: 1;
  readonly label: string | null;
  readonly mode: "stream" | "route";
  /** The thread or route link the first run opened. */
  readonly target: string;
  readonly windowSeconds: number;
  readonly createdAt: string;
  readonly runs: ReadonlyArray<MeasureRun>;
}

export interface RenderSummary {
  readonly runs: number;
  /** Median of each run's renders per commit; compare this when commit counts differ. */
  readonly rendersPerCommit: number;
  readonly renders: number;
  readonly commits: number;
  readonly windowMs: number;
  /** Median renders per component over all runs (0 where a run lacks it), zero rows dropped. */
  readonly components: ReadonlyArray<RenderCount>;
  readonly causes: ReadonlyArray<RenderCount>;
}

export class MeasureRendersError extends Error {
  override readonly name = "MeasureRendersError";
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MeasureRendersError(`Render report field "${field}" is not a non-negative number.`);
  }
  return value;
}

function counts(value: unknown, field: string): ReadonlyArray<RenderCount> {
  if (!Array.isArray(value)) {
    throw new MeasureRendersError(`Render report field "${field}" is not an array.`);
  }
  return value.map((entry: unknown, index) => {
    if (!isRecord(entry) || typeof entry.key !== "string") {
      throw new MeasureRendersError(`Render report entry ${field}[${index}] has no string key.`);
    }
    return { key: entry.key, count: count(entry.count, `${field}[${index}].count`) };
  });
}

/** Decodes `stop()`'s report, given as the JSON string the inspector returns or as a value. */
export function decodeRenderReport(value: unknown): RenderCounterReport {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new MeasureRendersError("The render report is not valid JSON.");
    }
  }
  if (!isRecord(parsed)) throw new MeasureRendersError("The render report is not an object.");
  return {
    commits: count(parsed.commits, "commits"),
    totalRenders: count(parsed.totalRenders, "totalRenders"),
    windowMs: count(parsed.windowMs, "windowMs"),
    components: counts(parsed.components, "components"),
    causes: counts(parsed.causes, "causes"),
    // Results files saved before the counter reported it have no field; the
    // driver of that time checked nothing, so read it as none.
    walkErrors: parsed.walkErrors === undefined ? 0 : count(parsed.walkErrors, "walkErrors"),
  };
}

/** Decodes a `--json` results file. */
export function decodeMeasureResults(value: unknown): MeasureResults {
  if (!isRecord(value) || value.version !== 1) {
    throw new MeasureRendersError("Not a measure-renders results file (version 1).");
  }
  if (value.mode !== "stream" && value.mode !== "route") {
    throw new MeasureRendersError('Results field "mode" is not "stream" or "route".');
  }
  if (!Array.isArray(value.runs)) throw new MeasureRendersError('Results field "runs" is missing.');
  const runs = value.runs.map((entry: unknown, index): MeasureRun => {
    if (!isRecord(entry)) throw new MeasureRendersError(`Results run ${index} is not an object.`);
    return {
      run: count(entry.run, `runs[${index}].run`),
      report: decodeRenderReport(entry.report),
      ...(typeof entry.threadId === "string" ? { threadId: entry.threadId } : {}),
      ...(typeof entry.priorRunsOnThread === "number"
        ? { priorRunsOnThread: entry.priorRunsOnThread }
        : {}),
      ...(typeof entry.streamingEndedInWindow === "boolean"
        ? { streamingEndedInWindow: entry.streamingEndedInWindow }
        : {}),
      ...(typeof entry.replyChars === "number" ? { replyChars: entry.replyChars } : {}),
    };
  });
  return {
    version: 1,
    label: typeof value.label === "string" ? value.label : null,
    mode: value.mode,
    target: typeof value.target === "string" ? value.target : "",
    windowSeconds: count(value.windowSeconds, "windowSeconds"),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    runs,
  };
}

export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) throw new MeasureRendersError("No values to take the median of.");
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianCounts(
  reports: ReadonlyArray<RenderCounterReport>,
  pick: (report: RenderCounterReport) => ReadonlyArray<RenderCount>,
): ReadonlyArray<RenderCount> {
  const keys = new Set(reports.flatMap((report) => pick(report).map((entry) => entry.key)));
  return [...keys]
    .map((key) => ({
      key,
      count: median(reports.map((report) => pick(report).find((e) => e.key === key)?.count ?? 0)),
    }))
    .filter((entry) => entry.count > 0)
    .toSorted((left, right) => right.count - left.count || (left.key < right.key ? -1 : 1));
}

export function summarize(reports: ReadonlyArray<RenderCounterReport>): RenderSummary {
  if (reports.length === 0) throw new MeasureRendersError("No successful runs to summarize.");
  return {
    runs: reports.length,
    rendersPerCommit: median(
      reports.map((report) => report.totalRenders / Math.max(report.commits, 1)),
    ),
    renders: median(reports.map((report) => report.totalRenders)),
    commits: median(reports.map((report) => report.commits)),
    windowMs: median(reports.map((report) => report.windowMs)),
    components: medianCounts(reports, (report) => report.components),
    causes: medianCounts(reports, (report) => report.causes),
  };
}

/**
 * The warning for runs whose turn ended inside the window (part of it was
 * idle, so their totals are low), or `null` when there are none. The medians
 * keep these runs; this names them wherever their medians are printed.
 */
export function endedInWindowWarning(
  label: string,
  runs: ReadonlyArray<MeasureRun>,
): string | null {
  const ended = runs.filter((entry) => entry.streamingEndedInWindow === true);
  if (ended.length === 0) return null;
  const numbers = ended.map((entry) => entry.run).join(", ");
  return `warning: ${label}: the turn ended inside the window in run${
    ended.length === 1 ? "" : "s"
  } ${numbers} of ${runs.length}; compare renders per commit, not totals.`;
}

const runsLabel = (runs: number) => `${runs} run${runs === 1 ? "" : "s"}`;

const formatNumber = (value: number, digits = 0) =>
  Number.isInteger(value) && digits === 0 ? String(value) : value.toFixed(Math.max(digits, 1));

/** Signed percent change, `-38.2%`; `new` when the before value is 0. */
export function percentChange(before: number, after: number): string {
  if (before === 0) return after === 0 ? "0.0%" : "new";
  const change = ((after - before) / before) * 100;
  const rounded = Math.round(change * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

const code = (key: string) => `\`${key.replaceAll("`", "'").replaceAll("|", "\\|")}\``;

export function formatSummary(
  summary: RenderSummary,
  options: {
    readonly label?: string | null;
    readonly topComponents?: number;
    readonly topCauses?: number;
  } = {},
): string {
  const title = options.label ? `${options.label}: ` : "";
  return [
    `${title}median of ${runsLabel(summary.runs)}, ${formatNumber(
      summary.windowMs / 1000,
      1,
    )} s window`,
    "",
    "| metric | value |",
    "| --- | ---: |",
    `| renders per commit | ${summary.rendersPerCommit.toFixed(2)} |`,
    `| renders | ${formatNumber(summary.renders)} |`,
    `| commits | ${formatNumber(summary.commits)} |`,
    "",
    "| component | renders |",
    "| --- | ---: |",
    ...summary.components
      .slice(0, options.topComponents ?? 20)
      .map((entry) => `| ${code(entry.key)} | ${formatNumber(entry.count)} |`),
    "",
    "| cause | renders |",
    "| --- | ---: |",
    ...summary.causes
      .slice(0, options.topCauses ?? 15)
      .map((entry) => `| ${code(entry.key)} | ${formatNumber(entry.count)} |`),
  ].join("\n");
}

export function formatComparison(
  before: RenderSummary,
  after: RenderSummary,
  options: { readonly topComponents?: number } = {},
): string {
  const row = (metric: string, left: number, right: number, digits = 0) =>
    `| ${metric} | ${formatNumber(left, digits)} | ${formatNumber(right, digits)} | ${percentChange(left, right)} |`;
  const afterCounts = new Map(after.components.map((entry) => [entry.key, entry.count]));
  const beforeCounts = new Map(before.components.map((entry) => [entry.key, entry.count]));
  const components = [...new Set([...beforeCounts.keys(), ...afterCounts.keys()])]
    .map((key) => ({ key, before: beforeCounts.get(key) ?? 0, after: afterCounts.get(key) ?? 0 }))
    .toSorted(
      (left, right) =>
        Math.max(right.before, right.after) - Math.max(left.before, left.after) ||
        (left.key < right.key ? -1 : 1),
    )
    .slice(0, options.topComponents ?? 10);
  return [
    `before: median of ${runsLabel(before.runs)}; after: median of ${runsLabel(after.runs)}`,
    "",
    "| metric | before | after | change |",
    "| --- | ---: | ---: | ---: |",
    `| renders per commit | ${before.rendersPerCommit.toFixed(2)} | ${after.rendersPerCommit.toFixed(2)} | ${percentChange(before.rendersPerCommit, after.rendersPerCommit)} |`,
    row("renders", before.renders, after.renders),
    row("commits", before.commits, after.commits),
    "",
    "| component | before | after | change |",
    "| --- | ---: | ---: | ---: |",
    ...components.map((entry) => row(code(entry.key), entry.before, entry.after)),
  ].join("\n");
}

export interface InspectorTarget {
  readonly appId: string;
  readonly title: string;
  readonly webSocketDebuggerUrl: string;
}

/**
 * The app's Hermes target from Metro's `/json/list`. The last match wins: after
 * a reload Metro lists the new JS runtime after the old one.
 */
export function pickInspectorTarget(targets: unknown, appId: string): InspectorTarget {
  if (!Array.isArray(targets)) {
    throw new MeasureRendersError("Metro's /json/list did not return a list of targets.");
  }
  const candidates = targets.filter(
    (entry: unknown): entry is Readonly<Record<string, unknown>> =>
      isRecord(entry) && typeof entry.webSocketDebuggerUrl === "string",
  );
  const match = candidates.findLast((entry) => entry.appId === appId);
  if (match === undefined) {
    const seen = [...new Set(candidates.map((entry) => String(entry.appId ?? "?")))];
    throw new MeasureRendersError(
      `No inspector target for app id "${appId}". Metro lists: ${
        seen.length > 0 ? seen.join(", ") : "nothing (is the app open and connected to Metro?)"
      }.`,
    );
  }
  return {
    appId,
    title: typeof match.title === "string" ? match.title : "",
    webSocketDebuggerUrl: match.webSocketDebuggerUrl as string,
  };
}

/** The app link of a thread (`navigation/mvpRouteConfig.ts`: `threads/:environmentId/:threadId`). */
export function threadLink(scheme: string, environmentId: string, threadId: string): string {
  return `${scheme}://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

/** The app link of a route path, e.g. `settings`. */
export function routeLink(scheme: string, route: string): string {
  return `${scheme}://${route.replace(/^\/+/u, "")}`;
}

/**
 * The command line of `ryco remote <verb>`, given the `--ryco` command's words.
 * `--base-dir` is a flag of each `remote` subcommand, not of `ryco`, so it goes
 * after the verb: the CLI rejects it anywhere before.
 */
export function remoteCommand(
  ryco: ReadonlyArray<string>,
  baseDir: string | undefined,
  verb: "list" | "send",
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const [command, ...prefix] = ryco;
  if (command === undefined) throw new MeasureRendersError("--ryco is empty.");
  return {
    command,
    args: [
      ...prefix,
      "remote",
      verb,
      ...(baseDir === undefined ? [] : ["--base-dir", baseDir]),
      ...args,
    ],
  };
}
