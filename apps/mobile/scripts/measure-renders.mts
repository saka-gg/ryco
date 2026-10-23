#!/usr/bin/env node
/// <reference types="node" />
/**
 * Counts React renders in a running Ryco development client, through Metro's
 * Hermes inspector and the dev-only counter in `src/devtools/renderCounter.ts`.
 * See "Measuring renders" in apps/mobile/README.md.
 *
 * Stream mode starts a real turn with `ryco remote send` and records a window
 * while the reply streams into the open thread. Route mode reloads the app,
 * opens a route and records its mount. Node builtins only; run it with `node`.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import {
  decodeMeasureResults,
  decodeRenderReport,
  endedInWindowWarning,
  formatComparison,
  formatSummary,
  MeasureRendersError,
  type MeasureResults,
  type MeasureRun,
  pickInspectorTarget,
  type RenderCounterReport,
  routeLink,
  summarize,
  threadLink,
} from "./measureRendersReport.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const COUNTER = "globalThis.__rycoRenderCounter";
const DEFAULT_PROMPT =
  "Write a plain essay of about 2,000 words on the history of movable type, in short paragraphs, with no headings, lists or code. Do not use any tools.";
// Below this many characters of reply the turn most likely failed (an API error
// streams back as a one-line reply), and no reply this short streams through a
// window anyway, so such a run fails.
const MIN_REPLY_CHARS = 500;
const CDP_TIMEOUT_MS = 10_000;
const FIRST_TEXT_TIMEOUT_MS = 90_000;
const BETWEEN_RUNS_MS = 3_000;

const USAGE = `Usage: node apps/mobile/scripts/measure-renders.mts [options]

Counts React renders in a Ryco development client started with
EXPO_PUBLIC_RYCO_RENDER_COUNTER=1 (see "Measuring renders" in apps/mobile/README.md).

Stream mode (a reply streams into an open thread):
  --remote <name>          \`ryco remote\` name of the node the app is paired with
  --thread <id>            thread to send to; repeat it to give each run its own
                           thread (runs cycle through them)
  --environment <id>       environment id for the thread link (default: from
                           \`ryco remote list --json\`)
  --prompt <text>          message sent each run (default: a ~2,000-word essay, no tools);
                           ask for a long reply: a run whose reply is under ${MIN_REPLY_CHARS}
                           characters fails
  --settle <seconds>       wait after opening the thread before sending (default 4)
  --turn-timeout <seconds> wait for the turn to end after the window (default 240); a
                           turn that runs longer stops the measurement, because it keeps
                           streaming on the node and later runs would record it
  --no-reload              keep the app's screen stack between runs instead of
                           reloading the JS app before each run
  --reload-wait <seconds>  wait after a reload (default 15)
  --ryco <command>         CLI command, split on spaces (default: node <repo>/apps/server/src/bin.ts)

Route mode (a screen mounts):
  --route <path>           app path to open after a reload, e.g. settings

Both:
  --metro <url>            Metro origin (default http://127.0.0.1:8081)
  --app-id <id>            inspector target app id (default dev.ryco.app.dev)
  --scheme <scheme>        app link scheme (default ryco-dev)
  --runs <n>               runs; tables show medians (default 3)
  --window <seconds>       recording window (default 12 stream, 6 route)
  --label <text>           stored in the JSON output, e.g. before or after
  --json <path>            write the raw reports here (.perf-results/ is ignored by git)

  --compare <before.json> <after.json>   print a before/after table and exit
  -h, --help

The CLI child inherits the environment: RYCO_HOME (or --base-dir inside --ryco) picks the
state dir that holds the remote. Never point it at a node with real work.
`;

interface Options {
  readonly metro: string;
  readonly appId: string;
  readonly scheme: string;
  readonly runs: number;
  readonly windowSeconds: number;
  readonly settleSeconds: number;
  readonly turnTimeoutSeconds: number;
  readonly reloadWaitSeconds: number;
  readonly reload: boolean;
  readonly remote: string | undefined;
  readonly threads: ReadonlyArray<string>;
  readonly environment: string | undefined;
  readonly prompt: string;
  readonly ryco: ReadonlyArray<string>;
  readonly route: string | undefined;
  readonly label: string | null;
  readonly json: string | undefined;
}

function positiveNumber(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MeasureRendersError(`--${flag} must be a positive number.`);
  }
  return parsed;
}

function parseOptions(
  argv: ReadonlyArray<string>,
):
  | { readonly kind: "help" }
  | { readonly kind: "compare"; readonly before: string; readonly after: string }
  | { readonly kind: "measure"; readonly options: Options } {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    allowNegative: true,
    options: {
      help: { type: "boolean", short: "h" },
      compare: { type: "boolean" },
      metro: { type: "string", default: "http://127.0.0.1:8081" },
      "app-id": { type: "string", default: "dev.ryco.app.dev" },
      scheme: { type: "string", default: "ryco-dev" },
      runs: { type: "string" },
      window: { type: "string" },
      settle: { type: "string" },
      "turn-timeout": { type: "string" },
      "reload-wait": { type: "string" },
      reload: { type: "boolean", default: true },
      remote: { type: "string" },
      thread: { type: "string", multiple: true },
      environment: { type: "string" },
      prompt: { type: "string", default: DEFAULT_PROMPT },
      ryco: { type: "string" },
      route: { type: "string" },
      label: { type: "string" },
      json: { type: "string" },
    },
  });
  if (values.help) return { kind: "help" };
  if (values.compare) {
    const [before, after, ...rest] = positionals;
    if (before === undefined || after === undefined || rest.length > 0) {
      throw new MeasureRendersError("--compare takes exactly two results files.");
    }
    return { kind: "compare", before, after };
  }
  if (positionals.length > 0) {
    throw new MeasureRendersError(`Unexpected argument: ${positionals[0]}`);
  }
  const threads = values.thread ?? [];
  const route = values.route;
  if (route === undefined && (values.remote === undefined || threads.length === 0)) {
    throw new MeasureRendersError(
      "Pass --remote and --thread to measure a streaming reply, or --route to measure a screen.",
    );
  }
  if (route !== undefined && (values.remote !== undefined || threads.length > 0)) {
    throw new MeasureRendersError("--route measures a screen; it takes no --remote or --thread.");
  }
  const runs = positiveNumber("runs", values.runs, 3);
  if (!Number.isInteger(runs)) throw new MeasureRendersError("--runs must be a whole number.");
  return {
    kind: "measure",
    options: {
      metro: new URL(values.metro).origin,
      appId: values["app-id"],
      scheme: values.scheme,
      runs,
      windowSeconds: positiveNumber("window", values.window, route === undefined ? 12 : 6),
      settleSeconds: positiveNumber("settle", values.settle, 4),
      turnTimeoutSeconds: positiveNumber("turn-timeout", values["turn-timeout"], 240),
      reloadWaitSeconds: positiveNumber("reload-wait", values["reload-wait"], 15),
      reload: values.reload,
      remote: values.remote,
      threads,
      environment: values.environment,
      prompt: values.prompt,
      ryco: (values.ryco ?? `node ${join(REPO_ROOT, "apps/server/src/bin.ts")}`)
        .split(" ")
        .filter((part) => part.length > 0),
      route,
      label: values.label ?? null,
      json: values.json,
    },
  };
}

const log = (line: string) => process.stderr.write(`${line}\n`);

const errorMessage = (error: unknown) =>
  error instanceof MeasureRendersError ? error.message : String(error);

// ─── Hermes inspector (Chrome DevTools Protocol through Metro's proxy) ───────

interface Inspector {
  evaluate(expression: string): Promise<unknown>;
  close(): void;
}

interface CdpReply {
  readonly id?: number;
  readonly error?: { readonly message?: string };
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: { readonly text?: string; readonly exception?: unknown };
  };
}

// Node's WebSocket (undici) takes an init dictionary with headers; the DOM type does not.
const NodeWebSocket = WebSocket as unknown as new (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => WebSocket;

async function connectInspector(options: Options): Promise<Inspector> {
  const response = await fetch(`${options.metro}/json/list`).catch((cause: unknown) => {
    throw new MeasureRendersError(
      `Could not reach Metro at ${options.metro} (${cause instanceof Error ? cause.message : String(cause)}). Is it running on that port?`,
    );
  });
  if (!response.ok) {
    throw new MeasureRendersError(`Metro at ${options.metro} answered ${response.status}.`);
  }
  const target = pickInspectorTarget(await response.json(), options.appId);
  // Metro's inspector proxy closes sockets whose Origin is not its own URL or localhost.
  const socket = new NodeWebSocket(target.webSocketDebuggerUrl, {
    headers: { origin: options.metro },
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      socket.close();
      rejectOpen(new MeasureRendersError("The inspector connection did not open in 10 s."));
    }, CDP_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveOpen();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectOpen(new MeasureRendersError("The inspector connection failed to open."));
    });
  });

  let nextId = 0;
  const pending = new Map<
    number,
    { resolve(reply: CdpReply): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  const failAll = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let reply: CdpReply;
    try {
      reply = JSON.parse(event.data) as CdpReply;
    } catch {
      return;
    }
    const entry = reply.id === undefined ? undefined : pending.get(reply.id);
    if (entry === undefined || reply.id === undefined) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    entry.resolve(reply);
  });
  socket.addEventListener("close", () => {
    failAll(new MeasureRendersError("The inspector connection closed (did the app reload?)."));
  });

  return {
    evaluate: async (expression) => {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new MeasureRendersError("The inspector connection closed (did the app reload?).");
      }
      nextId += 1;
      const id = nextId;
      const reply = await new Promise<CdpReply>((resolveReply, rejectReply) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectReply(new MeasureRendersError(`No inspector reply in 10 s to: ${expression}`));
        }, CDP_TIMEOUT_MS);
        pending.set(id, { resolve: resolveReply, reject: rejectReply, timer });
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
          }),
        );
      });
      if (reply.error) {
        throw new MeasureRendersError(`Inspector error: ${reply.error.message ?? "unknown"}`);
      }
      if (reply.result?.exceptionDetails) {
        throw new MeasureRendersError(
          `The app threw evaluating ${expression}: ${JSON.stringify(reply.result.exceptionDetails)}`,
        );
      }
      return reply.result?.result?.value;
    },
    close: () => {
      failAll(new MeasureRendersError("The inspector connection was closed."));
      socket.close();
    },
  };
}

/** Connects once the app's JS runtime is back after a reload. */
async function connectInspectorWhenReady(options: Options): Promise<Inspector> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    let inspector: Inspector | undefined;
    try {
      inspector = await connectInspector(options);
      await requireCounter(inspector);
      return inspector;
    } catch (error) {
      // An open socket would keep the process alive and hold the app's one debugger slot.
      inspector?.close();
      if (Date.now() > deadline) throw error;
      await sleep(1_000);
    }
  }
}

async function requireCounter(inspector: Inspector): Promise<void> {
  const status = await inspector.evaluate(
    `typeof ${COUNTER} === "object" ? JSON.stringify(${COUNTER}.status()) : null`,
  );
  const parsed =
    typeof status === "string" ? (JSON.parse(status) as { installed?: unknown }) : null;
  if (parsed?.installed !== true) {
    throw new MeasureRendersError(
      parsed === null
        ? "The render counter is not loaded. Start Metro with EXPO_PUBLIC_RYCO_RENDER_COUNTER=1 and reload the app."
        : "The render counter found no React DevTools hook. Is this a development build?",
    );
  }
}

async function reloadApp(options: Options): Promise<void> {
  const inspector = await connectInspector(options);
  try {
    await requireCounter(inspector);
    await inspector.evaluate(`${COUNTER}.reload()`);
  } finally {
    inspector.close();
  }
  await sleep(options.reloadWaitSeconds * 1000);
}

/** Stops the window and fails the run unless its counts are complete and non-empty. */
async function stopReport(
  inspector: Inspector,
  noCommitsHint: string,
): Promise<RenderCounterReport> {
  const report = decodeRenderReport(await inspector.evaluate(`JSON.stringify(${COUNTER}.stop())`));
  if (report.walkErrors > 0) {
    throw new MeasureRendersError(
      `The counter's fiber walk threw in ${report.walkErrors} of ${report.commits} commits, so the counts are incomplete. React's fiber internals changed; update src/devtools/renderCounter.ts.`,
    );
  }
  if (report.commits === 0) {
    throw new MeasureRendersError(`No React commits in the window. ${noCommitsHint}`);
  }
  return report;
}

/** Whether `promise` settles within `ms`. The timer is cleared, so it never holds the process open. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Ryco CLI ─────────────────────────────────────────────────────────────────

function runRyco(options: Options, args: ReadonlyArray<string>): string {
  const [command, ...prefix] = options.ryco;
  const result = spawnSync(command!, [...prefix, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new MeasureRendersError(
      `\`ryco ${args.join(" ")}\` failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function remoteEnvironmentId(options: Options, remote: string): string {
  const remotes = JSON.parse(runRyco(options, ["remote", "list", "--json"])) as ReadonlyArray<{
    readonly name?: unknown;
    readonly environmentId?: unknown;
  }>;
  const match = remotes.find((entry) => entry.name === remote);
  if (typeof match?.environmentId !== "string") {
    throw new MeasureRendersError(
      `No remote "${remote}" in \`ryco remote list\` (check RYCO_HOME), or it has no environment id.`,
    );
  }
  return match.environmentId;
}

/** One `ryco remote send`, which prints the reply as it streams and exits when the turn ends. */
interface Turn {
  /** Resolves on the first non-whitespace reply text; rejects if the CLI ends first or after 90 s. */
  readonly firstText: Promise<void>;
  /** Resolves once the CLI is gone and its output read: its exit code, `null` if killed or never started. */
  readonly ended: Promise<number | null>;
  readonly isOver: () => boolean;
  readonly replyChars: () => number;
  readonly kill: () => void;
}

function startTurn(options: Options, threadId: string): Turn {
  const [command, ...prefix] = options.ryco;
  const child = spawn(
    command!,
    [...prefix, "remote", "send", options.remote!, threadId, options.prompt],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let over = false;
  let startError: Error | null = null;
  const ended = new Promise<number | null>((resolveEnded) => {
    // `close`, not `exit`: it comes after stdout is drained, so the reply count is complete.
    child.once("close", (code: number | null) => {
      over = true;
      resolveEnded(code);
    });
    // A command that cannot start (a wrong --ryco) reports `error`, maybe without a `close`.
    child.once("error", (error) => {
      if (child.pid !== undefined) return;
      startError = error;
      over = true;
      resolveEnded(null);
    });
  });
  let replyChars = 0;
  const firstText = new Promise<void>((resolveText, rejectText) => {
    const timer = setTimeout(() => {
      rejectText(new MeasureRendersError("The reply did not start streaming within 90 s."));
    }, FIRST_TEXT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: string) => {
      // Whitespace before the reply is the CLI's spacing, not reply text.
      if (replyChars === 0 && chunk.trim().length === 0) return;
      const first = replyChars === 0;
      replyChars += chunk.length;
      if (!first) return;
      clearTimeout(timer);
      resolveText();
    });
    void ended.then((code) => {
      clearTimeout(timer);
      if (replyChars > 0) return;
      const reason =
        startError === null
          ? `\`ryco remote send\` exited (${code}) before replying.`
          : `Could not run \`${options.ryco.join(" ")}\`: ${startError.message}`;
      const detail = stderr.trim();
      rejectText(new MeasureRendersError(detail.length > 0 ? `${reason}\n${detail}` : reason));
    });
  });
  return {
    firstText,
    ended,
    isOver: () => over,
    replyChars: () => replyChars,
    kill: () => {
      if (!over) child.kill();
    },
  };
}

/**
 * A run that left its turn streaming on the node. The CLI has no way to stop a
 * turn, and the app re-renders for every thread's updates (the Home list under
 * the open thread), so a later window would record this stream too.
 */
class TurnLeftRunningError extends MeasureRendersError {}

// ─── Runs ─────────────────────────────────────────────────────────────────────

async function measureStreamRun(
  options: Options,
  environmentId: string,
  run: number,
  priorRuns: Map<string, number>,
): Promise<MeasureRun> {
  const threadId = options.threads[(run - 1) % options.threads.length]!;
  const priorRunsOnThread = priorRuns.get(threadId) ?? 0;
  if (priorRunsOnThread > 0) {
    log(
      `run ${run}: warning: thread ${threadId} already took ${priorRunsOnThread} run(s); its transcript is longer now. Pass one --thread per run for comparable runs.`,
    );
  }
  if (options.reload) await reloadApp(options);
  const inspector = await connectInspectorWhenReady(options);
  let turn: Turn | undefined;
  let measured:
    | { readonly report: RenderCounterReport; readonly endedInWindow: boolean }
    | undefined;
  let failure: unknown;
  try {
    await inspector.evaluate(
      `${COUNTER}.open(${JSON.stringify(threadLink(options.scheme, environmentId, threadId))})`,
    );
    await sleep(options.settleSeconds * 1000);

    turn = startTurn(options, threadId);
    priorRuns.set(threadId, priorRunsOnThread + 1);
    await turn.firstText;
    await inspector.evaluate(`${COUNTER}.start()`);
    await sleep(options.windowSeconds * 1000);
    const report = await stopReport(
      inspector,
      "Is the thread open on the device? Check for a red box.",
    );
    measured = { report, endedInWindow: turn.isOver() };
  } catch (error) {
    failure = error;
  } finally {
    inspector.close();
  }

  // Whatever happened, the next run starts only once this turn has ended.
  if (turn !== undefined && !(await settlesWithin(turn.ended, options.turnTimeoutSeconds * 1000))) {
    turn.kill();
    const cause = failure === undefined ? "" : `${errorMessage(failure)} `;
    throw new TurnLeftRunningError(
      `${cause}The turn did not end within ${options.turnTimeoutSeconds} s (--turn-timeout) and keeps running on the node; skipping the remaining runs, which would record its stream too.`,
    );
  }
  if (failure !== undefined) throw failure;
  const { report, endedInWindow } = measured!;
  const exitCode = await turn!.ended;
  const replyChars = turn!.replyChars();
  if (exitCode !== 0 || replyChars < MIN_REPLY_CHARS) {
    throw new MeasureRendersError(
      `The turn ended with exit ${exitCode} after ${replyChars} characters of reply, so the window did not see a real stream. Check the thread for an error.`,
    );
  }
  if (endedInWindow) {
    log(`run ${run}: warning: the turn ended inside the window; part of it was idle.`);
  }
  return {
    run,
    report,
    threadId,
    priorRunsOnThread,
    streamingEndedInWindow: endedInWindow,
    replyChars,
  };
}

async function measureRouteRun(options: Options, run: number): Promise<MeasureRun> {
  await reloadApp(options);
  const inspector = await connectInspectorWhenReady(options);
  try {
    await inspector.evaluate(`${COUNTER}.start()`);
    await inspector.evaluate(
      `${COUNTER}.open(${JSON.stringify(routeLink(options.scheme, options.route!))})`,
    );
    await sleep(options.windowSeconds * 1000);
    const report = await stopReport(inspector, `Is "${options.route}" a valid app path?`);
    return { run, report };
  } finally {
    inspector.close();
  }
}

async function measure(options: Options): Promise<number> {
  const environmentId =
    options.route === undefined
      ? (options.environment ?? remoteEnvironmentId(options, options.remote!))
      : "";
  const target =
    options.route === undefined
      ? threadLink(options.scheme, environmentId, options.threads[0]!)
      : routeLink(options.scheme, options.route);
  // Fail before the first run when the app or the counter is missing.
  const probe = await connectInspector(options);
  try {
    await requireCounter(probe);
  } finally {
    probe.close();
  }

  const runs: MeasureRun[] = [];
  const priorRuns = new Map<string, number>();
  let failures = 0;
  for (let run = 1; run <= options.runs; run += 1) {
    try {
      const result =
        options.route === undefined
          ? await measureStreamRun(options, environmentId, run, priorRuns)
          : await measureRouteRun(options, run);
      const { report } = result;
      log(
        `run ${run}: ${report.totalRenders} renders in ${report.commits} commits (${(
          report.totalRenders / Math.max(report.commits, 1)
        ).toFixed(2)} per commit, ${(report.windowMs / 1000).toFixed(1)} s)`,
      );
      runs.push(result);
    } catch (error) {
      failures += 1;
      log(`run ${run} failed: ${errorMessage(error)}`);
      if (error instanceof TurnLeftRunningError) break;
    }
    if (run < options.runs) await sleep(BETWEEN_RUNS_MS);
  }

  if (options.json !== undefined) {
    const results: MeasureResults = {
      version: 1,
      label: options.label,
      mode: options.route === undefined ? "stream" : "route",
      target,
      windowSeconds: options.windowSeconds,
      createdAt: new Date().toISOString(),
      runs,
    };
    mkdirSync(dirname(resolve(options.json)), { recursive: true });
    writeFileSync(options.json, `${JSON.stringify(results, null, 2)}\n`);
    log(`wrote ${options.json}`);
  }
  if (runs.length > 0) {
    process.stdout.write(
      `${formatSummary(summarize(runs.map((entry) => entry.report)), { label: options.label })}\n`,
    );
    const warning = endedInWindowWarning(options.label ?? "this measurement", runs);
    if (warning !== null) log(warning);
  }
  return failures === 0 && runs.length > 0 ? 0 : 1;
}

function compare(beforePath: string, afterPath: string): number {
  const read = (path: string) => decodeMeasureResults(JSON.parse(readFileSync(path, "utf8")));
  const before = read(beforePath);
  const after = read(afterPath);
  if (before.mode !== after.mode) {
    throw new MeasureRendersError(`Cannot compare a ${before.mode} run with a ${after.mode} run.`);
  }
  if (before.windowSeconds !== after.windowSeconds) {
    log(`warning: the windows differ (${before.windowSeconds} s vs ${after.windowSeconds} s).`);
  }
  for (const [side, results] of [
    ["before", before],
    ["after", after],
  ] as const) {
    const warning = endedInWindowWarning(side, results.runs);
    if (warning !== null) log(warning);
  }
  process.stdout.write(
    `${formatComparison(
      summarize(before.runs.map((entry) => entry.report)),
      summarize(after.runs.map((entry) => entry.report)),
    )}\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseOptions(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "compare") return compare(parsed.before, parsed.after);
  return measure(parsed.options);
}

main().then(
  (status) => {
    process.exitCode = status;
  },
  (error: unknown) => {
    log(errorMessage(error));
    process.exitCode = 1;
  },
);
