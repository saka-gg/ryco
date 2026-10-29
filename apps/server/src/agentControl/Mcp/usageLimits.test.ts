import {
  AGENT_CONTROL_MCP_USAGE_LIMITS_MAX,
  AgentControlMcpUsageLimitsResult,
  ProviderInstanceId,
  ServerProvider,
} from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { CliProxyCachedHub } from "../../cliProxy/CliProxyService.ts";
import { USAGE_LIMITS_NOTES, agentControlUsageLimits } from "./usageLimits.ts";

const OBSERVED = "2026-10-29T10:00:00.000Z";
const OBSERVED_MS = Date.parse(OBSERVED);
const NOW_MS = OBSERVED_MS + 60 * 60_000;
const HOUR_S = 60 * 60;
const atSeconds = (offsetSeconds: number) => OBSERVED_MS / 1000 + offsetSeconds;

const provider = (input: Record<string, unknown>) =>
  Schema.decodeUnknownSync(ServerProvider)({
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-29T09:00:00.000Z",
    models: [],
    ...input,
  });

const read = (
  providers: ReadonlyArray<ServerProvider>,
  options?: { readonly instanceId?: string; readonly hubs?: ReadonlyArray<CliProxyCachedHub> },
) => {
  const result = agentControlUsageLimits({
    providers,
    hubs: options?.hubs ?? [],
    instanceId:
      options?.instanceId === undefined ? undefined : ProviderInstanceId.make(options.instanceId),
    nowMs: NOW_MS,
    max: AGENT_CONTROL_MCP_USAGE_LIMITS_MAX,
  });
  // Every answer must fit the wire contract.
  Schema.encodeSync(AgentControlMcpUsageLimitsResult)(result);
  return result;
};

const codex = provider({
  instanceId: "codex",
  displayName: "Codex work",
  auth: {
    status: "authenticated",
    email: "person@example.com",
    label: "ChatGPT Pro",
    type: "chatgpt",
  },
  rateLimits: {
    limitId: "limit-account-123",
    limitName: "Pro plan for person@example.com",
    planType: "pro",
    credits: { hasCredits: true, unlimited: false, balance: "42.00" },
    observedAt: OBSERVED,
    windows: [
      // 5h, 2 h in at the read (40 % expected), 70 % used: 30 points above even.
      {
        id: "primary",
        usedPercent: 70,
        resetsAt: atSeconds(3 * HOUR_S),
        windowDurationMins: 300,
      },
      // Weekly, 3 of 7 days in (about 43 % expected), 10 % used: 33 points below even.
      {
        id: "secondary",
        usedPercent: 10,
        resetsAt: atSeconds(4 * 24 * HOUR_S),
        windowDurationMins: 7 * 24 * 60,
      },
      // A model-scoped weekly window on even pace.
      {
        id: "opus",
        scope: "Opus",
        usedPercent: 43,
        resetsAt: atSeconds(4 * 24 * HOUR_S),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
  },
});

const HUB_LISTED = "2026-10-29T10:05:00.000Z";

/** A hub as `CliProxyService.cachedQuotas` hands it over after a read. */
const hub = (overrides: Partial<CliProxyCachedHub> = {}): CliProxyCachedHub => ({
  label: "hub.example:8317",
  routedInstanceIds: [ProviderInstanceId.make("claude-hub")],
  failed: false,
  listed: {
    fetchedAtMs: Date.parse(HUB_LISTED),
    accounts: [
      {
        provider: "claude",
        disabled: false,
        quota: {
          status: "ok",
          checkedAt: OBSERVED,
          planType: "max",
          windows: [
            {
              id: "five_hour",
              usedPercent: 70,
              resetsAt: atSeconds(3 * HOUR_S),
              windowDurationMins: 300,
            },
            {
              id: "seven_day_opus",
              scope: "Opus",
              usedPercent: 43,
              resetsAt: atSeconds(4 * 24 * HOUR_S),
              windowDurationMins: 7 * 24 * 60,
            },
          ],
        },
      },
      { provider: "codex", disabled: true, quota: { status: "skipped", windows: [] } },
      { provider: "kimi", disabled: false, quota: { status: "unsupported", windows: [] } },
      {
        provider: "claude",
        disabled: false,
        quota: { status: "failed", checkedAt: OBSERVED, windows: [], message: "HTTP 401" },
      },
    ],
  },
  ...overrides,
});

describe("ryco_usage_limits", () => {
  it("labels windows and judges pace as the Limits page does, at the read time", () => {
    const result = read([codex]);
    expect(result.checkedAt).toBe(new Date(NOW_MS).toISOString());
    expect(result.instances).toEqual([
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex work",
        observedAt: OBSERVED,
        windows: [
          {
            label: "5h",
            usedPercent: 70,
            resetsAt: "2026-10-29T13:00:00.000Z",
            pace: "30 percentage points above even pace · at last check",
          },
          {
            label: "Weekly",
            usedPercent: 10,
            resetsAt: "2026-11-02T10:00:00.000Z",
            pace: "33 percentage points below even pace · at last check",
          },
          { label: "Weekly · Opus", usedPercent: 43, resetsAt: "2026-11-02T10:00:00.000Z" },
        ],
      },
    ]);
  });

  it("reads the legacy slots of servers that send no window list", () => {
    const claude = provider({
      instanceId: "claude",
      driver: "claudeAgent",
      checkedAt: OBSERVED,
      rateLimits: {
        primary: { usedPercent: 120, windowDurationMins: 300 },
        secondary: { usedPercent: 5, resetsAt: Number.MAX_VALUE, windowDurationMins: 10_080 },
      },
    });
    const [instance] = read([claude]).instances;
    expect(instance?.observedAt).toBe(OBSERVED);
    expect(instance?.windows).toEqual([
      { label: "5h", usedPercent: 100, resetsAt: null, pace: "Pace unavailable" },
      { label: "Weekly", usedPercent: 5, resetsAt: null, pace: "Pace unavailable" },
    ]);
  });

  it("marks re-served numbers as stale with the reason the Limits page gives", () => {
    const stale = provider({
      rateLimits: {
        ...codex.rateLimits,
        stale: true,
        staleReason: "rateLimited",
      },
    });
    const [instance] = read([stale]).instances;
    expect(instance?.stale).toBe(true);
    expect(instance?.staleReason).toBe("the provider is limiting usage reads");
    expect(instance?.observedAt).toBe(OBSERVED);
    expect(read([codex]).instances[0]).not.toHaveProperty("stale");
  });

  it("filters by instance and leaves disabled instances out", () => {
    const other = provider({ instanceId: "codex-team", rateLimits: codex.rateLimits });
    const disabled = provider({
      instanceId: "codex-off",
      enabled: false,
      status: "disabled",
      rateLimits: codex.rateLimits,
    });
    expect(read([codex, other, disabled]).instances.map((entry) => entry.instanceId)).toEqual([
      "codex",
      "codex-team",
    ]);
    expect(
      read([codex, other, disabled], { instanceId: "codex-team" }).instances.map(
        (entry) => entry.instanceId,
      ),
    ).toEqual(["codex-team"]);
    expect(read([codex, other, disabled], { instanceId: "codex-off" }).instances).toEqual([]);
  });

  it("explains instances without limits", () => {
    const cursor = provider({ instanceId: "cursor", driver: "cursor" });
    const unread = provider({ instanceId: "codex-new" });
    const creditsOnly = provider({ instanceId: "codex-credits", rateLimits: {} });
    expect(read([cursor, unread, creditsOnly]).instances).toEqual([
      {
        instanceId: "cursor",
        driver: "cursor",
        displayName: null,
        windows: [],
        observedAt: null,
        note: USAGE_LIMITS_NOTES.unsupported,
      },
      {
        instanceId: "codex-new",
        driver: "codex",
        displayName: null,
        windows: [],
        observedAt: null,
        note: USAGE_LIMITS_NOTES.noReading,
      },
      {
        instanceId: "codex-credits",
        driver: "codex",
        displayName: null,
        windows: [],
        observedAt: null,
        note: USAGE_LIMITS_NOTES.noReading,
      },
    ]);
  });

  it("points an instance a CLIProxyAPI hub serves at the hub instead of its own limits", () => {
    const routed = provider({
      instanceId: "claude-hub",
      driver: "claudeAgent",
      rateLimits: codex.rateLimits,
    });
    const result = read([routed], { hubs: [hub({ label: "Home hub" })] });
    expect(result.instances).toEqual([
      {
        instanceId: "claude-hub",
        driver: "claudeAgent",
        displayName: null,
        windows: [],
        observedAt: null,
        note: USAGE_LIMITS_NOTES.hubRouted("Home hub"),
      },
    ]);
    expect(result.hubs.map((entry) => entry.hubLabel)).toEqual(["Home hub"]);
  });

  it("numbers a hub's accounts in the hub's order, labelled and paced as the hub cards do", () => {
    const result = read([], { hubs: [hub()] });
    expect(result.hubs).toEqual([
      {
        hubLabel: "hub.example:8317",
        routedInstanceIds: ["claude-hub"],
        observedAt: HUB_LISTED,
        accounts: [
          {
            label: "Account 1",
            provider: "claude",
            observedAt: OBSERVED,
            windows: [
              {
                label: "5h",
                usedPercent: 70,
                resetsAt: "2026-10-29T13:00:00.000Z",
                pace: "30 percentage points above even pace · at last check",
              },
              { label: "Weekly · Opus", usedPercent: 43, resetsAt: "2026-11-02T10:00:00.000Z" },
            ],
          },
          {
            label: "Account 2",
            provider: "codex",
            windows: [],
            observedAt: null,
            note: USAGE_LIMITS_NOTES.hubQuota.skipped,
          },
          {
            label: "Account 3",
            provider: "kimi",
            windows: [],
            observedAt: null,
            note: USAGE_LIMITS_NOTES.hubQuota.unsupported,
          },
          {
            label: "Account 4",
            provider: "claude",
            windows: [],
            observedAt: null,
            note: USAGE_LIMITS_NOTES.hubQuota.failed,
          },
        ],
      },
    ]);
    // The same cache numbers the same way on every read.
    expect(read([], { hubs: [hub()] })).toEqual(result);
  });

  it("explains a hub without a reading, a failed hub read and a list cut at the cap", () => {
    const unread = { label: "Unread", routedInstanceIds: [], failed: false };
    const unreadable = { label: "Unreadable", routedInstanceIds: [], failed: true };
    const failedAgain = hub({ label: "Failed again", failed: true });
    const crowded = hub({
      label: "Crowded",
      listed: {
        fetchedAtMs: OBSERVED_MS,
        accounts: Array.from(
          { length: AGENT_CONTROL_MCP_USAGE_LIMITS_MAX.hubAccounts + 3 },
          () => ({
            provider: "claude",
            disabled: false,
            quota: { status: "ok" as const, checkedAt: OBSERVED, windows: [] },
          }),
        ),
      },
    });
    const [first, second, third, fourth] = read([], {
      hubs: [unread, unreadable, failedAgain, crowded],
    }).hubs;
    expect(first).toEqual({
      hubLabel: "Unread",
      routedInstanceIds: [],
      accounts: [],
      observedAt: null,
      note: "No hub reading yet; open the Limits page to read the hub.",
    });
    expect(second?.note).toBe(USAGE_LIMITS_NOTES.hubUnreadable);
    expect(third?.stale).toBe(true);
    expect(third?.staleReason).toBe("the latest hub read failed");
    expect(third?.accounts).toHaveLength(4);
    expect(fourth?.accounts).toHaveLength(AGENT_CONTROL_MCP_USAGE_LIMITS_MAX.hubAccounts);
    expect(fourth?.accounts.at(-1)?.label).toBe(
      `Account ${AGENT_CONTROL_MCP_USAGE_LIMITS_MAX.hubAccounts}`,
    );
    expect(fourth?.accounts[0]?.note).toBe(USAGE_LIMITS_NOTES.hubQuota.ok);
    expect(fourth?.note).toBe("3 more accounts are not listed.");
  });

  it("filters hubs to the one serving the requested instance", () => {
    const other = hub({ label: "Other", routedInstanceIds: [ProviderInstanceId.make("codex")] });
    expect(read([], { hubs: [hub(), other], instanceId: "claude-hub" }).hubs).toHaveLength(1);
    expect(read([], { hubs: [hub(), other], instanceId: "claude-hub" }).hubs[0]?.hubLabel).toBe(
      "hub.example:8317",
    );
    expect(read([], { hubs: [hub()], instanceId: "cursor" }).hubs).toEqual([]);
  });

  it("never carries hub account emails, names or credential indices", () => {
    // Fields the service never hands over, passed anyway: the tool copies only what it lists.
    const identity = (index: number) => ({
      email: `person${index}@example.com`,
      name: `claude-person${index}.json`,
      authIndex: `auth-index-${index}`,
      label: `Person ${index}`,
    });
    const withIdentity = {
      label: "Home hub",
      routedInstanceIds: [],
      failed: false,
      listed: {
        fetchedAtMs: OBSERVED_MS,
        accounts: [
          {
            ...identity(0),
            provider: "claude",
            disabled: false,
            quota: {
              status: "ok",
              checkedAt: OBSERVED,
              planType: "max",
              credits: { unlimited: false, balance: "12.50" },
              windows: [{ id: "five_hour", usedPercent: 10, windowDurationMins: 300 }],
            },
          },
          {
            ...identity(1),
            provider: "codex",
            disabled: false,
            quota: { status: "failed", windows: [], message: "token for person1@example.com" },
          },
        ],
      },
    } as CliProxyCachedHub;
    const serialized = JSON.stringify(read([], { hubs: [withIdentity] }));
    for (const forbidden of [
      "@example.com",
      ".json",
      "auth-index",
      "Person",
      "max",
      "12.50",
      "token",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("says when a limit is reached or the instance is not ready", () => {
    const reached = provider({
      rateLimits: { ...codex.rateLimits, rateLimitReachedType: "rate_limit_reached" },
    });
    expect(read([reached]).instances[0]?.note).toBe(USAGE_LIMITS_NOTES.limitReached);

    const signedOut = provider({
      auth: { status: "unauthenticated" },
      rateLimits: codex.rateLimits,
    });
    const [instance] = read([signedOut]).instances;
    expect(instance?.note).toBe(USAGE_LIMITS_NOTES.notReady);
    expect(instance?.windows.map((window) => window.pace)).toEqual([
      "Pace unavailable",
      "Pace unavailable",
      "Pace unavailable",
    ]);
  });

  it("never carries emails, account ids, plans, credits or credentials", () => {
    const serialized = JSON.stringify(read([codex]));
    for (const forbidden of [
      "person@example.com",
      "ChatGPT Pro",
      "chatgpt",
      "limit-account-123",
      "Pro plan",
      '"pro"',
      "42.00",
      "credits",
      "email",
      "auth",
      "plan",
      "limitId",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("caps instances and windows", () => {
    const manyWindows = provider({
      rateLimits: {
        windows: Array.from({ length: AGENT_CONTROL_MCP_USAGE_LIMITS_MAX.windows + 5 }, (_, i) => ({
          id: `window-${i}`,
          scope: `Model ${i}`,
          usedPercent: i,
          windowDurationMins: 300,
        })),
      },
    });
    const many = Array.from({ length: AGENT_CONTROL_MCP_USAGE_LIMITS_MAX.instances + 5 }, (_, i) =>
      provider({ instanceId: `codex-${i}`, rateLimits: manyWindows.rateLimits }),
    );
    const result = read(many);
    expect(result.instances).toHaveLength(AGENT_CONTROL_MCP_USAGE_LIMITS_MAX.instances);
    expect(result.instances[0]?.windows).toHaveLength(AGENT_CONTROL_MCP_USAGE_LIMITS_MAX.windows);
    const manyHubs = Array.from({ length: AGENT_CONTROL_MCP_USAGE_LIMITS_MAX.hubs + 2 }, () =>
      hub(),
    );
    expect(read([], { hubs: manyHubs }).hubs).toHaveLength(AGENT_CONTROL_MCP_USAGE_LIMITS_MAX.hubs);
  });
});
