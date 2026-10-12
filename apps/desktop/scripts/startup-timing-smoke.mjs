#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const desktopDir = resolve(scriptDir, "..");

const SUMMARY_PHASES = [
  ["windowCreated", "desktop.window.create"],
  ["firstReveal", "desktop.window.first-reveal"],
  ["backendSpawn", "desktop.backend.spawn"],
  ["backendBound", "desktop.backend.http-bound"],
  ["backendListening", "desktop.backend.listening"],
  ["bootLoaded", "desktop.window.boot.did-finish-load"],
  ["appDomReady", "desktop.window.app.dom-ready"],
  ["appLoaded", "desktop.window.app.did-finish-load"],
  ["shellUsable", "desktop.window.app.shell-usable"],
  ["shellPainted", "desktop.window.app.shell-painted"],
];
const REQUIRED_PHASES = new Set([
  "desktop.window.create",
  "desktop.window.first-reveal",
  "desktop.backend.listening",
  "desktop.window.app.did-finish-load",
  // Reported by the renderer once the primary shell snapshot is applied: the
  // point where the app is actually usable, not just loaded.
  "desktop.window.app.shell-usable",
]);
// Phases recorded before the main bundle loaded (entry start, early backend
// spawn) have negative elapsed times.
const TIMING_RE = /startup timing phase=(\S+) elapsedMs=(-?\d+) deltaMs=(-?\d+)(?:\s+(.*))?$/;

function usage() {
  return `Usage: node apps/desktop/scripts/startup-timing-smoke.mjs [options]

Options:
  --app <path>                 Packaged app bundle or executable to launch.
  --base-dir <path>            RYCO_HOME to use for the smoke profile.
  --timeout-ms <ms>            Timeout before failing. Default: 20000.
  --max-app-loaded-ms <ms>     Fail if appLoaded exceeds this time.
  --max-first-reveal-ms <ms>   Fail if firstReveal exceeds this time.
  --max-shell-usable-ms <ms>   Fail if shellUsable exceeds this time.
  --json                       Emit JSON summary.
  --keep-base-dir              Keep the temporary RYCO_HOME on success.
  --help                       Show this help.

Without --app, the script launches the local Electron build at apps/desktop/dist-electron/main.cjs.`;
}

function parseArgs(argv) {
  const parsed = {
    app: undefined,
    baseDir: undefined,
    timeoutMs: 20_000,
    maxAppLoadedMs: undefined,
    maxFirstRevealMs: undefined,
    maxShellUsableMs: undefined,
    json: false,
    keepBaseDir: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    if (arg === "--app") parsed.app = readValue();
    else if (arg === "--base-dir") parsed.baseDir = readValue();
    else if (arg === "--timeout-ms") parsed.timeoutMs = parsePositiveInt(arg, readValue());
    else if (arg === "--max-app-loaded-ms")
      parsed.maxAppLoadedMs = parsePositiveInt(arg, readValue());
    else if (arg === "--max-first-reveal-ms")
      parsed.maxFirstRevealMs = parsePositiveInt(arg, readValue());
    else if (arg === "--max-shell-usable-ms")
      parsed.maxShellUsableMs = parsePositiveInt(arg, readValue());
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--keep-base-dir") parsed.keepBaseDir = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function parsePositiveInt(name, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function resolveMacAppExecutable(appPath) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  let executableName = basename(appPath, ".app");
  if (existsSync(plistPath)) {
    const result = spawnSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleExecutable", plistPath],
      { encoding: "utf8" },
    );
    if (result.status === 0 && result.stdout.trim()) {
      executableName = result.stdout.trim();
    }
  }
  return join(appPath, "Contents", "MacOS", executableName);
}

async function resolveLaunchTarget(appPath) {
  if (appPath) {
    const resolvedAppPath = resolve(appPath);
    const executable =
      process.platform === "darwin" && extname(resolvedAppPath) === ".app"
        ? resolveMacAppExecutable(resolvedAppPath)
        : resolvedAppPath;
    if (!existsSync(executable)) {
      throw new Error(`App executable not found: ${executable}`);
    }
    return {
      command: executable,
      args: [],
      cwd: undefined,
      label: resolvedAppPath,
    };
  }

  const electronBin = resolve(desktopDir, "node_modules/.bin/electron");
  const mainPath = join(desktopDir, "dist-electron", "main.cjs");
  if (!existsSync(electronBin)) {
    throw new Error(`Missing Electron binary at ${electronBin}. Run 'bun install' first.`);
  }
  if (!existsSync(mainPath)) {
    throw new Error(`Missing ${mainPath}. Run 'bun run build --filter=@ryco/desktop' first.`);
  }
  return {
    command: electronBin,
    args: ["dist-electron/main.cjs"],
    cwd: desktopDir,
    label: mainPath,
  };
}

function parseTimingLine(source, line, entries, firstByPhase) {
  const match = TIMING_RE.exec(line);
  if (!match) return;
  const phase = match[1];
  const entry = {
    phase,
    elapsedMs: Number(match[2]),
    deltaMs: Number(match[3]),
    detail: match[4] || undefined,
    source,
  };
  entries.push(entry);
  if (!firstByPhase.has(phase)) {
    firstByPhase.set(phase, entry);
  }
}

function makeTextIngestor(onLine) {
  const buffers = new Map();
  return (source, text) => {
    const previous = buffers.get(source) ?? "";
    const parts = `${previous}${text}`.split(/\r?\n/);
    buffers.set(source, parts.pop() ?? "");
    for (const line of parts) {
      onLine(source, line);
    }
  };
}

function readNewFileContent(filePath, offsets) {
  if (!existsSync(filePath)) return "";
  const stat = statSync(filePath);
  const previous = offsets.get(filePath) ?? 0;
  if (stat.size < previous) {
    offsets.set(filePath, 0);
  }
  const start = offsets.get(filePath) ?? 0;
  if (stat.size === start) return "";
  const content = readFileSync(filePath, "utf8").slice(start);
  offsets.set(filePath, stat.size);
  return content;
}

function buildSummary(input) {
  const timings = {};
  for (const [label, phase] of SUMMARY_PHASES) {
    timings[label] = input.firstByPhase.get(phase)?.elapsedMs ?? null;
  }
  return {
    launchTarget: input.launchTarget,
    baseDir: input.baseDir,
    logFiles: input.logFiles,
    timings,
    entries: input.entries,
    outputTail: input.outputTail,
  };
}

function printSummary(summary, json) {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("\nDesktop startup timing summary:");
  for (const [label] of SUMMARY_PHASES) {
    const value = summary.timings[label];
    console.log(`  ${label.padEnd(16)} ${value === null ? "missing" : `${value}ms`}`);
  }
  console.log(`\nLaunch target: ${summary.launchTarget}`);
  console.log(`RYCO_HOME: ${summary.baseDir}`);
  console.log(`Desktop log: ${summary.logFiles.desktop}`);
  console.log(`Backend log: ${summary.logFiles.backend}`);
}

function missingRequiredPhases(firstByPhase) {
  return [...REQUIRED_PHASES].filter((phase) => !firstByPhase.has(phase));
}

function thresholdFailures(summary, options) {
  const failures = [];
  if (
    options.maxAppLoadedMs !== undefined &&
    summary.timings.appLoaded !== null &&
    summary.timings.appLoaded > options.maxAppLoadedMs
  ) {
    failures.push(`appLoaded ${summary.timings.appLoaded}ms > ${options.maxAppLoadedMs}ms`);
  }
  if (
    options.maxFirstRevealMs !== undefined &&
    summary.timings.firstReveal !== null &&
    summary.timings.firstReveal > options.maxFirstRevealMs
  ) {
    failures.push(`firstReveal ${summary.timings.firstReveal}ms > ${options.maxFirstRevealMs}ms`);
  }
  if (
    options.maxShellUsableMs !== undefined &&
    summary.timings.shellUsable !== null &&
    summary.timings.shellUsable > options.maxShellUsableMs
  ) {
    failures.push(`shellUsable ${summary.timings.shellUsable}ms > ${options.maxShellUsableMs}ms`);
  }
  return failures;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const ownsBaseDir = options.baseDir === undefined;
  const baseDir = resolve(options.baseDir ?? mkdtempSync(join(tmpdir(), "ryco-startup-smoke-")));
  const logFiles = {
    desktop: join(baseDir, "userdata", "logs", "desktop-main.log"),
    backend: join(baseDir, "userdata", "logs", "server-child.log"),
  };
  const launch = await resolveLaunchTarget(options.app);
  const entries = [];
  const outputTail = [];
  const firstByPhase = new Map();
  const fileOffsets = new Map();
  let settled = false;

  const ingest = makeTextIngestor((source, line) => {
    if (line.trim().length > 0) {
      outputTail.push({ source, line });
      if (outputTail.length > 80) outputTail.shift();
    }
    parseTimingLine(source, line, entries, firstByPhase);
    if (missingRequiredPhases(firstByPhase).length === 0) {
      finish(0);
    }
  });

  const childEnv = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    RYCO_DESKTOP_STARTUP_TIMING_STDOUT: "1",
    RYCO_HOME: baseDir,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.VITE_DEV_SERVER_URL;

  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pollLogs = () => {
    ingest("desktop-log", readNewFileContent(logFiles.desktop, fileOffsets));
    ingest("backend-log", readNewFileContent(logFiles.backend, fileOffsets));
  };
  const interval = setInterval(pollLogs, 100);
  const timeout = setTimeout(() => {
    const missing = missingRequiredPhases(firstByPhase);
    finish(1, `Timed out after ${options.timeoutMs}ms. Missing: ${missing.join(", ")}`);
  }, options.timeoutMs);

  child.stdout.on("data", (chunk) => ingest("stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => ingest("stderr", chunk.toString()));
  child.on("error", (error) => finish(1, `Failed to launch desktop app: ${error.message}`));
  child.on("exit", (code, signal) => {
    if (!settled) {
      finish(1, `Desktop app exited before startup completed (code=${code}, signal=${signal})`);
    }
  });

  function finish(code, message) {
    if (settled) return;
    settled = true;
    clearInterval(interval);
    clearTimeout(timeout);
    pollLogs();

    const summary = buildSummary({
      launchTarget: launch.label,
      baseDir,
      logFiles,
      entries,
      outputTail,
      firstByPhase,
    });
    const failures = code === 0 ? thresholdFailures(summary, options) : [];
    const finalCode = failures.length > 0 ? 1 : code;

    printSummary(summary, options.json);
    if (message) {
      console.error(`\n${message}`);
    }
    for (const failure of failures) {
      console.error(`\nStartup timing threshold failed: ${failure}`);
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }

    if (ownsBaseDir && !options.keepBaseDir && finalCode === 0) {
      rmSync(baseDir, { recursive: true, force: true });
    }
    process.exitCode = finalCode;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
