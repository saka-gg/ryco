import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

// The sheet's stateless pieces invoked as plain functions with react-native mocked (no React
// renderer exists in this suite): the control under the context bar, and an agent row with its
// status, time, unfolded details and Stop.

vi.mock("react-native", () => ({
  Alert: { alert: () => undefined },
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#888888" }));
vi.mock("../../connection/environmentApi", () => ({ ensureEnvironmentApi: () => undefined }));
vi.mock("../../state/threadsRuntime", () => ({
  isArchivedThreadStub: () => false,
  selectDelegatedChildThreadsForThreadRef: () => [],
  useStore: () => [],
}));
vi.mock("./sessionActions", () => ({ stopThreadSubagent: async () => undefined }));

import { ThreadAgentRowView, ThreadAgentsButton } from "./ThreadAgentsSheet";
import type { ThreadAgentRow } from "./threadAgentsSheetModel";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const children = element.props.children;
  // Mapped lists nest arrays inside the children array.
  return [element, ...[children].flat(Infinity).flatMap(elements)];
}

function texts(nodes: ReadonlyArray<ReactElement<Record<string, unknown>>>): string[] {
  return nodes
    .filter((node) => node.type === "Text")
    .map((node) => {
      const children = node.props.children;
      return Array.isArray(children) ? children.join("") : String(children);
    });
}

const row: ThreadAgentRow = {
  key: "agent:a",
  label: "Map the relay client",
  role: "Explore",
  statusLabel: "Running",
  tone: "working",
  activity: "Reading ws.ts",
  elapsed: "1m 05s",
  childThreadId: null,
  details: {
    title: "Map how the relay client reconnects after a drop",
    facts: ["opus-4 · high", "12.4k tokens"],
    recentActivity: [{ at: "2026-08-10T10:00:00.000Z", summary: "Grep reconnect" }],
    outcome: null,
  },
  stop: { taskId: "a", runtimeSessionId: "rt-1", attempt: 0 },
};

function renderRow(overrides: Partial<Parameters<typeof ThreadAgentRowView>[0]> = {}) {
  return elements(
    ThreadAgentRowView({
      row,
      divided: false,
      expanded: false,
      stopping: false,
      onPress: () => undefined,
      onStop: () => undefined,
      ...overrides,
    }),
  );
}

describe("thread agents control", () => {
  it("says how many agents are active, in the live color", () => {
    const onPress = vi.fn();
    const nodes = elements(
      ThreadAgentsButton({
        entry: {
          label: "2 agents active",
          live: true,
          accessibilityLabel: "2 agents active. Show agents.",
        },
        onPress,
      }),
    );
    const button = nodes[0]!;
    expect(button.props.accessibilityLabel).toBe("2 agents active. Show agents.");
    expect(texts(nodes)).toEqual(["2 agents active"]);
    expect(String(nodes.find((node) => node.type === "Text")?.props.className)).toContain(
      "text-accent-strong",
    );
    (button.props.onPress as () => void)();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("thread agent row", () => {
  it("leads with the agent, its status and live time, and what it is doing", () => {
    const nodes = renderRow();
    expect(texts(nodes)).toEqual([
      "Map the relay client",
      "Explore",
      "Running · 1m 05s",
      "Reading ws.ts",
      "Stop",
    ]);
    expect(nodes[1]?.props.accessibilityState).toEqual({ expanded: false });
  });

  it("unfolds the task, facts and recent activity when opened", () => {
    expect(texts(renderRow({ expanded: true }))).toEqual([
      "Map the relay client",
      "Explore",
      "Running · 1m 05s",
      "Reading ws.ts",
      "Map how the relay client reconnects after a drop",
      "opus-4 · high · 12.4k tokens",
      "Grep reconnect",
      "Stop",
    ]);
  });

  it("offers Stop only when the row carries a stop, and holds it while one is on its way", () => {
    expect(texts(renderRow({ row: { ...row, stop: null } }))).not.toContain("Stop");
    const stopping = renderRow({ stopping: true });
    expect(texts(stopping)).toContain("Stopping…");
    const stopButton = stopping.find(
      (node) => node.props.accessibilityLabel === "Stop Map the relay client",
    );
    expect(stopButton?.props.disabled).toBe(true);
  });

  it("opens a delegated task instead of unfolding", () => {
    const nodes = renderRow({
      row: { ...row, childThreadId: "child-1" as never, details: null, stop: null, role: null },
    });
    const button = nodes[1]!;
    expect(button.props.accessibilityHint).toBe("Opens the task");
    expect(button.props.accessibilityState).toBeUndefined();
    expect(nodes.find((node) => node.type === "SymbolView")?.props.name).toBe("chevron.right");
  });
});
