import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnvironmentId, ServerProvider } from "@ryco/contracts";

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
): ProviderLimitsNode {
  return { environmentId: label as EnvironmentId, label, connected, providers };
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
      rateLimits: { credits: { hasCredits: true, unlimited: false, balance: "12" } },
    } as ServerProvider;
    const html = render([node("M5", [windowless])]);
    expect(html).toContain("Codex");
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

  it("says when no provider is enabled", () => {
    const disabled = { ...provider, enabled: false };
    expect(render([node("M5", [disabled])])).toContain("No enabled providers on this device.");
    expect(render([node("M5", []), node("M4", [])])).toContain(
      "No enabled providers on these devices.",
    );
  });
});
