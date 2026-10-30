import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  deriveFollowUpQueueView,
  type FollowUpQueueRow,
  type QueueHold,
} from "@ryco/client-runtime/state/message-queue";
import type { EnvironmentId, MessageId, QueuedFollowUp, ThreadId } from "@ryco/contracts";

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../lib/useThemeColor", () => ({ useThemeColor: () => "#000" }));
import type { QueuedThreadMessage } from "../../state/threadOutboxModel";
import { ThreadQueuedMessages } from "./ThreadQueuedMessages";

type Element = ReactElement<Record<string, unknown>>;

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}

function texts(tree: Element): string[] {
  return elements(tree)
    .filter((element) => element.type === "Text")
    .map((element) => {
      const children = element.props.children;
      return (Array.isArray(children) ? children : [children]).join("");
    });
}

function controls(tree: Element, label: string): Array<Record<string, unknown>> {
  return elements(tree)
    .filter((element) => element.props.accessibilityLabel === label)
    .map((element) => element.props);
}

const AT = "2026-10-01T10:00:00.000Z";

function entry(id: string, overrides: Partial<QueuedFollowUp> = {}): QueuedFollowUp {
  return {
    messageId: id as MessageId,
    text: `node ${id}`,
    attachments: [],
    modelSelection: { instanceId: "codex", model: "gpt-5" } as QueuedFollowUp["modelSelection"],
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
    status: "queued",
    author: "user",
    ...overrides,
  };
}

const LOCAL: QueuedThreadMessage = {
  environmentId: "env" as EnvironmentId,
  threadId: "t" as ThreadId,
  messageId: "local-1" as MessageId,
  commandId: "cmd" as never,
  text: "from the outbox",
  attachments: [],
  createdAt: AT,
  resumeReviewError: "Review the resume first.",
};

function props(
  view: ReturnType<typeof deriveFollowUpQueueView>,
  overrides: Partial<Parameters<typeof ThreadQueuedMessages>[0]> = {},
) {
  return {
    rows: view.rows,
    hold: view.hold,
    localMessages: new Map([[String(LOCAL.messageId), LOCAL]]),
    onResume: vi.fn(),
    onPause: vi.fn(),
    getSteerUnavailableReason: () => null,
    onSteer: vi.fn(),
    onRetryReview: vi.fn(),
    onRetryHeld: vi.fn(),
    onRetry: vi.fn(),
    onRemove: vi.fn(),
    onEdit: vi.fn(),
    getEditUnavailableReason: () => null,
    onMove: vi.fn(),
    editingId: null,
    onCancelEdit: vi.fn(),
    ...overrides,
  };
}

const VIEW = deriveFollowUpQueueView({
  server: {
    entries: [
      entry("n-1"),
      entry("n-2", {
        status: "failed",
        failure: { reason: "start-failed", detail: "The provider refused it." },
      }),
    ],
    hold: null,
  },
  pending: [{ messageId: "p-1", summary: "on its way", createdAt: AT }],
  local: [{ id: "local-1", summary: "from the outbox", deliveryStatus: "failed", steering: false }],
  localHold: null,
});

describe("thread queue sheet over the node's queue", () => {
  it("lists the node's entries, adds on their way, then the outbox, with a Pause", () => {
    const input = props(VIEW);
    const tree = ThreadQueuedMessages(input) as Element;
    const shown = texts(tree);
    expect(shown).toContain("Queued · 4");
    const order = ["node n-1", "node n-2", "on its way", "from the outbox"].map((text) =>
      shown.indexOf(text),
    );
    expect(
      order.every((index, position) => index >= 0 && index > (order[position - 1] ?? -1)),
    ).toBe(true);
    expect(shown).toContain("Queuing…");
    // The add on its way offers nothing to press; the other three rows each offer Remove.
    expect(controls(tree, "Remove queued message")).toHaveLength(3);
    expect(controls(tree, "Steer queued message into active turn")).toHaveLength(3);

    (controls(tree, "Pause queued messages")[0]!.onPress as () => void)();
    expect(input.onPause).toHaveBeenCalledOnce();
    expect(controls(tree, "Resume queued messages")).toHaveLength(0);
  });

  it("retries the node's failed entry and shows why it failed", () => {
    const input = props(VIEW);
    const tree = ThreadQueuedMessages(input) as Element;
    expect(texts(tree)).toContain("The provider refused it.");
    (controls(tree, "Retry queued message")[0]!.onPress as () => void)();
    expect(input.onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n-2", source: "server", status: "failed" }),
    );
  });

  it("moves only the node's entries, within their own rows", () => {
    const input = props(VIEW);
    const tree = ThreadQueuedMessages(input) as Element;
    const up = controls(tree, "Move queued message up");
    const down = controls(tree, "Move queued message down");
    // Two node entries; the outbox row and the add on their way have none.
    expect(up.map((control) => control.disabled)).toEqual([true, false]);
    expect(down.map((control) => control.disabled)).toEqual([false, true]);
    (down[0]!.onPress as () => void)();
    expect(input.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "n-1" }), "down");
  });

  it("marks the entry being edited, with Cancel instead of its actions", () => {
    const input = props(VIEW, { editingId: "n-1" });
    const tree = ThreadQueuedMessages(input) as Element;
    expect(texts(tree)).toContain("Editing");
    expect(controls(tree, "Steer queued message into active turn")).toHaveLength(2);
    expect(controls(tree, "Remove queued message")[0]!.disabled).toBe(true);
    (controls(tree, "Cancel editing queued message")[0]!.onPress as () => void)();
    expect(input.onCancelEdit).toHaveBeenCalledOnce();
  });

  it("lists the stored attachments the edited entry keeps, each one droppable", () => {
    const onDropEditingAttachment = vi.fn();
    const editingAttachments = [{ id: "img-1", name: "a.png", kind: "image" as const }];
    const input = props(VIEW, { editingId: "n-1", editingAttachments, onDropEditingAttachment });
    const tree = ThreadQueuedMessages(input) as Element;
    expect(texts(tree)).toContain("a.png");
    (controls(tree, "Drop a.png from the queued message")[0]!.onPress as () => void)();
    expect(onDropEditingAttachment).toHaveBeenCalledWith("img-1");
    // While the edit saves, nothing can be dropped.
    const saving = ThreadQueuedMessages(
      props(VIEW, { editingId: "n-1", editingAttachments }),
    ) as Element;
    expect(controls(saving, "Drop a.png from the queued message")[0]!.disabled).toBe(true);
  });

  it("shows the node's hold with Resume instead of Pause", () => {
    const hold: QueueHold = {
      reason: "interrupted",
      detail: null,
      causeKeys: ["interrupt:turn-1"],
      heldAt: AT,
    };
    const view = deriveFollowUpQueueView({
      server: { entries: [entry("n-1")], hold },
      pending: [],
      local: [],
      localHold: null,
    });
    const input = props(view);
    const tree = ThreadQueuedMessages(input) as Element;
    expect(controls(tree, "Pause queued messages")).toHaveLength(0);
    (controls(tree, "Resume queued messages")[0]!.onPress as () => void)();
    expect(input.onResume).toHaveBeenCalledOnce();
  });

  it("keeps the outbox's own retry for a message waiting for review", () => {
    const input = props(VIEW);
    const tree = ThreadQueuedMessages(input) as Element;
    expect(texts(tree)).toContain("Review the resume first.");
    (controls(tree, "Review and retry queued message")[0]!.onPress as () => void)();
    expect(input.onRetryReview).toHaveBeenCalledWith("local-1");
    // The node's Retry is for its own entries only.
    expect(controls(tree, "Retry queued message")).toHaveLength(1);
  });

  it("routes each row's actions with its source", () => {
    const onRemove = vi.fn((_row: FollowUpQueueRow) => {});
    const tree = ThreadQueuedMessages(props(VIEW, { onRemove })) as Element;
    const removes = controls(tree, "Remove queued message");
    for (const remove of removes) (remove.onPress as () => void)();
    expect(onRemove.mock.calls.map(([row]) => [row.id, row.source])).toEqual([
      ["n-1", "server"],
      ["n-2", "server"],
      ["local-1", "local"],
    ]);
  });

  it("offers nothing for an outbox message on its way to the node", () => {
    const view = deriveFollowUpQueueView({
      server: null,
      pending: [],
      local: [
        { id: "moving-1", summary: "moving to the node", steering: false, moving: true },
        { id: "waiting-2", summary: "waits its turn", steering: false },
      ],
      localHold: null,
    });
    const tree = ThreadQueuedMessages(props(view)) as Element;
    expect(texts(tree)).toContain("Queuing…");
    // Its add can still land: an edit or a steer would make a second message.
    expect(controls(tree, "Edit queued message")).toHaveLength(1);
    expect(controls(tree, "Steer queued message into active turn")).toHaveLength(1);
    expect(controls(tree, "Remove queued message")).toHaveLength(1);
  });

  it("renders nothing for an empty queue", () => {
    const view = deriveFollowUpQueueView({ server: null, pending: [], local: [], localHold: null });
    expect(ThreadQueuedMessages(props(view))).toBeNull();
  });
});
