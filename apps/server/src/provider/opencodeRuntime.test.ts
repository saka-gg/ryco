import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";

import { makeAgentProcessPriority } from "./agentProcessPriority.ts";
import type { OpenCodeApi } from "./openCodeApi.ts";
import { OPENCODE_REJECTED_PASSWORD_MESSAGE } from "./openCodeProtocol.ts";
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
  const clientWithHealthData = (data: unknown, generation?: "v2") =>
    ({
      ...(generation !== undefined ? { generation } : {}),
      global: {
        health: async () => ({ data }),
      },
    }) as unknown as OpenCodeApi;
  const clientWithVersion = (version: string, generation?: "v2") =>
    clientWithHealthData({ healthy: true, version }, generation);
  const failureDetail = (client: OpenCodeApi) =>
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

  it("accepts a supported 2.x server on the 2.x facade", async () => {
    await expect(
      Effect.runPromise(verifyOpenCodeServerVersion(clientWithVersion("v2.2.0", "v2"))),
    ).resolves.toBe("2.2.0");
  });

  it("rejects a 2.x server below the minimum with the upgrade it needs", async () => {
    for (const generation of [undefined, "v2"] as const) {
      expect(await failureDetail(clientWithVersion("2.0.18", generation))).toBe(
        "OpenCode v2.0.18 is too old. Upgrade OpenCode 2 to v2.2.0 or newer.",
      );
    }
    expect(await failureDetail(clientWithVersion("3.0.0", "v2"))).toBe(
      "OpenCode v3.0.0 is not supported by this Ryco release.",
    );
  });

  it("refuses a 1.x client whose server reports 2.x before any mutation", async () => {
    for (const version of ["2.2.0", "2.9.0"]) {
      expect(await failureDetail(clientWithVersion(version))).toBe(
        `The OpenCode server reports v${version} but did not identify itself as OpenCode 2.`,
      );
    }
  });

  it("refuses a server whose reported generation does not match the client's API", async () => {
    expect(await failureDetail(clientWithVersion("1.18.18", "v2"))).toBe(
      "The OpenCode server reports v1.18.18 but did not identify itself as OpenCode 1.",
    );
  });

  it("rejects a v-prefixed 2.x server instead of passing it via string comparison", async () => {
    expect(await failureDetail(clientWithVersion("v2.9.0"))).toContain("reports v2.9.0");
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

describe("createOpenCodeSdkClient API detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stubs the global fetch the runtime's detection uses with a server keyed by path. */
  function stubServer(routes: Readonly<Record<string, () => Response>>) {
    const paths: Array<string> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return routes[path]?.() ?? new Response(null, { status: 404 });
    });
    return paths;
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const html = () =>
    new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
  /** Each test uses its own URL: detection remembers the last generation per URL. */
  const create = (baseUrl: string) =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      return yield* runtime.createOpenCodeSdkClient({
        baseUrl,
        directory: "/work",
        serverPassword: "secret",
      });
    }).pipe(Effect.provide(recordingRuntimeLayer("").layer));

  effectIt.live("returns the 2.x facade for a 2.x server", () => {
    const paths = stubServer({
      "/global/health": html,
      "/api/info": () => json({ version: "2.2.0", pid: 42 }),
    });
    return Effect.gen(function* () {
      const client = yield* create("http://127.0.0.1:4096");
      expect(client.generation).toBe("v2");
      expect(paths).toEqual(["/global/health", "/api/info"]);
      // The next attempt asks the 2.x route first and sends nothing to the 2.x catch-all.
      paths.length = 0;
      expect((yield* create("http://127.0.0.1:4096")).generation).toBe("v2");
      expect(paths).toEqual(["/api/info"]);
    });
  });

  effectIt.live("refuses a 2.x server below the minimum before creating any client", () => {
    stubServer({
      "/global/health": html,
      "/api/info": () => json({ version: "2.1.4", pid: 42 }),
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(create("http://127.0.0.1:4099"));
      expect(error.detail).toBe(
        "OpenCode v2.1.4 is too old. Upgrade OpenCode 2 to v2.2.0 or newer.",
      );
    });
  });

  effectIt.live("returns the 1.x SDK client for a 1.x server", () => {
    const paths = stubServer({
      "/global/health": () => json({ healthy: true, version: "1.18.34" }),
    });
    return Effect.gen(function* () {
      const client = yield* create("http://127.0.0.1:4097");
      expect(client.generation).toBeUndefined();
      expect(typeof client.session.promptAsync).toBe("function");
      expect(paths).toEqual(["/global/health"]);
    });
  });

  effectIt.live("surfaces a rejected password as the fixed detection text", () => {
    stubServer({ "/global/health": () => new Response(null, { status: 401 }) });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(create("http://127.0.0.1:4098"));
      expect(error.detail).toBe(OPENCODE_REJECTED_PASSWORD_MESSAGE);
      expect(error.operation).toBe("api.detect");
    });
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

  it("returns a supported 2.x version", async () => {
    await expect(
      Effect.runPromise(
        assertSupportedOpenCodeBinary(versionRunner("opencode v2.2.0\n"), {
          binaryPath: "opencode",
        }),
      ),
    ).resolves.toBe("2.2.0");
  });

  it("refuses a 2.x binary below the minimum and any 3.x", async () => {
    const detail = (stdout: string) =>
      Effect.runPromise(
        Effect.flip(
          assertSupportedOpenCodeBinary(versionRunner(stdout), { binaryPath: "opencode" }),
        ),
      ).then((error) => error.detail);
    expect(await detail("opencode v2.0.18\n")).toBe(
      "OpenCode v2.0.18 is too old. Upgrade OpenCode 2 to v2.2.0 or newer.",
    );
    expect(await detail("3.0.0\n")).toBe("OpenCode v3.0.0 is not supported by this Ryco release.");
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
 * The real runtime with a recording spawner. Only `--version` gets a (mock) process handle;
 * every other command — in particular `serve` — fails at spawn, so these tests observe exactly
 * which commands the version gate lets through.
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
  effectIt.live(
    "startOpenCodeServerProcess refuses an old 2.x binary before spawning serve",
    () => {
      const { layer, spawned } = recordingRuntimeLayer("opencode v2.0.18\n");
      return Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        const error = yield* runtime
          .startOpenCodeServerProcess({ binaryPath: "opencode" })
          .pipe(Effect.scoped, Effect.flip);
        expect(error.detail).toContain("is too old");
        expect(spawned).toEqual([["--version"]]);
      }).pipe(Effect.provide(layer));
    },
  );

  effectIt.live("connectToOpenCodeServer refuses an old 2.x binary before spawning serve", () => {
    const { layer, spawned } = recordingRuntimeLayer("opencode v2.0.18\n");
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const error = yield* runtime
        .connectToOpenCodeServer({ binaryPath: "opencode", serverUrl: "" })
        .pipe(Effect.scoped, Effect.flip);
      expect(error.detail).toContain("is too old");
      expect(spawned).toEqual([["--version"]]);
    }).pipe(Effect.provide(layer));
  });
  effectIt.live(
    "reuses a version the caller just verified instead of running --version again",
    () => {
      const { layer, spawned } = recordingRuntimeLayer("opencode v2.0.18\n");
      return Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        // The recording spawner refuses `serve`, so the attempt fails right after the gate.
        yield* runtime
          .connectToOpenCodeServer({
            binaryPath: "opencode",
            verifiedBinaryVersion: "1.18.34",
            serverUrl: "",
          })
          .pipe(Effect.scoped, Effect.flip);
        expect(spawned.some((args) => args.length === 1 && args[0] === "--version")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  effectIt.live("still runs the gate when the claimed version is unsupported", () => {
    const { layer, spawned } = recordingRuntimeLayer("opencode v2.0.18\n");
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const error = yield* runtime
        .startOpenCodeServerProcess({ binaryPath: "opencode", verifiedBinaryVersion: "2.0.18" })
        .pipe(Effect.scoped, Effect.flip);
      expect(error.detail).toContain("is too old");
      expect(spawned).toEqual([["--version"]]);
    }).pipe(Effect.provide(layer));
  });
});

describe("OpenCode serve teardown", () => {
  effectIt.live(
    "terminates the serve process group through the spawner handle, SIGKILLing after a 1 s grace",
    () => {
      const kills: Array<unknown> = [];
      const encoder = new TextEncoder();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            // Never a live process group, should anything ever signal it directly.
            pid: ChildProcessSpawner.ProcessId(2_147_483_000),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: (options) => Effect.sync(() => kills.push(options)),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(
              encoder.encode("opencode server listening on http://127.0.0.1:4096\n"),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const layer = OpenCodeRuntimeLive.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      return Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        const server = yield* runtime
          .startOpenCodeServerProcess({
            binaryPath: "opencode",
            verifiedBinaryVersion: "1.18.34",
            port: 4096,
          })
          .pipe(Effect.scoped);
        expect(server.url).toBe("http://127.0.0.1:4096");
        // One group-aware kill: no fixed sleep, no raw `process.kill(-pid)`.
        expect(kills).toEqual([{ killSignal: "SIGTERM", forceKillAfter: "1 second" }]);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("OpenCode agent priority", () => {
  const linuxExecNice = makeAgentProcessPriority({
    enabled: Effect.succeed(true),
    platform: "linux",
    niceExecutable: () => "/usr/bin/nice",
    commandResolves: async () => true,
    lowerChild: () => "lowered",
  });

  /** Answers `--version` and `serve` like OpenCode 1.18 and records every argv. */
  function servingRuntimeLayer() {
    const spawned: Array<ReadonlyArray<string>> = [];
    const encoder = new TextEncoder();
    const spawner = ChildProcessSpawner.make((command) => {
      const standard = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      spawned.push([standard.command, ...standard.args]);
      const version = standard.args.includes("--version");
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(2_147_483_001),
          exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
          isRunning: Effect.succeed(!version),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(
            encoder.encode(
              version
                ? "opencode v1.18.34\n"
                : "opencode server listening on http://127.0.0.1:4096\n",
            ),
          ),
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

  effectIt.live("starts the managed server through nice and keeps the version gate normal", () => {
    const { layer, spawned } = servingRuntimeLayer();
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      yield* runtime
        .startOpenCodeServerProcess({
          binaryPath: "opencode",
          port: 4096,
          processPriority: linuxExecNice,
        })
        .pipe(Effect.scoped);
      expect(spawned).toEqual([
        ["opencode", "--version"],
        ["/usr/bin/nice", "-n", "5", "opencode", "serve", "--hostname=127.0.0.1", "--port=4096"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  effectIt.live("connectToOpenCodeServer forwards the priority; probes stay unwrapped", () => {
    const { layer, spawned } = servingRuntimeLayer();
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      yield* runtime
        .connectToOpenCodeServer({
          binaryPath: "opencode",
          verifiedBinaryVersion: "1.18.34",
          port: 4096,
          processPriority: linuxExecNice,
        })
        .pipe(Effect.scoped);
      yield* runtime
        .connectToOpenCodeServer({
          binaryPath: "opencode",
          verifiedBinaryVersion: "1.18.34",
          port: 4096,
        })
        .pipe(Effect.scoped);
      expect(spawned.map((argv) => argv.slice(0, 2))).toEqual([
        ["/usr/bin/nice", "-n"],
        ["opencode", "serve"],
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("OpenCode server start by generation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  interface Spawn {
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string | undefined>>;
  }

  /**
   * Answers `--version` with `version` and `serve` with `serveOutput`; a serve that `exits` ends
   * right after its output, otherwise it runs until its scope closes. Records every argv and env.
   */
  function serveRuntimeLayer(input: {
    readonly version: string;
    readonly serveOutput: string;
    readonly exits?: boolean;
  }) {
    const spawns: Array<Spawn> = [];
    const encoder = new TextEncoder();
    const spawner = ChildProcessSpawner.make((command) => {
      const standard = command as unknown as {
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: Record<string, string | undefined> };
      };
      spawns.push({ args: [...standard.args], env: { ...standard.options.env } });
      const version = standard.args.includes("--version");
      const ends = version || input.exits === true;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(2_147_483_002),
          // The exit waits for the output, as a real process's exit follows its last write.
          exitCode: ends
            ? Effect.sleep("20 millis").pipe(
                Effect.as(ChildProcessSpawner.ExitCode(version ? 0 : 1)),
              )
            : Effect.never,
          isRunning: Effect.succeed(!ends),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(version ? `${input.version}\n` : input.serveOutput)),
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
    const serveEnv = () => spawns.find((spawn) => spawn.args[0] === "serve")?.env ?? {};
    return { layer, spawns, serveEnv };
  }

  const environment = { PATH: "/usr/bin", OPENCODE_SERVER_PASSWORD: "inherited-1x" };

  effectIt.live("gives a 2.x server a generated password of its own under its variable", () => {
    const { layer, serveEnv, spawns } = serveRuntimeLayer({
      version: "opencode v2.2.0",
      serveOutput: "OpenCode server listening on http://127.0.0.1:4196\n",
    });
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const start = runtime.startOpenCodeServerProcess({
        binaryPath: "opencode",
        environment,
        port: 4196,
      });
      const first = yield* start.pipe(Effect.scoped);
      const env = serveEnv();
      expect(first.url).toBe("http://127.0.0.1:4196");
      expect(first.serverPassword).toMatch(/^[\w-]{43}$/u);
      expect(env.OPENCODE_PASSWORD).toBe(first.serverPassword);
      // 2.x would read the inherited 1.x variable as a second password source.
      expect("OPENCODE_SERVER_PASSWORD" in env).toBe(false);
      expect(env.PATH).toBe("/usr/bin");
      expect(env.OPENCODE_CONFIG_CONTENT).toBe("{}");

      spawns.length = 0;
      const second = yield* start.pipe(Effect.scoped);
      expect(second.serverPassword).not.toBe(first.serverPassword);
    }).pipe(Effect.provide(layer));
  });

  effectIt.live("gives a 2.x server the configured password", () => {
    const { layer, serveEnv } = serveRuntimeLayer({
      version: "2.2.0",
      serveOutput: "OpenCode server listening on http://127.0.0.1:4197\n",
    });
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const server = yield* runtime
        .startOpenCodeServerProcess({
          binaryPath: "opencode",
          verifiedBinaryVersion: "2.2.0",
          serverPassword: "configured-secret",
          environment,
          port: 4197,
        })
        .pipe(Effect.scoped);
      expect(server.serverPassword).toBe("configured-secret");
      expect(serveEnv().OPENCODE_PASSWORD).toBe("configured-secret");
      expect("OPENCODE_SERVER_PASSWORD" in serveEnv()).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  effectIt.live("keeps the 1.x environment and its inherited password", () => {
    const { layer, serveEnv } = serveRuntimeLayer({
      version: "1.18.34",
      serveOutput: "opencode server listening on http://127.0.0.1:4198\n",
    });
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const server = yield* runtime
        .startOpenCodeServerProcess({ binaryPath: "opencode", environment, port: 4198 })
        .pipe(Effect.scoped);
      expect(server.url).toBe("http://127.0.0.1:4198");
      expect(server.serverPassword).toBe("inherited-1x");
      expect(serveEnv().OPENCODE_SERVER_PASSWORD).toBe("inherited-1x");
      expect("OPENCODE_PASSWORD" in serveEnv()).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  effectIt.live("reads the ready line in either generation's casing", () =>
    Effect.gen(function* () {
      for (const [line, url] of [
        ["opencode server listening on http://127.0.0.1:4096\n", "http://127.0.0.1:4096"],
        ["INFO  OpenCode Server listening on http://[::1]:4097\n", "http://[::1]:4097"],
        // Another server's line printed first (a plugin) is not the ready line.
        [
          "plugin proxy: server listening on http://127.0.0.1:9999\nopencode server listening on http://127.0.0.1:4098\n",
          "http://127.0.0.1:4098",
        ],
      ] as const) {
        const { layer } = serveRuntimeLayer({ version: "2.2.0", serveOutput: line });
        const server = yield* Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime
            .startOpenCodeServerProcess({ binaryPath: "opencode", port: 4096 })
            .pipe(Effect.scoped);
        }).pipe(Effect.provide(layer));
        expect(server.url).toBe(url);
      }
    }),
  );

  effectIt.live("keeps the password out of a failed start's output", () => {
    const { layer } = serveRuntimeLayer({
      version: "2.2.0",
      serveOutput: "Using password configured-secret\nError: database is locked\n",
      exits: true,
    });
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const error = yield* runtime
        .startOpenCodeServerProcess({
          binaryPath: "opencode",
          serverPassword: "configured-secret",
          port: 4199,
        })
        .pipe(Effect.scoped, Effect.flip);
      expect(error.detail).toContain("exited before startup completed");
      expect(error.detail).toContain("Using password <redacted>");
      expect(JSON.stringify([error.detail, error.cause])).not.toContain("configured-secret");
    }).pipe(Effect.provide(layer));
  });

  /** Stubs the global fetch with a server keyed by path, recording each path asked. */
  function stubServer(routes: Readonly<Record<string, () => Response>>) {
    const paths: Array<string> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return routes[path]?.() ?? new Response(null, { status: 404 });
    });
    return paths;
  }
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  effectIt.live("asks a 2.x server it started on the 2.x route only", () => {
    const { layer } = serveRuntimeLayer({
      version: "2.2.0",
      serveOutput: "OpenCode server listening on http://127.0.0.1:4296\n",
    });
    const paths = stubServer({ "/api/info": () => json({ version: "2.2.0", pid: 7 }) });
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = yield* Effect.gen(function* () {
        const server = yield* runtime.startOpenCodeServerProcess({
          binaryPath: "opencode",
          port: 4296,
        });
        return yield* runtime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: "/work",
          ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
        });
      }).pipe(Effect.scoped);
      expect(client.generation).toBe("v2");
      // The 2.x catch-all never sees a request, so the password never leaves the machine.
      expect(paths).toEqual(["/api/info"]);
    }).pipe(Effect.provide(layer));
  });

  effectIt.live("refuses a server it started that answers as the other generation", () => {
    const { layer } = serveRuntimeLayer({
      version: "2.2.0",
      serveOutput: "OpenCode server listening on http://127.0.0.1:4297\n",
    });
    // The binary was swapped for 1.x between its version check and `serve`.
    const paths = stubServer({
      "/global/health": () => json({ healthy: true, version: "1.18.34" }),
    });
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const error = yield* Effect.gen(function* () {
        const server = yield* runtime.startOpenCodeServerProcess({
          binaryPath: "opencode",
          port: 4297,
        });
        return yield* runtime.createOpenCodeSdkClient({ baseUrl: server.url, directory: "/work" });
      }).pipe(Effect.scoped, Effect.flip);
      expect(error.detail).toBe(
        "The OpenCode server Ryco started is not the OpenCode 2 its binary reported. Its binary may have changed; try again.",
      );
      expect(paths).toEqual(["/api/info"]);
    }).pipe(Effect.provide(layer));
  });

  effectIt.live("never asks a 2.x server it started on the 1.x route when /api/info fails", () => {
    const { layer } = serveRuntimeLayer({
      version: "2.2.0",
      serveOutput: "OpenCode server listening on http://127.0.0.1:4298\n",
    });
    const paths = stubServer({
      "/api/info": () => new Response(null, { status: 500 }),
      "/global/health": () => json({ healthy: true, version: "1.18.34" }),
    });
    return Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const error = yield* Effect.gen(function* () {
        const server = yield* runtime.startOpenCodeServerProcess({
          binaryPath: "opencode",
          port: 4298,
        });
        return yield* runtime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: "/work",
          ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
        });
      }).pipe(Effect.scoped, Effect.flip);
      expect(error.detail).toBe("The OpenCode server returned HTTP 500.");
      // The 2.x catch-all would get the password on /global/health.
      expect(paths).toEqual(["/api/info"]);
    }).pipe(Effect.provide(layer));
  });
});
