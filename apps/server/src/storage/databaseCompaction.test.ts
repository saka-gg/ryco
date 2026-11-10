import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  COMPACTION_RECORD_FILE,
  COMPACTION_RESULT_FILE,
  compactionBusyReasons,
  compactionRunner,
  detachedDoctorCommand,
  readLastCompactionRun,
  runFromDoctorDocument,
  startServiceCompaction,
} from "./databaseCompaction.ts";

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});
const stateDir = async () => (root = await mkdtemp(path.join(os.tmpdir(), "ryco-compaction-")));

const doctorDocument = {
  inspection: {},
  result: {
    status: "repaired",
    exitCode: 0,
    message: "10.0 GB → 4.0 GB.",
    before: { fileBytes: 10_000 },
    after: { fileBytes: 4_000 },
  },
};

describe("one-click compaction", () => {
  it("runs from the desktop app, a background service, or not at all", () => {
    expect(compactionRunner({ mode: "desktop", serviceLabel: undefined, platform: "darwin" })).toBe(
      "desktop",
    );
    expect(compactionRunner({ mode: "web", serviceLabel: "gg.ryco", platform: "linux" })).toBe(
      "service",
    );
    expect(compactionRunner({ mode: "web", serviceLabel: undefined, platform: "linux" })).toBe(
      "none",
    );
    expect(compactionRunner({ mode: "web", serviceLabel: "gg.ryco", platform: "win32" })).toBe(
      "none",
    );
  });

  it("says what a run would cut off", async () => {
    const reasons = await Effect.runPromise(
      compactionBusyReasons({
        agentWork: Effect.succeed(true),
        busyTerminals: Effect.succeed(false),
        restartSensitiveWork: Effect.succeed(1),
      }),
    );
    expect(reasons).toEqual([
      "Agents are working or waiting for an answer.",
      "A clone, checkout or storage cleanup is running.",
    ]);
  });

  it("runs the doctor outside the service's control group on Linux", () => {
    const base = {
      execPath: "/usr/bin/node",
      execArgv: ["--enable-source-maps"],
      entryScript: "/opt/ryco/bin.mjs",
      baseDir: "/home/a/.ryco",
      devUrl: null,
      resultFile: "/home/a/.ryco/userdata/database-compaction-result.json",
      unitName: "ryco-doctor-1",
    };
    const doctor = [
      "--enable-source-maps",
      "/opt/ryco/bin.mjs",
      "doctor",
      "--apply",
      "--yes",
      "--json",
      "--base-dir",
      "/home/a/.ryco",
      "--result-file",
      "/home/a/.ryco/userdata/database-compaction-result.json",
    ];
    expect(detachedDoctorCommand({ ...base, platform: "linux" })).toEqual({
      command: "systemd-run",
      args: ["--user", "--collect", "--quiet", "--unit=ryco-doctor-1", "/usr/bin/node", ...doctor],
    });
    expect(detachedDoctorCommand({ ...base, platform: "darwin" })).toEqual({
      command: "/usr/bin/node",
      args: doctor,
    });
  });

  it("reads the doctor's result after the service started again", async () => {
    const dir = await stateDir();
    expect(runFromDoctorDocument(doctorDocument)).toEqual({
      status: "repaired",
      message: "10.0 GB → 4.0 GB.",
      beforeBytes: 10_000,
      afterBytes: 4_000,
    });
    expect(
      await Effect.runPromise(readLastCompactionRun({ stateDir: dir, processStartedAtMs: 0 })),
    ).toBeNull();

    const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const fakeSpawn = ((command: string, args: ReadonlyArray<string>) => {
      spawned.push({ command, args });
      const child = Object.assign(new EventEmitter(), { unref: () => undefined });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as never;
    const startedAt = new Date("2026-11-10T12:00:00.000Z");
    const started = await Effect.runPromise(
      startServiceCompaction({
        stateDir: dir,
        baseDir: "/b",
        devUrl: null,
        now: startedAt,
        spawn: fakeSpawn,
      }),
    );
    expect(started.started).toBe(true);
    expect(spawned[0]!.args).toContain("--result-file");
    expect(JSON.parse(await readFile(path.join(dir, COMPACTION_RECORD_FILE), "utf8"))).toEqual({
      version: 1,
      runner: "service",
      startedAt: startedAt.toISOString(),
    });
    // Before the doctor wrote its result: still running.
    expect(
      (await Effect.runPromise(readLastCompactionRun({ stateDir: dir, processStartedAtMs: 0 })))
        ?.status,
    ).toBe("running");

    await writeFile(path.join(dir, COMPACTION_RESULT_FILE), JSON.stringify(doctorDocument));
    const run = await Effect.runPromise(
      readLastCompactionRun({ stateDir: dir, processStartedAtMs: startedAt.getTime() + 95_000 }),
    );
    expect(run).toMatchObject({
      runner: "service",
      status: "repaired",
      beforeBytes: 10_000,
      afterBytes: 4_000,
      downtimeMs: 95_000,
    });
  });
});
