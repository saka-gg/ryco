import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@ryco/contracts";

const state = vi.hoisted(() => ({ notices: [] as unknown[], undo: vi.fn(), announce: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useEffect: (callback: () => void) => callback(),
}));
vi.mock("react-native", () => ({
  View: "View",
  Pressable: "Pressable",
  AccessibilityInfo: { announceForAccessibility: state.announce },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 12 }) }));
vi.mock("./AppText", () => ({ AppText: "Text" }));
vi.mock("../state/sidebarUndo", () => ({
  sidebarUndo: { undo: state.undo },
  sidebarUndoNotices: { subscribe: vi.fn(), read: () => state.notices },
}));
import { SidebarUndoNoticeHost } from "./SidebarUndoNoticeHost";

beforeEach(() => {
  vi.clearAllMocks();
  state.notices = [];
});
it("presents each scoped native action with an accessible Undo control", () => {
  state.notices = ["archive", "settle", "snooze", "unpin"].map((action, id) => ({
    id,
    action,
    target: {
      environmentId: EnvironmentId.make("synthetic-node"),
      threadId: ThreadId.make(action),
    },
    pending: id === 3,
  }));
  const root = SidebarUndoNoticeHost() as ReactElement<{
    children: ReactElement<{ children: ReactElement[] }>[];
    style: { bottom: number };
  }>;
  expect(root.props.style.bottom).toBe(28);
  root.props.children.forEach((row, id) => {
    const button = row.props.children[1] as ReactElement<{
      accessibilityRole: string;
      accessibilityLabel: string;
      disabled: boolean;
      onPress: () => void;
    }>;
    expect(button.props.accessibilityRole).toBe("button");
    expect(button.props.accessibilityLabel).toBe(
      `Undo ${["archive", "settle", "snooze", "unpin"][id]}`,
    );
    expect(button.props.disabled).toBe(id === 3);
    if (!button.props.disabled) button.props.onPress();
  });
  expect(state.undo.mock.calls).toEqual([[0], [1], [2]]);
});
it("announces the available action and renders no expired notices", () => {
  state.notices = [{ id: 1, action: "archive", pending: false }];
  SidebarUndoNoticeHost();
  expect(state.announce).toHaveBeenCalledWith("Task archived. Undo available.");
  state.notices = [];
  const root = SidebarUndoNoticeHost() as ReactElement<{ children: unknown[] }>;
  expect(root.props.children).toEqual([]);
});
