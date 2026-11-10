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
  THREAD_LIST_ESTIMATED_ROW_SIZE,
  threadListRowType,
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

  it("flags the sent messages that offer Edit from here, and drops the flag while busy", () => {
    const annotate = createThreadListRowAnnotator();
    const user = MessageId.make("user-1");
    const editable = annotate(rows, {
      forkableMessageIds: NONE,
      editableMessageIds: new Set([user]),
      highlightedMessageId: null,
    });
    expect(editable[0]).toMatchObject({ editable: true, id: rows[0]!.id });
    expect(editable[1]).toBe(rows[1]);

    const busy = annotate(rows, {
      forkableMessageIds: NONE,
      editableMessageIds: NONE,
      highlightedMessageId: null,
    });
    expect(busy[0]).toBe(rows[0]);
  });

  it("flags the replies that offer Undo file changes, alongside their fork button", () => {
    const annotate = createThreadListRowAnnotator();
    const forkable = annotate(rows, {
      forkableMessageIds: new Set([reply]),
      highlightedMessageId: null,
    });
    const undoable = annotate(rows, {
      forkableMessageIds: new Set([reply]),
      undoableMessageIds: new Set([reply]),
      highlightedMessageId: null,
    });
    expect(undoable[2]).toMatchObject({ forkable: true, undoable: true, id: rows[2]!.id });
    // The undo button appearing is a new item for that row alone.
    expect(undoable[2]).not.toBe(forkable[2]);
    expect(undoable[1]).toBe(rows[1]);
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

  it("flags only the plan that can be implemented now", () => {
    const plan = (id: string): ThreadTimelineRow => {
      const entry = {
        id: `proposed-plan:${id}`,
        kind: "proposed-plan",
        createdAt: "2026-10-11T10:00:00.000Z",
        proposedPlan: { id, turnId: null, planMarkdown: "# Plan", implementedAt: null },
      };
      return { kind: "entry", id: entry.id, entry: entry as unknown as TimelineEntry };
    };
    const planRows = [plan("plan-1"), messageRow("reply-1"), plan("plan-2")];
    const annotate = createThreadListRowAnnotator();
    const live = annotate(planRows, {
      forkableMessageIds: NONE,
      highlightedMessageId: null,
      actionablePlanId: "plan-2",
    });
    expect(live[0]).toBe(planRows[0]);
    expect(live[2]).toMatchObject({ planActionable: true });
    // Implemented (or a new turn started): the buttons go, a new item for that row alone.
    const done = annotate(planRows, {
      forkableMessageIds: NONE,
      highlightedMessageId: null,
      actionablePlanId: null,
    });
    expect(done[2]).toBe(planRows[2]);
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

describe("threadListRowType", () => {
  const fold = (expanded: boolean): ThreadTimelineRow => ({
    kind: "activity-fold",
    id: `fold-${String(expanded)}`,
    turnId: null,
    status: "settled",
    label: "Read 3 files",
    durationLabel: null,
    rows: [],
    expanded,
    liveThought: null,
  });

  it("names each row kind the feed shows", () => {
    expect(
      [messageRow("u", "user"), messageRow("r"), fold(false), fold(true)].map(threadListRowType),
    ).toEqual(["sent", "reply", "fold", "fold-open"]);
  });

  /**
   * An older page loads above the reader: the list places its rows by the averages of the rows it
   * measured. A turn here is a sent message, two closed folds and a reply, at heights from the
   * rows' styles (80, 36, 36 and 260 pt); the reader has measured the newest 8 turns, one with a
   * long reply. Total misplacement of the 40 prepended rows, in points.
   */
  it("places an older page closer to its real height with an average per kind", () => {
    const heights: Record<string, number> = { sent: 80, fold: 36, reply: 260 };
    const turn = [messageRow("u", "user"), fold(false), fold(false), messageRow("r")];
    const measured = Array.from({ length: 8 }, (_, index) =>
      turn.map((row) => {
        const type = threadListRowType(row);
        return { type, size: type === "reply" && index === 0 ? 900 : heights[type]! };
      }),
    ).flat();
    const older = Array.from({ length: 10 }, () => turn).flat();
    const real = older.reduce((sum, row) => sum + heights[threadListRowType(row)]!, 0);

    const average = (sizes: ReadonlyArray<number>) =>
      sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
    const single = average(measured.map((row) => row.size)) * older.length;
    const perKind = older.reduce(
      (sum, row) =>
        sum +
        average(
          measured.filter((entry) => entry.type === threadListRowType(row)).map((e) => e.size),
        ),
      0,
    );
    // The whole page is off by the same amount either way (the long reply skews both)...
    expect(Math.round(Math.abs(single - real))).toBe(Math.round(Math.abs(perKind - real)));
    // ...but row by row, which is what jumps while the reader scrolls into the page, a single
    // average (123 pt) makes every fold ~90 pt too tall and every reply ~140 pt too short, while
    // per kind only the replies carry the long one's share (340 pt).
    const rowError = (estimate: (type: string) => number) =>
      older.reduce((sum, row) => {
        const type = threadListRowType(row);
        return sum + Math.abs(estimate(type) - heights[type]!);
      }, 0);
    const singleAverage = average(measured.map((row) => row.size));
    expect(Math.round(rowError(() => singleAverage))).toBe(3_540);
    expect(
      Math.round(
        rowError((type) =>
          average(measured.filter((entry) => entry.type === type).map((e) => e.size)),
        ),
      ),
    ).toBe(800);
    expect(THREAD_LIST_ESTIMATED_ROW_SIZE).toBeGreaterThanOrEqual(36);
  });
});
