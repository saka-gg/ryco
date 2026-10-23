import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger } from "effect";

import {
  HEAP_SNAPSHOT_COOLDOWN_MS,
  HEAP_SNAPSHOT_FREE_DISK_RESERVE_BYTES,
  heapSnapshotFileName,
  installHeapSnapshotSignalHandler,
  makeHeapSnapshotTaker,
  type HeapSnapshotDeps,
} from "./HeapSnapshot.ts";

const NOW = Date.parse("2026-10-23T08:00:00.000Z");
const GiB = 1024 ** 3;

interface LogLine {
  readonly level: string;
  readonly message: string;
}

const harness = (overrides: Partial<HeapSnapshotDeps> = {}) => {
  const logsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-heap-"));
  let nowMs = NOW;
  const writes: Array<string> = [];
  const logs: Array<LogLine> = [];
  const deps: HeapSnapshotDeps = {
    platform: "darwin",
    logsDir,
    pid: 4242,
    nowMs: () => nowMs,
    heapTotalBytes: () => 100 * 1024 * 1024,
    freeDiskBytes: async () => 50 * GiB,
    writeSnapshot: (filePath) => {
      writes.push(filePath);
      // Like a writer that replaces the file: the result must still be owner-only.
      NodeFS.rmSync(filePath, { force: true });
      NodeFS.writeFileSync(filePath, '{"snapshot":{}}', { mode: 0o644 });
    },
    isProcessAlive: () => false,
    ...overrides,
  };
  const logger = Logger.layer(
    [
      Logger.make((options) => {
        const message = Array.isArray(options.message) ? options.message[0] : options.message;
        logs.push({ level: options.logLevel, message: String(message) });
      }),
    ],
    { mergeWithExisting: false },
  );
  return {
    deps,
    logsDir,
    writes,
    logs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    run: <A>(effect: Effect.Effect<A>) => effect.pipe(Effect.provide(logger)),
    files: () => NodeFS.readdirSync(logsDir).toSorted(),
    cleanup: () => NodeFS.rmSync(logsDir, { recursive: true, force: true }),
  };
};

const seedSnapshot = (logsDir: string, name: string, ageMs: number, contents = "old") => {
  const filePath = NodePath.join(logsDir, name);
  NodeFS.writeFileSync(filePath, contents);
  const time = new Date(NOW - ageMs);
  NodeFS.utimesSync(filePath, time, time);
  return filePath;
};

describe("HeapSnapshot", () => {
  it.effect("does not install a handler on Windows", () =>
    Effect.gen(function* () {
      const test = harness({ platform: "win32" });
      try {
        const before = process.listenerCount("SIGUSR2");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* installHeapSnapshotSignalHandler(test.deps);
            expect(process.listenerCount("SIGUSR2")).toBe(before);
          }),
        );
      } finally {
        test.cleanup();
      }
    }),
  );

  it.effect("writes a snapshot on SIGUSR2 while installed and removes the handler after", () =>
    Effect.gen(function* () {
      const test = harness();
      try {
        const before = process.listenerCount("SIGUSR2");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* installHeapSnapshotSignalHandler(test.deps);
            expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
            // Emitting runs the listeners without sending a real signal to the test worker.
            process.emit("SIGUSR2", "SIGUSR2");
            yield* Effect.promise(async () => {
              const startedAt = Date.now();
              while (!test.files().some((name) => name.endsWith(".heapsnapshot"))) {
                if (Date.now() - startedAt > 5_000) throw new Error("no snapshot written");
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
            });
          }),
        ).pipe(test.run);
        expect(process.listenerCount("SIGUSR2")).toBe(before);
        expect(test.writes).toHaveLength(1);
      } finally {
        test.cleanup();
      }
    }),
  );

  it.effect("writes an owner-only snapshot and keeps only the newest ones", () =>
    Effect.gen(function* () {
      const test = harness();
      try {
        seedSnapshot(test.logsDir, "server-1-a.heapsnapshot", 3_000);
        seedSnapshot(test.logsDir, "server-1-b.heapsnapshot", 2_000);
        seedSnapshot(test.logsDir, "server-1-c.heapsnapshot", 1_000);
        seedSnapshot(test.logsDir, "server.trace.ndjson", 5_000);
        yield* makeHeapSnapshotTaker(test.deps).take.pipe(test.run);

        const expected = heapSnapshotFileName(4242, NOW);
        expect(expected).not.toContain(":");
        expect(test.files()).toEqual(
          [
            "server-1-b.heapsnapshot",
            "server-1-c.heapsnapshot",
            expected,
            "server.trace.ndjson",
          ].toSorted(),
        );
        if (process.platform !== "win32") {
          expect(NodeFS.statSync(NodePath.join(test.logsDir, expected)).mode & 0o777).toBe(0o600);
        }
        expect(test.writes).toEqual([NodePath.join(test.logsDir, `${expected}.partial`)]);
        const wrote = test.logs.find((line) => line.message === "Wrote heap snapshot");
        expect(wrote?.level).toBe("Info");
      } finally {
        test.cleanup();
      }
    }),
  );

  it.effect("refuses on low disk, writes nothing and keeps old snapshots", () =>
    Effect.gen(function* () {
      const test = harness({ freeDiskBytes: async () => HEAP_SNAPSHOT_FREE_DISK_RESERVE_BYTES });
      try {
        for (const name of ["a", "b", "c"]) {
          seedSnapshot(test.logsDir, `server-1-${name}.heapsnapshot`, 1_000);
        }
        yield* makeHeapSnapshotTaker(test.deps).take.pipe(test.run);
        expect(test.writes).toEqual([]);
        expect(test.files()).toEqual([
          "server-1-a.heapsnapshot",
          "server-1-b.heapsnapshot",
          "server-1-c.heapsnapshot",
        ]);
        expect(test.logs).toContainEqual({
          level: "Warn",
          message: "Heap snapshot refused: low disk space",
        });
      } finally {
        test.cleanup();
      }
    }),
  );

  it.effect("counts space the prune frees before refusing", () =>
    Effect.gen(function* () {
      const needed = 2 * 100 * 1024 * 1024 + HEAP_SNAPSHOT_FREE_DISK_RESERVE_BYTES;
      const test = harness({ freeDiskBytes: async () => needed - 1_000 });
      try {
        // A leftover from a write that died (dead pid): its size counts as reclaimable.
        seedSnapshot(test.logsDir, "server-77-x.heapsnapshot.partial", 60_000, "x".repeat(2_000));
        yield* makeHeapSnapshotTaker(test.deps).take.pipe(test.run);
        expect(test.writes).toHaveLength(1);
        expect(test.files()).toEqual([heapSnapshotFileName(4242, NOW)]);
      } finally {
        test.cleanup();
      }
    }),
  );

  it.effect("keeps another live process's fresh partial snapshot", () =>
    Effect.gen(function* () {
      const test = harness({ isProcessAlive: (pid) => pid === 88 });
      try {
        seedSnapshot(test.logsDir, "server-88-live.heapsnapshot.partial", 1_000);
        seedSnapshot(test.logsDir, "server-88-old.heapsnapshot.partial", 60 * 60_000);
        yield* makeHeapSnapshotTaker(test.deps).take.pipe(test.run);
        expect(test.files()).toEqual(
          [heapSnapshotFileName(4242, NOW), "server-88-live.heapsnapshot.partial"].toSorted(),
        );
      } finally {
        test.cleanup();
      }
    }),
  );

  it.effect("ignores a second request inside the cooldown", () =>
    Effect.gen(function* () {
      const test = harness();
      try {
        const taker = makeHeapSnapshotTaker(test.deps);
        yield* taker.take.pipe(test.run);
        test.advance(HEAP_SNAPSHOT_COOLDOWN_MS - 1);
        yield* taker.take.pipe(test.run);
        expect(test.writes).toHaveLength(1);
        expect(test.logs).toContainEqual({
          level: "Info",
          message: "Heap snapshot request ignored: one was just written",
        });
        test.advance(1);
        yield* taker.take.pipe(test.run);
        expect(test.writes).toHaveLength(2);
      } finally {
        test.cleanup();
      }
    }),
  );

  it.effect("removes the partial file and keeps the server running when the write fails", () =>
    Effect.gen(function* () {
      const test = harness({
        writeSnapshot: () => {
          throw new Error("out of memory");
        },
      });
      try {
        yield* makeHeapSnapshotTaker(test.deps).take.pipe(test.run);
        expect(test.files()).toEqual([]);
        expect(test.logs).toContainEqual({ level: "Warn", message: "Heap snapshot failed" });
      } finally {
        test.cleanup();
      }
    }),
  );

  it.effect("writes anyway when free space cannot be read", () =>
    Effect.gen(function* () {
      const test = harness({
        freeDiskBytes: async () => {
          throw new Error("statfs unsupported");
        },
      });
      try {
        yield* makeHeapSnapshotTaker(test.deps).take.pipe(test.run);
        expect(test.writes).toHaveLength(1);
        expect(test.logs.some((line) => line.message.startsWith("Could not read free disk"))).toBe(
          true,
        );
      } finally {
        test.cleanup();
      }
    }),
  );
});
