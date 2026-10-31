import { describe, expect, it } from "vite-plus/test";
import type {
  CliProxyAccount,
  CliProxyHubSnapshot,
  EnvironmentId,
  ServerProvider,
} from "@ryco/contracts";

import {
  deriveProviderLimitsView,
  providerLimitsNodes,
  type ProviderLimitsNode,
} from "./providerLimitsModel";
import type { NodeStatistics } from "./useStatisticsData";

const NOW = Date.parse("2026-10-31T10:00:00Z");

function account(authIndex: string, overrides: Partial<CliProxyAccount> = {}): CliProxyAccount {
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
      windows: [{ id: "five-hour", usedPercent: 20, windowDurationMins: 300 }],
    },
    ...overrides,
  };
}

function hub(
  label: string,
  url: string,
  accounts: readonly CliProxyAccount[],
  overrides: Partial<CliProxyHubSnapshot> = {},
): CliProxyHubSnapshot {
  return {
    hubId: label.toLowerCase().replaceAll(" ", "-") as CliProxyHubSnapshot["hubId"],
    label,
    url,
    checkedAt: new Date(NOW).toISOString(),
    status: "ok",
    accounts,
    apiKeys: [],
    routedInstanceIds: [],
    ...overrides,
  };
}

function node(
  label: string,
  hubs: readonly CliProxyHubSnapshot[],
  providers: readonly ServerProvider[] = [],
): ProviderLimitsNode {
  return { environmentId: label as EnvironmentId, label, connected: true, providers, hubs };
}

const direct = {
  instanceId: "claude",
  driver: "claudeAgent",
  displayName: "Claude",
  enabled: true,
  status: "ready",
  auth: { status: "authenticated", email: "Alice@Example.com" },
  checkedAt: new Date(NOW).toISOString(),
  rateLimits: {
    planType: "max",
    windows: [{ id: "five_hour", usedPercent: 10, windowDurationMins: 300 }],
  },
} as unknown as ServerProvider;

describe("providerLimitsNodes", () => {
  const environment = {
    environmentId: "mac" as EnvironmentId,
    label: "Mac",
    connectionState: "connected" as const,
    role: "owner" as const,
  };
  const at = (receivedAtMs: number) => ({ receivedAtMs });

  it("passes each device's hubs on with its providers, and says why missing hubs are missing", () => {
    const hubs = [hub("Home", "https://hub.example.test", [account("a")])];
    const nodes: NodeStatistics[] = [
      { environment, providers: [direct], hubs: { status: "ok", hubs, ...at(NOW) } },
      {
        environment: { ...environment, environmentId: "old" as EnvironmentId, label: "Old" },
        providers: [],
        hubs: { status: "unsupported", hubs: [], message: "Update Ryco.", ...at(NOW) },
      },
      // No providers: the device did not answer the Limits tab.
      { environment: { ...environment, environmentId: "x" as EnvironmentId }, error: "Offline" },
    ];
    expect(providerLimitsNodes(nodes)).toEqual([
      {
        environmentId: "mac",
        label: "Mac",
        connected: true,
        providers: [direct],
        hubs,
      },
      {
        environmentId: "old",
        label: "Old",
        connected: true,
        providers: [],
        hubs: [],
        hubsMessage: "Update Ryco.",
      },
    ]);
  });
});

describe("deriveProviderLimitsView", () => {
  it("numbers email-named hub accounts and never puts an email in a row", () => {
    const view = deriveProviderLimitsView(
      [
        node("Mac", [
          hub("Home", "https://hub.example.test", [
            account("a", { email: "alice@example.com" }),
            account("b", { name: "claude-bob@example.com.json" }),
            account("c", { label: "Seat 3" }),
          ]),
        ]),
      ],
      NOW,
    );
    const rows = view.groups[0]!.hubAccounts;
    expect(rows.map((row) => row.name)).toEqual(["Account 1", "Account 2", "Seat 3"]);
    expect(rows.map((row) => row.driver)).toEqual(["claudeAgent", "claudeAgent", "claudeAgent"]);
    expect(JSON.stringify(rows)).not.toContain("@");
    expect(view.groups[0]!.pooled).toMatchObject([{ label: "5h", accountCount: 3 }]);
    expect(view.windows).toHaveLength(3);
    expect(view.empty).toBe(false);
  });

  it("counts a hub several devices share once, and names a loopback hub by its device", () => {
    const shared = hub("Home", "https://hub.example.test", [account("a")]);
    const local = (accounts: CliProxyAccount[]) => hub("Laptop", "http://127.0.0.1:8317", accounts);
    const view = deriveProviderLimitsView(
      [
        node("Mac", [shared, local([account("l1")])]),
        node("Mini", [shared, local([account("l2")])]),
      ],
      NOW,
    );
    expect(view.groups[0]!.hubAccounts.map((row) => row.detail)).toEqual([
      "Max · via Home",
      "Max · via Laptop · Mac",
      "Max · via Laptop · Mini",
    ]);
  });

  it("notes a direct account a hub also holds, and keeps it out of the pool", () => {
    const view = deriveProviderLimitsView(
      [
        node(
          "Mac",
          [hub("Home", "https://hub.example.test", [account("a", { email: "alice@example.com" })])],
          [direct],
        ),
      ],
      NOW,
    );
    const [group] = view.groups;
    expect(group!.directAccounts).toHaveLength(1);
    expect(group!.hubAccounts).toHaveLength(1);
    // One hub account: nothing to average.
    expect(group!.pooled).toEqual([]);
    expect([...view.alsoInHubs.values()]).toEqual(["Also in Home"]);
  });

  it("says how each hub account stands when it cannot serve or report usage", () => {
    const view = deriveProviderLimitsView(
      [
        node("Mac", [
          hub("Home", "https://hub.example.test", [
            account("a", {
              label: "Cooling",
              unavailable: true,
              nextRetryAt: new Date(NOW + 60_000).toISOString(),
            }),
            account("b", {
              label: "Broken",
              status: "error",
              statusMessage: "token expired",
              quota: { status: "failed", windows: [], message: "HTTP 401" },
            }),
            account("c", {
              label: "Off",
              disabled: true,
              quota: { status: "skipped", windows: [] },
            }),
          ]),
        ]),
      ],
      NOW,
    );
    const rows = new Map(view.groups[0]!.hubAccounts.map((row) => [row.name, row]));
    expect(rows.get("Cooling")).toMatchObject({ detail: "Max · via Home · Cooling down" });
    expect(rows.get("Cooling")!.notes[0]).toMatch(/^The hub retries it /);
    expect(rows.get("Broken")).toMatchObject({
      detail: "via Home · Error",
      windows: [],
      notes: ["The hub reports: token expired", "HTTP 401"],
    });
    expect(rows.get("Off")).toMatchObject({
      detail: "via Home · Disabled",
      available: false,
      windows: [],
      notes: ["Disabled on the hub, so its quota is not read."],
    });
  });

  it("reports hubs that could not be read and devices whose hubs are missing", () => {
    const down = hub("Office", "https://office.example.test", [], {
      status: "error",
      error: "Connection refused",
    });
    const view = deriveProviderLimitsView(
      [node("Mac", [down]), { ...node("Mini", []), hubsMessage: "Hub read failed" }],
      NOW,
    );
    expect(view.notices).toEqual([
      { key: "hub\nMac\noffice", title: "Office · Mac", message: "Connection refused" },
      { key: "node\nMini", title: "Mini", message: "Hub read failed" },
    ]);
    expect(view.empty).toBe(true);
  });

  it("notes a routed instance even when its provider has nothing else to show", () => {
    const routed = hub("Home", "https://hub.example.test", [], {
      routedInstanceIds: ["claude" as never],
    });
    const view = deriveProviderLimitsView([node("Mac", [routed], [direct])], NOW);
    expect(view.groups).toEqual([]);
    expect(view.routed).toEqual([
      "Claude is routed through Home, so it uses the hub's accounts and its own limits are not shown.",
    ]);
    expect(view.empty).toBe(false);
  });
});
