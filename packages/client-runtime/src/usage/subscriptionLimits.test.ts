import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CliProxyAccount,
  type CliProxyHubSnapshot,
  type ServerProvider,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  directAccountHealth,
  groupSubscriptionLimits,
  listDirectProviderAccounts,
  providerLimitWindows,
} from "./subscriptionLimits.ts";

function provider(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "instanceId">,
): ServerProvider {
  return {
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-22T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function hub(accounts: CliProxyAccount[], routed: ProviderInstanceId[] = []): CliProxyHubSnapshot {
  return {
    hubId: "home" as CliProxyHubSnapshot["hubId"],
    label: "home",
    url: "https://hub.example.com",
    checkedAt: "2026-10-22T10:00:00.000Z",
    status: "ok",
    accounts,
    apiKeys: [],
    routedInstanceIds: routed,
  };
}

const fiveHour = (usedPercent: number, resetsAt?: number) => ({
  usedPercent,
  windowDurationMins: 300,
  ...(resetsAt === undefined ? {} : { resetsAt }),
});

describe("providerLimitWindows", () => {
  it("labels windows by duration and falls back to the slot name", () => {
    const windows = providerLimitWindows(
      provider({
        instanceId: ProviderInstanceId.make("opencode"),
        rateLimits: {
          primary: fiveHour(10),
          secondary: { usedPercent: 20 },
          tertiary: { usedPercent: 30, windowDurationMins: 30 * 24 * 60 },
        },
      }),
    );
    expect(windows.map((window) => window.label)).toEqual(["5h", "Weekly", "Monthly"]);
  });
});

describe("listDirectProviderAccounts", () => {
  it("counts one account signed in on several nodes once, keeping the freshest snapshot", () => {
    const email = "Person@example.com";
    const older = provider({
      instanceId: ProviderInstanceId.make("codex"),
      auth: { status: "authenticated", email },
      rateLimits: { primary: fiveHour(10) },
    });
    const newer = provider({
      instanceId: ProviderInstanceId.make("codex"),
      auth: { status: "authenticated", email: email.toLowerCase() },
      checkedAt: "2026-10-22T10:05:00.000Z",
      rateLimits: { primary: fiveHour(30) },
    });
    const { accounts } = listDirectProviderAccounts([
      { environmentId: "m5", label: "M5", connected: true, providers: [older], hubs: [] },
      { environmentId: "m4", label: "M4", connected: true, providers: [newer], hubs: [] },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.snapshot).toBe(newer);
    expect(accounts[0]!.locations.map((location) => location.environmentLabel)).toEqual([
      "M5",
      "M4",
    ]);
  });

  it("prefers an available snapshot over a newer one from a disconnected node", () => {
    const live = provider({
      instanceId: ProviderInstanceId.make("codex"),
      auth: { status: "authenticated", email: "a@example.com" },
      rateLimits: { primary: fiveHour(10) },
    });
    const stale = { ...live, checkedAt: "2026-10-22T11:00:00.000Z" };
    const { accounts } = listDirectProviderAccounts([
      { environmentId: "m5", label: "M5", connected: true, providers: [live], hubs: [] },
      { environmentId: "m4", label: "M4", connected: false, providers: [stale], hubs: [] },
    ]);
    expect(accounts[0]!.snapshot).toBe(live);
    expect(accounts[0]!.available).toBe(true);
  });

  it("keeps instances without an email apart and skips routed, disabled and limitless ones", () => {
    const routedId = ProviderInstanceId.make("claudeAgent");
    const { accounts, routed } = listDirectProviderAccounts([
      {
        environmentId: "m5",
        label: "M5",
        connected: true,
        hubs: [hub([], [routedId])],
        providers: [
          provider({
            instanceId: routedId,
            driver: ProviderDriverKind.make("claudeAgent"),
            rateLimits: { primary: fiveHour(99) },
          }),
          provider({
            instanceId: ProviderInstanceId.make("a"),
            rateLimits: { primary: fiveHour(1) },
          }),
          provider({
            instanceId: ProviderInstanceId.make("b"),
            rateLimits: { primary: fiveHour(2) },
          }),
          provider({
            instanceId: ProviderInstanceId.make("off"),
            enabled: false,
            rateLimits: { primary: fiveHour(3) },
          }),
          provider({ instanceId: ProviderInstanceId.make("none") }),
        ],
      },
    ]);
    expect(accounts.map((account) => account.snapshot.instanceId)).toEqual(["a", "b"]);
    expect(routed).toEqual([
      expect.objectContaining({ instanceId: routedId, provider: "claude", hubLabel: "home" }),
    ]);
  });
});

describe("directAccountHealth", () => {
  it("reports unavailable, limited and ready accounts", () => {
    const base = {
      key: "k",
      provider: "codex",
      locations: [],
      windows: [{ label: "5h", window: fiveHour(100) }],
    };
    const snapshot = provider({ instanceId: ProviderInstanceId.make("codex"), message: "Gone" });
    expect(directAccountHealth({ ...base, snapshot, available: false })).toEqual({
      kind: "unavailable",
      message: "Gone",
    });
    expect(directAccountHealth({ ...base, snapshot, available: true })).toEqual({
      kind: "limited",
    });
    expect(
      directAccountHealth({
        ...base,
        snapshot,
        available: true,
        windows: [{ label: "5h", window: fiveHour(50) }],
      }),
    ).toEqual({ kind: "ready" });
  });
});

describe("groupSubscriptionLimits", () => {
  it("pools direct and hub windows of a provider by label", () => {
    const routedId = ProviderInstanceId.make("claudeAgent");
    const environment = {
      environmentId: "m5",
      label: "M5",
      connected: true,
      hubs: [
        hub(
          [
            {
              authIndex: "1",
              provider: "claude",
              name: "one.json",
              status: "active",
              disabled: false,
              unavailable: false,
              cooldowns: [],
              requests: { success: 0, failed: 0, recent: [] },
              quota: {
                status: "ok",
                windows: [{ id: "five_hour", ...fiveHour(20, 2_000) }],
              },
            },
          ],
          [routedId],
        ),
      ],
      providers: [
        provider({
          instanceId: routedId,
          driver: ProviderDriverKind.make("claudeAgent"),
        }),
        provider({
          instanceId: ProviderInstanceId.make("claude-personal"),
          driver: ProviderDriverKind.make("claudeAgent"),
          rateLimits: { primary: fiveHour(40, 1_000) },
        }),
        provider({
          instanceId: ProviderInstanceId.make("codex"),
          rateLimits: { primary: fiveHour(5) },
        }),
      ],
    };
    const direct = listDirectProviderAccounts([environment]);
    const groups = groupSubscriptionLimits({
      hubs: environment.hubs.map((snapshot) => ({ environmentId: "m5", hub: snapshot })),
      direct: direct.accounts,
      routed: direct.routed,
    });

    expect(groups.map((group) => group.label)).toEqual(["Claude", "Codex"]);
    const claude = groups[0]!;
    expect(claude.directAccounts).toHaveLength(1);
    expect(claude.hubAccounts).toHaveLength(1);
    expect(claude.routed).toHaveLength(1);
    expect(claude.pooled).toEqual([
      {
        id: "5h",
        label: "5h",
        windowDurationMins: 300,
        usedPercent: 30,
        accountCount: 2,
        nextResetsAt: 1_000,
      },
    ]);
    expect(groups[1]!.routed).toEqual([]);
  });
});
