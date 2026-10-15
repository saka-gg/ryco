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
import { Duration, Effect, Fiber, Layer, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
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
function testLayer(
  root: string,
  settings: ServerSettings,
  document: unknown = {},
  respond: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => ReturnType<Parameters<typeof HttpClient.make>[0]> = (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(document))),
) {
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
        Layer.succeed(HttpClient.HttpClient, HttpClient.make(respond)),
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
  const state = usageStateDir(root);
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
        expect(first.sources.find((source) => source.provider === "claude")).toMatchObject({
          status: "partial",
          // Distinct from read failures, so the page can say why.
          diagnosticCode: "transcript-scan-budget",
        });
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

/** ServerConfig.layerTest derives its state directory as `<base>/userdata`. */
function usageStateDir(root: string) {
  return join(root, "state", "userdata", "usage");
}

function claudeSettings(claudeHome: string, root: string): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {},
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, homePath: claudeHome },
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: join(root, "codex") },
    },
  };
}

function claudeLine(id: string, inputTokens = 2) {
  return (
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-07T00:00:00Z",
      sessionId: "session",
      message: { id, model: "claude-test", usage: { input_tokens: inputTokens, output_tokens: 3 } },
    }) + "\n"
  );
}

const summaryRequest = {
  contractVersion: USAGE_CONTRACT_VERSION,
  startDate: "2026-08-01",
  endDate: "2026-08-10",
  timeZone: "UTC",
} as const;

const rateDocument = {
  "claude-test": { input_cost_per_token: 1, output_cost_per_token: 2 },
};

it("prices with stale cached rates at once, refreshes them in the background, and backs off failures", async () => {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-rates-summary-"));
  roots.push(root);
  const claudeHome = join(root, "claude");
  await FS.mkdir(join(claudeHome, "projects"), { recursive: true });
  await FS.writeFile(join(claudeHome, "projects", "a.jsonl"), claudeLine("a"));
  const state = usageStateDir(root);
  await FS.mkdir(state, { recursive: true });
  const staleAtMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
  await FS.writeFile(
    join(state, "pricing-cache.json"),
    JSON.stringify({
      version: 2,
      fetchedAtMs: staleAtMs,
      revision: "stale",
      document: rateDocument,
    }),
  );
  let fetches = 0;
  // An unreachable rates host: the download never answers.
  const hanging = () => {
    fetches += 1;
    return Effect.never;
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* UsageService;
      const startedAt = Date.now();
      const first = yield* service.readSummary(summaryRequest);
      const second = yield* service.readSummary(summaryRequest);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      for (const summary of [first, second]) {
        expect(summary.pricing).toMatchObject({ state: "cached", sourceRevision: "stale" });
        expect(summary.buckets[0]?.estimatedCostUsd).toBe(8);
      }
      // One background attempt, not one per summary.
      expect(fetches).toBe(1);
    }).pipe(
      Effect.provide(testLayer(root, claudeSettings(claudeHome, root), {}, hanging)),
      Effect.scoped,
    ),
  );

  // Without any rates, a failed download is not retried on every summary either.
  await FS.rm(join(state, "pricing-cache.json"));
  fetches = 0;
  const failing = () => {
    fetches += 1;
    return Effect.fail(new Error("offline") as never);
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* UsageService;
      for (let index = 0; index < 3; index++) {
        const summary = yield* service.readSummary(summaryRequest);
        expect(summary.pricing.state).toBe("unavailable");
        expect(summary.buckets[0]?.tokens.totalTokens).toBe(5);
      }
      expect(fetches).toBe(1);
    }).pipe(
      Effect.provide(testLayer(root, claudeSettings(claudeHome, root), {}, failing)),
      Effect.scoped,
    ),
  );
});

it("lets a slow rates download finish once its headers arrived in time", async () => {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-rates-slow-body-"));
  roots.push(root);
  const claudeHome = join(root, "claude");
  await FS.mkdir(join(claudeHome, "projects"), { recursive: true });
  await FS.writeFile(join(claudeHome, "projects", "a.jsonl"), claudeLine("a"));
  const state = usageStateDir(root);
  await FS.mkdir(state, { recursive: true });
  await FS.writeFile(
    join(state, "pricing-cache.json"),
    JSON.stringify({
      version: 2,
      fetchedAtMs: Date.now() - 3 * 24 * 60 * 60 * 1000,
      revision: "stale",
      document: rateDocument,
    }),
  );
  // The host answers at once, then the 2.75 MB document trickles in over a slow link.
  let releaseBody: () => void = () => {};
  const bodyReleased = new Promise<void>((resolve) => (releaseBody = resolve));
  const slowBody = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await bodyReleased;
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    "claude-test": { input_cost_per_token: 2, output_cost_per_token: 4 },
                  }),
                ),
              );
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
  const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* UsageService;
      const first = yield* service.readSummary(summaryRequest);
      expect(first.pricing).toMatchObject({ state: "cached", sourceRevision: "stale" });
      yield* settle;
      // Longer than the connect/headers deadline, well within the body budget.
      yield* TestClock.adjust(Duration.seconds(20));
      yield* settle;
      releaseBody();
      let latest = first;
      for (let attempt = 0; attempt < 100 && latest.pricing.state !== "live"; attempt++) {
        yield* settle;
        latest = yield* service.readSummary(summaryRequest);
      }
      expect(latest.pricing.state).toBe("live");
      expect(latest.buckets[0]?.estimatedCostUsd).toBe(16);
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          testLayer(root, claudeSettings(claudeHome, root), {}, slowBody),
        ),
      ),
      Effect.scoped,
    ),
  );
});

it("reuses an unchanged source's result, re-reads it after a change, and shares identical scans", async () => {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-memo-summary-"));
  roots.push(root);
  const claudeHome = join(root, "claude");
  const projects = join(claudeHome, "projects");
  await FS.mkdir(projects, { recursive: true });
  await FS.writeFile(join(projects, "a.jsonl"), claudeLine("a"));
  await FS.writeFile(join(projects, "b.jsonl"), claudeLine("b"));
  const listing = vi.spyOn(TranscriptReader, "listUsageTranscriptFiles");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* UsageService;
        const [first, concurrent] = yield* Effect.all(
          [service.readSummary(summaryRequest), service.readSummary(summaryRequest)],
          { concurrency: "unbounded" },
        );
        // Both callers received the result of a single scan.
        expect(concurrent).toBe(first);
        expect(listing).toHaveBeenCalledTimes(1);
        expect(first.buckets[0]?.responseCount).toBe(2);
        const memoized = yield* service.readSummary(summaryRequest);
        expect(memoized.buckets).toEqual(first.buckets);
        expect(memoized.sources.find((source) => source.provider === "claude")).toMatchObject({
          status: "complete",
          parsedFileCount: 0,
          reusedCacheFileCount: 2,
        });
        yield* Effect.promise(() => FS.appendFile(join(projects, "b.jsonl"), claudeLine("c", 10)));
        const changed = yield* service.readSummary(summaryRequest);
        expect(changed.buckets[0]?.responseCount).toBe(3);
        expect(changed.buckets[0]?.tokens.totalTokens).toBe(23);
        expect(changed.sources.find((source) => source.provider === "claude")).toMatchObject({
          parsedFileCount: 1,
          reusedCacheFileCount: 1,
        });
      }).pipe(Effect.provide(testLayer(root, claudeSettings(claudeHome, root))), Effect.scoped),
    );
  } finally {
    listing.mockRestore();
  }
  // The scan cache was persisted as shards on shutdown and is reused by a new process.
  const shards = await FS.readdir(join(usageStateDir(root), "scan-cache"));
  expect(shards.some((name) => name.endsWith(".json"))).toBe(true);
  await Effect.runPromise(
    Effect.gen(function* () {
      const summary = yield* (yield* UsageService).readSummary(summaryRequest);
      expect(summary.sources.find((source) => source.provider === "claude")).toMatchObject({
        parsedFileCount: 0,
        reusedCacheFileCount: 2,
      });
      expect(summary.buckets[0]?.responseCount).toBe(3);
    }).pipe(Effect.provide(testLayer(root, claudeSettings(claudeHome, root))), Effect.scoped),
  );
});

it("drops a queued scan once every caller has gone away", async () => {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-abandon-summary-"));
  roots.push(root);
  const claudeHome = join(root, "claude");
  await FS.mkdir(join(claudeHome, "projects"), { recursive: true });
  await FS.writeFile(join(claudeHome, "projects", "a.jsonl"), claudeLine("a"));
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const firstScanEntered = new Promise<void>((resolve) => (entered = resolve));
  const original = TranscriptReader.listUsageTranscriptFiles;
  const listing = vi
    .spyOn(TranscriptReader, "listUsageTranscriptFiles")
    .mockImplementation(async (...args) => {
      // The first scan holds the scan lock until released.
      if (release === undefined) {
        const held = new Promise<void>((resolve) => (release = resolve));
        entered?.();
        await held;
      }
      return original(...args);
    });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* UsageService;
        const first = yield* Effect.forkChild(service.readSummary(summaryRequest));
        yield* Effect.promise(() => firstScanEntered);
        // A different window queues behind the running scan; its caller leaves.
        const abandoned = yield* Effect.forkChild(
          service.readSummary({ ...summaryRequest, startDate: "2026-08-05" }),
        );
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(abandoned);
        release?.();
        const summary = yield* Fiber.join(first);
        expect(summary.buckets[0]?.responseCount).toBe(1);
        // Give a (wrongly) surviving queued scan the chance to run.
        yield* Effect.sleep("50 millis");
        expect(listing).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(testLayer(root, claudeSettings(claudeHome, root))), Effect.scoped),
    );
  } finally {
    listing.mockRestore();
  }
});

it("releases the in-memory scan cache only after usage has been idle", async () => {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-idle-summary-"));
  roots.push(root);
  const claudeHome = join(root, "claude");
  const projects = join(claudeHome, "projects");
  await FS.mkdir(projects, { recursive: true });
  await FS.writeFile(join(projects, "a.jsonl"), claudeLine("a"));
  await FS.writeFile(join(projects, "b.jsonl"), claudeLine("b"));
  const shardDirectory = join(usageStateDir(root), "scan-cache");
  // Background fibers (debounced persist, idle release) do real file I/O after a clock jump.
  const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
  /** Drop the persisted shards, so only an in-memory cache can still reuse a file. */
  const dropPersistedShards = Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const names = yield* Effect.promise(() => FS.readdir(shardDirectory).catch(() => []));
      if (names.some((name) => name.endsWith(".json"))) break;
      yield* settle;
    }
    yield* Effect.promise(() => FS.rm(shardDirectory, { recursive: true, force: true }));
  });
  const claudeCoverage = (summary: { readonly sources: ReadonlyArray<{ provider: string }> }) =>
    summary.sources.find((source) => source.provider === "claude");
  let index = 0;
  const appendAndRead = Effect.gen(function* () {
    // A changed listing bypasses the per-source memo, so the scan cache is consulted.
    yield* Effect.promise(() =>
      FS.appendFile(join(projects, "b.jsonl"), claudeLine(`b-${index++}`)),
    );
    return yield* (yield* UsageService).readSummary(summaryRequest);
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* UsageService).readSummary(summaryRequest);
      // Activity within the idle window keeps the cache resident.
      yield* TestClock.adjust(Duration.minutes(9));
      yield* settle;
      yield* dropPersistedShards;
      expect(claudeCoverage(yield* appendAndRead)).toMatchObject({
        parsedFileCount: 1,
        reusedCacheFileCount: 1,
      });
      yield* TestClock.adjust(Duration.minutes(2));
      yield* settle;
      yield* dropPersistedShards;
      expect(claudeCoverage(yield* appendAndRead)).toMatchObject({
        parsedFileCount: 1,
        reusedCacheFileCount: 1,
      });

      // Ten idle minutes later the cache is persisted and released: with the
      // shards gone, every file has to be read again.
      yield* TestClock.adjust(Duration.minutes(11));
      yield* settle;
      yield* dropPersistedShards;
      expect(claudeCoverage(yield* appendAndRead)).toMatchObject({
        parsedFileCount: 2,
        reusedCacheFileCount: 0,
      });
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), testLayer(root, claudeSettings(claudeHome, root))),
      ),
      Effect.scoped,
    ),
  );
});
