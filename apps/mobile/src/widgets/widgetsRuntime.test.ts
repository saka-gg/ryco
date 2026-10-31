import type {
  CliProxyHubSnapshot,
  EnvironmentId,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import { CLI_PROXY_HUB_POLL_INTERVAL_MS, type CliProxyHubRead } from "@ryco/client-runtime/usage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SUBSCRIPTION_USAGE_WIDGET_KIND } from "./subscriptionUsageSnapshot";
import { startWidgetsRuntime, type WidgetsRuntimeDeps } from "./widgetsRuntime";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const ENV = "env-1" as EnvironmentId;
const OTHER = "env-2" as EnvironmentId;

function provider(usedPercent: number, overrides: Record<string, unknown> = {}): ServerProvider {
  return {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(NOW).toISOString(),
    rateLimits: {
      observedAt: new Date(NOW).toISOString(),
      windows: [
        {
          id: "five-hour",
          usedPercent,
          windowDurationMins: 300,
          resetsAt: NOW / 1000 + 7200,
        },
      ],
    },
    ...overrides,
  } as unknown as ServerProvider;
}

function config(providers: readonly ServerProvider[], extra: Record<string, unknown> = {}) {
  return { providers, ...extra } as unknown as ServerConfig;
}

/** A store with a snapshot and listeners, like the app's config store and hub reads. */
function store<V>(initial: ReadonlyMap<EnvironmentId, V>) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next: ReadonlyMap<EnvironmentId, V>) => {
      value = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function harness(initialConfigs: ReadonlyMap<EnvironmentId, ServerConfig>, active = true) {
  const configs = store(initialConfigs);
  const hubs = store<CliProxyHubRead>(new Map());
  const appListeners = new Set<(active: boolean) => void>();
  let isActive = active;
  const native = {
    writeTimeline: vi.fn(async (_kind: string, _json: string) => undefined),
    clear: vi.fn(async (_kind: string) => undefined),
  };
  const read = vi.fn(async (_environmentId: EnvironmentId) => undefined);
  const deps: WidgetsRuntimeDeps = {
    native,
    configs,
    hubs: { ...hubs, read },
    appState: {
      isActive: () => isActive,
      subscribe: (listener) => {
        appListeners.add(listener);
        return () => appListeners.delete(listener);
      },
    },
    url: "ryco-dev://settings/statistics?tab=limits",
    now: () => Date.now(),
    onError: () => undefined,
  };
  const setActive = (next: boolean) => {
    isActive = next;
    for (const listener of appListeners) listener(next);
  };
  return { deps, configs, hubs, native, read, setActive, appListeners };
}

function writtenTimeline(native: { writeTimeline: { mock: { calls: unknown[][] } } }) {
  const call = native.writeTimeline.mock.calls.at(-1)!;
  return { kind: call[0], timeline: JSON.parse(call[1] as string) };
}

describe("the widgets runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the timeline once, and not again for config events that leave the limits alone", async () => {
    const h = harness(new Map([[ENV, config([provider(40)])]]));
    const runtime = startWidgetsRuntime(h.deps);
    await runtime.settled();
    expect(h.native.writeTimeline).toHaveBeenCalledTimes(1);
    const { kind, timeline } = writtenTimeline(h.native);
    expect(kind).toBe(SUBSCRIPTION_USAGE_WIDGET_KIND);
    expect(timeline.v).toBe(1);
    expect(timeline.entries[0].at).toBe(NOW);
    expect(timeline.entries[0].content.providers[0].pooled.rows[0].remaining).toBe(60);

    // A new config object whose settings changed, and a new providers array with the same
    // limits: nothing the widget shows changed.
    vi.setSystemTime(NOW + 1_000);
    h.configs.set(new Map([[ENV, config([provider(40)], { settings: { theme: "dark" } })]]));
    await runtime.settled();
    expect(h.native.writeTimeline).toHaveBeenCalledTimes(1);

    h.configs.set(new Map([[ENV, config([provider(55)])]]));
    await runtime.settled();
    expect(h.native.writeTimeline).toHaveBeenCalledTimes(2);
    expect(
      writtenTimeline(h.native).timeline.entries[0].content.providers[0].pooled.rows[0],
    ).toMatchObject({
      remaining: 45,
    });
    await runtime.stop();
  });

  it("follows the hubs a node reports", async () => {
    const h = harness(new Map([[ENV, config([])]]));
    const runtime = startWidgetsRuntime(h.deps);
    await runtime.settled();
    expect(h.native.writeTimeline).not.toHaveBeenCalled();

    const hub: CliProxyHubSnapshot = {
      hubId: "home" as CliProxyHubSnapshot["hubId"],
      label: "Home",
      url: "https://hub.example.test",
      checkedAt: new Date(NOW).toISOString(),
      status: "ok",
      accounts: [
        {
          authIndex: "a",
          provider: "claude",
          name: "a.json",
          status: "active",
          disabled: false,
          unavailable: false,
          cooldowns: [],
          requests: { success: 0, failed: 0, recent: [] },
          quota: {
            status: "ok",
            checkedAt: new Date(NOW).toISOString(),
            windows: [{ id: "five-hour", usedPercent: 10, windowDurationMins: 300 }],
          },
        },
      ],
      apiKeys: [],
      routedInstanceIds: [],
    };
    h.hubs.set(new Map([[ENV, { status: "ok", hubs: [hub], receivedAtMs: NOW }]]));
    await runtime.settled();
    const { timeline } = writtenTimeline(h.native);
    expect(timeline.entries[0].content.providers[0]).toMatchObject({ name: "Claude" });
    expect(JSON.stringify(timeline)).not.toContain("hub.example.test");
    await runtime.stop();
  });

  it("clears the widget when nothing is left to show, and on sign-out", async () => {
    const h = harness(new Map([[ENV, config([provider(40)])]]));
    const runtime = startWidgetsRuntime(h.deps);
    await runtime.settled();
    h.configs.set(new Map());
    await runtime.settled();
    expect(h.native.clear).toHaveBeenCalledWith(SUBSCRIPTION_USAGE_WIDGET_KIND);

    h.configs.set(new Map([[ENV, config([provider(40)])]]));
    await runtime.settled();
    expect(h.native.writeTimeline).toHaveBeenCalledTimes(2);
    h.native.clear.mockClear();
    await runtime.stop({ clear: true });
    expect(h.native.clear).toHaveBeenCalledTimes(1);
    // Stopped, it follows nothing.
    expect(h.configs.listenerCount()).toBe(0);
    expect(h.appListeners.size).toBe(0);
    h.configs.set(new Map([[ENV, config([provider(90)])]]));
    await runtime.settled();
    expect(h.native.writeTimeline).toHaveBeenCalledTimes(2);
  });

  it("writes again after a write failed", async () => {
    const h = harness(new Map([[ENV, config([provider(40)])]]));
    h.native.writeTimeline.mockRejectedValueOnce(new Error("disk full"));
    const runtime = startWidgetsRuntime(h.deps);
    await runtime.settled();
    h.configs.set(new Map([[ENV, config([provider(40)])]]));
    await runtime.settled();
    expect(h.native.writeTimeline).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it("reads hubs in the foreground, every five minutes there, and for a node that connects", async () => {
    const h = harness(new Map([[ENV, config([])]]));
    const runtime = startWidgetsRuntime(h.deps);
    expect(h.read.mock.calls).toEqual([[ENV]]);

    h.configs.set(
      new Map([
        [ENV, config([])],
        [OTHER, config([])],
      ]),
    );
    expect(h.read.mock.calls).toEqual([[ENV], [OTHER]]);

    vi.advanceTimersByTime(CLI_PROXY_HUB_POLL_INTERVAL_MS);
    expect(h.read).toHaveBeenCalledTimes(4);

    // In the background nothing is read, not even on a timer.
    h.setActive(false);
    vi.advanceTimersByTime(3 * CLI_PROXY_HUB_POLL_INTERVAL_MS);
    h.configs.set(
      new Map([
        [ENV, config([])],
        [OTHER, config([])],
      ]),
    );
    expect(h.read).toHaveBeenCalledTimes(4);

    h.setActive(true);
    expect(h.read).toHaveBeenCalledTimes(6);
    await runtime.stop();
    vi.advanceTimersByTime(CLI_PROXY_HUB_POLL_INTERVAL_MS);
    expect(h.read).toHaveBeenCalledTimes(6);
  });

  it("starts in the background without reading hubs", async () => {
    const h = harness(new Map([[ENV, config([provider(40)])]]), false);
    const runtime = startWidgetsRuntime(h.deps);
    await runtime.settled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.native.writeTimeline).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });
});
