import { PassThrough } from "node:stream";

import { Config, ConfigProvider, Effect } from "effect";
import * as Migrator from "effect/sql/Migrator";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BootstrapEnvelopeUnavailableError } from "./bootstrap.ts";
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
