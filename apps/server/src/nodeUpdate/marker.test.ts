import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";

import {
  bootRunFromMarker,
  markerAwaitsBootReady,
  type NodeUpdateMarker,
  readNodeUpdateMarker,
  writeNodeUpdateMarker,
} from "./marker.ts";

const marker: NodeUpdateMarker = {
  requestId: "update-1",
  fromVersion: "0.1.35",
  targetVersion: "0.1.36",
  startedAt: "2026-10-21T10:00:00.000Z",
};
const startedAtMs = Date.parse(marker.startedAt);
const rollback: NonNullable<NodeUpdateMarker["rollback"]> = {
  install: {
    command: "npm",
    args: ["install", "-g", "--prefix", "/opt/homebrew", "ryco-cli@0.1.35"],
    timeoutMs: 600_000,
  },
  databasePath: "/Users/me/.ryco/userdata/state.sqlite",
  snapshotPath: "/Users/me/.ryco/userdata/node-update/pre-0.1.35.sqlite",
};

describe("node update marker", () => {
  it("reports success when the node came back on the target release", () => {
    expect(
      bootRunFromMarker({ marker, runningVersion: "0.1.36", nowMs: startedAtMs + 30_000 }),
    ).toEqual({
      status: "succeeded",
      requestId: "update-1",
      fromVersion: "0.1.35",
      targetVersion: "0.1.36",
      startedAt: marker.startedAt,
      finishedAt: "2026-10-21T10:00:30.000Z",
      restartAt: null,
      progressPercent: null,
      message: null,
      output: null,
    });
  });

  it("reports a failure naming the release it came back on", () => {
    expect(
      bootRunFromMarker({ marker, runningVersion: "0.1.35", nowMs: startedAtMs + 30_000 }),
    ).toMatchObject({ status: "failed", message: "Restarted on 0.1.35 instead of 0.1.36." });
  });

  it("ignores a marker older than a day", () => {
    expect(
      bootRunFromMarker({
        marker,
        runningVersion: "0.1.36",
        nowMs: startedAtMs + 24 * 60 * 60 * 1_000 + 1,
      }),
    ).toBeNull();
  });

  it.effect("round-trips through its file and drops an unreadable one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "node-update-marker-" });
      const filePath = path.join(dir, "node-update.json");
      expect(Option.isNone(yield* readNodeUpdateMarker(filePath))).toBe(true);
      yield* writeNodeUpdateMarker(filePath, marker);
      expect(yield* readNodeUpdateMarker(filePath)).toEqual(Option.some(marker));
      yield* fs.writeFileString(filePath, '{"requestId": 1}');
      expect(Option.isNone(yield* readNodeUpdateMarker(filePath))).toBe(true);
      expect(yield* fs.exists(filePath)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("waits for the server to confirm a restart it can roll back", () => {
    const awaits = (value: NodeUpdateMarker, runningVersion = "0.1.36") =>
      markerAwaitsBootReady({ marker: value, runningVersion, nowMs: startedAtMs + 30_000 });
    expect(awaits({ ...marker, rollback })).toBe(true);
    expect(awaits({ ...marker, rollback, bootAttempts: 2 })).toBe(true);
    // Desktop updates and releases before the rollback leave no plan.
    expect(awaits(marker)).toBe(false);
    expect(awaits({ ...marker, rollback, readyAt: marker.startedAt })).toBe(false);
    expect(awaits({ ...marker, rollback }, "0.1.35")).toBe(false);
    expect(
      markerAwaitsBootReady({
        marker: { ...marker, rollback },
        runningVersion: "0.1.36",
        nowMs: startedAtMs + 25 * 60 * 60 * 1_000,
      }),
    ).toBe(false);
  });

  it("reports a rollback as a failed update that names both releases", () => {
    const rolledBack = (databaseRestored: boolean) =>
      bootRunFromMarker({
        marker: {
          ...marker,
          rollback,
          bootAttempts: 3,
          rolledBack: {
            at: "2026-10-21T10:01:00.000Z",
            failedBoots: 2,
            databaseRestored,
            ...(databaseRestored ? { output: "added 1 package" } : { databaseError: "EACCES" }),
          },
        },
        runningVersion: "0.1.35",
        nowMs: startedAtMs + 90_000,
      });
    expect(rolledBack(true)).toMatchObject({
      status: "failed",
      fromVersion: "0.1.35",
      targetVersion: "0.1.36",
      message:
        "Ryco 0.1.36 did not finish starting (2 attempts), so the node rolled back to 0.1.35 and restored the database from before the update.",
      output: "added 1 package",
    });
    expect(rolledBack(false)?.message).toBe(
      "Ryco 0.1.36 did not finish starting (2 attempts), so the node rolled back to 0.1.35, but could not restore the database from before the update: EACCES.",
    );
  });

  it.effect("keeps reading markers of earlier releases, and round-trips every new field", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "node-update-marker-" });
      const filePath = path.join(dir, "node-update.json");
      // Exactly what 0.1.35 writes.
      yield* fs.writeFileString(
        filePath,
        '{"requestId":"update-1","fromVersion":"0.1.35","targetVersion":"0.1.36","startedAt":"2026-10-21T10:00:00.000Z"}\n',
      );
      expect(yield* readNodeUpdateMarker(filePath)).toEqual(Option.some(marker));
      const full: NodeUpdateMarker = {
        ...marker,
        rollback,
        bootAttempts: 3,
        readyAt: "2026-10-21T10:00:40.000Z",
        rolledBack: {
          at: "2026-10-21T10:01:00.000Z",
          failedBoots: 2,
          databaseRestored: false,
          databaseError: "EACCES",
          output: "added 1 package",
        },
      };
      yield* writeNodeUpdateMarker(filePath, full);
      expect(yield* readNodeUpdateMarker(filePath)).toEqual(Option.some(full));
      // A later release may record more, and the release it rolls back to still reads the rest.
      yield* fs.writeFileString(
        filePath,
        JSON.stringify({ ...full, rolledBack: { ...full.rolledBack, reasonCode: "x" }, extra: 1 }),
      );
      expect(yield* readNodeUpdateMarker(filePath)).toEqual(Option.some(full));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
