import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  hydrateCachedProviderFromConfig,
  readProviderStatusCache,
  readProviderStatusCacheEntry,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

const makeProvider = (
  provider: ProviderDriverKind,
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(provider),
  driver: provider,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it.layer(NodeServices.layer)("providerStatusCache", (it) => {
  it.effect("writes and reads provider status snapshots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-provider-cache-" });
      const codexProvider = makeProvider(CODEX_DRIVER);
      const claudeProvider = makeProvider(CLAUDE_AGENT_DRIVER, {
        status: "warning",
        auth: { status: "unknown" },
      });
      const openCodeProvider = makeProvider(OPENCODE_DRIVER, {
        status: "warning",
        auth: { status: "unknown", type: "opencode" },
      });
      const codexPath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
      });
      const claudePath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")),
      });
      const openCodePath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("opencode")),
      });

      yield* writeProviderStatusCache({
        filePath: codexPath,
        provider: codexProvider,
      });
      yield* writeProviderStatusCache({
        filePath: claudePath,
        provider: claudeProvider,
      });
      yield* writeProviderStatusCache({
        filePath: openCodePath,
        provider: openCodeProvider,
      });

      assert.deepStrictEqual(yield* readProviderStatusCache(codexPath), codexProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(claudePath), claudeProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(openCodePath), openCodeProvider);
    }),
  );

  it.effect("round-trips probe freshness and reads legacy files without it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-provider-cache-" });
      const filePath = yield* resolveProviderStatusCachePath({
        cacheDir: tempDir,
        instanceId: defaultInstanceIdForDriver(CODEX_DRIVER),
      });
      const provider = makeProvider(CODEX_DRIVER);
      const probeFreshness = { fingerprint: "fp-1", checkedAt: "2026-04-11T00:00:00.000Z" };

      yield* writeProviderStatusCache({ filePath, provider, probeFreshness });
      assert.deepStrictEqual(yield* readProviderStatusCacheEntry(filePath), {
        provider,
        probeFreshness,
      });
      assert.deepStrictEqual(yield* readProviderStatusCache(filePath), provider);

      yield* writeProviderStatusCache({ filePath, provider });
      assert.deepStrictEqual(yield* readProviderStatusCacheEntry(filePath), {
        provider,
        probeFreshness: undefined,
      });
    }),
  );

  it("seeds a configured instance from its cached snapshot with current presentation", () => {
    const cachedCodex = makeProvider(CODEX_DRIVER, {
      displayName: "Old name",
      accentColor: "#000000",
      message: "Cached message",
      updateState: {
        status: "running",
        startedAt: "2026-04-10T12:00:00.000Z",
        finishedAt: null,
        message: null,
        output: null,
      },
      models: [
        {
          slug: "gpt-5-mini",
          name: "GPT-5 Mini",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
    });
    const { updateState: _updateState, accentColor: _accentColor, ...expected } = cachedCodex;

    assert.deepStrictEqual(
      hydrateCachedProviderFromConfig({
        cachedProvider: cachedCodex,
        identity: {
          instanceId: cachedCodex.instanceId,
          driverKind: CODEX_DRIVER,
          displayName: "Work Codex",
          accentColor: undefined,
          enabled: true,
        },
      }),
      { ...expected, displayName: "Work Codex" },
    );
  });

  it("does not seed cached snapshots whose identity or enabled state no longer matches", () => {
    const identity = {
      instanceId: defaultInstanceIdForDriver(CODEX_DRIVER),
      driverKind: CODEX_DRIVER,
      displayName: undefined,
      accentColor: undefined,
      enabled: true,
    };
    const legacyCachedCodex = {
      provider: CODEX_DRIVER,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    } as unknown as ServerProvider;

    for (const cachedProvider of [
      legacyCachedCodex,
      makeProvider(CODEX_DRIVER, { instanceId: ProviderInstanceId.make("codex_personal") }),
      makeProvider(CLAUDE_AGENT_DRIVER, { instanceId: identity.instanceId }),
      makeProvider(CODEX_DRIVER, { enabled: false, status: "disabled" }),
    ]) {
      assert.strictEqual(hydrateCachedProviderFromConfig({ cachedProvider, identity }), undefined);
    }
  });
});
