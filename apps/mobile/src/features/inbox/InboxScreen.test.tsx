import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement } from "react";
import type { InboxThreadRow } from "./inboxModel";

const rpc = vi.hoisted(() => ({ dispatch: vi.fn(), lookup: vi.fn(), alert: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T,>(value: T) => [value, vi.fn()],
}));
vi.mock("react-native", () => ({
  Alert: { alert: rpc.alert },
  Pressable: "Pressable",
  View: "View",
}));
vi.mock("@react-native-menu/menu", () => ({ MenuView: "MenuView" }));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: "LegendList" }));
vi.mock("../../connection/environmentApi", () => ({ ensureEnvironmentApi: rpc.lookup }));
vi.mock("../../lib/ids", () => ({ newCommandId: () => "command" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/EmptyState", () => ({ EmptyState: "EmptyState" }));
vi.mock("./InboxThreadRow", () => ({ InboxThreadRow: "InboxThreadRow" }));
vi.mock("../home/WorkspaceConnectionStatus", () => ({
  WorkspaceConnectionStatus: "WorkspaceConnectionStatus",
}));

import { InboxScreen } from "./InboxScreen";

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
  const list = InboxScreen({
    sections: [],
    emptyState: null,
    onOpenThread: vi.fn(),
    onEmptyAction: vi.fn(),
  }) as ReactElement<{ renderItem: (props: unknown) => ReactElement<MenuProps> }>;
  return list.props.renderItem({ item: { kind: "thread", row } }).props;
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
