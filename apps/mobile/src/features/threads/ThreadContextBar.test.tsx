import type { ReactElement } from "react";
import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// The context bar invoked as a plain function with react-native mocked (no React renderer
// exists in this suite): the pull request watch chip sits beside the change-request badge while
// a watch is on, toned by its state and spoken in full.

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/DeviceIcon", () => ({ DeviceIcon: "DeviceIcon" }));
vi.mock("../../components/ChangeRequestBadge", () => ({
  ChangeRequestBadge: "ChangeRequestBadge",
}));
vi.mock("../../components/CheckSummaryBadge", () => ({ CheckSummaryBadge: "CheckSummaryBadge" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#888888" }));

import { PullRequestWatchChip, ThreadContextBar } from "./ThreadContextBar";
import type { ThreadHeaderModel, ThreadPullRequestWatchChip } from "./threadHeaderModel";

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

function model(pullRequestWatch: ThreadHeaderModel["pullRequestWatch"]): ThreadHeaderModel {
  return {
    title: "Fix CI",
    nodeLabel: "Studio",
    projectLabel: "Ryco",
    worktreeLabel: "feat/ci",
    contextHeading: "Project · Worktree",
    statusLabel: "Ready",
    contextAccessibilityLabel: "",
    reviewVisible: false,
    filesVisible: true,
    terminalVisible: false,
    moreActions: ["rename", "archive", "details"],
    changeRequest: {
      kind: "pull-request",
      label: "#42",
      tone: "open",
      accessibilityLabel: "Pull request 42, open. Last known state.",
    },
    settlementAction: null,
    compactAction: null,
    pullRequestWatch,
  };
}

function render(headerModel: ThreadHeaderModel) {
  return elements(
    ThreadContextBar({
      model: headerModel,
      environmentId: EnvironmentId.make("env-bar"),
      onPress: () => undefined,
    }),
  );
}

describe("thread context bar pull request watch chip", () => {
  it("sits right after the change-request badge while a watch is on", () => {
    const nodes = render(
      model({
        target: { number: 42, url: "https://github.com/o/r/pull/42" },
        startable: true,
        otherWorkspace: false,
        watches: null,
        chip,
      }),
    );
    const badge = nodes.findIndex((element) => element.type === "ChangeRequestBadge");
    const watch = nodes.findIndex((element) => element.type === PullRequestWatchChip);
    expect(badge).toBeGreaterThan(-1);
    expect(watch).toBeGreaterThan(badge);
    expect(nodes[watch]?.props.chip).toBe(chip);
  });

  it("shows no chip without a watch", () => {
    const offered = render(
      model({
        target: { number: 42, url: null },
        startable: true,
        otherWorkspace: false,
        watches: null,
        chip: null,
      }),
    );
    expect(offered.some((element) => element.type === PullRequestWatchChip)).toBe(false);
    expect(render(model(null)).some((element) => element.type === PullRequestWatchChip)).toBe(
      false,
    );
  });

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
