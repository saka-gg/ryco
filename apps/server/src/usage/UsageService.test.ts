// @effect-diagnostics nodeBuiltinImport:off
import * as FS from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  USAGE_CONTRACT_VERSION,
  type ServerSettings,
} from "@ryco/contracts";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TranscriptReader from "./usageTranscriptReader.ts";
import { UsageService, UsageServiceLive } from "./UsageService.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});
function testLayer(root: string, settings: ServerSettings, document: unknown = {}) {
  return UsageServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ServerConfig.layerTest(root, join(root, "state")).pipe(Layer.provide(NodeServices.layer)),
        Layer.succeed(ServerSettingsService, {
          withSettingsSnapshot: (effect) => effect,
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(settings),
          updateSettings: () => Effect.succeed(settings),
          streamChanges: Stream.empty,
        }),
        Layer.succeed(ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture")),
          getDescriptor: Effect.die("unused"),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(document))),
          ),
        ),
      ),
    ),
  );
}

it("deduplicates same-account exports from multiple instances and keeps failed refresh coverage truthful", async () => {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-summary-fixture-"));
  roots.push(root);
  const exportPath = join(root, "export.json");
  await FS.writeFile(
    exportPath,
    await FS.readFile(new URL("./fixtures/cursor-usage-page.json", import.meta.url)),
  );
  const dataHome = join(root, "data");
  await FS.mkdir(join(dataHome, "opencode"), { recursive: true });
  const databasePath = join(dataHome, "opencode", "opencode.db");
  const db = new DatabaseSync(databasePath);
  db.exec(
    "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, type TEXT, data TEXT)",
  );
  const {
    id: _id,
    type: _type,
    ...message
  } = JSON.parse(
    await FS.readFile(new URL("./fixtures/opencode-v2.json", import.meta.url), "utf8"),
  );
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
    "msg_fixture",
    "ses_fixture",
    1786060800000,
    "assistant",
    JSON.stringify(message),
  );
  db.close();
  const config = {
    usageExportPath: exportPath,
    usageExportAccountKey: "synthetic-team",
    usageExportUserEmail: "personal@example.invalid",
  };
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        homePath: join(root, "claude"),
      },
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: join(root, "codex") },
    },
    providerInstances: {
      [ProviderInstanceId.make("opencode-default")]: {
        driver: ProviderDriverKind.make("opencode"),
        environment: [{ name: "XDG_DATA_HOME", value: dataHome, sensitive: false }],
      },
      [ProviderInstanceId.make("opencode-explicit")]: {
        driver: ProviderDriverKind.make("opencode"),
        environment: [{ name: "OPENCODE_DB", value: databasePath, sensitive: false }],
      },
      [ProviderInstanceId.make("cursor-a")]: {
        driver: ProviderDriverKind.make("cursor"),
        name: "A",
        enabled: true,
        config,
      },
      [ProviderInstanceId.make("cursor-b")]: {
        driver: ProviderDriverKind.make("cursor"),
        name: "B",
        enabled: true,
        config,
      },
    },
  };
  const request = {
    contractVersion: USAGE_CONTRACT_VERSION,
    timeZone: "UTC",
    startDate: "2025-01-01",
    endDate: "2027-01-01",
  };
  const program = Effect.gen(function* () {
    const service = yield* UsageService;
    const first = yield* service.readSummary(request);
    expect(first.buckets).toHaveLength(2);
    expect(first.sources.filter((source) => source.provider === "opencode")).toHaveLength(1);
    expect(first.buckets.find((bucket) => bucket.provider === "opencode")?.tokens.totalTokens).toBe(
      185,
    );
    expect(first.buckets.find((bucket) => bucket.provider === "cursor")).toMatchObject({
      provider: "cursor",
      responseCount: 1,
      estimatedCostUsd: 0.2018232,
    });
    expect(first.buckets.find((bucket) => bucket.provider === "cursor")?.exportRecordId).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(
      first.buckets.find((bucket) => bucket.provider === "cursor")?.tokens.reasoningTokens,
    ).toBeUndefined();
    expect(first.imports).toHaveLength(4);
    expect(first.sources.filter((source) => source.provider === "cursor")).toHaveLength(1);
    expect(first.sources.find((source) => source.provider === "cursor")).toMatchObject({
      status: "partial",
      distinctResponseCount: 1,
    });
    expect(JSON.stringify(first)).not.toMatch(/example.invalid|fixture-conversation/);
    yield* Effect.promise(() => FS.writeFile(exportPath, '{"usageEvents":'));
    const failed = yield* service.readSummary(request);
    expect(failed.buckets.filter((bucket) => bucket.provider === "cursor")).toHaveLength(0);
    expect(
      failed.buckets.find((bucket) => bucket.provider === "opencode")?.tokens.totalTokens,
    ).toBe(185);
    const incompatible = yield* service
      .readSummary({ ...request, contractVersion: 1 })
      .pipe(Effect.result);
    expect(incompatible._tag).toBe("Failure");
    expect(failed.sources.find((source) => source.provider === "cursor")?.status).toBe("failed");
  });
  await Effect.runPromise(program.pipe(Effect.provide(testLayer(root, settings)), Effect.scoped));
});

it("scans large histories past the old byte/line limits, then reuses them with corrected persisted pricing", async () => {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-large-summary-"));
  roots.push(root);
  const claudeHome = join(root, "claude");
  const projects = join(claudeHome, "projects");
  await FS.mkdir(projects, { recursive: true });
  const chunk = ('{"type":"user","padding":"' + "x".repeat(640) + '"}\n').repeat(1000);
  for (let file = 0; file < 5; file++) {
    const target = join(projects, `${file}.jsonl`);
    await FS.writeFile(target, "");
    for (let block = 0; block < 110; block++) await FS.appendFile(target, chunk);
    await FS.appendFile(
      target,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-07T00:00:00Z",
        sessionId: `session-${file}`,
        message: {
          id: `response-${file}`,
          model: "claude-test",
          usage: {
            input_tokens: 2,
            output_tokens: 3,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 10,
            speed: "fast",
          },
        },
      }) + "\n",
    );
  }
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {},
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, homePath: claudeHome },
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: join(root, "codex") },
    },
  };
  const state = join(root, "state", "usage");
  await FS.mkdir(state, { recursive: true });
  // A fresh legacy cache is already collapsed/poisoned; it must be fetched again.
  await FS.writeFile(
    join(state, "pricing-cache.json"),
    JSON.stringify({
      fetchedAtMs: Date.now(),
      revision: "old",
      document: { "claude-test": { input_cost_per_token: 0, output_cost_per_token: 0 } },
    }),
  );
  const document = {
    "claude-test": {
      input_cost_per_token: 1,
      output_cost_per_token: 2,
      cache_read_input_token_cost: 0.1,
      cache_creation_input_token_cost: 1.25,
      provider_specific_entry: { fast: 2 },
    },
  };
  const request = {
    contractVersion: USAGE_CONTRACT_VERSION,
    startDate: "2026-08-01",
    endDate: "2026-08-10",
    timeZone: "UTC",
  };
  const scan = Effect.gen(function* () {
    const service = yield* UsageService;
    const cold = yield* service.readSummary(request);
    const warm = yield* service.readSummary(request);
    for (const summary of [cold, warm]) {
      expect(summary.sources.find((source) => source.provider === "claude")?.status).toBe(
        "complete",
      );
      expect(summary.buckets).toHaveLength(1);
      expect(summary.buckets[0]?.tokens.totalTokens).toBe(575);
      expect(summary.buckets[0]?.estimatedCostUsd).toBeCloseTo(305);
      expect(summary.buckets[0]?.estimatedCacheSavingsUsd).toBeCloseTo(900);
    }
    expect(warm.sources.find((source) => source.provider === "claude")?.reusedCacheFileCount).toBe(
      5,
    );
  });
  await Effect.runPromise(
    scan.pipe(Effect.provide(testLayer(root, settings, document)), Effect.scoped),
  );
  // New process: both scan and rate caches retain speeds and produce identical results offline.
  await Effect.runPromise(scan.pipe(Effect.provide(testLayer(root, settings)), Effect.scoped));
}, 15000);

it("continues past exhausted scan budgets and does not charge cached files again", async () => {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-budget-summary-"));
  roots.push(root);
  const claudeHome = join(root, "claude");
  const projects = join(claudeHome, "projects");
  await FS.mkdir(projects, { recursive: true });
  for (let index = 0; index < 3; index++)
    await FS.writeFile(
      join(projects, `${index}.jsonl`),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-07T00:00:00Z",
        message: {
          id: `message-${index}`,
          model: "unknown",
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      }) + "\n",
    );
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {},
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, homePath: claudeHome },
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: join(root, "codex") },
    },
  };
  const original = TranscriptReader.listUsageTranscriptFiles;
  // Exercise the budget with tiny synthetic files; no multi-GiB fixture is needed.
  const listing = vi
    .spyOn(TranscriptReader, "listUsageTranscriptFiles")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      return {
        ...result,
        files: result.files.map((file) => Object.assign({}, file, { size: 2 * 1024 ** 3 })),
      };
    });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* UsageService;
        const request = {
          contractVersion: USAGE_CONTRACT_VERSION,
          startDate: "2026-08-01",
          endDate: "2026-08-10",
          timeZone: "UTC",
        };
        const first = yield* service.readSummary(request);
        expect(first.sources.find((source) => source.provider === "claude")?.status).toBe(
          "partial",
        );
        expect(first.buckets[0]?.responseCount).toBe(2);
        const next = yield* service.readSummary(request);
        expect(next.sources.find((source) => source.provider === "claude")?.status).toBe(
          "complete",
        );
        expect(
          next.sources.find((source) => source.provider === "claude")?.reusedCacheFileCount,
        ).toBe(2);
        expect(next.buckets[0]?.responseCount).toBe(3);
      }).pipe(Effect.provide(testLayer(root, settings)), Effect.scoped),
    );
  } finally {
    listing.mockRestore();
  }
});

it("includes disabled accounts and follows the runtime's explicit history environment paths", async () => {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-account-summary-"));
  roots.push(root);
  const claudeStore = join(root, "claude-store"),
    codexStore = join(root, "codex-store");
  await FS.mkdir(join(claudeStore, "projects"), { recursive: true });
  await FS.mkdir(join(codexStore, "sessions"), { recursive: true });
  await FS.writeFile(
    join(claudeStore, "projects", "usage.jsonl"),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-07T00:00:00Z",
      message: {
        id: "assistant-account",
        model: "unknown",
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    }),
  );
  await FS.writeFile(
    join(codexStore, "sessions", "usage.jsonl"),
    JSON.stringify({ type: "turn_context", payload: { model: "unknown" } }) +
      "\n" +
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-07T00:00:00Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 7, output_tokens: 3 } },
        },
      }),
  );
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        homePath: join(root, "default-claude"),
      },
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: join(root, "default-codex") },
    },
    providerInstances: {
      [ProviderInstanceId.make("disabled-claude")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: false,
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: claudeStore, sensitive: false }],
      },
      [ProviderInstanceId.make("disabled-codex")]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: false,
        environment: [{ name: "CODEX_HOME", value: codexStore, sensitive: false }],
      },
      [ProviderInstanceId.make("same-codex")]: {
        driver: ProviderDriverKind.make("codex"),
        config: { homePath: codexStore },
      },
      [ProviderInstanceId.make("invalid-codex")]: {
        driver: ProviderDriverKind.make("codex"),
        config: { homePath: 123 },
      },
    },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* UsageService;
      const summary = yield* service.readSummary({
        contractVersion: USAGE_CONTRACT_VERSION,
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        timeZone: "UTC",
      });
      expect(
        summary.buckets.find((bucket) => bucket.provider === "claude")?.tokens.totalTokens,
      ).toBe(5);
      expect(
        summary.buckets.find((bucket) => bucket.provider === "codex")?.tokens.totalTokens,
      ).toBe(10);
      expect(summary.sources.filter((source) => source.status === "complete")).toHaveLength(2);
      expect(
        summary.sources.some((source) => source.diagnosticCode === "history-config-invalid"),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer(root, settings)), Effect.scoped),
  );
});
