import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

// The chip invoked as a plain function with react-native mocked (no React renderer exists in
// this suite): the pull request watch chip beside the context sheet's pull request badge,
// toned by its state and spoken in full.

vi.mock("react-native", () => ({ Pressable: "Pressable", Switch: "Switch", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#888888" }));

import { PullRequestWatchChip } from "./PullRequestWatchViews";
import type { ThreadPullRequestWatchChip } from "./threadHeaderModel";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  return [element, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}

const chip: ThreadPullRequestWatchChip = {
  label: "Fixing 2/3",
  tone: "active",
  accessibilityLabel: "Pull request 42: Fixing CI · attempt 2 of 3. Starting the fix turn.",
};

describe("pull request watch chip", () => {
  it("speaks the whole status and tones the chip by state", () => {
    const [outer, ...inner] = elements(PullRequestWatchChip({ chip }));
    expect(outer?.props).toMatchObject({
      accessible: true,
      accessibilityLabel: chip.accessibilityLabel,
    });
    expect(outer?.props.className).toContain("bg-accent-bg");
    const label = inner.find((element) => element.type === "Text");
    expect(label?.props.children).toBe("Fixing 2/3");
    expect(label?.props.className).toContain("text-accent-strong");

    const [paused] = elements(
      PullRequestWatchChip({ chip: { ...chip, label: "Auto-fix paused", tone: "warning" } }),
    );
    expect(paused?.props.className).toContain("border-warning-border");
  });
});
