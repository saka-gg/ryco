import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  canReplaceDatabaseInPlace,
  pickRestorableBackup,
  readRestoreOutcome,
  runServerCli,
  serverCliArgs,
  type ServerCliLaunch,
} from "./databaseRecovery.ts";

const launch: ServerCliLaunch = {
  executable: "/Applications/Ryco.app/Contents/MacOS/Ryco",
  backendEntry: "/Applications/Ryco.app/Contents/Resources/app/server/bin.mjs",
  nodeRuntime: true,
  compileCacheHook: "/Applications/Ryco.app/Contents/Resources/app/compileCache.cjs",
  cwd: "/Users/me",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  baseDir: "/Users/me/.ryco",
  devUrl: null,
};

describe("serverCliArgs", () => {
  it("runs a CLI command with the packaged backend's runtime flags and data directory", () => {
    expect(serverCliArgs(launch, ["db", "list"])).toEqual([
      "--max-semi-space-size=16",
      "--require",
      launch.compileCacheHook,
      launch.backendEntry,
      "db",
      "list",
      "--base-dir",
      "/Users/me/.ryco",
      "--json",
    ]);
  });

  it("passes Bun no Node flags and names the dev server in development", () => {
    expect(
      serverCliArgs({ ...launch, nodeRuntime: false, devUrl: "http://127.0.0.1:5733" }, [
        "db",
        "restore",
        "/x/state-v093-before-v095.sqlite.zst",
        "--replace",
      ]),
    ).toEqual([
      launch.backendEntry,
      "db",
      "restore",
      "/x/state-v093-before-v095.sqlite.zst",
      "--replace",
      "--base-dir",
      "/Users/me/.ryco",
      "--dev-url",
      "http://127.0.0.1:5733",
      "--json",
    ]);
  });
});

const listOutput = (backups: ReadonlyArray<Record<string, unknown>>) =>
  `${JSON.stringify({ directory: "/b", supportedSchema: 93, backups })}\n`;
const backup = (overrides: Record<string, unknown>) => ({
  name: "state.sqlite.zst",
  path: "/b/state.sqlite.zst",
  kind: "before-upgrade",
  from: 93,
  to: 95,
  createdAt: "2026-10-20T10:00:00.000Z",
  bytes: 1,
  state: "finalized",
  codec: "zst",
  opensWithThisBuild: true,
  ...overrides,
});

describe("pickRestorableBackup", () => {
  it("offers the newest backup this build opens whose check did not fail", () => {
    const picked = pickRestorableBackup(
      listOutput([
        backup({
          path: "/b/newer-schema",
          from: 95,
          createdAt: "2026-10-29T00:00:00.000Z",
          opensWithThisBuild: false,
        }),
        backup({ path: "/b/damaged", createdAt: "2026-10-28T00:00:00.000Z", state: "unverified" }),
        backup({ path: "/b/older", createdAt: "2026-10-01T00:00:00.000Z" }),
        backup({ path: "/b/newest-usable", createdAt: "2026-10-25T00:00:00.000Z", state: "raw" }),
      ]),
    );
    expect(picked).toEqual({
      path: "/b/newest-usable",
      createdAt: Date.parse("2026-10-25T00:00:00.000Z"),
      kind: "before-upgrade",
      schema: 93,
    });
  });

  it("offers nothing when no backup is usable or the output is not a listing", () => {
    expect(pickRestorableBackup(listOutput([]))).toBeNull();
    expect(pickRestorableBackup(listOutput([backup({ opensWithThisBuild: false })]))).toBeNull();
    expect(pickRestorableBackup("")).toBeNull();
    expect(pickRestorableBackup("not json\n")).toBeNull();
    expect(pickRestorableBackup('{"backups":"nope"}')).toBeNull();
  });
});

describe("readRestoreOutcome", () => {
  it("reads where the replaced database went", () => {
    expect(
      readRestoreOutcome({
        exitCode: 0,
        stdout: `${JSON.stringify({
          replacedDir: "/u/replaced-x",
          signedOut: true,
          revoked: { pairingLinks: 2, integrations: 1 },
          warnings: ["w"],
        })}\n`,
        stderr: "",
        timedOut: false,
      }),
    ).toEqual({
      ok: true,
      replacedDir: "/u/replaced-x",
      signedOut: true,
      revoked: { pairingLinks: 2, integrations: 1 },
      warnings: ["w"],
    });
  });

  it("reports the command's error line, or a timeout", () => {
    expect(
      readRestoreOutcome({
        exitCode: 1,
        stdout: "",
        stderr: "some log\nError: pid 4242 (node) still has /u/state.sqlite open.\n",
        timedOut: false,
      }),
    ).toEqual({ ok: false, message: "pid 4242 (node) still has /u/state.sqlite open." });
    expect(readRestoreOutcome({ exitCode: null, stdout: "", stderr: "", timedOut: true })).toEqual({
      ok: false,
      message: "The restore did not finish in time and was stopped.",
    });
  });
});

/** A child process double that `spawn` returns. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  return child;
}

describe("runServerCli", () => {
  it("collects the output and exit code", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const result = runServerCli(launch, ["db", "list"], 1_000, { spawn: spawn as never });
    child.stdout.write('{"backups":[]}\n');
    child.stderr.write("note\n");
    child.emit("close", 0);
    expect(await result).toEqual({
      exitCode: 0,
      stdout: '{"backups":[]}\n',
      stderr: "note\n",
      timedOut: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      launch.executable,
      serverCliArgs(launch, ["db", "list"]),
      expect.objectContaining({ cwd: launch.cwd, env: launch.env }),
    );
  });

  it("stops a run that takes too long with SIGTERM, then SIGKILL after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const result = runServerCli(launch, ["db", "list"], 30_000, {
        spawn: (() => child) as never,
        killGraceMs: 5_000,
      });
      vi.advanceTimersByTime(30_000);
      // SIGTERM first: a restore's swap cannot be interrupted, so it finishes before exiting.
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
      vi.advanceTimersByTime(5_000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", null);
      expect((await result).timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a run when the app quits", async () => {
    const child = fakeChild();
    const abort = new AbortController();
    const result = runServerCli(launch, ["db", "list"], 30_000, {
      spawn: (() => child) as never,
      signal: abort.signal,
    });
    abort.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null);
    expect((await result).timedOut).toBe(false);
  });

  it("never rejects when the executable cannot start", async () => {
    const result = await runServerCli(launch, ["db", "list"], 1_000, {
      spawn: (() => {
        throw new Error("spawn ENOENT");
      }) as never,
    });
    expect(result).toEqual({ exitCode: null, stdout: "", stderr: "spawn ENOENT", timedOut: false });
  });
});

describe("canReplaceDatabaseInPlace", () => {
  it("offers an in-place restore only where other processes holding the file can be seen", () => {
    expect(canReplaceDatabaseInPlace("darwin")).toBe(true);
    expect(canReplaceDatabaseInPlace("linux")).toBe(true);
    expect(canReplaceDatabaseInPlace("win32")).toBe(false);
  });
});
