/**
 * One Ryco server per data directory, with real server processes: a second
 * server on the same base directory exits with EX_CONFIG (78) and names the
 * first, also when it inherited a service's label, a CLI command still works
 * next to the running server, and a killed server's lock is reclaimed by the
 * next one.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const SERVER_ROOT = NodePath.join(import.meta.dirname, "..");
const BIN = NodePath.join(SERVER_ROOT, "src/bin.ts");
const READY_TIMEOUT_MS = 60_000;

const baseDirs: string[] = [];
const processes: NodeChildProcess.ChildProcess[] = [];

afterEach(() => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const baseDir of baseDirs.splice(0)) {
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
});

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

interface Launched {
  readonly child: NodeChildProcess.ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function launch(
  baseDir: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
): Launched {
  const child = NodeChildProcess.spawn(process.execPath, [BIN, ...args, "--base-dir", baseDir], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      RYCO_HOME: baseDir,
      RYCO_NO_BROWSER: "true",
      RYCO_TELEMETRY_ENABLED: "false",
      RYCO_HUB_CONNECTOR_ENABLED: "false",
      // A second server gives up after half a second instead of ten.
      RYCO_DB_OWNER_WAIT_MS: "500",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, output: () => output, exited };
}

async function launchServer(
  baseDir: string,
  env?: Readonly<Record<string, string>>,
): Promise<Launched> {
  const port = await reservePort();
  return launch(
    baseDir,
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
    env,
  );
}

async function waitForReady(server: Launched): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!/(?:^|\n)Pairing URL:\s/u.test(server.output())) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`server exited before it was ready:\n${server.output()}`);
    }
    if (Date.now() > deadline) throw new Error(`server not ready:\n${server.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("database owner lock across processes", () => {
  it("lets one server use a data directory, keeps the CLI working, and reclaims a killed server's lock", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-db-owner-it-"));
    baseDirs.push(baseDir);
    const lockPath = NodePath.join(baseDir, "userdata", "state.sqlite.owner");

    const first = await launchServer(baseDir);
    await waitForReady(first);
    expect(JSON.parse(NodeFS.readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: first.child.pid,
      kind: "server",
      launcher: "serve",
    });

    // A CLI command opens the same database while the server runs.
    const cli = launch(baseDir, ["auth", "pairing", "list"]);
    const cliExit = await cli.exited;
    expect(cliExit.code, cli.output()).toBe(0);

    // Started by an agent of a `ryco service`, it inherits the service's label (and on systemd
    // the service's SYSTEMD_EXEC_PID): it is not the service, so it does not wait for good.
    const second = await launchServer(baseDir, {
      RYCO_SERVICE_LABEL: "space.ryco.node",
      SYSTEMD_EXEC_PID: "1",
    });
    const secondExit = await second.exited;
    expect(secondExit.code, second.output()).toBe(78);
    expect(second.output()).toContain("Another Ryco server is using this data directory");
    expect(second.output()).toContain(`pid ${first.child.pid}`);

    // Killed without a chance to release: the next server reclaims the lock.
    first.child.kill("SIGKILL");
    await first.exited;
    const third = await launchServer(baseDir);
    await waitForReady(third);
    expect(JSON.parse(NodeFS.readFileSync(lockPath, "utf8")).pid).toBe(third.child.pid);

    // A clean stop releases it.
    third.child.kill("SIGTERM");
    await third.exited;
    expect(NodeFS.existsSync(lockPath)).toBe(false);
  }, 180_000);
});
