import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ChildProcessSpawner } from "effect/process";
import { GrokSettings, type ServerProviderRateLimits } from "@ryco/contracts";

import { makeUsageReadGate } from "../usageReadGate.ts";
import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  grokSlashCommandsFromInitialize,
} from "./GrokProvider.ts";
import { resolveGrokAccount, type GrokAccount } from "./GrokUsage.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const mockAgentPath = NodePath.join(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

/**
 * A `grok` that answers `--version` and serves the ACP mock agent for `grok agent stdio`, so the
 * probe reaches its ready branch without the real CLI or account.
 */
const makeReadyGrokBinary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-grok-ready-" });
  const grokPath = path.join(dir, "grok");
  yield* fs.writeFileString(
    grokPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then printf "grok-cli 0.0.99\\n"; exit 0; fi',
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"`,
      "",
    ].join("\n"),
  );
  yield* fs.chmod(grokPath, 0o755);
  return grokPath;
});

/** The test runner's environment without an xAI API key, so the CLI login is what counts. */
function loginEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { XAI_API_KEY: _apiKey, ...environment } = process.env;
  return { ...environment, ...overrides };
}

const CREDITS: ServerProviderRateLimits = {
  limitId: "grok-credits",
  secondary: { usedPercent: 37, resetsAt: 1_789_701_030, windowDurationMins: 10_080 },
  windows: [
    { id: "credits", usedPercent: 37, resetsAt: 1_789_701_030, windowDurationMins: 10_080 },
  ],
  observedAt: "2026-09-16T00:00:00.000Z",
};

const runNode = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("buildInitialGrokProviderSnapshot", () => {
  it("returns a disabled snapshot when settings.enabled is false", () => {
    const snapshot = buildInitialGrokProviderSnapshot(decodeGrokSettings({ enabled: false }));
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.status).toBe("disabled");
    expect(snapshot.installed).toBe(false);
    expect(snapshot.message).toContain("disabled");
  });

  it("returns a pending snapshot by default", () => {
    const snapshot = buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.status).toBe("warning");
    expect(snapshot.version).toBeNull();
    expect(snapshot.message).toContain("Checking Grok");
  });
});

describe("checkGrokProviderStatus", () => {
  it("reports the binary as missing when the binary path does not resolve", async () => {
    const snapshot = await runNode(
      checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      ),
    );
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.installed).toBe(false);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
  });

  it("reports an installed CLI as unhealthy when --version exits non-zero", async () => {
    const secretStderr = "broken grok install: secret-token-value";
    const snapshot = await runNode(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      ),
    );

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.status).toBe("error");
    expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
    expect(snapshot.message).not.toContain(secretStderr);
  });

  it("reports an error when ACP model discovery is unavailable", async () => {
    const snapshot = await runNode(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      ),
    );

    expect(snapshot.status).toBe("error");
    expect(snapshot.installed).toBe(true);
    expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
    expect(snapshot.message).toContain("ACP startup failed");
  });
});

describe("checkGrokProviderStatus account", () => {
  it("reports a ready probe as signed in, naming the login and carrying its credits", async () => {
    const environment = loginEnvironment({ GROK_HOME: "/definitely/not/a/grok-home" });
    const reads: Array<NodeJS.ProcessEnv> = [];
    const snapshot = await runNode(
      Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* makeReadyGrokBinary;
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            environment,
            (readEnvironment) =>
              Effect.sync((): GrokAccount => {
                reads.push(readEnvironment);
                return { email: "someone@example.com", rateLimits: CREDITS };
              }),
          );
        }),
      ),
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.models.map((model) => model.slug)).toContain("grok-build");
    expect(snapshot.auth).toEqual({ status: "authenticated", email: "someone@example.com" });
    expect(snapshot.rateLimits).toEqual(CREDITS);
    expect(reads).toEqual([environment]);
  });

  it("reports an API-key instance as signed in with its key, without reading credits", async () => {
    const requests: Array<string> = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      requests.push(String(url));
      throw new Error("An API-key instance must not read the CLI login's credits.");
    }) as unknown as typeof globalThis.fetch;
    const snapshot = await runNode(
      Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* makeReadyGrokBinary;
          const gate = yield* makeUsageReadGate();
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            loginEnvironment({ XAI_API_KEY: "xai-test-key" }),
            (readEnvironment) => resolveGrokAccount(readEnvironment, gate, { fetchImpl }),
          );
        }),
      ),
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.auth).toEqual({
      status: "authenticated",
      type: "apiKey",
      label: "xAI API key",
    });
    expect(snapshot.rateLimits).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("stays ready when the account cannot be read", async () => {
    const snapshot = await runNode(
      Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* makeReadyGrokBinary;
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            loginEnvironment({ GROK_HOME: "/definitely/not/a/grok-home" }),
            () => Effect.die(new Error("account read failed")),
          );
        }),
      ),
    );

    expect(snapshot.status).toBe("ready");
    // The ACP start authenticated; only the email and credits are unknown.
    expect(snapshot.auth).toEqual({ status: "authenticated" });
    expect(snapshot.rateLimits).toBeUndefined();
  });
});

describe("grokSlashCommandsFromInitialize", () => {
  it("normalizes the listed commands, drops malformed and hidden ones", () => {
    expect(
      grokSlashCommandsFromInitialize({
        _meta: {
          availableCommands: [
            { name: "/review", description: " Review a PR ", input: { hint: "<pr>" } },
            { name: "always-approve", description: "Approve everything" },
            { name: "context", description: "Show context" },
            { name: "no-description" },
            { name: 3, description: "x" },
            "compact",
            { name: "compact", description: "Compact the chat" },
          ],
        },
      }),
    ).toEqual([
      { name: "review", description: "Review a PR", input: { hint: "<pr>" } },
      { name: "compact", description: "Compact the chat" },
    ]);
    expect(grokSlashCommandsFromInitialize({})).toEqual([]);
    expect(grokSlashCommandsFromInitialize({ _meta: null })).toEqual([]);
    expect(grokSlashCommandsFromInitialize({ _meta: { availableCommands: "review" } })).toEqual([]);
  });

  it("lists the built-in commands of a probed CLI", async () => {
    const snapshot = await runNode(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-grok-commands-" });
          const grokPath = path.join(dir, "grok");
          const mockAgentPath = yield* path.fromFileUrl(
            new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
          );
          const commands = JSON.stringify([
            { name: "review", description: "Review" },
            { name: "always-approve", description: "Approve everything" },
          ]);
          yield* fs.writeFileString(
            grokPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then printf "grok-cli 0.0.99\\n"; exit 0; fi',
              `export RYCO_ACP_INITIALIZE_META_COMMANDS=${JSON.stringify(commands)}`,
              `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"`,
              "",
            ].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      ),
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.slashCommands).toEqual([{ name: "review", description: "Review" }]);
  }, 30_000);
});
