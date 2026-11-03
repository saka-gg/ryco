import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

// The project screen's task row invoked as a plain function with react-native and its artwork
// mocked (no React renderer exists in this suite): its follow-up queue mark, as the inbox row
// shows it.

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#888888" }));

import { FollowUpQueueMark } from "../../components/FollowUpQueueMark";
import { ProjectThreadRow } from "./ProjectThreadRow";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...[element.props.children].flat(Infinity).flatMap(elements)];
}

const stopped = {
  reason: "interrupted" as const,
  detail: null,
  causeKeys: ["interrupt:turn-1"],
  heldAt: "2026-07-26T08:00:00.000Z",
};

function renderRow(followUpQueueSummary?: SidebarThreadSummary["followUpQueueSummary"]) {
  const thread = {
    id: "task",
    title: "Port the queue badge",
    ...(followUpQueueSummary ? { followUpQueueSummary } : {}),
  } as unknown as SidebarThreadSummary;
  return elements(ProjectThreadRow({ thread, onPress: () => undefined }));
}

describe("project thread row follow-up queue mark", () => {
  it("shows nothing for a thread without queued follow-ups", () => {
    const nodes = renderRow();
    expect(nodes.some((node) => node.type === FollowUpQueueMark)).toBe(false);
    expect(nodes[0]?.props.accessibilityLabel).toBe("Open task Port the queue badge");
  });

  it("marks queued follow-ups and reads the queue's sentence to a screen reader", () => {
    const nodes = renderRow({ count: 2, hold: null, headStatus: "queued", headPreview: "a" });
    const mark = nodes.find((node) => node.type === FollowUpQueueMark);
    expect(mark?.props.badge).toEqual({
      label: "2 queued",
      title: "2 queued follow-ups",
      held: false,
    });
    expect(nodes[0]?.props.accessibilityLabel).toBe(
      "Open task Port the queue badge, 2 queued follow-ups",
    );
  });

  it("marks a held queue as held, with the hold's reason in the spoken label", () => {
    const nodes = renderRow({ count: 1, hold: stopped, headStatus: "queued", headPreview: "b" });
    const mark = nodes.find((node) => node.type === FollowUpQueueMark);
    expect(mark?.props.badge).toEqual({
      label: "1 held",
      title: "1 queued follow-up: Paused after Stop",
      held: true,
    });
    expect(nodes[0]?.props.accessibilityLabel).toBe(
      "Open task Port the queue badge, 1 queued follow-up: Paused after Stop",
    );
  });
});
