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
} from "@ryco/contracts";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, expect, it } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UsageService, UsageServiceLive } from "./UsageService.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});
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
  await Effect.runPromise(
    program.pipe(
      Effect.provide(
        UsageServiceLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              ServerConfig.layerTest(root, join(root, "state")).pipe(
                Layer.provide(NodeServices.layer),
              ),
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
                  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );
});
