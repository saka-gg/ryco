import type {
  CliProxyAccount,
  CliProxyHubSnapshot,
  CliProxyQuotaWindow,
  EnvironmentId,
  ServerProvider,
} from "@ryco/contracts";
import type { SubscriptionLimitsEnvironment } from "@ryco/client-runtime/usage";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSubscriptionUsageSnapshot,
  buildSubscriptionUsageTimeline,
  OPEN_RYCO_TO_REFRESH,
  SUBSCRIPTION_USAGE_MAX_AGE_MS,
} from "./subscriptionUsageSnapshot";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const NOW_SECONDS = NOW / 1000;
const URL = "ryco-dev://settings/statistics?tab=limits";
const HUB_URL = "https://hub.private.example.test:8317";
const EMAIL = ["alice", "example.com"].join("@");

const session = (usedPercent: number, resetsInMinutes = 120): CliProxyQuotaWindow => ({
  id: "five-hour",
  usedPercent,
  windowDurationMins: 300,
  resetsAt: NOW_SECONDS + resetsInMinutes * 60,
});
const weekly = (usedPercent: number, scope?: string): CliProxyQuotaWindow => ({
  id: scope ? `weekly-${scope}` : "weekly",
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: NOW_SECONDS + 3 * 24 * 3600,
  ...(scope ? { scope } : {}),
});

function account(
  authIndex: string,
  windows: readonly CliProxyQuotaWindow[],
  overrides: Partial<CliProxyAccount> = {},
): CliProxyAccount {
  return {
    authIndex,
    provider: "claude",
    name: `${authIndex}.json`,
    status: "active",
    disabled: false,
    unavailable: false,
    cooldowns: [],
    requests: { success: 0, failed: 0, recent: [] },
    quota: {
      status: "ok",
      planType: "max",
      checkedAt: new Date(NOW).toISOString(),
      windows,
    },
    ...overrides,
  };
}

function hub(accounts: readonly CliProxyAccount[]): CliProxyHubSnapshot {
  return {
    hubId: "home" as CliProxyHubSnapshot["hubId"],
    label: "Home hub",
    url: HUB_URL,
    checkedAt: new Date(NOW).toISOString(),
    status: "ok",
    accounts,
    apiKeys: [],
    routedInstanceIds: [],
  };
}

function directProvider(
  windows: readonly CliProxyQuotaWindow[],
  overrides: Record<string, unknown> = {},
): ServerProvider {
  return {
    instanceId: "codex-work",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    status: "ready",
    auth: { status: "authenticated", email: EMAIL },
    checkedAt: new Date(NOW).toISOString(),
    rateLimits: { planType: "pro", observedAt: new Date(NOW).toISOString(), windows },
    ...overrides,
  } as unknown as ServerProvider;
}

function environment(
  providers: readonly ServerProvider[],
  hubs: readonly CliProxyHubSnapshot[] = [],
): SubscriptionLimitsEnvironment {
  return {
    environmentId: "env-1" as EnvironmentId,
    label: "Studio Mac",
    connected: true,
    providers,
    hubs,
  };
}

describe("the subscription usage snapshot", () => {
  it("pools a hub's accounts and lists them one by one, Claude first", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      [
        environment(
          [directProvider([session(30), weekly(10)])],
          [hub([account("a", [session(20), weekly(50)]), account("b", [session(60), weekly(70)])])],
        ),
      ],
      URL,
    );
    expect(snapshot.url).toBe(URL);
    expect(snapshot.providers.map((provider) => provider.name)).toEqual(["Claude", "Codex"]);
    const [claude, codex] = snapshot.providers;
    expect(claude!.pooled).toEqual({
      detail: "2 accounts · pooled",
      rows: [
        { label: "Weekly", kind: "weekly", remaining: 40, resetsAt: NOW + 3 * 24 * 3600_000 },
        { label: "5h", kind: "session", remaining: 60, resetsAt: NOW + 120 * 60_000 },
      ],
      total: 2,
    });
    expect(claude!.accounts.detail).toBe("2 accounts");
    expect(claude!.accounts.rows.map((row) => [row.account, row.label, row.remaining])).toEqual([
      ["b.json", "Weekly", 30],
      ["b.json", "5h", 40],
      ["a.json", "Weekly", 50],
      ["a.json", "5h", 80],
    ]);
    // A direct account is never averaged; on its own it is named by its plan.
    expect(codex!.pooled).toMatchObject({
      detail: "Pro",
      rows: [
        { label: "Weekly", remaining: 90 },
        { label: "5h", remaining: 70 },
      ].toSorted((left, right) => left.remaining - right.remaining),
    });
    expect(codex!.pooled.rows.every((row) => row.account === undefined)).toBe(true);
  });

  it("keeps direct accounts out of the hub pool, as accounts of their own", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      [
        environment(
          [
            directProvider([session(10)], {
              instanceId: "claude",
              driver: "claudeAgent",
              displayName: "Claude Work",
            }),
          ],
          [hub([account("a", [session(20)]), account("b", [session(40)])])],
        ),
      ],
      URL,
    );
    const claude = snapshot.providers[0]!;
    expect(claude.pooled.detail).toBe("2 pooled · 1 direct");
    expect(claude.pooled.rows.map((row) => [row.account, row.remaining])).toEqual([
      ["Pooled", 70],
      ["Claude Work", 90],
    ]);
  });

  it("names an account by its email nowhere: an email-named one is Account N", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      [
        environment(
          [directProvider([session(30)], { displayName: `Codex (${EMAIL})` })],
          [
            hub([
              account("a", [session(20)], { name: "alpha.json", label: "Alpha" }),
              account("b", [session(40)], { name: `claude-${EMAIL}.json`, email: EMAIL }),
            ]),
          ],
        ),
      ],
      URL,
    );
    const claude = snapshot.providers[0]!;
    // Numbered in the Limits tab's order, where the email-named account comes first.
    expect(claude.accounts.rows.map((row) => row.account)).toEqual(["Account 1", "Alpha"]);
    // The direct Codex account named by its email falls back to its plan.
    expect(snapshot.providers[1]!.pooled.detail).toBe("Pro");
    const json = JSON.stringify(buildSubscriptionUsageTimeline(snapshot, NOW));
    expect(json).not.toContain("@");
    expect(json).not.toContain("hub.private.example.test");
    expect(json).not.toContain("Home hub");
    expect(json).not.toContain("codex-work");
    expect(json).not.toContain("env-1");
    expect(json).not.toContain("Studio Mac");
  });

  it("keeps the tightest session and weekly window past six windows", () => {
    const monthly = ["Opus", "Sonnet", "Haiku", "Fable", "Design", "Research"].map(
      (scope, index): CliProxyQuotaWindow => ({
        id: `monthly-${scope}`,
        scope,
        usedPercent: 80 - index,
        windowDurationMins: 30 * 24 * 60,
      }),
    );
    const snapshot = buildSubscriptionUsageSnapshot(
      [environment([], [hub([account("a", [session(5), weekly(10), ...monthly])])])],
      URL,
    );
    const pooled = snapshot.providers[0]!.pooled;
    expect(pooled.total).toBe(8);
    expect(pooled.rows.map((row) => [row.label, row.kind, row.remaining])).toEqual([
      ["Monthly · Opus", "other", 20],
      ["Monthly · Sonnet", "other", 21],
      ["Monthly · Haiku", "other", 22],
      ["Monthly · Fable", "other", 23],
      ["Weekly", "weekly", 90],
      ["5h", "session", 95],
    ]);
  });

  it("files a scoped weekly window as weekly", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      [environment([], [hub([account("a", [weekly(30, "Opus")])])])],
      URL,
    );
    expect(snapshot.providers[0]!.pooled.rows).toEqual([
      expect.objectContaining({ label: "Weekly · Opus", kind: "weekly", remaining: 70 }),
    ]);
  });

  it("expires at a reset that comes before the snapshot's own fifteen minutes", () => {
    const soon = buildSubscriptionUsageSnapshot(
      [environment([], [hub([account("a", [session(20, 5)])])])],
      URL,
    );
    expect(soon.providers[0]!.expiresAt).toBe(NOW + 5 * 60_000);
    const later = buildSubscriptionUsageSnapshot(
      [environment([], [hub([account("a", [session(20, 300)])])])],
      URL,
    );
    expect(later.providers[0]!.expiresAt).toBe(NOW + SUBSCRIPTION_USAGE_MAX_AGE_MS);
  });

  it("leaves out accounts with nothing to show and providers without limits", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      [
        environment(
          [directProvider([], { rateLimits: undefined })],
          [
            hub([
              account("off", [session(20)], { disabled: true }),
              account("failed", [], {
                quota: { status: "failed", windows: [], message: "Upstream said no" },
              }),
            ]),
          ],
        ),
      ],
      URL,
    );
    expect(snapshot.providers).toEqual([]);
  });
});

describe("the subscription usage timeline", () => {
  const snapshot = buildSubscriptionUsageSnapshot(
    [
      environment(
        [directProvider([session(30, 600)])],
        [hub([account("a", [session(20, 5)]), account("b", [session(40, 5)])])],
      ),
    ],
    URL,
  );

  it("starts now and changes at each deadline, where an expired provider asks to open Ryco", () => {
    const timeline = buildSubscriptionUsageTimeline(snapshot, NOW);
    expect(timeline.map((entry) => entry.at)).toEqual([
      NOW,
      NOW + 5 * 60_000,
      NOW + SUBSCRIPTION_USAGE_MAX_AGE_MS,
    ]);
    const [first, second, last] = timeline.map((entry) => entry.content);
    expect(first!.providers.map((provider) => provider.fresh)).toEqual([true, true]);
    expect(first!.observedAt).toBe(NOW);
    expect(second!.providers[0]).toMatchObject({
      name: "Claude",
      fresh: false,
      pooled: { detail: OPEN_RYCO_TO_REFRESH, rows: [] },
      accounts: { detail: OPEN_RYCO_TO_REFRESH, rows: [] },
    });
    expect(second!.providers[1]!.fresh).toBe(true);
    expect(last!.providers.every((provider) => !provider.fresh)).toBe(true);
    expect(last!.observedAt).toBe(0);
  });

  it("shows a snapshot read too long ago as expired from the start", () => {
    const timeline = buildSubscriptionUsageTimeline(snapshot, NOW + 60 * 60_000);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.content.providers.every((provider) => !provider.fresh)).toBe(true);
  });
});
