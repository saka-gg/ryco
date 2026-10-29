// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  decideNodeUpdateBoot,
  failedDatabasePath,
  type GuardedNodeUpdateMarker,
  NODE_UPDATE_MAX_BOOT_ATTEMPTS,
  NODE_UPDATE_ROLLBACK_TRIES,
  readGuardedNodeUpdateMarker,
  runNodeUpdateBootGuard,
  serveStateDirectory,
} from "./bootGuard.ts";
import { type NodeUpdateMarker, readNodeUpdateMarker, writeNodeUpdateMarker } from "./marker.ts";

const startedAt = "2026-10-21T10:00:00.000Z";
const nowMs = Date.parse(startedAt) + 60_000;

const plan = {
  install: { command: "npm", args: ["install", "-g", "ryco-cli@0.1.35"], timeoutMs: 600_000 },
  databasePath: "/Users/me/.ryco/userdata/state.sqlite",
  snapshotPath: "/Users/me/.ryco/userdata/node-update/pre-0.1.35.sqlite",
};

const guarded = (overrides: Partial<GuardedNodeUpdateMarker> = {}): GuardedNodeUpdateMarker => ({
  fromVersion: "0.1.35",
  targetVersion: "0.1.36",
  startedAt,
  bootAttempts: 0,
  settled: false,
  rollback: plan,
  ...overrides,
});

describe("node update boot decision", () => {
  const decide = (marker: GuardedNodeUpdateMarker | null, runningVersion = "0.1.36") =>
    decideNodeUpdateBoot({ marker, runningVersion, nowMs });

  it("counts the target's starts and rolls back the one after two that never got ready", () => {
    expect(decide(guarded())).toEqual({ action: "count", bootAttempts: 1 });
    expect(decide(guarded({ bootAttempts: 1 }))).toEqual({ action: "count", bootAttempts: 2 });
    expect(decide(guarded({ bootAttempts: 2 }))).toEqual({
      action: "roll-back",
      bootAttempts: 3,
      plan,
    });
  });

  it("retries a failed rollback a few times, then lets the release start", () => {
    const lastTry = NODE_UPDATE_MAX_BOOT_ATTEMPTS + NODE_UPDATE_ROLLBACK_TRIES;
    expect(decide(guarded({ bootAttempts: lastTry - 1 }))).toMatchObject({
      action: "roll-back",
      bootAttempts: lastTry,
    });
    expect(decide(guarded({ bootAttempts: lastTry }))).toEqual({
      action: "count",
      bootAttempts: lastTry + 1,
    });
  });

  it("leaves every other start alone", () => {
    expect(decide(null)).toEqual({ action: "boot" });
    // Ready, or already rolled back.
    expect(decide(guarded({ settled: true, bootAttempts: 5 }))).toEqual({ action: "boot" });
    // A marker from an older release, or a desktop update: nothing to roll back to.
    expect(decide(guarded({ rollback: null, bootAttempts: 5 }))).toEqual({ action: "boot" });
    // Another release came back (the server reports it); the previous one after a rollback.
    expect(decide(guarded({ bootAttempts: 5 }), "0.1.35")).toEqual({ action: "boot" });
    // Nobody waits for an update older than a day.
    expect(
      decideNodeUpdateBoot({
        marker: guarded({ bootAttempts: 2 }),
        runningVersion: "0.1.36",
        nowMs: Date.parse(startedAt) + 25 * 60 * 60 * 1_000,
      }),
    ).toEqual({ action: "boot" });
  });
});

describe("node update marker, as the boot guard reads it", () => {
  it("reads markers of earlier releases as having nothing to roll back", () => {
    expect(
      readGuardedNodeUpdateMarker({
        requestId: "update-1",
        fromVersion: "0.1.34",
        targetVersion: "0.1.35",
        startedAt,
      }),
    ).toEqual(guarded({ fromVersion: "0.1.34", targetVersion: "0.1.35", rollback: null }));
  });

  it("reads the rollback plan, attempts and settlement", () => {
    expect(
      readGuardedNodeUpdateMarker({
        requestId: "update-1",
        fromVersion: "0.1.35",
        targetVersion: "0.1.36",
        startedAt,
        rollback: plan,
        bootAttempts: 2,
      }),
    ).toEqual(guarded({ bootAttempts: 2 }));
    expect(
      readGuardedNodeUpdateMarker({
        fromVersion: "0.1.35",
        targetVersion: "0.1.36",
        startedAt,
        readyAt: startedAt,
      }),
    ).toMatchObject({ settled: true });
  });

  it("ignores what is not a marker, and a plan it could not run", () => {
    expect(readGuardedNodeUpdateMarker(null)).toBeNull();
    expect(readGuardedNodeUpdateMarker([])).toBeNull();
    expect(readGuardedNodeUpdateMarker({ fromVersion: "0.1.35" })).toBeNull();
    expect(
      readGuardedNodeUpdateMarker({
        fromVersion: "0.1.35",
        targetVersion: "0.1.36",
        startedAt,
        rollback: { ...plan, install: { command: "npm", args: [1], timeoutMs: 1 } },
      }),
    ).toMatchObject({ rollback: null });
  });

  it.effect("reads what the server writes", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-boot-guard-"));
      const markerPath = NodePath.join(dir, "node-update.json");
      yield* writeNodeUpdateMarker(markerPath, {
        requestId: "update-1",
        fromVersion: "0.1.35",
        targetVersion: "0.1.36",
        startedAt,
        rollback: plan,
      });
      expect(
        readGuardedNodeUpdateMarker(JSON.parse(NodeFS.readFileSync(markerPath, "utf8"))),
      ).toEqual(guarded());
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("the state directory a service start uses", () => {
  const home = "/Users/me";
  const resolve = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
    serveStateDirectory({ args, env, homeDirectory: home });

  it("resolves it as the CLI does", () => {
    expect(resolve([])).toBe("/Users/me/.ryco/userdata");
    expect(resolve(["--base-dir", "/srv/ryco"])).toBe("/srv/ryco/userdata");
    expect(resolve(["--base-dir=/srv/ryco", "/Users/me/code"])).toBe("/srv/ryco/userdata");
    expect(resolve(["--base-dir", "~/nodes/two"])).toBe("/Users/me/nodes/two/userdata");
    expect(resolve([], { RYCO_HOME: "/opt/ryco" })).toBe("/opt/ryco/userdata");
    expect(resolve(["--base-dir", "/srv/ryco"], { RYCO_HOME: "/opt/ryco" })).toBe(
      "/srv/ryco/userdata",
    );
    expect(resolve(["--dev-url", "http://localhost:5733"])).toBe("/Users/me/.ryco/dev");
    expect(resolve([], { VITE_DEV_SERVER_URL: "http://localhost:5733" })).toBe(
      "/Users/me/.ryco/dev",
    );
  });
});

describe("node update rollback", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  /** A state directory with a live (WAL) database, a snapshot, and an installer that records. */
  const makeNode = (options: { readonly installerExit?: number; readonly snapshot?: boolean }) => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-rollback-"));
    dirs.push(stateDir);
    const updateDir = NodePath.join(stateDir, "node-update");
    NodeFS.mkdirSync(updateDir);
    const databasePath = NodePath.join(stateDir, "state.sqlite");
    const snapshotPath = NodePath.join(updateDir, "pre-0.1.35.sqlite");
    const installedPath = NodePath.join(stateDir, "installed.txt");

    const snapshot = new DatabaseSync(snapshotPath);
    snapshot.exec("CREATE TABLE note (text TEXT); INSERT INTO note VALUES ('before the update')");
    snapshot.close();
    if (options.snapshot === false) NodeFS.rmSync(snapshotPath);
    // The failed release's database, left open so its WAL and index stay beside it.
    const live = new DatabaseSync(databasePath);
    live.exec("PRAGMA journal_mode = WAL");
    live.exec("CREATE TABLE note (text TEXT); INSERT INTO note VALUES ('migrated by 0.1.36')");
    expect(NodeFS.existsSync(`${databasePath}-wal`)).toBe(true);

    const marker: NodeUpdateMarker = {
      requestId: "update-1",
      fromVersion: "0.1.35",
      targetVersion: "0.1.36",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      rollback: {
        install: {
          command: process.execPath,
          args: [
            "-e",
            `require("node:fs").appendFileSync(process.argv[1], "0.1.35\\n"); process.exit(${options.installerExit ?? 0})`,
            installedPath,
          ],
          timeoutMs: 30_000,
        },
        databasePath,
        snapshotPath,
      },
    };
    const markerPath = NodePath.join(stateDir, "node-update.json");
    const lines: Array<string> = [];
    const start = (runningVersion = "0.1.36") =>
      runNodeUpdateBootGuard({
        markerPath,
        runningVersion: () => runningVersion,
        log: (line) => lines.push(line),
      });
    const readNotes = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return (db.prepare("SELECT text FROM note").all() as Array<{ text: string }>).map(
          (row) => row.text,
        );
      } finally {
        db.close();
      }
    };
    const installs = () =>
      NodeFS.existsSync(installedPath)
        ? NodeFS.readFileSync(installedPath, "utf8").trim().split("\n").length
        : 0;
    const readMarker = () =>
      readNodeUpdateMarker(markerPath).pipe(
        Effect.map((value) => (value._tag === "Some" ? value.value : null)),
      );
    return {
      stateDir,
      updateDir,
      databasePath,
      markerPath,
      marker,
      live,
      lines,
      start,
      readNotes,
      installs,
      readMarker,
    };
  };

  it.effect("reinstalls the previous release and restores its database on the third start", () =>
    Effect.gen(function* () {
      const node = makeNode({});
      yield* writeNodeUpdateMarker(node.markerPath, node.marker);

      expect(node.start()).toBe("boot");
      expect(node.start()).toBe("boot");
      expect((yield* node.readMarker())?.bootAttempts).toBe(2);
      expect(node.installs()).toBe(0);

      expect(node.start()).toBe("exit");
      node.live.close();
      expect(node.installs()).toBe(1);
      expect(node.readNotes()).toEqual(["before the update"]);
      expect(NodeFS.existsSync(`${node.databasePath}-wal`)).toBe(false);
      expect(NodeFS.existsSync(`${node.databasePath}-shm`)).toBe(false);
      // The failed release's database is kept, with its WAL, for a look by hand.
      const failed = failedDatabasePath(node.updateDir, "0.1.36");
      const kept = new DatabaseSync(failed, { readOnly: true });
      expect(kept.prepare("SELECT text FROM note").all()).toEqual([{ text: "migrated by 0.1.36" }]);
      kept.close();
      expect(yield* node.readMarker()).toMatchObject({
        bootAttempts: 3,
        rolledBack: { failedBoots: 2, databaseRestored: true },
      });
      expect(node.lines.at(-1)).toBe(
        "Rolled back to Ryco 0.1.35 and restored the database from before the update.",
      );

      // The previous release starts as usual, and so does any later start.
      expect(node.start("0.1.35")).toBe("boot");
      expect(node.start("0.1.36")).toBe("boot");
      expect(node.installs()).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops counting once the server marked the release ready", () =>
    Effect.gen(function* () {
      const node = makeNode({});
      yield* writeNodeUpdateMarker(node.markerPath, {
        ...node.marker,
        bootAttempts: 2,
        readyAt: new Date().toISOString(),
      });
      expect(node.start()).toBe("boot");
      node.live.close();
      expect(node.installs()).toBe(0);
      expect((yield* node.readMarker())?.bootAttempts).toBe(2);
      expect(node.readNotes()).toEqual(["migrated by 0.1.36"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves the database alone while the reinstall fails, then gives up", () =>
    Effect.gen(function* () {
      const node = makeNode({ installerExit: 1 });
      yield* writeNodeUpdateMarker(node.markerPath, { ...node.marker, bootAttempts: 2 });
      for (let attempt = 0; attempt < NODE_UPDATE_ROLLBACK_TRIES; attempt += 1) {
        expect(node.start()).toBe("exit");
      }
      expect(node.installs()).toBe(NODE_UPDATE_ROLLBACK_TRIES);
      expect(node.lines).toContain(
        `Reinstalling 0.1.35 failed: ${process.execPath} exited with code 1.`,
      );
      // Out of tries: the release starts as it would have without the guard.
      expect(node.start()).toBe("boot");
      expect(node.start()).toBe("boot");
      node.live.close();
      expect(node.installs()).toBe(NODE_UPDATE_ROLLBACK_TRIES);
      expect(node.readNotes()).toEqual(["migrated by 0.1.36"]);
      expect((yield* node.readMarker())?.rolledBack).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a rollback that could not restore the database", () =>
    Effect.gen(function* () {
      const node = makeNode({ snapshot: false });
      yield* writeNodeUpdateMarker(node.markerPath, { ...node.marker, bootAttempts: 2 });
      expect(node.start()).toBe("exit");
      node.live.close();
      expect(node.installs()).toBe(1);
      // The failed release's database stays where it was.
      expect(node.readNotes()).toEqual(["migrated by 0.1.36"]);
      const marker = yield* node.readMarker();
      expect(marker?.rolledBack).toMatchObject({ databaseRestored: false });
      expect(marker?.rolledBack?.databaseError).toContain("pre-0.1.35.sqlite is missing");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
