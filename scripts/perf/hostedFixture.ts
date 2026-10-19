import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { stopProcess } from "./serverLifecycle.ts";

/**
 * Local nodes for hosted-switch measurements.
 *
 * Starts N `ryco serve` nodes on generated, sanitized homes, enrolls each with
 * a compatible Hub, and keeps them running until interrupted. The Hub itself
 * (and how an enrollment gets approved) is outside this repository: the caller
 * gives its origin and, optionally, a command that approves one enrollment
 * file. Everything runs on loopback with file-backed key storage, so no
 * platform keychain is touched.
 */

const ENROLL_TIMEOUT_MS = 60_000;
const ONLINE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const GENERATE_TIMEOUT_MS = 30 * 60_000;

export interface HostedFixtureOptions {
  readonly repoRoot: string;
  /** Origin the nodes enroll with; behind a delay proxy, the proxied origin. */
  readonly hubOrigin: string;
  readonly baseDir: string;
  readonly nodes: number;
  readonly projects: number;
  readonly threads: number;
  readonly portBase: number;
  /** Shell command run with the path of one enrollment file appended. */
  readonly approveCommand: string | null;
  /** Start nodes with the Hub thread read cache enabled. */
  readonly threadCache: boolean;
}

export interface HostedFixtureNode {
  readonly label: string;
  readonly baseDir: string;
  readonly port: number;
  readonly environmentId: string;
  readonly pid: number;
}

/** The identity a node starts from, so enrollment uses permissioned files instead of a keychain. */
export function seedHubIdentity(environmentId: string): string {
  return JSON.stringify({
    version: 1,
    revision: 1,
    environmentId,
    protectedStoreBackend: "permissioned-file",
    pendingEnrollment: null,
    activeNode: null,
    stagedRotation: null,
    pendingTeardown: null,
  });
}

export function newEnvironmentId(): string {
  return `env_${randomBytes(16).toString("base64url")}`;
}

const nodeBinary = () => process.env.RYCO_PERF_NODE_BINARY || "node";

function runCommand(
  description: string,
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${description} failed.\n${stderr}`.trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function nodeCli(
  repoRoot: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<string> {
  return runCommand(
    `ryco ${args.slice(0, 2).join(" ")}`,
    nodeBinary(),
    [path.join(repoRoot, "apps/server/src/bin.ts"), ...args],
    { cwd: repoRoot, timeoutMs, signal },
  );
}

/** Retries `attempt` until it returns a value, the deadline passes, or `signal` aborts. */
async function pollUntil<T>(
  description: string,
  timeoutMs: number,
  signal: AbortSignal,
  attempt: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await attempt();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }
  const detail = lastError instanceof Error ? `\n${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}.${detail}`);
}

async function hubState(
  repoRoot: string,
  nodeDir: string,
  signal: AbortSignal,
): Promise<string | null> {
  const output = await nodeCli(
    repoRoot,
    ["hub", "status", "--base-dir", nodeDir, "--json"],
    signal,
  );
  const status = JSON.parse(output) as { readonly state?: unknown };
  return typeof status.state === "string" ? status.state : null;
}

function approveEnrollment(
  command: string,
  enrollFile: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // The file path is a positional parameter, so it needs no shell quoting.
    const child = spawn("sh", ["-c", `${command} "$1"`, "sh", enrollFile], {
      stdio: ["ignore", "inherit", "inherit"],
      signal,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`The approve command exited with ${String(code)}.`)),
    );
  });
}

function startNode(input: {
  readonly options: HostedFixtureOptions;
  readonly label: string;
  readonly nodeDir: string;
  readonly port: number;
  readonly logFile: string;
}): ChildProcess {
  const cwd = path.join(input.nodeDir, "workspaces", "project-1");
  mkdirSync(cwd, { recursive: true });
  const log = openSync(input.logFile, "a");
  try {
    return spawn(
      nodeBinary(),
      [
        path.join(input.options.repoRoot, "apps/server/src/bin.ts"),
        "serve",
        "--base-dir",
        input.nodeDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(input.port),
        "--no-browser",
        "--hub-connector-enabled",
        "--hub-origin",
        input.options.hubOrigin,
        "--hub-allow-file-secret-store",
        "--hub-node-name",
        input.label,
      ],
      {
        cwd,
        env: {
          ...process.env,
          RYCO_TELEMETRY_ENABLED: "false",
          RYCO_HUB_THREAD_CACHE_ENABLED: input.options.threadCache ? "true" : "false",
        },
        stdio: ["ignore", log, log],
        detached: process.platform !== "win32",
      },
    );
  } finally {
    closeSync(log);
  }
}

async function prepareNode(options: HostedFixtureOptions, ordinal: number, signal: AbortSignal) {
  const nodeDir = path.join(options.baseDir, `node${ordinal}`);
  await runCommand(
    "Fixture home generation",
    nodeBinary(),
    [
      path.join(options.repoRoot, "apps/server/scripts/generate-fixture-home.ts"),
      "--out",
      nodeDir,
      "--projects",
      String(options.projects),
      "--threads",
      String(options.threads),
      "--turns",
      "4",
      "--archived",
      "0.2",
      "--seed",
      String(ordinal),
    ],
    { cwd: options.repoRoot, timeoutMs: GENERATE_TIMEOUT_MS, signal },
  );
  const userdata = path.join(nodeDir, "userdata");
  chmodSync(userdata, 0o700);
  const environmentId = newEnvironmentId();
  writeFileSync(path.join(userdata, "hub-identity.json"), seedHubIdentity(environmentId), {
    mode: 0o600,
  });
  return { nodeDir, environmentId };
}

/** Resolves once the child process exists; rejects when it could not be started. */
function spawned(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

/**
 * Starts the fixture and resolves after an interrupt has stopped every node.
 * An interrupt during setup (home generation, enrollment, approval) stops the
 * nodes started so far, and a node that fails to start or exits while the
 * fixture runs stops the rest and rejects.
 */
export async function runHostedFixture(options: HostedFixtureOptions): Promise<void> {
  mkdirSync(options.baseDir, { recursive: true });
  const children: ChildProcess[] = [];
  const nodes: HostedFixtureNode[] = [];
  const abort = new AbortController();
  const { signal } = abort;
  const failures: Error[] = [];
  let stopping = false;
  // Nodes run in their own process groups, so a terminal interrupt only
  // reaches this process. The handlers stay installed until every node stopped.
  const interrupt = () => abort.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  const fail = (error: Error) => {
    failures.push(error);
    abort.abort();
  };
  const watch = (child: ChildProcess, label: string) => {
    child.once("error", (error) => fail(new Error(`${label}: ${error.message}`)));
    child.once("exit", (code, exitSignal) => {
      if (stopping) return;
      fail(
        new Error(
          `${label} exited unexpectedly (${exitSignal ?? `code ${String(code)}`}); see its log in ${options.baseDir}.`,
        ),
      );
    });
  };
  const stopAll = async () => {
    stopping = true;
    await Promise.all(
      children
        .filter((child) => child.pid !== undefined)
        .map((child) => stopProcess(child, { ownsProcessGroup: process.platform !== "win32" })),
    );
  };

  try {
    for (let index = 0; index < options.nodes; index += 1) {
      const ordinal = index + 1;
      const label = `Fixture ${ordinal}`;
      console.log(
        `${label}: generating ${options.threads} threads in ${options.projects} projects`,
      );
      const { nodeDir, environmentId } = await prepareNode(options, ordinal, signal);

      const port = options.portBase + index;
      const child = startNode({
        options,
        label,
        nodeDir,
        port,
        logFile: path.join(options.baseDir, `node${ordinal}.log`),
      });
      children.push(child);
      watch(child, label);
      await spawned(child);
      if (child.pid === undefined) throw new Error(`${label}: the server did not start.`);

      const enrollFile = path.join(options.baseDir, `enroll${ordinal}.json`);
      const enrollment = await pollUntil(
        `${label} to accept enrollment`,
        ENROLL_TIMEOUT_MS,
        signal,
        () => nodeCli(options.repoRoot, ["hub", "enroll", "--base-dir", nodeDir, "--json"], signal),
      );
      writeFileSync(enrollFile, enrollment);
      console.log(`${label}: enrollment written to ${enrollFile}`);

      if (options.approveCommand) {
        await approveEnrollment(options.approveCommand, enrollFile, signal);
        await pollUntil(`${label} to come online`, ONLINE_TIMEOUT_MS, signal, async () =>
          (await hubState(options.repoRoot, nodeDir, signal)) === "online" ? true : null,
        );
        console.log(`${label}: online on port ${port}`);
      }
      nodes.push({ label, baseDir: nodeDir, port, environmentId, pid: child.pid });
    }

    writeFileSync(
      path.join(options.baseDir, "fixture.json"),
      JSON.stringify(
        { hubOrigin: options.hubOrigin, threadCache: options.threadCache, nodes },
        null,
        2,
      ),
    );
    console.log(`Fixture ready (${nodes.length} nodes). Press Ctrl+C to stop.`);

    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } catch (error) {
    // An interrupt or a failed node aborts the setup step in flight; anything
    // else is a real failure.
    if (!signal.aborted) throw error;
  } finally {
    console.log("Stopping nodes...");
    try {
      await stopAll();
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
  const [failure] = failures;
  if (failure) throw failure;
}
