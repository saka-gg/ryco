import * as NFS from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { FileSystem, Schema } from "effect";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import {
  applyBootstrapShellEnvironment,
  readBootstrapEnvelope,
  resolveFdPath,
} from "./bootstrap.ts";
import { assertNone, assertSome } from "@effect/vitest/utils";

const openSyncInterceptor = vi.hoisted(() => ({ failPath: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const [filePath, flags] = args;
      if (
        typeof filePath === "string" &&
        filePath === openSyncInterceptor.failPath &&
        flags === "r"
      ) {
        const error = new Error("no such device or address");
        Object.assign(error, { code: "ENXIO" });
        throw error;
      }
      return (actual.openSync as (...a: typeof args) => number)(...args);
    },
  };
});

const TestEnvelopeSchema = Schema.Struct({ mode: Schema.String });

it.layer(NodeServices.layer)("readBootstrapEnvelope", (it) => {
  it.effect("uses platform-specific fd paths", () =>
    Effect.sync(() => {
      assert.equal(resolveFdPath(3, "linux"), "/proc/self/fd/3");
      assert.equal(resolveFdPath(3, "darwin"), "/dev/fd/3");
      assert.equal(resolveFdPath(3, "win32"), undefined);
    }),
  );

  it.effect("reads a bootstrap envelope from a provided fd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({
        prefix: "ryco-bootstrap-",
        suffix: ".ndjson",
      });

      yield* fs.writeFileString(
        filePath,
        `${yield* Schema.encodeEffect(Schema.fromJsonString(TestEnvelopeSchema))({
          mode: "desktop",
        })}\n`,
      );

      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NFS.openSync(filePath, "r")),
        (fd) => Effect.sync(() => NFS.closeSync(fd)),
      );

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
      assertSome(payload, {
        mode: "desktop",
      });
    }),
  );

  it.effect("falls back to reading the inherited fd when path duplication fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filePath = yield* fs.makeTempFileScoped({
        prefix: "ryco-bootstrap-",
        suffix: ".ndjson",
      });

      yield* fs.writeFileString(
        filePath,
        `${yield* Schema.encodeEffect(Schema.fromJsonString(TestEnvelopeSchema))({
          mode: "desktop",
        })}\n`,
      );

      // Open without acquireRelease: the direct-stream fallback uses autoClose: true,
      // so the stream owns the fd lifecycle and closes it asynchronously on end.
      // Attempting to also close it synchronously in a finalizer races with the
      // stream's async close and produces an uncaught EBADF.
      const fd = NFS.openSync(filePath, "r");

      openSyncInterceptor.failPath = `/proc/self/fd/${fd}`;
      try {
        const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
        assertSome(payload, {
          mode: "desktop",
        });
      } finally {
        openSyncInterceptor.failPath = null;
      }
    }),
  );

  it.effect("returns none when the fd is unavailable", () =>
    Effect.gen(function* () {
      const fd = NFS.openSync("/dev/null", "r");
      NFS.closeSync(fd);

      const payload = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, { timeoutMs: 100 });
      assertNone(payload);
    }),
  );

  it.effect("returns none when the bootstrap read times out before any value arrives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-bootstrap-" });
      const fifoPath = path.join(tempDir, "bootstrap.pipe");

      yield* Effect.sync(() => execFileSync("mkfifo", [fifoPath]));

      const _writer = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn("sh", ["-c", 'exec 3>"$1"; sleep 60', "sh", fifoPath], {
            stdio: ["ignore", "ignore", "ignore"],
          }),
        ),
        (writer) =>
          Effect.sync(() => {
            writer.kill("SIGKILL");
          }),
      );

      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NFS.openSync(fifoPath, "r")),
        (fd) => Effect.sync(() => NFS.closeSync(fd)),
      );

      const fiber = yield* readBootstrapEnvelope(TestEnvelopeSchema, fd, {
        timeoutMs: 100,
      }).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(100));

      const payload = yield* Fiber.join(fiber);
      assertNone(payload);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it.effect("merges a bootstrap shell environment without dropping inherited values", () =>
  Effect.sync(() => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      SSH_AUTH_SOCK: "/inherited/agent.sock",
    };
    applyBootstrapShellEnvironment(
      {
        PATH: "/opt/homebrew/bin:/usr/bin",
        SSH_AUTH_SOCK: "/shell/agent.sock",
        HOMEBREW_PREFIX: "/opt/homebrew",
        FNM_DIR: "",
        NODE_OPTIONS: "--inspect",
      },
      env,
      "darwin",
    );
    // Shell PATH entries first, inherited entries kept, no duplicates.
    assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
    // An explicitly inherited value wins; other known names fill gaps.
    assert.equal(env.SSH_AUTH_SOCK, "/inherited/agent.sock");
    assert.equal(env.HOMEBREW_PREFIX, "/opt/homebrew");
    // Empty values and names outside the shell environment are ignored.
    assert.isUndefined(env.FNM_DIR);
    assert.isUndefined(env.NODE_OPTIONS);

    const untouched: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    applyBootstrapShellEnvironment(undefined, untouched, "darwin");
    assert.deepEqual(untouched, { PATH: "/usr/bin" });
  }),
);
