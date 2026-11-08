import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement } from "react";
import type { InboxSection, InboxThreadRow } from "./inboxModel";

const baseRow = {
  key: "node:task",
  environmentId: "node",
  threadId: "task",
  title: "Task",
  attentionState: "active",
  mutationEnabled: true,
  canSettle: true,
  canSnooze: true,
  canArchive: true,
  pinned: false,
} as unknown as InboxThreadRow;

const rpc = vi.hoisted(() => ({
  dispatch: vi.fn(),
  lookup: vi.fn(),
  alert: vi.fn(),
  customSnooze: vi.fn(),
}));
// Effects run as the component renders; their cleanups run after each test.
const effectCleanups = vi.hoisted((): Array<() => void> => []);
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => (() => void) | void) => {
    const cleanup = effect();
    if (cleanup) effectCleanups.push(cleanup);
  },
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(value: T) => [value, vi.fn()],
}));
vi.mock("react-native", () => ({
  Alert: { alert: rpc.alert },
  Pressable: "Pressable",
  View: "View",
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#000" }));
vi.mock("../threadList/ThreadSwipeable", () => ({
  ThreadSwipeable: "ThreadSwipeable",
  SwipeableScrollGateProvider: "SwipeableScrollGateProvider",
  useSwipeableScrollGate: () => ({ swipeEnabled: true, scrollGateHandlers: {} }),
}));
const pins = vi.hoisted(() => ({ change: vi.fn() }));
vi.mock("../../state/threadPins", () => ({ changeThreadPin: pins.change }));
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

import { dispatchHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
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
  const row = { ...baseRow, ...overrides } as InboxThreadRow;
  const menuRow = listOf(
    render(InboxScreen, {
      sections: [],
      emptyState: null,
      nowMs: Date.UTC(2026, 9, 12, 9),
      onOpenThread: vi.fn(),
      onEmptyAction: vi.fn(),
    }),
  ).props.renderItem({ item: { kind: "thread", row } });
  expect(menuRow.type).toBe(InboxThreadMenuRow);
  return menuOf((render(InboxThreadMenuRow, menuRow.props) as ReactElement<SwipeProps>).props);
}

type SwipeProps = {
  leadingAction: { label: string; onPress: () => void };
  primaryAction: { label: string; onPress: () => void } | null;
  secondaryAction: {
    label: string;
    menu: { actions: { id: string }[]; onPressAction: (event: string) => void };
  } | null;
  children: ReactElement<MenuProps>;
};

/** The swipeable row InboxThreadMenuRow renders for `row`. */
function swipeableOf(row: InboxThreadRow): SwipeProps {
  const element = render(InboxThreadMenuRow, {
    row,
    snoozeMenuPresets: [{ id: "hour", label: "In 1 hour" }],
    onOpenThread: vi.fn(),
  }) as ReactElement<SwipeProps>;
  expect(element.type).toBe("ThreadSwipeable");
  return element.props;
}

function menuOf(swipe: SwipeProps): MenuProps {
  return swipe.children.props;
}

/** The LegendList inside the scroll gate provider. */
function listOf(element: ReactElement): ReactElement<{
  renderItem: (props: unknown) => ReactElement;
}> {
  return (element as ReactElement<{ children: ReactElement }>).props.children as ReactElement<{
    renderItem: (props: unknown) => ReactElement;
  }>;
}

afterEach(() => {
  for (const cleanup of effectCleanups.splice(0)) cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  rpc.dispatch.mockResolvedValue(undefined);
  rpc.lookup.mockReturnValue({ orchestration: { dispatchCommand: rpc.dispatch } });
});

it.each(["active", "settled"] as const)(
  "dispatches the %s row action to its own machine",
  async (attentionState) => {
    const props = menu({ attentionState });
    const action = attentionState === "settled" ? "unsettle" : "settle";
    props.onPressAction({ nativeEvent: { event: action } });
    await vi.waitFor(() => expect(rpc.lookup).toHaveBeenCalledWith("node"));
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
  it("reports a connection lost between rendering and the tap", async () => {
    rpc.lookup.mockImplementationOnce(() => {
      throw new Error("Disconnected");
    });
    menu().onPressAction({ nativeEvent: { event: "settle" } });
    await vi.waitFor(() =>
      expect(rpc.alert).toHaveBeenCalledWith("Could not update task", "Disconnected"),
    );
  });
});

describe("inbox snooze menu", () => {
  it("offers three hours and a custom time after the presets", () => {
    const ids = menu().actions.map((action) => action.id);
    expect(ids.slice(0, 4)).toEqual(["pin", "settle", "hour", "three-hours"]);
    // Custom… closes the snooze choices; Hide and Archive follow, Copy task ID ends the menu.
    expect(ids.slice(-4)).toEqual(["snooze-custom", "hide", "archive", "copy-id"]);
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

describe("inbox swipe actions", () => {
  it("archives on the primary swipe action", async () => {
    swipeableOf(baseRow).primaryAction!.onPress();
    await vi.waitFor(() =>
      expect(rpc.dispatch).toHaveBeenCalledWith({
        type: "thread.archive",
        threadId: "task",
        commandId: "command",
      }),
    );
  });

  it("offers no archive while it cannot run, and no snooze on a snoozed row", () => {
    const swipe = swipeableOf({
      ...baseRow,
      canArchive: false,
      snoozedUntil: "2026-10-14T08:30:00.000Z",
    });
    expect(swipe.primaryAction).toBeNull();
    expect(swipe.secondaryAction).toBeNull();
  });

  it("snoozes from the swipe menu", async () => {
    const snooze = swipeableOf(baseRow).secondaryAction!;
    expect(snooze.menu.actions.map((action) => action.id)).toEqual(["hour", "snooze-custom"]);
    snooze.menu.onPressAction("hour");
    await vi.waitFor(() =>
      expect(rpc.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.snooze", threadId: "task" }),
      ),
    );
  });

  it("pins and unpins from the leading swipe and the menu", () => {
    const pin = swipeableOf(baseRow).leadingAction;
    expect(pin.label).toBe("Pin");
    pin.onPress();
    expect(pins.change).toHaveBeenLastCalledWith("node:task", true);
    const pinned = { ...baseRow, pinned: true } as InboxThreadRow;
    expect(swipeableOf(pinned).leadingAction.label).toBe("Unpin");
    menu({ pinned: true }).onPressAction({ nativeEvent: { event: "unpin" } });
    expect(pins.change).toHaveBeenLastCalledWith("node:task", false);
  });
});

describe("inbox thread jumps", () => {
  const row = (key: string) => ({ key, environmentId: "node", threadId: key }) as InboxThreadRow;
  const sections: InboxSection[] = [
    { key: "active", title: "Active", rows: [row("first"), row("second")] },
    { key: "settled", title: "Settled", rows: [row("settled")] },
  ];

  it("opens the thread row at a jump's number, as the list shows it", () => {
    const onOpenThread = vi.fn();
    render(InboxScreen, {
      sections,
      emptyState: null,
      nowMs: Date.UTC(2026, 9, 12, 9),
      onOpenThread,
      onEmptyAction: vi.fn(),
    });

    expect(dispatchHardwareKeyboardCommand("thread.jump.2")).toBe(true);
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(sections[0]!.rows[1]);
    // The settled shelf starts collapsed, so its row has no number.
    dispatchHardwareKeyboardCommand("thread.jump.3");
    expect(onOpenThread).toHaveBeenCalledTimes(1);
  });

  it("stops handling jumps once the list is gone", () => {
    render(InboxScreen, {
      sections,
      emptyState: null,
      nowMs: Date.UTC(2026, 9, 12, 9),
      onOpenThread: vi.fn(),
      onEmptyAction: vi.fn(),
    });
    for (const cleanup of effectCleanups.splice(0)) cleanup();
    expect(dispatchHardwareKeyboardCommand("thread.jump.1")).toBe(false);
  });
});
