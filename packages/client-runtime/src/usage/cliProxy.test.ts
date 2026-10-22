import {
  ProviderInstanceId,
  type CliProxyAccount,
  type CliProxyHubSnapshot,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cliProxyAccountDisplayName,
  cliProxyAccountHealth,
  cliProxyCurrentAccount,
  cliProxyWindowLabel,
  findCliProxyRouteForInstance,
  formatCliProxyPlan,
  groupCliProxyAccounts,
  listCliProxyApiKeys,
} from "./cliProxy.ts";

const NOW = Date.parse("2026-10-11T10:00:00Z");

const at = (environmentId: string, snapshot: CliProxyHubSnapshot) => ({
  environmentId,
  hub: snapshot,
});

function account(overrides: Partial<CliProxyAccount> & Pick<CliProxyAccount, "authIndex">) {
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
  } satisfies CliProxyAccount;
}

function hub(
  id: string,
  url: string,
  accounts: CliProxyAccount[],
  routedInstanceIds: ProviderInstanceId[] = [],
): CliProxyHubSnapshot {
  return {
    hubId: id as CliProxyHubSnapshot["hubId"],
    label: id,
    url,
    checkedAt: "2026-10-11T10:00:00.000Z",
    status: "ok",
    accounts,
    apiKeys: [],
    routedInstanceIds,
  };
}

describe("cliProxyWindowLabel", () => {
  it("derives the cadence from the duration and appends the scope", () => {
    expect(cliProxyWindowLabel({ id: "a", usedPercent: 1, windowDurationMins: 300 })).toBe("5h");
    expect(
      cliProxyWindowLabel({ id: "b", scope: "Opus", usedPercent: 1, windowDurationMins: 10_080 }),
    ).toBe("Weekly · Opus");
    expect(cliProxyWindowLabel({ id: "c", scope: "Cloud session credits", usedPercent: 1 })).toBe(
      "Cloud session credits",
    );
  });
});

describe("formatCliProxyPlan", () => {
  it("title-cases plan slugs", () => {
    expect(formatCliProxyPlan("max")).toBe("Max");
    expect(formatCliProxyPlan("plus_team")).toBe("Plus Team");
    expect(formatCliProxyPlan(undefined)).toBeUndefined();
  });
});

describe("cliProxyAccountHealth", () => {
  it("orders disabled, error, cooldown and exhausted states", () => {
    expect(cliProxyAccountHealth(account({ authIndex: "a", disabled: true }), NOW)).toEqual({
      kind: "disabled",
    });
    expect(
      cliProxyAccountHealth(
        account({ authIndex: "b", status: "error", statusMessage: "token expired" }),
        NOW,
      ),
    ).toEqual({ kind: "error", message: "token expired" });
    expect(
      cliProxyAccountHealth(
        account({
          authIndex: "c",
          cooldowns: [
            { scope: "model", retryAt: "2026-10-11T10:05:00.000Z" },
            { scope: "model", retryAt: "2026-10-11T09:00:00.000Z" },
          ],
        }),
        NOW,
      ),
    ).toEqual({ kind: "cooling", until: "2026-10-11T10:05:00.000Z" });
    expect(
      cliProxyAccountHealth(
        account({
          authIndex: "d",
          quota: { status: "ok", windows: [{ id: "five_hour", usedPercent: 100 }] },
        }),
        NOW,
      ),
    ).toEqual({ kind: "limited" });
    expect(cliProxyAccountHealth(account({ authIndex: "e" }), NOW)).toEqual({ kind: "ready" });
  });
});

describe("findCliProxyRouteForInstance", () => {
  it("finds the hub that routes an instance", () => {
    const claudeHub = ProviderInstanceId.make("claude_hub");
    const routed = hub("two", "http://other", [], [claudeHub]);
    const hubs = [hub("one", "http://hub", []), routed];
    expect(findCliProxyRouteForInstance(hubs, claudeHub)).toBe(routed);
    expect(findCliProxyRouteForInstance(hubs, ProviderInstanceId.make("claude"))).toBeUndefined();
  });
});

describe("cliProxyCurrentAccount", () => {
  const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

  it("picks the most recently used usable account and counts recent rotation", () => {
    const snapshot = hub("one", "http://hub", [
      account({ authIndex: "a", lastUsedAt: minutesAgo(8) }),
      account({ authIndex: "b", lastUsedAt: minutesAgo(1) }),
      account({ authIndex: "c", lastUsedAt: minutesAgo(30) }),
      account({ authIndex: "d", lastUsedAt: minutesAgo(0), disabled: true }),
      account({ authIndex: "e", provider: "codex", lastUsedAt: minutesAgo(0) }),
      account({ authIndex: "f" }),
    ]);
    const current = cliProxyCurrentAccount(snapshot, "claude", NOW);
    expect(current?.account.authIndex).toBe("b");
    expect(current?.recentAccountCount).toBe(2);
  });

  it("answers with a lone usable account before the hub observed it", () => {
    const lone = hub("one", "http://hub", [
      account({ authIndex: "a" }),
      account({ authIndex: "b", status: "disabled" }),
    ]);
    expect(cliProxyCurrentAccount(lone, "claude", NOW)).toEqual({
      account: lone.accounts[0],
      recentAccountCount: 0,
    });
    const unobserved = hub("one", "http://hub", [
      account({ authIndex: "a" }),
      account({ authIndex: "b" }),
    ]);
    expect(cliProxyCurrentAccount(unobserved, "claude", NOW)).toBeNull();
  });
});

describe("groupCliProxyAccounts", () => {
  it("groups by provider, dedupes shared hubs and pools usable windows", () => {
    const fiveHour = (usedPercent: number, resetsAt: number) => ({
      id: "five_hour",
      usedPercent,
      resetsAt,
      windowDurationMins: 300,
    });
    const groups = groupCliProxyAccounts([
      at(
        "desktop",
        hub("one", "http://hub", [
          account({ authIndex: "z", provider: "kimi" }),
          account({
            authIndex: "b",
            email: "b@example.com",
            quota: { status: "ok", windows: [fiveHour(60, 2_000)] },
          }),
          account({
            authIndex: "a",
            email: "a@example.com",
            quota: { status: "ok", windows: [fiveHour(20, 1_000)] },
          }),
          account({ authIndex: "c", provider: "codex", disabled: true }),
          account({
            authIndex: "f",
            email: "f@example.com",
            quota: { status: "failed", windows: [], message: "HTTP 429" },
          }),
        ]),
      ),
      // The same hub seen through a second environment.
      at("laptop", hub("two", "http://hub", [account({ authIndex: "a", email: "a@example.com" })])),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["Claude", "Codex", "Kimi"]);
    const claude = groups[0]!;
    expect(claude.accounts.map((entry) => entry.account.authIndex)).toEqual(["a", "b", "f"]);
    expect(claude.pooled).toEqual([
      {
        id: "5h",
        label: "5h",
        windowDurationMins: 300,
        usedPercent: 40,
        accountCount: 2,
        nextResetsAt: 1_000,
      },
    ]);
    expect(groups[1]!.pooled).toEqual([]);
  });

  it("keeps loopback hubs of different environments apart", () => {
    const local = (environmentId: string, email: string) =>
      at(
        environmentId,
        hub("cliproxy-127-0-0-1-8317", "http://127.0.0.1:8317", [
          account({ authIndex: "0", email }),
        ]),
      );
    const groups = groupCliProxyAccounts([
      local("desktop", "desk@example.com"),
      local("ssh", "ssh@example.com"),
    ]);
    expect(groups[0]!.accounts.map((entry) => entry.account.email)).toEqual([
      "desk@example.com",
      "ssh@example.com",
    ]);
    expect(new Set(groups[0]!.accounts.map((entry) => entry.hubKey)).size).toBe(2);
  });
});

describe("listCliProxyApiKeys", () => {
  it("counts a shared hub once and keeps colliding masked keys apart", () => {
    const usage = {
      provider: "claude",
      keyHint: "…1234",
      requests: { success: 1, failed: 0, recent: [] },
    };
    const shared = { ...hub("one", "http://hub", []), apiKeys: [usage, usage] };
    const rows = listCliProxyApiKeys([
      at("desktop", shared),
      at("laptop", { ...shared, hubId: "two" as typeof shared.hubId }),
    ]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it("lists the keys of each environment's loopback hub", () => {
    const local = (environmentId: string, keyHint: string) =>
      at(environmentId, {
        ...hub("cliproxy-127-0-0-1-8317", "http://127.0.0.1:8317", []),
        apiKeys: [{ provider: "claude", keyHint, requests: { success: 1, failed: 0, recent: [] } }],
      });
    const rows = listCliProxyApiKeys([local("desktop", "…a1a1"), local("ssh", "…b2b2")]);
    expect(rows.map((row) => row.usage.keyHint)).toEqual(["…a1a1", "…b2b2"]);
  });
});

describe("cliProxyAccountDisplayName", () => {
  it("treats a name that carries an email as sensitive", () => {
    expect(cliProxyAccountDisplayName(account({ authIndex: "a", email: "a@x.com" }))).toEqual({
      value: "a@x.com",
      sensitive: true,
    });
    expect(
      cliProxyAccountDisplayName(account({ authIndex: "b", name: "claude-bob@example.com.json" })),
    ).toEqual({ value: "claude-bob@example.com.json", sensitive: true });
    expect(
      cliProxyAccountDisplayName(
        account({ authIndex: "c", name: "codex.json", label: "carol@example.com" }),
      ),
    ).toEqual({ value: "carol@example.com", sensitive: true });
    expect(cliProxyAccountDisplayName(account({ authIndex: "d", label: "claude" }))).toEqual({
      value: "claude",
      sensitive: false,
    });
  });
});
