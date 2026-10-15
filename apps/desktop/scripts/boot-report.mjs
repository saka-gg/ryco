#!/usr/bin/env node
// Startup percentiles from a user's own desktop logs, for bug reports and
// before/after comparisons. Reads the always-on startup timing lines in
// desktop-main.log* (including the backend phase durations the server forwards
// over its lifecycle pipe) and the session boundaries in server-child.log*.
//
//   node apps/desktop/scripts/boot-report.mjs [--log-dir <dir>] [--last <n>] [--json]

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DESKTOP_TIMING_RE =
  /^\[([^\]]+)\] \[desktop run=([0-9a-f]+)\] startup timing phase=(\S+) elapsedMs=(-?\d+) deltaMs=(-?\d+)(?:\s+(.*))?$/;
const SESSION_START_RE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+)Z\] ---- APP SESSION START run=(\w+)/;
const SERVER_LOG_RE = /^\[(\d\d):(\d\d):(\d\d)\.(\d\d\d)\] \w+ \(#\d+\): (.*)$/;
const DETAIL_NUMBER_RE = (key) => new RegExp(`(?:^|\\s)${key}=(-?\\d+)(?:\\s|$)`);
const PROVIDER_CREATE_PREFIX = "provider.instance.create_";
const TOP_BACKEND_PHASES = 12;

const PHASES = [
  ["ready", "desktop.ready"],
  ["windowCreate", "desktop.window.create"],
  ["backendSpawn", "desktop.backend.spawn"],
  ["firstReveal", "desktop.window.first-reveal"],
  ["backendBound", "desktop.backend.http-bound"],
  ["backendListening", "desktop.backend.listening"],
  ["appLoaded", "desktop.window.app.did-finish-load"],
  ["shellUsable", "desktop.window.app.shell-usable"],
  ["shellPainted", "desktop.window.app.shell-painted"],
];

function parseArgs(argv) {
  const options = {
    logDir: join(process.env.RYCO_HOME?.trim() || join(homedir(), ".ryco"), "userdata", "logs"),
    last: Number.POSITIVE_INFINITY,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--log-dir") options.logDir = argv[++index];
    else if (arg === "--last") options.last = Number.parseInt(argv[++index] ?? "", 10);
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: boot-report.mjs [--log-dir <dir>] [--last <n>] [--json]");
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** Oldest rotated file first, so runs come out in chronological order. */
function logFiles(logDir, baseName) {
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((name) => name === baseName || name.startsWith(`${baseName}.`))
    .map((name) => ({
      name,
      index: name === baseName ? 0 : Number(name.slice(baseName.length + 1)),
    }))
    .filter((entry) => Number.isInteger(entry.index))
    .toSorted((left, right) => right.index - left.index)
    .map((entry) => join(logDir, entry.name));
}

function detailNumber(detail, key) {
  const match = detail === undefined ? null : DETAIL_NUMBER_RE(key).exec(detail);
  return match ? Number(match[1]) : undefined;
}

/** Backend phase durations of one run, keyed by phase name without the `backend.` prefix. */
function backendPhaseDurations(marks) {
  const durations = {};
  for (const mark of marks) {
    if (!mark.phase.startsWith("backend.")) continue;
    const durationMs = detailNumber(mark.detail, "durationMs");
    if (durationMs === undefined) continue;
    const name = mark.phase.slice("backend.".length);
    durations[name] = Math.max(durations[name] ?? 0, durationMs);
  }
  return durations;
}

export function readDesktopRuns(files) {
  const runs = new Map();
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = DESKTOP_TIMING_RE.exec(line);
      if (!match) continue;
      const [, timestamp, run, phase, elapsed, , detail] = match;
      if (!runs.has(run)) runs.set(run, { run, timestamp, marks: [] });
      runs.get(run).marks.push({ phase, elapsedMs: Number(elapsed), detail });
    }
  }
  return [...runs.values()].map((run) => {
    const first = (phase) => run.marks.find((mark) => mark.phase === phase)?.elapsedMs;
    const spawns = run.marks.filter((mark) => mark.phase === "desktop.backend.spawn").length;
    const timings = Object.fromEntries(PHASES.map(([label, phase]) => [label, first(phase)]));
    const listening = run.marks.find((mark) => mark.phase === "desktop.backend.listening");
    const launch = run.marks.find((mark) => mark.phase === "desktop.launch");
    return {
      run: run.run,
      timestamp: run.timestamp,
      spawns,
      listeningSource: listening?.detail?.replace(/^source=/, "") ?? null,
      // Time Electron and the main bundle took before `desktop.launch`, the origin of `timings`.
      preMainMs: detailNumber(launch?.detail, "processUptimeMs"),
      mainModuleLoadMs: detailNumber(launch?.detail, "mainModuleLoadMs"),
      timings,
      backendPhases: backendPhaseDurations(run.marks),
    };
  });
}

/**
 * Percentiles per backend phase, slowest p90 first. Provider instances collapse into one row
 * (the slowest instance of each run) that names the instance that was slowest overall.
 */
export function summarizeBackendPhases(runs, limit = TOP_BACKEND_PHASES) {
  const byPhase = new Map();
  const add = (name, value) => {
    if (!byPhase.has(name)) byPhase.set(name, []);
    byPhase.get(name).push(value);
  };
  let worstProviderCreate = null;
  for (const run of runs) {
    let slowestProviderCreate;
    for (const [name, durationMs] of Object.entries(run.backendPhases)) {
      if (!name.startsWith(PROVIDER_CREATE_PREFIX)) {
        add(name, durationMs);
        continue;
      }
      slowestProviderCreate = Math.max(slowestProviderCreate ?? 0, durationMs);
      if (worstProviderCreate === null || durationMs > worstProviderCreate.durationMs) {
        worstProviderCreate = {
          instance: name.slice(PROVIDER_CREATE_PREFIX.length),
          durationMs,
          run: run.run,
        };
      }
    }
    if (slowestProviderCreate !== undefined)
      add("provider.instance.create (slowest)", slowestProviderCreate);
  }
  const phases = [...byPhase.entries()]
    .map(([name, values]) => Object.assign({ name }, percentiles(values)))
    .toSorted((left, right) => right.p90 - left.p90 || left.name.localeCompare(right.name))
    .slice(0, limit);
  return { phases, worstProviderCreate };
}

function readServerSessions(files) {
  const sessions = [];
  for (const file of files) {
    let current = null;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const start = SESSION_START_RE.exec(line);
      if (start) {
        current = { startedAt: new Date(`${start[1]}Z`), firstLogMs: null, listeningMs: null };
        sessions.push(current);
        continue;
      }
      if (!current || line.length > 400) continue;
      const log = SERVER_LOG_RE.exec(line);
      if (!log) continue;
      const at = new Date(current.startedAt);
      at.setHours(Number(log[1]), Number(log[2]), Number(log[3]), Number(log[4]));
      let offsetMs = at.getTime() - current.startedAt.getTime();
      if (offsetMs < -43_200_000) offsetMs += 86_400_000;
      current.firstLogMs ??= offsetMs;
      if (current.listeningMs === null && log[5].startsWith("Listening on")) {
        current.listeningMs = offsetMs;
      }
    }
  }
  return sessions.filter(
    (session) =>
      session.listeningMs !== null && session.listeningMs >= 0 && session.listeningMs < 120_000,
  );
}

export function percentiles(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), min: sorted[0], max: sorted.at(-1) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const allRuns = readDesktopRuns(logFiles(options.logDir, "desktop-main.log"));
  // Runs that restarted their backend measure the crash, not the launch.
  const runs = allRuns.filter((run) => run.spawns === 1).slice(-options.last);
  const derived = {
    preMain: runs.map((run) => run.preMainMs),
    mainModuleLoad: runs.map((run) => run.mainModuleLoadMs),
    shellUsableFromProcessStart: runs.map((run) => run.preMainMs + run.timings.shellUsable),
    spawnToListening: runs.map((run) => run.timings.backendListening - run.timings.backendSpawn),
    listeningToAppLoaded: runs.map((run) => run.timings.appLoaded - run.timings.backendListening),
  };
  const sessions = readServerSessions(logFiles(options.logDir, "server-child.log")).slice(
    -options.last,
  );
  const report = {
    logDir: options.logDir,
    runs: allRuns.length,
    singleSpawnRuns: runs.length,
    phases: Object.fromEntries(
      PHASES.map(([label]) => [label, percentiles(runs.map((run) => run.timings[label]))]),
    ),
    derived: Object.fromEntries(
      Object.entries(derived).map(([label, values]) => [label, percentiles(values)]),
    ),
    backendPhases: summarizeBackendPhases(runs),
    listeningSources: runs.reduce((counts, run) => {
      if (run.listeningSource) counts[run.listeningSource] = (counts[run.listeningSource] ?? 0) + 1;
      return counts;
    }, {}),
    server: {
      sessions: sessions.length,
      firstLog: percentiles(sessions.map((session) => session.firstLogMs)),
      listening: percentiles(sessions.map((session) => session.listeningMs)),
    },
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const row = (label, stats) =>
    `  ${label.padEnd(22)} ${
      stats === null
        ? "no data"
        : `n=${stats.n} p50=${stats.p50}ms p90=${stats.p90}ms min=${stats.min} max=${stats.max}`
    }`;
  console.log(
    `Desktop startup (${report.singleSpawnRuns} of ${report.runs} runs, ms since desktop.launch)`,
  );
  for (const [label, stats] of Object.entries(report.phases)) console.log(row(label, stats));
  for (const [label, stats] of Object.entries(report.derived)) console.log(row(label, stats));
  console.log(`  listening sources      ${JSON.stringify(report.listeningSources)}`);
  console.log(`Backend phases (durationMs, slowest p90 first)`);
  if (report.backendPhases.phases.length === 0) console.log("  no data");
  for (const { name, ...stats } of report.backendPhases.phases) console.log(row(name, stats));
  const worst = report.backendPhases.worstProviderCreate;
  if (worst !== null) {
    console.log(
      `  slowest provider create: ${worst.instance} ${worst.durationMs}ms (run ${worst.run})`,
    );
  }
  console.log(`Backend (${report.server.sessions} sessions, ms since spawn)`);
  console.log(row("firstLog", report.server.firstLog));
  console.log(row("listening", report.server.listening));
}

/**
 * Whether the module at `moduleUrl` is the script node was asked to run. The module URL is
 * resolved through symlinks (macOS /tmp is one), `argv[1]` is not, so resolve it too.
 */
export function isMainModule(moduleUrl, argvPath) {
  if (argvPath === undefined) return false;
  let resolved = argvPath;
  try {
    resolved = realpathSync(argvPath);
  } catch {
    // Fall back to the path as given.
  }
  return moduleUrl === pathToFileURL(resolved).href;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
