import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { OPENCODE_NON_JSON_HEALTH_MESSAGE } from "./openCodeVersion.ts";
import {
  assertSupportedOpenCodeBinary,
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  type OpenCodeCommandResult,
  type OpenCodeRuntimeShape,
  resolveOpenCodeServerPassword,
  verifyOpenCodeServerVersion,
} from "./opencodeRuntime.ts";

describe("resolveOpenCodeServerPassword", () => {
  it("prefers an explicitly configured password", () => {
    expect(
      resolveOpenCodeServerPassword({
        external: false,
        configuredPassword: "configured",
        environment: { OPENCODE_SERVER_PASSWORD: "environment" },
      }),
    ).toBe("configured");
  });

  it("inherits the environment password for a locally managed server", () => {
    expect(
      resolveOpenCodeServerPassword({
        external: false,
        environment: { OPENCODE_SERVER_PASSWORD: "environment" },
      }),
    ).toBe("environment");
  });

  it("does not leak the process environment password to an external server", () => {
    expect(
      resolveOpenCodeServerPassword({
        external: true,
        environment: { OPENCODE_SERVER_PASSWORD: "environment" },
      }),
    ).toBeUndefined();
  });
});

describe("verifyOpenCodeServerVersion", () => {
  const clientWithHealthData = (data: unknown) =>
    ({
      global: {
        health: async () => ({ data }),
      },
    }) as unknown as OpencodeClient;
  const clientWithVersion = (version: string) => clientWithHealthData({ healthy: true, version });
  const failureDetail = (client: OpencodeClient) =>
    Effect.runPromise(Effect.flip(verifyOpenCodeServerVersion(client))).then(
      (error) => error.detail,
    );

  it("accepts a supported authenticated server", async () => {
    await expect(
      Effect.runPromise(verifyOpenCodeServerVersion(clientWithVersion("1.18.18"))),
    ).resolves.toBe("1.18.18");
  });

  it("rejects an outdated server before using its API", async () => {
    const error = await Effect.runPromise(
      Effect.flip(verifyOpenCodeServerVersion(clientWithVersion("1.14.18"))),
    );
    expect(error.detail).toContain("too old");
  });

  it("rejects a 2.x server with an explicit reason", async () => {
    expect(await failureDetail(clientWithVersion("2.0.18"))).toContain("reports v2.0.18");
  });

  it("rejects a v-prefixed 2.x server instead of passing it via string comparison", async () => {
    expect(await failureDetail(clientWithVersion("v2.0.18"))).toContain("reports v2.0.18");
  });

  it("fails closed for an unparseable server version", async () => {
    expect(await failureDetail(clientWithVersion("garbage"))).toContain("unrecognized version");
  });

  it("normalises a v-prefixed supported version", async () => {
    await expect(
      Effect.runPromise(verifyOpenCodeServerVersion(clientWithVersion("v1.18.18"))),
    ).resolves.toBe("1.18.18");
  });

  it("names an HTML health response instead of calling it invalid", async () => {
    expect(await failureDetail(clientWithHealthData("<!doctype html><html></html>"))).toBe(
      OPENCODE_NON_JSON_HEALTH_MESSAGE,
    );
  });

  it("keeps the invalid-response failure for other malformed shapes", async () => {
    expect(await failureDetail(clientWithHealthData({ healthy: false }))).toContain(
      "invalid response",
    );
    expect(await failureDetail(clientWithHealthData(undefined))).toContain("invalid response");
  });
});

const versionRunner =
  (stdout: string): OpenCodeRuntimeShape["runOpenCodeCommand"] =>
  () =>
    Effect.succeed({ stdout, stderr: "", code: 0 } satisfies OpenCodeCommandResult);

describe("assertSupportedOpenCodeBinary", () => {
  it("returns a supported 1.x version", async () => {
    await expect(
      Effect.runPromise(
        assertSupportedOpenCodeBinary(versionRunner("1.18.34\n"), { binaryPath: "opencode" }),
      ),
    ).resolves.toBe("1.18.34");
  });

  it("refuses a 2.x binary", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        assertSupportedOpenCodeBinary(versionRunner("opencode v2.0.18\n"), {
          binaryPath: "opencode",
        }),
      ),
    );
    expect(error.detail).toContain("not supported yet");
  });

  it("refuses output without a version", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        assertSupportedOpenCodeBinary(versionRunner("no version here"), {
          binaryPath: "opencode",
        }),
      ),
    );
    expect(error.detail).toContain("Unable to determine");
  });
});

describe("assertSupportedOpenCodeBinary timeout", () => {
  effectIt.effect("fails when `--version` does not finish within 5 seconds", () =>
    Effect.gen(function* () {
      const fiber = yield* assertSupportedOpenCodeBinary(() => Effect.never, {
        binaryPath: "/opt/opencode",
      }).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.detail).toContain("did not finish within 5 seconds");
      expect(error.detail).toContain("/opt/opencode --version");
    }),
  );
});

/**
 * The real runtime with a recording spawner. SAFETY: only `--version` gets a (mock) process
 * handle. Every other command — in particular `serve` — fails at spawn, because the real
 * `startOpenCodeServerProcess` finalizer runs `process.kill(-pid)` and a mock pid of 1 would
 * signal every process the user owns.
 */
function recordingRuntimeLayer(versionStdout: string) {
  const spawned: Array<ReadonlyArray<string>> = [];
  const encoder = new TextEncoder();
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
    spawned.push([...args]);
    if (args.length !== 1 || args[0] !== "--version") {
      return Effect.fail(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "ChildProcess",
          method: "spawn",
          description: `test spawner refuses: ${args.join(" ")}`,
        }),
      );
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(versionStdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  const layer = OpenCodeRuntimeLive.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );
  return { layer, spawned };
}

describe("OpenCode pre-spawn version gate", () => {
  effectIt.live("startOpenCodeServerProcess refuses a 2.x binary before spawning serve", () => {
    const { layer, spawned } = recordingRuntimeLayer("opencode v2.0.18\n");
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const error = yield* runtime
        .startOpenCodeServerProcess({ binaryPath: "opencode" })
        .pipe(Effect.scoped, Effect.flip);
      expect(error.detail).toContain("not supported yet");
      expect(spawned).toEqual([["--version"]]);
    }).pipe(Effect.provide(layer));
  });

  effectIt.live("connectToOpenCodeServer refuses a 2.x binary before spawning serve", () => {
    const { layer, spawned } = recordingRuntimeLayer("opencode v2.0.18\n");
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const error = yield* runtime
        .connectToOpenCodeServer({ binaryPath: "opencode", serverUrl: "" })
        .pipe(Effect.scoped, Effect.flip);
      expect(error.detail).toContain("not supported yet");
      expect(spawned).toEqual([["--version"]]);
    }).pipe(Effect.provide(layer));
  });
});
