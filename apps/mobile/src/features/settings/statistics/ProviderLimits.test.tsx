import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerProvider } from "@ryco/contracts";

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
import { ProviderLimits } from "./ProviderLimits";

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

describe("native provider limits", () => {
  it("shows the same snapshot pace and preserves unavailable usage", () => {
    const html = renderToStaticMarkup(<ProviderLimits providers={[provider]} connected />);
    expect(html).toContain("20 percentage points below even pace");
    const unknown = {
      ...provider,
      rateLimits: { primary: { ...provider.rateLimits!.primary!, usedPercent: NaN } },
    };
    const invalid = renderToStaticMarkup(<ProviderLimits providers={[unknown]} connected />);
    expect(invalid).toContain("Unavailable");
    expect(invalid).not.toContain("100% left");
  });
  it("does not trust retained windows on an unavailable provider or disconnected environment", () => {
    const unavailable = { ...provider, availability: "unavailable" as const };
    for (const html of [
      renderToStaticMarkup(<ProviderLimits providers={[unavailable]} connected />),
      renderToStaticMarkup(<ProviderLimits providers={[provider]} connected={false} />),
    ]) {
      expect(html).toContain("Pace unavailable");
      expect(html).not.toContain("below even pace");
    }
  });
});
