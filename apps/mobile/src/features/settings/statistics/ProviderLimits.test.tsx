import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CliProxyAccount,
  CliProxyHubSnapshot,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@ryco/contracts";

vi.mock("./CodexResetCredits", () => ({
  CodexResetCredits: ({
    environmentId,
    instanceId,
    allowed,
  }: {
    environmentId: string;
    instanceId: string;
    allowed: boolean;
  }) => <i data-env={environmentId} data-instance={instanceId} data-allowed={String(allowed)} />,
}));
vi.mock("react-native", () => ({ View: "div", AppState: {} }));
vi.mock("../../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("./StatisticsParts", () => ({
  Note: "p",
  Panel: "section",
  Row: ({ label, value }: { label: string; value: string }) => (
    <p>
      {label}: {value}
    </p>
  ),
}));
import { ProviderLimits, type ProviderLimitsNode } from "./ProviderLimits";

const now = Date.now();
const provider = {
  instanceId: "test",
  driver: "codex",
  enabled: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: new Date(now).toISOString(),
  rateLimits: {
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: (now + 120 * 60_000) / 1000 },
  },
} as ServerProvider;

function node(
  label: string,
  providers: readonly ServerProvider[],
  connected = true,
  hubs: readonly CliProxyHubSnapshot[] = [],
): ProviderLimitsNode {
  return { environmentId: label as EnvironmentId, label, connected, providers, hubs };
}

function hubAccount(
  authIndex: string,
  usedPercent: number,
  overrides: Partial<CliProxyAccount> = {},
) {
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
      checkedAt: new Date(now).toISOString(),
      planType: "max",
      windows: [{ id: "five-hour", usedPercent, windowDurationMins: 300 }],
    },
    ...overrides,
  } satisfies CliProxyAccount;
}

function hub(
  accounts: readonly CliProxyAccount[],
  routedInstanceIds: readonly string[] = [],
): CliProxyHubSnapshot {
  return {
    hubId: "home" as CliProxyHubSnapshot["hubId"],
    label: "Home hub",
    url: "https://hub.example.test",
    checkedAt: new Date(now).toISOString(),
    status: "ok",
    accounts,
    apiKeys: [],
    routedInstanceIds: routedInstanceIds as ProviderInstanceId[],
  };
}

function render(
  nodes: readonly ProviderLimitsNode[],
  canRedeem: (environmentId: EnvironmentId) => boolean = () => true,
) {
  return renderToStaticMarkup(<ProviderLimits nodes={nodes} canRedeem={canRedeem} />);
}

function account(email: string, planType: string, overrides: Partial<ServerProvider> = {}) {
  return {
    ...provider,
    auth: { status: "authenticated", email },
    rateLimits: { ...provider.rateLimits, planType },
    ...overrides,
  } as ServerProvider;
}

const panels = (html: string) => html.match(/<section/g)?.length ?? 0;

describe("native provider limits", () => {
  it("shows the same snapshot pace and preserves unavailable usage", () => {
    const html = render([node("M5", [provider])]);
    expect(html).toContain("20 percentage points below even pace");
    const unknown = {
      ...provider,
      rateLimits: { primary: { ...provider.rateLimits!.primary!, usedPercent: NaN } },
    };
    const invalid = render([node("M5", [unknown])]);
    expect(invalid).toContain("Unavailable");
    expect(invalid).not.toContain("100% left");
  });

  it("does not trust retained windows on an unavailable provider or disconnected environment", () => {
    const unavailable = { ...provider, availability: "unavailable" as const };
    for (const html of [
      render([node("M5", [unavailable])]),
      render([node("M5", [provider], false)]),
    ]) {
      expect(html).toContain("Pace unavailable");
      expect(html).not.toContain("below even pace");
    }
  });

  it("shows an account signed in on two devices once, with a reset block per device", () => {
    const shared = account("me@example.com", "plus");
    const html = render(
      [node("M5", [shared]), node("M4", [shared])],
      (environmentId) => environmentId === "M5",
    );
    expect(panels(html)).toBe(1);
    expect(html).toContain("Plus · on M5 · M4");
    expect(html).not.toContain("me@example.com");
    expect(html).toContain('data-env="M5" data-instance="test" data-allowed="true"');
    expect(html).toContain('data-env="M4" data-instance="test" data-allowed="false"');
    expect(html).toContain("test on M5");
    expect(html).toContain("test on M4");
  });

  it("names the device of each account when several devices are shown", () => {
    const html = render([
      node("M5", [account("me@example.com", "plus")]),
      node("M4", [account("work@example.com", "plus")]),
    ]);
    expect(panels(html)).toBe(2);
    expect(html).toContain("Plus · on M5");
    expect(html).toContain("Plus · on M4");
    // One device per account: its reset block needs no caption.
    expect(html).not.toContain("test on M5");
  });

  it("keeps redemption gated on sign-in, not on live limits", () => {
    const signedOut = account("me@example.com", "plus", {
      auth: { status: "unauthenticated", email: "me@example.com" },
    });
    expect(render([node("M5", [signedOut])])).toContain('data-allowed="false"');
    const unavailable = account("me@example.com", "plus", { availability: "unavailable" });
    expect(render([node("M5", [unavailable])])).toContain('data-allowed="true"');
  });

  it("keeps the reset block of a Codex instance that reports no windows", () => {
    const windowless = {
      ...provider,
      message: "Usage could not be read.",
      rateLimits: {
        planType: "plus",
        credits: { hasCredits: true, unlimited: false, balance: "12" },
      },
    } as ServerProvider;
    const html = render([node("M5", [windowless])]);
    expect(html).toContain("Codex");
    expect(html).toContain("Plus");
    expect(html).toContain('data-env="M5" data-instance="test" data-allowed="true"');
    expect(html).toContain("Usage could not be read.");
    expect(html).toContain("Credits: 12");
    expect(html).not.toContain("No limits reported");
  });

  it("collapses other instances without limits into one note", () => {
    const copilot = {
      ...provider,
      instanceId: "copilot",
      driver: "copilot",
      displayName: "Copilot",
      rateLimits: undefined,
    } as ServerProvider;
    expect(render([node("M5", [copilot])])).toContain("No limits reported: Copilot");
    const html = render([node("M5", [copilot]), node("M4", [copilot])]);
    expect(html).toContain("No limits reported: Copilot on M5, Copilot on M4");
    expect(panels(html)).toBe(0);
  });

  it("lists every reported window and judges pace at the usage read", () => {
    const observedAt = new Date(now).toISOString();
    const claude = {
      ...provider,
      // The full probe ran 100 minutes before this usage re-read.
      checkedAt: new Date(now - 100 * 60_000).toISOString(),
      rateLimits: {
        primary: provider.rateLimits!.primary,
        windows: [
          { id: "five_hour", ...provider.rateLimits!.primary },
          { id: "seven_day_opus", scope: "Opus", usedPercent: 12, windowDurationMins: 10_080 },
        ],
        observedAt,
      },
    } as ServerProvider;
    const html = render([node("M5", [claude])]);
    expect(html).toContain("5h: 60% left");
    expect(html).toContain("Weekly · Opus: 88% left");
    // Measured from the read, 3 of the 5 hours have passed: 40% used is 20 points below.
    expect(html).toContain("20 percentage points below even pace");
    expect(html).not.toContain("Usage from");
  });

  it("says when the shown usage is the last good read of a throttled provider", () => {
    const observedAt = new Date(now - 12 * 60_000).toISOString();
    const stale = {
      ...provider,
      rateLimits: { ...provider.rateLimits, observedAt, stale: true, staleReason: "rateLimited" },
    } as ServerProvider;
    const html = render([node("M5", [stale])]);
    expect(html).toContain(
      `Usage from ${new Date(observedAt).toLocaleString()}; the provider is limiting usage reads.`,
    );
    expect(html).not.toContain("Checked ");
  });

  it("shows every account a hub pools and their pooled windows, never an email", () => {
    const html = render([
      node("M5", [], true, [
        hub([
          hubAccount("a", 40, { email: "alice@example.com" }),
          hubAccount("b", 60, { label: "Team seat" }),
        ]),
      ]),
    ]);
    expect(html).toContain("Claude");
    expect(html).toContain("5h · avg of 2 accounts: 50% left");
    expect(html).toContain("Account 1");
    expect(html).toContain("Team seat");
    expect(html).toContain("Max · via Home hub");
    expect(html).toContain("5h: 60% left");
    expect(html).toContain("5h: 40% left");
    expect(html).not.toContain("alice@example.com");
    expect(html).not.toContain("No enabled providers");
  });

  it("names an instance a hub serves instead of showing its own limits", () => {
    const claude = {
      ...provider,
      instanceId: "claude",
      driver: "claudeAgent",
      displayName: "Claude",
    };
    const html = render([
      node("M5", [claude as ServerProvider], true, [hub([hubAccount("a", 10)], ["claude"])]),
    ]);
    expect(html).toContain(
      "Claude is routed through Home hub, so it uses the hub&#x27;s accounts and its own limits are not shown.",
    );
    // Its own 40% used window is not shown; the hub account's 10% is.
    expect(html).not.toContain("60% left");
    expect(html).toContain("5h: 90% left");
  });

  it("says why a device's hubs are missing", () => {
    const html = render([
      {
        ...node("M5", [provider]),
        hubsMessage: "Update Ryco on this node to read CLIProxyAPI hubs.",
      },
    ]);
    expect(html).toContain("Update Ryco on this node to read CLIProxyAPI hubs.");
    expect(html).toContain("60% left");
  });

  it("says when no provider is enabled", () => {
    const disabled = { ...provider, enabled: false };
    expect(render([node("M5", [disabled])])).toContain("No enabled providers on this device.");
    expect(render([node("M5", []), node("M4", [])])).toContain(
      "No enabled providers on these devices.",
    );
  });
});
