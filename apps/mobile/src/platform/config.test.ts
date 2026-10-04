import type {
  EnvironmentConnection,
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// `extra` is per-test data here, so the expo-constants stub reads a mutable
// holder instead of a frozen literal (platform.test.ts pins `extra` to `{}`).
const constantsHolder = vi.hoisted(() => ({
  extra: {} as Record<string, unknown>,
  version: undefined as unknown,
  platform: { ios: {} } as { ios?: object },
}));
vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return { extra: constantsHolder.extra, version: constantsHolder.version };
    },
    get platform() {
      return constantsHolder.platform;
    },
  },
}));

// Native modules stubbed so the two-plane guard can load the direct plane's
// driver and threads runtime under the Node test runner.
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));

import {
  createMobileEnvironmentDriver,
  type MobileCatalogLike,
} from "../connection/environmentDriver";
import {
  getMobileClientRuntimeConfig,
  resetMobileRuntimeConfigForTests,
} from "../connection/runtimeConfig";
import { getThreadsRuntimeConfiguration } from "../state/threadsRuntime";
import {
  readMobileAppVersion,
  readMobileClientRuntimeConfig,
  readMobileHostedConfig,
  readMobileNativePlatform,
} from "./config";

const NODE = { httpBaseUrl: "http://node.local:44342", wsBaseUrl: "ws://node.local:44342" };

function setExtra(extra: Record<string, unknown>): void {
  constantsHolder.extra = { node: NODE, ...extra };
  resetMobileRuntimeConfigForTests();
}

/** A hosted block as `app.config.ts` emits it, with per-test overrides. */
function hostedExtra(
  overrides: Record<string, unknown> = {},
  appVariant = "production",
): Record<string, unknown> {
  return {
    appVariant,
    hosted: {
      hubBaseUrl: "https://hub.example.test",
      appUrl: "https://app.example.test",
      relyingParty: "app.example.test",
      ...overrides,
    },
  };
}

beforeEach(() => {
  setExtra({});
  constantsHolder.version = undefined;
  constantsHolder.platform = { ios: {} };
});

describe("native enrollment metadata", () => {
  it("bounds the app version and identifies the native platform", () => {
    constantsHolder.version = `  ${"v".repeat(80)}  `;
    expect(readMobileAppVersion()).toBe("v".repeat(64));
    expect(readMobileNativePlatform()).toBe("ios");
    constantsHolder.platform = {};
    expect(readMobileNativePlatform()).toBe("android");
  });
});

describe("mobile hosted config", () => {
  it("stays in direct-node mode when no hosted block is configured", () => {
    setExtra({ appVariant: "production" });

    expect(readMobileHostedConfig()).toBeNull();
    expect(readMobileClientRuntimeConfig()).toEqual({
      clientMode: "standard",
      httpBaseUrl: NODE.httpBaseUrl,
      wsBaseUrl: NODE.wsBaseUrl,
    });
  });

  it("derives hosted mode from a valid hosted block without touching the direct node origin", () => {
    setExtra(hostedExtra());

    expect(readMobileHostedConfig()).toEqual({
      hubOrigin: "https://hub.example.test",
      appUrl: "https://app.example.test/",
      relyingParty: "app.example.test",
    });
    const config = readMobileClientRuntimeConfig();
    expect(config.clientMode).toBe("hosted-hub");
    expect(config.hostedAppUrl).toBe("https://app.example.test/");
    // The hosted origin is a different server from the direct node default.
    expect(config.httpBaseUrl).toBe(NODE.httpBaseUrl);
    expect(config.wsBaseUrl).toBe(NODE.wsBaseUrl);
  });

  it("normalizes an origin with a trailing slash and keeps an explicit port", () => {
    setExtra(hostedExtra({ hubBaseUrl: "https://hub.example.test:8443/" }));

    expect(readMobileHostedConfig()?.hubOrigin).toBe("https://hub.example.test:8443");
  });

  it("fails closed on every unusable hub base url", () => {
    const rejected: ReadonlyArray<readonly [string, unknown]> = [
      ["absent", undefined],
      ["null", null],
      ["non-string", 42],
      ["empty", ""],
      ["whitespace", "   "],
      ["relative", "/api"],
      ["unparseable", "not a url"],
      ["insecure in production", "http://hub.example.test"],
      ["non-http scheme", "ryco://hub.example.test"],
      ["path-bearing", "https://hub.example.test/api"],
      ["query-bearing", "https://hub.example.test/?a=1"],
      ["fragment-bearing", "https://hub.example.test/#x"],
      ["credential-bearing", "https://user:pass@hub.example.test"],
    ];

    for (const [label, hubBaseUrl] of rejected) {
      setExtra(hostedExtra({ hubBaseUrl }));
      expect(readMobileHostedConfig(), label).toBeNull();
      const config = readMobileClientRuntimeConfig();
      expect(config.clientMode, label).toBe("standard");
      expect(config.hostedAppUrl, label).toBeUndefined();
      // The direct plane is unaffected by a rejected hosted block.
      expect(config.httpBaseUrl, label).toBe(NODE.httpBaseUrl);
      expect(config.wsBaseUrl, label).toBe(NODE.wsBaseUrl);
    }
  });

  it("rejects a non-object or relying-party-less hosted block", () => {
    setExtra({ appVariant: "production", hosted: "https://hub.example.test" });
    expect(readMobileHostedConfig()).toBeNull();

    setExtra(hostedExtra({ relyingParty: undefined }));
    expect(readMobileHostedConfig()).toBeNull();

    setExtra(hostedExtra({ relyingParty: 7 }));
    expect(readMobileHostedConfig()).toBeNull();
    expect(readMobileClientRuntimeConfig().clientMode).toBe("standard");
  });

  it("allows an http hub only for a development build", () => {
    setExtra(hostedExtra({ hubBaseUrl: "http://192.168.1.10:8080" }, "development"));
    expect(readMobileHostedConfig()?.hubOrigin).toBe("http://192.168.1.10:8080");
    expect(readMobileClientRuntimeConfig().clientMode).toBe("hosted-hub");

    setExtra(hostedExtra({ hubBaseUrl: "http://192.168.1.10:8080" }, "preview"));
    expect(readMobileHostedConfig()).toBeNull();

    // An absent/unknown variant is treated as production.
    setExtra({ hosted: hostedExtra({ hubBaseUrl: "http://192.168.1.10:8080" }).hosted });
    expect(readMobileHostedConfig()).toBeNull();
  });

  it("keeps hosted mode when only the fallback app url is unusable", () => {
    for (const appUrl of [
      undefined,
      null,
      "",
      "  ",
      12,
      "app.example.test",
      "http://app.example.test",
      "https://app.example.test/?token=leak",
      "https://app.example.test/#token=leak",
      "https://user:pass@app.example.test",
    ]) {
      setExtra(hostedExtra({ appUrl }));
      const hosted = readMobileHostedConfig();
      expect(hosted?.hubOrigin, String(appUrl)).toBe("https://hub.example.test");
      expect(hosted?.appUrl, String(appUrl)).toBeNull();
      expect(readMobileClientRuntimeConfig().hostedAppUrl, String(appUrl)).toBeUndefined();
    }

    // A path-bearing app url is fine: the hosted web app need not sit at the root.
    setExtra(hostedExtra({ appUrl: "https://app.example.test/hub" }));
    expect(readMobileHostedConfig()?.appUrl).toBe("https://app.example.test/hub");
  });
});

const ENV_ID = "env-1" as EnvironmentId;

/** The minimum catalog surface the driver needs, with observable seams. */
function createGuardCatalog() {
  const registryListeners = new Set<() => void>();
  const subscribeRegistry = vi.fn((listener: () => void) => {
    registryListeners.add(listener);
    return () => registryListeners.delete(listener);
  });
  const waitForHydration = vi.fn(async () => {});
  const catalog: MobileCatalogLike = {
    registryStore: { subscribe: subscribeRegistry, getState: () => ({ markConnected: () => {} }) },
    runtimeStore: {
      getState: () => ({
        byId: {},
        ensure: () => {},
        patch: (_id: EnvironmentId, _patch: Partial<SavedEnvironmentRuntimeState>) => {},
      }),
    },
    hasHydrated: () => true,
    waitForHydration,
    list: () => [],
    get: () => null,
    readBearerToken: async () => null,
    writeBearerToken: async () => false,
  };
  return { catalog, subscribeRegistry, waitForHydration };
}

describe("two-plane isolation guard", () => {
  // Load-bearing: createEnvironmentConnectionSupervisor reads isHostedMode() at
  // start() and, when true, disables saved-environment registry syncing and
  // resume-driven reconnect (client-runtime connection/supervision.ts). The
  // direct plane must keep both seams no matter what clientMode says.
  it("keeps the direct plane out of hosted mode even when the client mode is hosted-hub", async () => {
    setExtra(hostedExtra());
    expect(getMobileClientRuntimeConfig().clientMode).toBe("hosted-hub");

    const { catalog, subscribeRegistry, waitForHydration } = createGuardCatalog();
    const subscribeResume = vi.fn(() => () => {});
    const driver = createMobileEnvironmentDriver({
      catalog,
      remoteApi: {
        fetchRemoteSessionState: async () => {
          throw new Error("The guard never reaches a real connect.");
        },
        resolveRemoteWebSocketConnectionUrl: async () => "ws://node.local/?wsToken=t",
        rotateRemoteBearerSession: async () => {
          throw new Error("The guard never reaches a real connect.");
        },
      },
      subscribeResume,
      connectSavedEnvironment: async (record: SavedEnvironmentRecord) =>
        ({ environmentId: record.environmentId }) as unknown as EnvironmentConnection,
    });

    const stop = driver.start();
    try {
      // Each of these three seams is skipped when isHostedMode() returns true.
      expect(subscribeRegistry).toHaveBeenCalledTimes(1);
      expect(subscribeResume).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(waitForHydration).toHaveBeenCalled());
      // A registry change still reaches the direct plane's sync.
      expect(driver.supervisor.read(ENV_ID)).toBeNull();
    } finally {
      stop();
    }

    // The threads runtime stays on the direct plane's hosted-hub-free path.
    expect(getThreadsRuntimeConfiguration().isHostedHubMode()).toBe(false);
  });
});
