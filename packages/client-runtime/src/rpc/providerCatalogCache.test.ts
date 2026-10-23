import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerConfigStreamSnapshotEvent,
  type ServerProvider,
} from "@ryco/contracts";
import { NODE_DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/shared/keybindings";
import { Stream } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./wsTransport.ts", () => ({
  WsTransport: class WsTransport {
    readonly mocked = true;
  },
}));

import {
  createProviderCatalogCache,
  PROVIDER_CATALOG_LOAD_MAX_WAIT_MS,
  providerCatalogCache,
  restoreSnapshotCatalogs,
  type ProviderCatalog,
  type ProviderCatalogStore,
} from "./providerCatalogCache.ts";
import { createWsRpcClient } from "./wsRpcClient.ts";
import type { WsTransport } from "./wsTransport.ts";

const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
const catalog = (slug: string): ProviderCatalog => ({
  models: [model(slug)],
  skills: [],
  slashCommands: [],
});
const provider = (instanceId: string, slug: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-12T00:00:00.000Z",
  ...catalog(slug),
});
const emptied = (entry: ServerProvider): ServerProvider => ({
  ...entry,
  models: [],
  skills: [],
  slashCommands: [],
});
const config = (providers: ReadonlyArray<ServerProvider>): ServerConfig => ({
  environment: {
    environmentId: EnvironmentId.make("environment-local"),
    label: "Local",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
      threadSettlement: false,
      threadPriorityRanking: false,
    },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "ryco_session",
  },
  cwd: "/repo",
  keybindingsConfigPath: "/repo/keybindings.json",
  keybindings: NODE_DEFAULT_RESOLVED_KEYBINDINGS,
  issues: [],
  providers,
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/repo/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
});
const snapshotEvent = (
  providers: ReadonlyArray<ServerProvider>,
  providerCatalogs?: ServerConfigStreamSnapshotEvent["providerCatalogs"],
): ServerConfigStreamSnapshotEvent => ({
  version: 1,
  type: "snapshot",
  config: config(providers),
  ...(providerCatalogs === undefined ? {} : { providerCatalogs }),
});

describe("provider catalog cache", () => {
  it("keeps the newest entries within its bound", () => {
    const cache = createProviderCatalogCache(2);
    cache.put("a", catalog("a"));
    cache.put("b", catalog("b"));
    cache.put("a", catalog("a"));
    cache.put("c", catalog("c"));
    expect([...cache.pin().keys()]).toEqual(["a", "c"]);
  });

  it("loads persisted entries under what the page already holds, and saves new ones", async () => {
    const saved: Array<ReadonlyArray<readonly [string, ProviderCatalog]>> = [];
    const store: ProviderCatalogStore = {
      load: async () => [
        ["old", catalog("old")],
        ["bad", { models: "nope" } as never],
      ],
      save: async (entries) => {
        saved.push(entries);
      },
    };
    const cache = createProviderCatalogCache();
    cache.put("live", catalog("live"));
    await cache.attachStore(store);
    expect([...cache.pin().keys()]).toEqual(["old", "live"]);
    cache.put("new", catalog("new"));
    await Promise.resolve();
    expect(saved.at(-1)?.map(([digest]) => digest)).toEqual(["old", "live", "new"]);
  });

  it("reports a pending load until every declared load has settled, rejected or not", async () => {
    const cache = createProviderCatalogCache();
    expect(cache.loaded()).toBeNull();

    let finishFirst!: () => void;
    let failSecond!: (error: Error) => void;
    cache.expectLoad(
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
    );
    cache.expectLoad(
      new Promise<void>((_resolve, reject) => {
        failSecond = reject;
      }),
    );
    const pending = cache.loaded();
    expect(pending).not.toBeNull();
    let settled = false;
    void pending?.then(() => {
      settled = true;
    });

    finishFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    failSecond(new Error("indexeddb unavailable"));
    await pending;
    expect(settled).toBe(true);
    await Promise.resolve();
    expect(cache.loaded()).toBeNull();
  });

  it("stops waiting for a load that never settles once its wait runs out", async () => {
    vi.useFakeTimers();
    try {
      const cache = createProviderCatalogCache();
      cache.expectLoad(new Promise<void>(() => undefined));
      let settled = false;
      void cache.loaded()?.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(PROVIDER_CATALOG_LOAD_MAX_WAIT_MS - 1);
      expect(settled).toBe(false);
      expect(cache.loaded()).not.toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(cache.loaded()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("restoreSnapshotCatalogs", () => {
  it("passes a snapshot without catalog bookkeeping through (an older server)", () => {
    const event = snapshotEvent([provider("codex", "a")]);
    expect(restoreSnapshotCatalogs(event, new Map(), createProviderCatalogCache())).toBe(event);
  });

  it("restores left-out catalogs from what the subscription claimed and keeps sent ones", () => {
    const cache = createProviderCatalogCache();
    const event = snapshotEvent([emptied(provider("codex", "a")), provider("claude", "b")], {
      digests: { codex: "digest-a", claude: "digest-b" } as never,
      omitted: [ProviderInstanceId.make("codex")],
    });
    const restored = restoreSnapshotCatalogs(event, new Map([["digest-a", catalog("a")]]), cache);
    expect(restored?.config.providers).toEqual([provider("codex", "a"), provider("claude", "b")]);
    expect(restored && "providerCatalogs" in restored).toBe(false);
    expect([...cache.pin().keys()].toSorted()).toEqual(["digest-a", "digest-b"]);
  });

  it("refuses a snapshot that left out a catalog the subscription never claimed", () => {
    const event = snapshotEvent([emptied(provider("codex", "a"))], {
      digests: { codex: "digest-a" } as never,
      omitted: [ProviderInstanceId.make("codex")],
    });
    expect(restoreSnapshotCatalogs(event, new Map(), createProviderCatalogCache())).toBeNull();
  });
});

describe("wsRpcClient config subscription", () => {
  type Connect = (client: unknown) => Stream.Stream<ServerConfigStreamEvent>;
  const makeHarness = () => {
    const attempts: Array<{
      readonly connect: Connect;
      readonly listener: (event: ServerConfigStreamEvent) => void;
      readonly unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const transport = {
      subscribe: vi.fn((connect: Connect, listener: (event: ServerConfigStreamEvent) => void) => {
        const unsubscribe = vi.fn();
        attempts.push({ connect, listener, unsubscribe });
        return unsubscribe;
      }),
    };
    const inputOf = (index: number) => {
      const wire = vi.fn((_input: unknown) => Stream.empty);
      attempts[index]!.connect({ [WS_METHODS.subscribeServerConfig]: wire });
      return wire.mock.calls[0]?.[0];
    };
    return {
      client: createWsRpcClient(transport as unknown as WsTransport),
      attempts,
      inputOf,
    };
  };

  it("names the catalogs the page holds, asks for deltas, and delivers restored snapshots", () => {
    providerCatalogCache.clear();
    providerCatalogCache.put("digest-a", catalog("a"));
    const harness = makeHarness();
    const listener = vi.fn();
    harness.client.server.subscribeConfig(listener);
    expect(harness.inputOf(0)).toEqual({
      providerStatuses: "delta",
      knownProviderCatalogs: ["digest-a"],
    });

    harness.attempts[0]!.listener(
      snapshotEvent([emptied(provider("codex", "a"))], {
        digests: { codex: "digest-a" } as never,
        omitted: [ProviderInstanceId.make("codex")],
      }),
    );
    expect(listener.mock.calls[0]?.[0].config.providers).toEqual([provider("codex", "a")]);
    providerCatalogCache.clear();
  });

  it("names nothing on a page that holds no catalogs (and an old server's snapshot passes)", () => {
    providerCatalogCache.clear();
    const harness = makeHarness();
    const listener = vi.fn();
    harness.client.server.subscribeConfig(listener);
    expect(harness.inputOf(0)).toEqual({ providerStatuses: "delta" });
    const legacy = snapshotEvent([provider("codex", "a")]);
    harness.attempts[0]!.listener(legacy);
    expect(listener).toHaveBeenCalledWith(legacy);
  });

  it("opens the subscription only once the page's persisted catalogs have loaded", async () => {
    providerCatalogCache.clear();
    let attachCatalogs!: () => void;
    providerCatalogCache.expectLoad(
      new Promise<void>((resolve) => {
        attachCatalogs = resolve;
      }),
    );
    const harness = makeHarness();
    harness.client.server.subscribeConfig(vi.fn());
    await Promise.resolve();
    expect(harness.attempts).toHaveLength(0);

    providerCatalogCache.put("digest-a", catalog("a"));
    attachCatalogs();
    await providerCatalogCache.loaded();
    await Promise.resolve();
    expect(harness.attempts).toHaveLength(1);
    expect(harness.inputOf(0)).toEqual({
      providerStatuses: "delta",
      knownProviderCatalogs: ["digest-a"],
    });
    providerCatalogCache.clear();
  });

  it("opens the subscription without catalogs when the load never settles", async () => {
    providerCatalogCache.clear();
    vi.useFakeTimers();
    try {
      providerCatalogCache.expectLoad(new Promise<void>(() => undefined));
      const harness = makeHarness();
      harness.client.server.subscribeConfig(vi.fn());
      await vi.advanceTimersByTimeAsync(PROVIDER_CATALOG_LOAD_MAX_WAIT_MS - 1);
      expect(harness.attempts).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(harness.attempts).toHaveLength(1);
      expect(harness.inputOf(0)).toEqual({ providerStatuses: "delta" });

      // Later subscriptions are not held up by the same load either.
      harness.client.server.subscribeConfig(vi.fn());
      expect(harness.attempts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never opens a subscription that is disposed while catalogs are still loading", async () => {
    let attachCatalogs!: () => void;
    providerCatalogCache.expectLoad(
      new Promise<void>((resolve) => {
        attachCatalogs = resolve;
      }),
    );
    const harness = makeHarness();
    const stop = harness.client.server.subscribeConfig(vi.fn());
    stop();
    attachCatalogs();
    await providerCatalogCache.loaded();
    await Promise.resolve();
    expect(harness.attempts).toHaveLength(0);
  });

  it("starts over without naming catalogs when a snapshot cannot be completed", async () => {
    providerCatalogCache.clear();
    const harness = makeHarness();
    const listener = vi.fn();
    harness.client.server.subscribeConfig(listener);
    harness.inputOf(0);
    harness.attempts[0]!.listener(
      snapshotEvent([emptied(provider("codex", "a"))], {
        digests: { codex: "digest-unknown" } as never,
        omitted: [ProviderInstanceId.make("codex")],
      }),
    );
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(harness.attempts[0]!.unsubscribe).toHaveBeenCalled();
    expect(harness.attempts).toHaveLength(2);
    providerCatalogCache.put("digest-a", catalog("a"));
    expect(harness.inputOf(1)).toEqual({ providerStatuses: "delta" });
    providerCatalogCache.clear();
  });
});
