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
  hubKeysByDirectAccount,
  listDirectProviderAccounts,
  nextLimitResetAtMs,
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

function hubAccount(
  overrides: Partial<CliProxyAccount> & Pick<CliProxyAccount, "authIndex">,
): CliProxyAccount {
  return {
    provider: "claude",
    name: `${overrides.authIndex}.json`,
    status: "active",
    disabled: false,
    unavailable: false,
    cooldowns: [],
    requests: { success: 0, failed: 0, recent: [] },
    quota: { status: "ok", windows: [] },
    ...overrides,
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

  it("falls back to the slot name for a zero or invalid duration", () => {
    const windows = providerLimitWindows(
      provider({
        instanceId: ProviderInstanceId.make("codex"),
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 0 },
          secondary: { usedPercent: 20, windowDurationMins: Number.NaN },
        },
      }),
    );
    expect(windows.map((window) => window.label)).toEqual(["Short window", "Weekly"]);
  });
});

describe("nextLimitResetAtMs", () => {
  it("returns the soonest future reset in milliseconds", () => {
    const windows = [
      { label: "past", window: fiveHour(10, 1_000) },
      { label: "later", window: fiveHour(10, 9_000) },
      { label: "sooner", window: fiveHour(10, 5_000) },
      { label: "invalid", window: fiveHour(10, Number.NaN) },
      { label: "none", window: fiveHour(10) },
    ];
    expect(nextLimitResetAtMs(windows, 2_000_000)).toBe(5_000_000);
    expect(nextLimitResetAtMs(windows, 9_000_000)).toBeNull();
    expect(nextLimitResetAtMs([], 0)).toBeNull();
  });
});

describe("listDirectProviderAccounts", () => {
  it("counts one account signed in on several nodes once, keeping the freshest snapshot", () => {
    const email = "Person@example.com";
    const older = provider({
      instanceId: ProviderInstanceId.make("codex"),
      auth: { status: "authenticated", email },
      rateLimits: { planType: "plus", primary: fiveHour(10) },
    });
    const newer = provider({
      instanceId: ProviderInstanceId.make("codex"),
      auth: { status: "authenticated", email: email.toLowerCase() },
      checkedAt: "2026-10-22T10:05:00.000Z",
      rateLimits: { planType: "plus", primary: fiveHour(30) },
    });
    const { accounts } = listDirectProviderAccounts([
      { environmentId: "m5", label: "M5", connected: true, providers: [older], hubs: [] },
      { environmentId: "m4", label: "M4", connected: true, providers: [newer], hubs: [] },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.snapshot).toBe(newer);
    expect(accounts[0]!.plan).toBe("Plus");
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
    expect(
      accounts[0]!.locations.map(({ environmentId, available, authenticated, checkedAt }) => ({
        environmentId,
        available,
        authenticated,
        checkedAt,
      })),
    ).toEqual([
      {
        environmentId: "m5",
        available: true,
        authenticated: true,
        checkedAt: "2026-10-22T10:00:00.000Z",
      },
      {
        environmentId: "m4",
        available: false,
        authenticated: true,
        checkedAt: "2026-10-22T11:00:00.000Z",
      },
    ]);
  });

  it("keeps one email on two plans apart and joins a planless snapshot only when unambiguous", () => {
    const signedIn = (instanceId: string, planType?: string) =>
      provider({
        instanceId: ProviderInstanceId.make(instanceId),
        auth: { status: "authenticated", email: "a@example.com" },
        rateLimits: { ...(planType ? { planType } : {}), primary: fiveHour(10) },
      });
    const keysOf = (providers: ServerProvider[]) =>
      listDirectProviderAccounts([
        { environmentId: "m5", label: "M5", connected: true, providers, hubs: [] },
      ]).accounts.map((account) => account.locations.map((location) => location.instanceId));

    expect(keysOf([signedIn("plus", "plus"), signedIn("team", "Team")])).toEqual([
      ["plus"],
      ["team"],
    ]);
    expect(keysOf([signedIn("plus", "plus"), signedIn("old")])).toEqual([["plus", "old"]]);
    expect(keysOf([signedIn("plus", "plus"), signedIn("team", "team"), signedIn("old")])).toEqual([
      ["plus"],
      ["team"],
      ["old"],
    ]);
    // A plan reported without windows still makes the email ambiguous.
    const teamWithoutWindows = provider({
      instanceId: ProviderInstanceId.make("team"),
      auth: { status: "authenticated", email: "a@example.com" },
      rateLimits: { planType: "team", credits: { hasCredits: true, unlimited: false } },
    });
    expect(keysOf([signedIn("plus", "plus"), teamWithoutWindows, signedIn("old")])).toEqual([
      ["plus"],
      ["old"],
    ]);
  });

  it("takes banked resets from the newest read that reported them", () => {
    const resetCredits = { availableCount: 2 };
    const reported = provider({
      instanceId: ProviderInstanceId.make("codex"),
      auth: { status: "authenticated", email: "a@example.com" },
      rateLimits: { primary: fiveHour(10), resetCredits },
    });
    const newer = provider({
      instanceId: ProviderInstanceId.make("codex"),
      auth: { status: "authenticated", email: "a@example.com" },
      checkedAt: "2026-10-22T10:05:00.000Z",
      rateLimits: { primary: fiveHour(20) },
    });
    const { accounts } = listDirectProviderAccounts([
      { environmentId: "m5", label: "M5", connected: true, providers: [reported], hubs: [] },
      { environmentId: "m4", label: "M4", connected: true, providers: [newer], hubs: [] },
    ]);
    expect(accounts[0]!.snapshot).toBe(newer);
    expect(accounts[0]!.resetCredits).toBe(resetCredits);
  });

  it("counts an unparsable check time as older than any other", () => {
    const signedIn = (checkedAt: string, availableCount: number) =>
      provider({
        instanceId: ProviderInstanceId.make("codex"),
        auth: { status: "authenticated", email: "a@example.com" },
        checkedAt,
        rateLimits: { primary: fiveHour(10), resetCredits: { availableCount } },
      });
    const unparsable = signedIn("not a time", 1);
    const parsed = signedIn("2026-10-22T09:00:00.000Z", 3);
    const { accounts } = listDirectProviderAccounts([
      { environmentId: "m5", label: "M5", connected: true, providers: [unparsable], hubs: [] },
      { environmentId: "m4", label: "M4", connected: true, providers: [parsed], hubs: [] },
    ]);
    expect(accounts[0]!.snapshot).toBe(parsed);
    expect(accounts[0]!.resetCredits).toEqual({ availableCount: 3 });
  });

  it("never lets a routed instance join a direct account with the same email", () => {
    const email = "a@example.com";
    const routedId = ProviderInstanceId.make("claudeAgent");
    const claude = (instanceId: ProviderInstanceId, usedPercent: number, checkedAt: string) =>
      provider({
        instanceId,
        driver: ProviderDriverKind.make("claudeAgent"),
        auth: { status: "authenticated", email },
        checkedAt,
        rateLimits: { primary: fiveHour(usedPercent) },
      });
    const direct = claude(ProviderInstanceId.make("claude-personal"), 10, "2026-10-22T10:00:00Z");
    const { accounts, routed } = listDirectProviderAccounts([
      { environmentId: "m5", label: "M5", connected: true, providers: [direct], hubs: [] },
      {
        environmentId: "m4",
        label: "M4",
        connected: true,
        providers: [claude(routedId, 99, "2026-10-22T11:00:00Z")],
        hubs: [hub([], [routedId])],
      },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.snapshot).toBe(direct);
    expect(accounts[0]!.locations.map((location) => location.environmentId)).toEqual(["m5"]);
    expect(routed.map((instance) => instance.environmentId)).toEqual(["m4"]);
  });

  it("keeps instances without an email apart and skips routed, disabled and limitless ones", () => {
    const routedId = ProviderInstanceId.make("claudeAgent");
    const { accounts, routed, withoutLimits } = listDirectProviderAccounts([
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
          provider({ instanceId: ProviderInstanceId.make("none"), message: "No usage yet" }),
          provider({
            instanceId: ProviderInstanceId.make("off-none"),
            enabled: false,
          }),
        ],
      },
    ]);
    expect(accounts.map((account) => account.snapshot.instanceId)).toEqual(["a", "b"]);
    expect(routed).toEqual([
      expect.objectContaining({ instanceId: routedId, provider: "claude", hubLabel: "home" }),
    ]);
    expect(withoutLimits).toEqual([
      expect.objectContaining({
        instanceId: "none",
        environmentLabel: "M5",
        provider: "codex",
        authenticated: true,
        reason: "No usage yet",
      }),
    ]);
  });
});

describe("directAccountHealth", () => {
  it("reports unavailable, limited and ready accounts", () => {
    const base = {
      key: "k",
      provider: "codex",
      plan: undefined,
      resetCredits: undefined,
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
  it("groups direct and hub accounts by provider and pools only the hub accounts", () => {
    const routedId = ProviderInstanceId.make("claudeAgent");
    const environment = {
      environmentId: "m5",
      label: "M5",
      connected: true,
      hubs: [
        hub(
          [
            hubAccount({
              authIndex: "1",
              quota: { status: "ok", windows: [{ id: "five_hour", ...fiveHour(20, 2_000) }] },
            }),
            hubAccount({
              authIndex: "2",
              quota: { status: "ok", windows: [{ id: "five_hour", ...fiveHour(40, 3_000) }] },
            }),
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
          rateLimits: { primary: fiveHour(90, 1_000) },
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
    expect(claude.hubAccounts).toHaveLength(2);
    expect(claude.routed).toHaveLength(1);
    // The direct account's 90% is never averaged in.
    expect(claude.pooled).toEqual([
      {
        id: "5h",
        label: "5h",
        windowDurationMins: 300,
        usedPercent: 30,
        accountCount: 2,
        nextResetsAt: 2_000,
      },
    ]);
    expect(groups[1]!.routed).toEqual([]);
    expect(groups[1]!.pooled).toEqual([]);
    expect(groups.flatMap((group) => group.withoutLimits)).toEqual([]);
  });

  it("lists the instances without limits it is given under their provider", () => {
    const { accounts, withoutLimits } = listDirectProviderAccounts([
      {
        environmentId: "m5",
        label: "M5",
        connected: true,
        hubs: [],
        providers: [
          provider({
            instanceId: ProviderInstanceId.make("claude"),
            driver: ProviderDriverKind.make("claudeAgent"),
            rateLimits: { primary: fiveHour(10) },
          }),
          provider({
            instanceId: ProviderInstanceId.make("codex"),
            message: "Read failed",
            rateLimits: { planType: "plus", credits: { hasCredits: true, unlimited: false } },
          }),
          provider({
            instanceId: ProviderInstanceId.make("copilot"),
            driver: ProviderDriverKind.make("copilot"),
          }),
        ],
      },
    ]);
    const groups = groupSubscriptionLimits({
      hubs: [],
      direct: accounts,
      routed: [],
      withoutLimits: withoutLimits.filter((instance) => instance.driver === "codex"),
    });

    expect(groups.map((group) => group.label)).toEqual(["Claude", "Codex"]);
    expect(groups[0]!.withoutLimits).toEqual([]);
    expect(groups[1]!.directAccounts).toEqual([]);
    // A credits-only snapshot still names its plan, like an account's.
    expect(groups[1]!.withoutLimits).toEqual([
      expect.objectContaining({ instanceId: "codex", plan: "Plus", reason: "Read failed" }),
    ]);
  });
});

describe("hubKeysByDirectAccount", () => {
  it("matches a direct account to hub accounts of its provider by email", () => {
    const { accounts } = listDirectProviderAccounts([
      {
        environmentId: "m5",
        label: "M5",
        connected: true,
        hubs: [],
        providers: [
          provider({
            instanceId: ProviderInstanceId.make("claude"),
            driver: ProviderDriverKind.make("claudeAgent"),
            auth: { status: "authenticated", email: "Alice@example.com" },
            rateLimits: { primary: fiveHour(10) },
          }),
          provider({
            instanceId: ProviderInstanceId.make("codex"),
            auth: { status: "authenticated", email: "alice@example.com" },
            rateLimits: { primary: fiveHour(10) },
          }),
        ],
      },
    ]);
    const matches = hubKeysByDirectAccount(accounts, [
      {
        environmentId: "m5",
        hub: hub([
          hubAccount({ authIndex: "1", email: "alice@example.com" }),
          // Named only by its credential file, which never matches.
          hubAccount({ authIndex: "2", provider: "codex", name: "codex-alice@example.com.json" }),
        ]),
      },
    ]);
    const claude = accounts.find((account) => account.provider === "claude")!;
    expect([...matches]).toEqual([[claude.key, ["https://hub.example.com"]]]);
  });

  it("never matches a hub account on another plan of the same email", () => {
    const { accounts } = listDirectProviderAccounts([
      {
        environmentId: "m5",
        label: "M5",
        connected: true,
        hubs: [],
        providers: [
          provider({
            instanceId: ProviderInstanceId.make("codex-personal"),
            auth: { status: "authenticated", email: "a@x.com" },
            rateLimits: { planType: "plus", primary: fiveHour(10) },
          }),
          provider({
            instanceId: ProviderInstanceId.make("codex-work"),
            auth: { status: "authenticated", email: "a@x.com" },
            rateLimits: { planType: "team", primary: fiveHour(10) },
          }),
        ],
      },
    ]);
    const teamHub = hub([
      hubAccount({
        authIndex: "1",
        provider: "codex",
        email: "a@x.com",
        quota: { status: "ok", planType: "Team", windows: [] },
      }),
    ]);
    const planlessHub = {
      ...hub([hubAccount({ authIndex: "1", provider: "codex", email: "a@x.com" })]),
      url: "https://other.example.com",
    };
    const keyOf = (plan: string) =>
      accounts.find((account) => account.snapshot.rateLimits?.planType === plan)!.key;

    expect(hubKeysByDirectAccount(accounts, [{ environmentId: "m5", hub: teamHub }])).toEqual(
      new Map([[keyOf("team"), ["https://hub.example.com"]]]),
    );
    // A hub account that names no plan may hold either one.
    expect(hubKeysByDirectAccount(accounts, [{ environmentId: "m5", hub: planlessHub }])).toEqual(
      new Map([
        [keyOf("plus"), ["https://other.example.com"]],
        [keyOf("team"), ["https://other.example.com"]],
      ]),
    );
  });

  it("matches across plan names only one side uses", () => {
    const { accounts } = listDirectProviderAccounts([
      {
        environmentId: "m5",
        label: "M5",
        connected: true,
        hubs: [],
        providers: [
          provider({
            instanceId: ProviderInstanceId.make("claude"),
            driver: ProviderDriverKind.make("claudeAgent"),
            auth: { status: "authenticated", email: "a@x.com" },
            // A rate-limit tier stands in for a plan the hub words as `max`.
            rateLimits: { planType: "default_claude_max_20x", primary: fiveHour(10) },
          }),
        ],
      },
    ]);
    const matches = hubKeysByDirectAccount(accounts, [
      {
        environmentId: "m5",
        hub: hub([
          hubAccount({
            authIndex: "1",
            email: "a@x.com",
            quota: { status: "ok", planType: "max", windows: [] },
          }),
        ]),
      },
    ]);
    expect([...matches]).toEqual([[accounts[0]!.key, ["https://hub.example.com"]]]);
  });
});
