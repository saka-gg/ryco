import type { TimelineEntry } from "@ryco/client-runtime/state/session";
import {
  deriveForkableReplyMessageIds,
  threadForkBoundaryQuote,
  type ChatMessage,
} from "@ryco/client-runtime/state/threads";
import { EnvironmentId, MessageId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadTimelineRows, type ThreadTimelineRow } from "./threadActivityFold";
import {
  createThreadListRowAnnotator,
  nextThreadMessageAnchorStep,
  resolveOpenThreadNavigation,
  threadMessageRowIndex,
} from "./threadTimelineList";

function messageRow(id: string, role: ChatMessage["role"] = "assistant"): ThreadTimelineRow {
  const message = {
    id: MessageId.make(id),
    role,
    text: `text of ${id}`,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-10-11T10:00:00.000Z",
    streaming: false,
  } as ChatMessage;
  const entry = { id: `message:${id}`, kind: "message", createdAt: message.createdAt, message };
  return { kind: "entry", id: entry.id, entry: entry as TimelineEntry };
}

const NONE: ReadonlySet<MessageId> = new Set();

describe("createThreadListRowAnnotator", () => {
  const rows = [messageRow("user-1", "user"), messageRow("reply-1"), messageRow("reply-2")];
  const reply = MessageId.make("reply-2");

  it("hands LegendList a new item for exactly the rows whose fork button appears or goes", () => {
    const annotate = createThreadListRowAnnotator();
    const before = annotate(rows, { forkableMessageIds: NONE, highlightedMessageId: null });
    expect(before).toEqual(rows);
    expect(before.every((row, index) => row === rows[index])).toBe(true);

    // The node became ready without the thread changing: only the reply's item changes, so
    // LegendList (which memoizes each mounted row on its item) re-renders that row alone.
    const ready = annotate(rows, {
      forkableMessageIds: new Set([reply]),
      highlightedMessageId: null,
    });
    expect(ready[2]).not.toBe(rows[2]);
    expect(ready[2]).toMatchObject({ forkable: true, id: rows[2]!.id });
    expect(ready[0]).toBe(rows[0]);
    expect(ready[1]).toBe(rows[1]);

    // Unchanged flags keep the item, so streaming elsewhere re-renders nothing here.
    const again = annotate(rows, {
      forkableMessageIds: new Set([reply]),
      highlightedMessageId: null,
    });
    expect(again[2]).toBe(ready[2]);

    // Disconnected: the button goes, which is again a new item for that row.
    const gone = annotate(rows, { forkableMessageIds: NONE, highlightedMessageId: null });
    expect(gone[2]).toBe(rows[2]);
    expect(gone[2]).not.toBe(ready[2]);
  });

  describe("a turn that answered with a page and ended on a blank reply", () => {
    const turnId = TurnId.make("turn-page");
    const chat = (id: string, overrides: Partial<ChatMessage>): ChatMessage =>
      ({
        id: MessageId.make(id),
        role: "assistant",
        text: "",
        turnId,
        createdAt: "2026-10-11T10:00:00.000Z",
        streaming: false,
        ...overrides,
      }) as ChatMessage;
    const user = chat("user", { role: "user", text: "Chart it", turnId: null });
    const page = chat("page", {
      attachments: [
        {
          type: "file",
          id: "page.html",
          name: "page.html",
          mimeType: "text/html",
          sizeBytes: 2048,
          htmlRender: { title: "Bundle report", height: 320 },
        },
      ],
    });
    const blank = chat("blank", {});

    /** What the thread screen derives: the forkable replies and the flagged list rows. */
    function screen(messages: ReadonlyArray<ChatMessage>) {
      const forkableMessageIds = deriveForkableReplyMessageIds({
        messages,
        latestTurn: { turnId, state: "completed" },
        session: null,
      });
      const entries = messages.map((message): TimelineEntry => ({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      }));
      const rows = buildThreadTimelineRows({
        entries,
        runningTurnId: null,
        expandedFoldIds: new Set(),
        now: "2026-10-11T10:01:00.000Z",
      });
      const annotate = createThreadListRowAnnotator();
      return {
        forkableMessageIds,
        rows: annotate(rows, { forkableMessageIds, highlightedMessageId: null }),
      };
    }

    it.each([
      ["the page, then the blank reply", [user, page, blank]],
      ["a blank placeholder the provider opened before the page", [user, blank, page]],
    ])("offers the fork from the blank reply on the page's row (%s)", (_shape, messages) => {
      const { forkableMessageIds, rows } = screen(messages);
      // The shared boundary rule (the node's too) ends this turn on the blank reply.
      expect([...forkableMessageIds]).toEqual([blank.id]);
      // That reply has no row of its own; the page stands in for it and offers its fork.
      expect(rows.map((row) => row.id)).toEqual(["user", "page"]);
      const pageRow = rows[1]!;
      expect(pageRow).toMatchObject({ forkable: true });
      expect(pageRow.kind === "entry" ? pageRow.forkReply?.id : null).toBe(blank.id);
      // The sheet quotes what the turn published, not the empty reply.
      expect(threadForkBoundaryQuote(messages, blank.id)).toBe("Bundle report");
    });

    it.each([
      ["the page, then the blank reply", [user, page, blank]],
      ["a blank placeholder the provider opened before the page", [user, blank, page]],
    ])("anchors a link to the blank reply on the page's row (%s)", (_shape, messages) => {
      // A fork from this turn links back to its boundary, the blank reply.
      const { rows } = screen(messages);
      expect(threadMessageRowIndex(rows, blank.id)).toBe(1);
      expect(threadMessageRowIndex(rows, page.id)).toBe(1);
      // Loaded already: scroll there, never ask the node for the history around it.
      expect(
        nextThreadMessageAnchorStep({
          rows,
          messageId: blank.id,
          loadRequested: false,
          historyReady: true,
        }),
      ).toEqual({ kind: "scroll", index: 1 });
      const annotate = createThreadListRowAnnotator();
      const shown = annotate(rows, { forkableMessageIds: NONE, highlightedMessageId: blank.id });
      expect(shown[1]).toMatchObject({ highlighted: true });
      expect(shown[0]).not.toHaveProperty("highlighted");
    });
  });

  it("flags the anchored message for its highlight", () => {
    const annotate = createThreadListRowAnnotator();
    const shown = annotate(rows, {
      forkableMessageIds: NONE,
      highlightedMessageId: MessageId.make("reply-1"),
    });
    expect(shown[1]).toMatchObject({ highlighted: true });
    expect(shown[1]).not.toHaveProperty("forkable");
  });
});

describe("nextThreadMessageAnchorStep", () => {
  const rows = [messageRow("reply-1"), messageRow("reply-2")];

  it("scrolls to a loaded message, loads around one that is not, and only once", () => {
    expect(
      nextThreadMessageAnchorStep({
        rows,
        messageId: MessageId.make("reply-2"),
        loadRequested: false,
        historyReady: true,
      }),
    ).toEqual({ kind: "scroll", index: 1 });
    const older = MessageId.make("reply-old");
    expect(
      nextThreadMessageAnchorStep({
        rows,
        messageId: older,
        loadRequested: false,
        historyReady: true,
      }),
    ).toEqual({ kind: "load" });
    expect(
      nextThreadMessageAnchorStep({
        rows,
        messageId: older,
        loadRequested: true,
        historyReady: true,
      }),
    ).toEqual({ kind: "wait" });
    // No history window yet (the detail snapshot is still on its way): wait for it.
    expect(
      nextThreadMessageAnchorStep({
        rows: [],
        messageId: older,
        loadRequested: false,
        historyReady: false,
      }),
    ).toEqual({ kind: "wait" });
  });
});

describe("resolveOpenThreadNavigation", () => {
  const environmentId = EnvironmentId.make("env-fork");
  const source = ThreadId.make("source-thread");
  const messageId = MessageId.make("reply-1");

  it("pushes the source thread opened at the fork's reply", () => {
    expect(
      resolveOpenThreadNavigation({
        state: {
          index: 0,
          routes: [
            { key: "thread-fork", name: "Thread", params: { environmentId, threadId: "fork" } },
          ],
        },
        environmentId,
        threadId: source,
        messageId,
      }),
    ).toEqual({ kind: "push", params: { environmentId, threadId: source, messageId } });
    expect(
      resolveOpenThreadNavigation({
        state: undefined,
        environmentId,
        threadId: source,
        messageId: null,
      }),
    ).toEqual({ kind: "push", params: { environmentId, threadId: source } });
  });

  it("goes back to the source when it is the previous screen, pointing it at the reply", () => {
    const state = {
      index: 1,
      routes: [
        { key: "thread-source", name: "Thread", params: { environmentId, threadId: source } },
        { key: "thread-fork", name: "Thread", params: { environmentId, threadId: "fork" } },
      ],
    };
    expect(
      resolveOpenThreadNavigation({ state, environmentId, threadId: source, messageId }),
    ).toEqual({ kind: "back", anchor: { routeKey: "thread-source", params: { messageId } } });
    expect(
      resolveOpenThreadNavigation({ state, environmentId, threadId: source, messageId: null }),
    ).toEqual({ kind: "back", anchor: null });
    // Another environment's thread with the same id is not the previous screen.
    expect(
      resolveOpenThreadNavigation({
        state,
        environmentId: EnvironmentId.make("env-other"),
        threadId: source,
        messageId,
      }).kind,
    ).toBe("push");
  });
});
