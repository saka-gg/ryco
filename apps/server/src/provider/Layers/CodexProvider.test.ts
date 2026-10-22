import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { CodexSettings } from "@ryco/contracts";
import { Deferred, Effect, Fiber, Ref, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import * as CodexSchema from "effect-codex-app-server/schema";

import {
  checkCodexProviderStatus,
  parseCodexModelListResponse,
  parseCodexRateLimits,
} from "./CodexProvider.ts";
import { makeCodexStoredThreadReader } from "./CodexStoredThreadReader.ts";

const baseResponse = (
  rateLimits: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitSnapshot,
): CodexSchema.V2GetAccountRateLimitsResponse => ({ rateLimits });

describe("parseCodexRateLimits", () => {
  it("normalizes the upstream snapshot into the contract shape", () => {
    const result = parseCodexRateLimits(
      baseResponse({
        limitId: "primary",
        limitName: "ChatGPT Pro",
        planType: "pro",
        primary: {
          usedPercent: 42,
          resetsAt: 1_700_000_000,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 7,
          windowDurationMins: 7 * 24 * 60,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "$12.50",
        },
        rateLimitReachedType: "rate_limit_reached",
      }),
    );

    expect(result).toEqual({
      limitId: "primary",
      limitName: "ChatGPT Pro",
      planType: "pro",
      primary: {
        usedPercent: 42,
        resetsAt: 1_700_000_000,
        windowDurationMins: 300,
      },
      secondary: {
        usedPercent: 7,
        windowDurationMins: 7 * 24 * 60,
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "$12.50",
      },
      rateLimitReachedType: "rate_limit_reached",
    });
  });

  it("drops null window fields rather than forwarding them", () => {
    const result = parseCodexRateLimits(
      baseResponse({
        primary: {
          usedPercent: 10,
          resetsAt: null,
          windowDurationMins: null,
        },
      }),
    );

    expect(result).toEqual({
      primary: { usedPercent: 10 },
    });
  });

  it("returns undefined when no usage data is present", () => {
    expect(parseCodexRateLimits(baseResponse({}))).toBeUndefined();
    expect(
      parseCodexRateLimits(
        baseResponse({
          limitName: "ChatGPT Pro",
          planType: "pro",
        }),
      ),
    ).toBeUndefined();
  });

  it("retains credits even when usage windows are absent", () => {
    expect(
      parseCodexRateLimits(
        baseResponse({
          credits: {
            hasCredits: false,
            unlimited: true,
          },
        }),
      ),
    ).toEqual({
      credits: { hasCredits: false, unlimited: true },
    });
  });
});

describe("parseCodexModelListResponse", () => {
  it("maps GPT-5.6 max and ultra reasoning efforts into selectable model capabilities", () => {
    const models = parseCodexModelListResponse({
      data: [
        {
          defaultReasoningEffort: "max",
          description: "Frontier model for complex professional work",
          displayName: "gpt-5.6-sol",
          hidden: false,
          id: "gpt-5.6-sol",
          isDefault: true,
          model: "gpt-5.6-sol",
          supportedReasoningEfforts: [
            { reasoningEffort: "none", description: "No reasoning" },
            { reasoningEffort: "low", description: "Low reasoning" },
            { reasoningEffort: "medium", description: "Medium reasoning" },
            { reasoningEffort: "high", description: "High reasoning" },
            { reasoningEffort: "xhigh", description: "Extra high reasoning" },
            { reasoningEffort: "max", description: "Maximum reasoning" },
            { reasoningEffort: "ultra", description: "Ultra reasoning" },
          ],
        },
      ],
    } satisfies CodexSchema.V2ModelListResponse);

    expect(models[0]).toMatchObject({
      slug: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            currentValue: "max",
            options: [
              { id: "none", label: "None" },
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
              { id: "xhigh", label: "Extra High" },
              { id: "max", label: "Max", isDefault: true },
              { id: "ultra", label: "Ultra" },
            ],
          },
        ],
      },
    });
  });

  it("formats unknown future reasoning efforts instead of dropping labels", () => {
    const models = parseCodexModelListResponse({
      data: [
        {
          defaultReasoningEffort: "ultra-deep",
          description: "Future model",
          displayName: "future-model",
          hidden: false,
          id: "future-model",
          isDefault: false,
          model: "future-model",
          supportedReasoningEfforts: [
            { reasoningEffort: "ultra-deep", description: "Future effort" },
          ],
        },
      ],
    } satisfies CodexSchema.V2ModelListResponse);

    const descriptor = models[0]!.capabilities!.optionDescriptors![0];
    expect(descriptor).toMatchObject({
      currentValue: "ultra-deep",
      options: [{ id: "ultra-deep", label: "Ultra Deep", isDefault: true }],
    });
  });
});

// A stand-in `codex app-server` that answers the requests of a status probe and records its
// starts and requests, so tests can see how many processes a probe used.
const STUB_APP_SERVER = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const configPath = process.env.RYCO_CODEX_STUB_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const record = (entry) => fs.appendFileSync(config.logPath, entry + "\\n");
record("start");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  record(method);
  if (config.hangOn === method) return;
  const exitedOnce = configPath + ".exited";
  if (
    config.exitAlways === method ||
    (config.exitOnce === method && !fs.existsSync(exitedOnce))
  ) {
    fs.writeFileSync(exitedOnce, "");
    process.exit(3);
  }
  const results = {
    initialize: { userAgent: "codex-stub/1.2.3", codexHome: "/codex-home", platformFamily: "unix", platformOs: "linux" },
    "account/read": { account: { type: "apiKey" }, requiresOpenaiAuth: false },
    "model/list": {
      data: [
        {
          id: "stub-model",
          model: "stub-model",
          displayName: "stub-model",
          description: "Stub",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
        },
      ],
    },
    "skills/list": {
      data: (params.cwds ?? []).map((cwd) => ({ cwd, errors: [], skills: [] })),
    },
  };
  process.stdout.write(JSON.stringify({ id, result: results[method] ?? {} }) + "\\n");
});
`;

const makeStubAppServer = (config: Record<string, unknown> = {}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-codex-probe-"));
  const binaryPath = NodePath.join(dir, "codex");
  const configPath = NodePath.join(dir, "config.json");
  const logPath = NodePath.join(dir, "log");
  NodeFS.writeFileSync(binaryPath, STUB_APP_SERVER, { mode: 0o755 });
  const writeConfig = (next: Record<string, unknown>) =>
    NodeFS.writeFileSync(configPath, JSON.stringify({ logPath, ...next }), "utf8");
  writeConfig(config);
  const lines = () =>
    NodeFS.existsSync(logPath) ? NodeFS.readFileSync(logPath, "utf8").trim().split("\n") : [];
  return {
    binaryPath,
    environment: { ...process.env, RYCO_CODEX_STUB_CONFIG: configPath },
    writeConfig,
    processStarts: () => lines().filter((line) => line === "start").length,
    requests: () => lines().filter((line) => line !== "start"),
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};

const settingsFor = (binaryPath: string) =>
  Schema.decodeSync(CodexSettings)({ enabled: true, binaryPath });

describe("checkCodexProviderStatus through the shared app-server process", () => {
  effectIt.live("probes through the process the stored-thread reads use", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer();
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const settings = settingsFor(stub.binaryPath);
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: stub.binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: stub.environment,
      });

      const first = yield* checkCodexProviderStatus(settings, undefined, stub.environment, reader);
      expect(first.status).toBe("ready");
      expect(first.version).toBe("1.2.3");
      expect(first.models.map((model) => model.slug)).toEqual(["stub-model"]);
      expect(reader.starts()).toBe(1);

      // Reads and later probes find the process the first probe started.
      yield* reader.withClient((client) => client.request("skills/list", { cwds: ["/repo"] }));
      const second = yield* checkCodexProviderStatus(settings, undefined, stub.environment, reader);
      expect(second.status).toBe("ready");
      expect(reader.starts()).toBe(1);
      expect(stub.processStarts()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("probes without starting a process when a read already did", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer();
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: stub.binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: stub.environment,
      });
      yield* reader.withClient((client) => client.request("skills/list", { cwds: ["/repo"] }));
      expect(stub.processStarts()).toBe(1);

      const status = yield* checkCodexProviderStatus(
        settingsFor(stub.binaryPath),
        undefined,
        stub.environment,
        reader,
      );
      expect(status.status).toBe("ready");
      expect(stub.processStarts()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("probes through a process of its own when no reader is given", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer();
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const status = yield* checkCodexProviderStatus(
        settingsFor(stub.binaryPath),
        undefined,
        stub.environment,
      );
      expect(status.status).toBe("ready");
      expect(status.version).toBe("1.2.3");
      expect(stub.processStarts()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("probes once more on a fresh process when the shared one dies mid-probe", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer({ exitOnce: "model/list" });
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: stub.binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: stub.environment,
      });

      const status = yield* checkCodexProviderStatus(
        settingsFor(stub.binaryPath),
        undefined,
        stub.environment,
        reader,
      );
      expect(status.status).toBe("ready");
      expect(status.models.map((model) => model.slug)).toEqual(["stub-model"]);
      expect(stub.processStarts()).toBe(2);
      expect(reader.starts()).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("reports a process that keeps dying as a failed probe after one retry", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer({ exitAlways: "model/list" });
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: stub.binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: stub.environment,
      });

      const status = yield* checkCodexProviderStatus(
        settingsFor(stub.binaryPath),
        undefined,
        stub.environment,
        reader,
      );
      expect(status.status).toBe("error");
      expect(status.installed).toBe(true);
      expect(status.message).toContain("Codex app-server provider probe failed");
      expect(stub.processStarts()).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("classifies a binary that is missing as not installed", () =>
    Effect.gen(function* () {
      const binaryPath = NodePath.join(NodeOS.tmpdir(), `ryco_codex_missing_${process.pid}`);
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath,
        cwd: NodeOS.tmpdir(),
      });

      const status = yield* checkCodexProviderStatus(
        settingsFor(binaryPath),
        undefined,
        process.env,
        reader,
      );
      expect(status.status).toBe("error");
      expect(status.installed).toBe(false);
      expect(status.message).toBe("Codex CLI (`codex`) is not installed or not on PATH.");
      expect(reader.starts()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("classifies a binary that dies at start as a failed probe without retrying", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer({ exitAlways: "initialize" });
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: stub.binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: stub.environment,
      });

      const status = yield* checkCodexProviderStatus(
        settingsFor(stub.binaryPath),
        undefined,
        stub.environment,
        reader,
      );
      expect(status.status).toBe("error");
      expect(status.installed).toBe(true);
      expect(status.message).toContain("Codex app-server provider probe failed");
      expect(stub.processStarts()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("starts a new process once the binary identity changed", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer();
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const identity = yield* Ref.make("codex@1.2.3");
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: stub.binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: stub.environment,
        binaryIdentity: Ref.get(identity),
      });
      const probe = checkCodexProviderStatus(
        settingsFor(stub.binaryPath),
        undefined,
        stub.environment,
        reader,
      );

      yield* probe;
      yield* probe;
      expect(stub.processStarts()).toBe(1);

      yield* Ref.set(identity, "codex@1.3.0");
      const upgraded = yield* probe;
      expect(upgraded.status).toBe("ready");
      expect(stub.processStarts()).toBe(2);
      yield* probe;
      expect(stub.processStarts()).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("reports a timeout when the process never answers its initialize request", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer({ hangOn: "initialize" });
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: stub.binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: stub.environment,
      });

      const startedAt = Date.now();
      const status = yield* checkCodexProviderStatus(
        settingsFor(stub.binaryPath),
        undefined,
        stub.environment,
        reader,
      );
      const elapsedMs = Date.now() - startedAt;
      expect(status.status).toBe("error");
      expect(status.installed).toBe(true);
      expect(status.message).toBe("Timed out while checking Codex app-server provider status.");
      // The probe timeout also covers the process start, well inside the request timeout.
      expect(elapsedMs).toBeLessThan(12_000);
      expect(reader.isRunning()).toBe(false);

      // The process that stopped answering does not hold up the next call.
      stub.writeConfig({});
      const next = yield* checkCodexProviderStatus(
        settingsFor(stub.binaryPath),
        undefined,
        stub.environment,
        reader,
      );
      expect(next.status).toBe("ready");
      expect(reader.starts()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("lets a read on the shared process finish when its probe is interrupted", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer({ hangOn: "model/list" });
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: stub.binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: stub.environment,
      });
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const read = yield* reader
        .withClient((client) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(client.request("skills/list", { cwds: ["/repo"] })),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);

      const hung = yield* checkCodexProviderStatus(
        settingsFor(stub.binaryPath),
        undefined,
        stub.environment,
        reader,
      ).pipe(Effect.forkChild);
      for (let attempt = 0; attempt < 100 && !stub.requests().includes("model/list"); attempt++) {
        yield* Effect.sleep("20 millis");
      }
      expect(stub.requests()).toContain("model/list");
      yield* Fiber.interrupt(hung);

      // The process is no longer handed out, but the read already using it is not cut short.
      expect(reader.isRunning()).toBe(false);
      yield* Deferred.succeed(gate, undefined);
      const response = yield* Fiber.join(read);
      expect(response.data).toHaveLength(1);
      expect(stub.processStarts()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  effectIt.live("retires a process that was still answering when its probe was interrupted", () =>
    Effect.gen(function* () {
      const stub = makeStubAppServer({ hangOn: "model/list" });
      yield* Effect.addFinalizer(() => Effect.sync(stub.cleanup));
      const reader = yield* makeCodexStoredThreadReader({
        binaryPath: stub.binaryPath,
        cwd: NodeOS.tmpdir(),
        environment: stub.environment,
      });
      const settings = settingsFor(stub.binaryPath);

      const hung = yield* checkCodexProviderStatus(
        settings,
        undefined,
        stub.environment,
        reader,
      ).pipe(Effect.forkChild);
      for (let attempt = 0; attempt < 100 && !stub.requests().includes("model/list"); attempt++) {
        yield* Effect.sleep("20 millis");
      }
      expect(stub.requests()).toContain("model/list");
      expect(reader.isRunning()).toBe(true);
      yield* Fiber.interrupt(hung);
      expect(reader.isRunning()).toBe(false);

      // The next probe starts a process instead of reusing the one that stopped answering.
      stub.writeConfig({});
      const status = yield* checkCodexProviderStatus(settings, undefined, stub.environment, reader);
      expect(status.status).toBe("ready");
      expect(stub.processStarts()).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
