import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { InboxThreadRow as InboxThreadRowModel } from "./inboxModel";

// The row the memo wraps, invoked as a plain function with react-native and the row's
// artwork mocked (no React renderer exists in this suite): its follow-up queue mark.

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/icons", () => ({
  IconFolder: "IconFolder",
  IconGitBranch: "IconGitBranch",
  IconGitFork: "IconGitFork",
  IconMessage: "IconMessage",
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: "ProjectFavicon" }));
vi.mock("../../components/DeviceIcon", () => ({ DeviceIcon: "DeviceIcon" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: "ProviderIcon" }));
vi.mock("../../components/ChangeRequestBadge", () => ({
  ChangeRequestBadge: "ChangeRequestBadge",
}));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#888888" }));
vi.mock("../../lib/time", () => ({ relativeTime: () => "2m" }));

import { InboxThreadRow } from "./InboxThreadRow";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...[element.props.children].flat(Infinity).flatMap(elements)];
}

function texts(nodes: ReadonlyArray<ReactElement<Record<string, unknown>>>): string[] {
  return nodes
    .filter((node) => node.type === "Text")
    .map((node) => [node.props.children].flat().join(""));
}

const row = {
  key: "node:task",
  environmentId: "node",
  threadId: "task",
  title: "Port the queue badge",
  nodeLabel: "Studio",
  projectLabel: "Ryco",
  project: null,
  isChat: false,
  isWorktree: false,
  worktreeLabel: "main",
  contextLabel: "Studio · Ryco · main",
  state: "idle",
  statusLabel: "Idle",
  updatedAt: "2026-10-30T10:00:00.000Z",
  changeRequest: null,
  roleLabel: null,
  followUpQueue: null,
  providerDriver: null,
  providerLabel: null,
  attentionState: "active",
  canSettle: true,
  settlementBlocker: null,
  mutationEnabled: true,
  mutationBlocker: null,
} as unknown as InboxThreadRowModel;

function renderRow(overrides: Partial<InboxThreadRowModel> = {}) {
  const component = InboxThreadRow as unknown as {
    type: (props: { row: InboxThreadRowModel; onPress: () => void }) => ReactElement;
  };
  return elements(component.type({ row: { ...row, ...overrides }, onPress: () => undefined }));
}

describe("inbox thread row follow-up queue mark", () => {
  it("shows nothing for a thread without queued follow-ups", () => {
    const nodes = renderRow();
    expect(texts(nodes)).toEqual(["Port the queue badge", "2m", "Ryco", "main", "Studio"]);
    expect(nodes[0]?.props.accessibilityLabel).toBe(
      "Port the queue badge, Studio · Ryco · main, Original directory, Idle",
    );
  });

  it("says queued in words and reads the queue's sentence to a screen reader", () => {
    const nodes = renderRow({
      followUpQueue: { label: "2 queued", title: "2 queued follow-ups", held: false },
    });
    const mark = nodes.find((node) => node.type === "Text" && node.props.children === "2 queued");
    expect(mark?.props.className).toContain("text-foreground-tertiary");
    expect(nodes[0]?.props.accessibilityLabel).toContain("Idle, 2 queued follow-ups");
  });

  it("says held in words, not only in the warning color", () => {
    const nodes = renderRow({
      followUpQueue: {
        label: "1 held",
        title: "1 queued follow-up: Paused after Stop",
        held: true,
      },
    });
    const mark = nodes.find((node) => node.type === "Text" && node.props.children === "1 held");
    expect(mark?.props.className).toContain("text-warning");
    expect(nodes[0]?.props.accessibilityLabel).toContain("1 queued follow-up: Paused after Stop");
  });
});

describe("inbox thread row Woke mark", () => {
  it("says Woke in words and to a screen reader on an idle row that woke", () => {
    const nodes = renderRow({ woke: true, wokeAt: "2026-10-30T09:00:00.000Z" });
    const mark = nodes.find((node) => node.type === "Text" && node.props.children === "Woke");
    expect(mark?.props.className).toContain("text-warning");
    expect(nodes[0]?.props.accessibilityLabel).toContain("Woke from snooze");
  });

  it("says nothing once the thread was seen", () => {
    const nodes = renderRow({ woke: false, wokeAt: "2026-10-30T09:00:00.000Z" });
    expect(texts(nodes)).not.toContain("Woke");
  });
});
