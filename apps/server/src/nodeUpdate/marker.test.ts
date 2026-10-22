import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";

import {
  bootRunFromMarker,
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
});
