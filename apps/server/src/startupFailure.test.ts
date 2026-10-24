import { PassThrough } from "node:stream";

import { Config, ConfigProvider, Effect } from "effect";
import * as Migrator from "effect/sql/Migrator";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BootstrapEnvelopeUnavailableError } from "./bootstrap.ts";
import {
  DatabaseOwnedError,
  DatabaseUpgradeBlockedError,
} from "./persistence/databaseOwnerLock.ts";
import {
  attachDesktopLifecycleChannel,
  detachDesktopLifecycleChannelForTests,
} from "./desktopLifecycle.ts";
import {
  classifyFatalStartupError,
  FATAL_STARTUP_EXIT_CODE,
  reportFatalStartupFailure,
} from "./startupFailure.ts";

afterEach(() => detachDesktopLifecycleChannelForTests());

describe("fatal startup failures", () => {
  it("treats a database written by a newer binary as fatal", () => {
    const error = new Migrator.MigrationError({
      kind: "BadState",
      message: "Database schema 77 is newer than this binary supports (76).",
    });
    expect(classifyFatalStartupError(error)).toBe("database-schema-newer");
  });

  it("treats invalid configuration as fatal", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Config.Int("RYCO_PORT").pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ RYCO_PORT: "x" }))),
        ),
      ),
    );
    expect(classifyFatalStartupError(error)).toBe("invalid-config");
  });

  it("treats a missing bootstrap envelope as fatal", () => {
    const error = new BootstrapEnvelopeUnavailableError({ fd: 3, message: "pipe closed" });
    expect(classifyFatalStartupError(error)).toBe("bootstrap-envelope-missing");
  });

  it("treats a database another server owns as fatal, and reports who owns it", () => {
    const channel = new PassThrough();
    let written = "";
    channel.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
    attachDesktopLifecycleChannel(channel);
    const error = new DatabaseOwnedError({
      dbPath: "/data/userdata/state.sqlite",
      lockPath: "/data/userdata/state.sqlite.owner",
      owner: null,
      reason: "held",
      message: "Another Ryco server is using this data directory: `ryco serve` (pid 4242).",
    });

    expect(classifyFatalStartupError(error)).toBe("database-in-use");
    expect(reportFatalStartupFailure("database-in-use", error)).toBe(78);
    expect(JSON.parse(written.trim())).toEqual({
      type: "fatal",
      code: "database-in-use",
      message: "Another Ryco server is using this data directory: `ryco serve` (pid 4242).",
    });
  });

  it("keeps a lock that is still being written retryable", () => {
    const fields = {
      dbPath: "/data/userdata/state.sqlite",
      lockPath: "/data/userdata/state.sqlite.owner",
      owner: null,
      message: "Ryco cannot use its owner lock.",
    };
    expect(
      classifyFatalStartupError(new DatabaseOwnedError({ ...fields, reason: "being-written" })),
    ).toBeNull();
    for (const reason of ["unreadable", "foreign-file", "io-error"] as const) {
      expect(classifyFatalStartupError(new DatabaseOwnedError({ ...fields, reason }))).toBe(
        "database-in-use",
      );
    }
  });

  it("keeps a CLI's refused upgrade an ordinary failure", () => {
    const error = new DatabaseUpgradeBlockedError({
      owner: null,
      from: 92,
      to: 93,
      repairs: [],
      message: "This ryco needs to upgrade the database",
    });
    expect(classifyFatalStartupError(error)).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("This ryco needs to upgrade the database");
  });

  it("keeps other failures retryable", () => {
    expect(
      classifyFatalStartupError(new Migrator.MigrationError({ kind: "Locked", message: "busy" })),
    ).toBeNull();
    expect(classifyFatalStartupError(new Error("EADDRINUSE"))).toBeNull();
    expect(classifyFatalStartupError(null)).toBeNull();
  });

  it("reports the reason on the desktop lifecycle channel and exits with EX_CONFIG", () => {
    const channel = new PassThrough();
    let written = "";
    channel.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
    attachDesktopLifecycleChannel(channel);

    const code = reportFatalStartupFailure(
      "database-schema-newer",
      new Error("Database schema 77 is newer than this binary supports (76)."),
    );

    expect(code).toBe(FATAL_STARTUP_EXIT_CODE);
    expect(code).toBe(78);
    expect(JSON.parse(written.trim())).toEqual({
      type: "fatal",
      code: "database-schema-newer",
      message: "Database schema 77 is newer than this binary supports (76).",
    });
  });

  it("does nothing outside desktop mode", () => {
    expect(() => reportFatalStartupFailure("invalid-config", new Error("bad port"))).not.toThrow();
  });
});
