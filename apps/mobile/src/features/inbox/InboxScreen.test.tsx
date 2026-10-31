import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement } from "react";
import type { InboxThreadRow } from "./inboxModel";

const rpc = vi.hoisted(() => ({
  dispatch: vi.fn(),
  lookup: vi.fn(),
  alert: vi.fn(),
  customSnooze: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: <T,>(callback: T) => callback,
  useMemo: <T,>(factory: () => T) => factory(),
  useState: <T,>(value: T) => [value, vi.fn()],
}));
vi.mock("react-native", () => ({
  Alert: { alert: rpc.alert },
  Pressable: "Pressable",
  View: "View",
}));
vi.mock("@react-native-menu/menu", () => ({ MenuView: "MenuView" }));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: "LegendList" }));
vi.mock("../../state/sidebarUndo", () => ({
  sidebarUndo: {
    dispatch: (target: { environmentId: string }, command: unknown) =>
      rpc.lookup(target.environmentId).orchestration.dispatchCommand(command),
  },
}));
vi.mock("../../lib/ids", () => ({ newCommandId: () => "command" }));
const copied = vi.hoisted(() => [] as Array<{ value: string; target?: string }>);
vi.mock("../../lib/copyTextWithHaptic", () => ({
  copyTextWithHaptic: (value: string, options: { target?: string } = {}) =>
    copied.push({ value, ...(options.target === undefined ? {} : { target: options.target }) }),
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/EmptyState", () => ({ EmptyState: "EmptyState" }));
vi.mock("./InboxThreadRow", () => ({ InboxThreadRow: "InboxThreadRow" }));
vi.mock("./customSnoozeModel", () => ({ requestCustomSnooze: rpc.customSnooze }));
vi.mock("../home/WorkspaceConnectionStatus", () => ({
  WorkspaceConnectionStatus: "WorkspaceConnectionStatus",
}));

import { InboxScreen, InboxThreadMenuRow } from "./InboxScreen";

/** The function a `memo` wraps, called directly with the hooks above stubbed. */
function render<P>(component: unknown, props: P): ReactElement {
  return (component as { type: (props: P) => ReactElement }).type(props);
}

type MenuProps = {
  actions: { id: string; attributes: { disabled: boolean } }[];
  onPressAction: (event: { nativeEvent: { event: string } }) => void;
};
function menu(overrides: Partial<InboxThreadRow> = {}): MenuProps {
  const row = {
    key: "node:task",
    environmentId: "node",
    threadId: "task",
    attentionState: "active",
    mutationEnabled: true,
    canSettle: true,
    canSnooze: true,
    ...overrides,
  } as InboxThreadRow;
  const list = render(InboxScreen, {
    sections: [],
    emptyState: null,
    nowMs: Date.UTC(2026, 9, 12, 9),
    onOpenThread: vi.fn(),
    onEmptyAction: vi.fn(),
  }) as ReactElement<{ renderItem: (props: unknown) => ReactElement }>;
  const menuRow = list.props.renderItem({ item: { kind: "thread", row } });
  expect(menuRow.type).toBe(InboxThreadMenuRow);
  return (render(InboxThreadMenuRow, menuRow.props) as ReactElement<MenuProps>).props;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.dispatch.mockResolvedValue(undefined);
  rpc.lookup.mockReturnValue({ orchestration: { dispatchCommand: rpc.dispatch } });
});

it.each(["active", "settled"] as const)(
  "dispatches the %s row action to its own machine",
  (attentionState) => {
    const props = menu({ attentionState });
    const action = attentionState === "settled" ? "unsettle" : "settle";
    props.onPressAction({ nativeEvent: { event: action } });
    expect(rpc.lookup).toHaveBeenCalledWith("node");
    expect(rpc.dispatch).toHaveBeenCalledWith({
      type: `thread.${action}`,
      threadId: "task",
      commandId: "command",
      ...(action === "unsettle" ? { reason: "user" } : {}),
    });
  },
);

describe("inbox settlement action guards", () => {
  it.each([{ mutationEnabled: false }, { canSettle: false }])(
    "blocks unavailable actions %o",
    (overrides) => {
      const props = menu(overrides);
      expect(props.actions.find((action) => action.id === "settle")?.attributes.disabled).toBe(
        true,
      );
      props.onPressAction({ nativeEvent: { event: "settle" } });
      expect(rpc.dispatch).not.toHaveBeenCalled();
    },
  );
  it("reports a connection lost between rendering and the tap", () => {
    rpc.lookup.mockImplementationOnce(() => {
      throw new Error("Disconnected");
    });
    menu().onPressAction({ nativeEvent: { event: "settle" } });
    expect(rpc.alert).toHaveBeenCalledWith("Could not update task", "Disconnected");
  });
});

describe("inbox snooze menu", () => {
  it("offers three hours and a custom time after the presets", () => {
    const ids = menu().actions.map((action) => action.id);
    expect(ids.slice(0, 3)).toEqual(["settle", "hour", "three-hours"]);
    expect(ids.at(-2)).toBe("snooze-custom");
    expect(ids.at(-1)).toBe("copy-id");
  });

  it("copies the task's ID from the menu", () => {
    copied.length = 0;
    menu().onPressAction({ nativeEvent: { event: "copy-id" } });
    expect(copied).toEqual([{ value: "task", target: "task ID" }]);
    expect(rpc.dispatch).not.toHaveBeenCalled();
  });

  it("snoozes until the custom time the sheet returns", async () => {
    rpc.customSnooze.mockResolvedValueOnce("2026-10-14T08:30:00.000Z");
    menu().onPressAction({ nativeEvent: { event: "snooze-custom" } });
    await vi.waitFor(() =>
      expect(rpc.dispatch).toHaveBeenCalledWith({
        type: "thread.snooze",
        threadId: "task",
        commandId: "command",
        snoozedUntil: "2026-10-14T08:30:00.000Z",
      }),
    );
  });

  it("sends nothing when the sheet is dismissed or the row cannot snooze", async () => {
    rpc.customSnooze.mockResolvedValueOnce(null);
    menu().onPressAction({ nativeEvent: { event: "snooze-custom" } });
    await Promise.resolve();
    await Promise.resolve();
    menu({ canSnooze: false }).onPressAction({ nativeEvent: { event: "snooze-custom" } });
    expect(rpc.customSnooze).toHaveBeenCalledTimes(1);
    expect(rpc.dispatch).not.toHaveBeenCalled();
  });
});
