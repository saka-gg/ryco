/**
 * A desktop backend whose app is gone shuts down through its finalizers,
 * whether the app closed its end of the fd-4 pipe or was killed, and the
 * watchdog ends it when a finalizer hangs. Each case runs a real backend
 * process (fixtures/desktopParentLifetimeBackend.ts) on a real pipe.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const FIXTURE = NodePath.join(import.meta.dirname, "fixtures/desktopParentLifetimeBackend.ts");
const HUNG_SHUTDOWN_TIMEOUT_MS = 300;
const PARENT_LOSS_WARNING = "desktop app is gone; shutting the backend down";

const stateDirs: string[] = [];
const processes: NodeChildProcess.ChildProcess[] = [];

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    const pid = Number(readState(stateDir, "ready"));
    if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function makeStateDir(): string {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-desktop-parent-"));
  stateDirs.push(stateDir);
  return stateDir;
}

function readState(stateDir: string, name: string): string | null {
  try {
    return NodeFS.readFileSync(NodePath.join(stateDir, name), "utf8");
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw cause;
  }
}

async function waitFor<A>(read: () => A | null, what: string): Promise<A> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function exited(child: NodeChildProcess.ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** The desktop's stdio layout (apps/desktop/src/backendLauncher.ts); fd 4 is the app's pipe. */
const DESKTOP_BACKEND_STDIO = ["ignore", "pipe", "pipe", "pipe", "pipe"] as const;

function spawnBackend(stateDir: string, args: ReadonlyArray<string>) {
  const child = NodeChildProcess.spawn(process.execPath, [FIXTURE, stateDir, ...args], {
    env: { ...process.env, RYCO_HOME: stateDir },
    stdio: [...DESKTOP_BACKEND_STDIO],
  });
  processes.push(child);
  child.stdout?.resume();
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { child, stderr: () => stderr };
}

async function waitForReady(stateDir: string, stderr: () => string): Promise<number> {
  const pid = await waitFor(() => readState(stateDir, "ready"), `backend start (${stderr()})`);
  return Number(pid);
}

describe.skipIf(process.platform === "win32")("desktop backend parent lifetime", () => {
  it("runs the finalizers and exits once the app closes its end of the pipe", async () => {
    const stateDir = makeStateDir();
    const backend = spawnBackend(stateDir, ["graceful"]);
    await waitForReady(stateDir, backend.stderr);

    backend.child.stdio[4]?.destroy();

    // 130: interrupted, as on SIGTERM.
    expect(await exited(backend.child)).toEqual({ code: 130, signal: null });
    expect(readState(stateDir, "finalized")).not.toBeNull();
    expect(readState(stateDir, "log")).toContain(PARENT_LOSS_WARNING);
  });

  it("runs the finalizers and exits once the app is killed", async () => {
    const stateDir = makeStateDir();
    // The app holds the pipe and the backend's stdout and stderr, as Electron does.
    const app = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        `require("node:child_process").spawn(process.execPath, process.argv.slice(1), {
          stdio: ${JSON.stringify(DESKTOP_BACKEND_STDIO)},
        });`,
        FIXTURE,
        stateDir,
        "graceful",
      ],
      { env: { ...process.env, RYCO_HOME: stateDir }, stdio: "ignore" },
    );
    processes.push(app);
    const pid = await waitForReady(stateDir, () => "");

    app.kill("SIGKILL");
    await exited(app);

    expect(await waitFor(() => readState(stateDir, "exit-code"), "backend exit")).toBe("130");
    await waitFor(() => (isAlive(pid) ? null : true), "backend process to end");
    expect(readState(stateDir, "finalized")).not.toBeNull();
    expect(readState(stateDir, "log")).toContain(PARENT_LOSS_WARNING);
  });

  it("exits through the watchdog when a finalizer hangs", async () => {
    const stateDir = makeStateDir();
    const backend = spawnBackend(stateDir, ["hung", String(HUNG_SHUTDOWN_TIMEOUT_MS)]);
    await waitForReady(stateDir, backend.stderr);

    backend.child.stdio[4]?.destroy();

    expect(await exited(backend.child)).toEqual({ code: 1, signal: null });
    expect(readState(stateDir, "finalizer-started")).not.toBeNull();
    expect(readState(stateDir, "finalized")).toBeNull();
    expect(backend.stderr()).toContain(
      `backend shutdown did not finish within ${HUNG_SHUTDOWN_TIMEOUT_MS} ms`,
    );
  });
});
