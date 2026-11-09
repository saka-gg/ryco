import type { LocalTaskView } from "@ryco/client-runtime/state/tasks";
import { CommandId, MessageId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { calendarMonth, shiftCalendarMonth } from "./taskDueCalendarModel";
import { taskChatSeed } from "./taskChatSeedModel";
import {
  LINKABLE_CHAT_LIMIT,
  linkableTaskChats,
  taskChatRows,
  taskLinkRows,
  titleToSave,
  type TaskThreadInfo,
} from "./taskDetailModel";

const RYCO = ProjectId.make("p-ryco");
const OTHER = ProjectId.make("p-other");

function task(overrides: Partial<LocalTaskView> = {}): LocalTaskView {
  return {
    taskId: "t1",
    revision: 1,
    title: "Ship the push follow-up",
    notes: "Wire the Hub sender.",
    priority: "normal",
    dueAt: null,
    projectId: RYCO,
    links: [],
    files: [],
    state: "todo",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    status: "todo",
    delegations: [],
    optimisticStarts: [],
    creating: false,
    saving: false,
    ...overrides,
  };
}

const thread = (id: string, overrides: Partial<TaskThreadInfo> = {}): TaskThreadInfo => ({
  id: ThreadId.make(id),
  title: `Chat ${id}`,
  projectId: RYCO,
  archivedAt: null,
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...overrides,
});

describe("taskChatRows", () => {
  it("names each chat and says when one is gone", () => {
    const rows = taskChatRows(
      task({
        delegations: [
          {
            commandId: CommandId.make("c1"),
            threadId: ThreadId.make("known"),
            messageId: MessageId.make("m1"),
            sequence: 1,
            branch: "task/ship-push",
            dispatched: true,
            status: "running",
            error: null,
            createdAt: "2026-10-11T00:00:00.000Z",
          },
        ],
        links: [{ kind: "thread", threadId: ThreadId.make("gone") }],
      }),
      () => undefined,
      (threadId) => (threadId === "known" ? thread("known", { title: "Push work" }) : undefined),
    );
    expect(rows).toMatchObject([
      { title: "Push work", word: "Running", branch: "task/ship-push", openable: true },
      { title: "Linked chat", word: "Gone", tone: "gone", linked: true, openable: false },
    ]);
  });
});

describe("taskLinkRows", () => {
  it("labels links and says what tapping one opens", () => {
    const rows = taskLinkRows(
      [
        { kind: "pr", number: 7, url: "https://github.com/a/b/pull/7", title: "Fix it" },
        { kind: "branch", name: "feature/x" },
        { kind: "thread", threadId: ThreadId.make("c") },
      ],
      (threadId) => (threadId === "c" ? thread("c", { title: "Design chat" }) : undefined),
    );
    expect(rows.map((row) => [row.label, row.detail, row.target?.kind ?? null])).toEqual([
      ["#7", "Fix it", "url"],
      ["feature/x", "Branch feature/x", null],
      ["Design chat", "Chat", "thread"],
    ]);
  });
});

describe("linkableTaskChats", () => {
  it("offers the project's live chats the task does not have, most recent first", () => {
    const chats = linkableTaskChats(
      task({ links: [{ kind: "thread", threadId: ThreadId.make("linked") }] }),
      [
        thread("old", { updatedAt: "2026-10-01T00:00:00.000Z" }),
        thread("new", { updatedAt: "2026-10-15T00:00:00.000Z" }),
        thread("linked"),
        thread("archived", { archivedAt: "2026-10-12T00:00:00.000Z" }),
        thread("elsewhere", { projectId: OTHER }),
      ],
    );
    expect(chats.map((chat) => chat.id)).toEqual(["new", "old"]);
  });

  it("offers any project's chats to a task without one, up to the limit", () => {
    const many = Array.from({ length: LINKABLE_CHAT_LIMIT + 3 }, (_, index) =>
      thread(`t${index}`, { projectId: index % 2 ? RYCO : OTHER }),
    );
    expect(linkableTaskChats(task({ projectId: null }), many)).toHaveLength(LINKABLE_CHAT_LIMIT);
  });
});

describe("titleToSave", () => {
  it("saves a changed title on one line, never a blank one", () => {
    expect(titleToSave("  Ship\n push  ", "Old")).toBe("Ship push");
    expect(titleToSave("Old", "Old")).toBeNull();
    expect(titleToSave("   ", "Old")).toBeNull();
  });
});

describe("taskChatSeed", () => {
  it("opens the chat with the task as its message on a new task branch", () => {
    const seed = taskChatSeed(task({ links: [{ kind: "pr", number: 9 }] }), () => null);
    expect(seed).toMatchObject({
      taskId: "t1",
      projectId: RYCO,
      branch: "task/ship-push-follow-up",
      baseBranch: "",
    });
    expect(seed.prompt).toBe(
      "Ship the push follow-up\n\nWire the Hub sender.\n\nLinked:\n- Pull request #9",
    );
  });

  it("branches from a linked branch, numbering the task's later chats", () => {
    const seed = taskChatSeed(
      task({
        links: [{ kind: "branch", name: "mobile/push" }],
        delegations: [
          {
            commandId: CommandId.make("c1"),
            threadId: ThreadId.make("t"),
            messageId: MessageId.make("m"),
            sequence: 1,
            branch: "task/ship-push-follow-up",
            dispatched: true,
            status: "review",
            error: null,
            createdAt: "2026-10-11T00:00:00.000Z",
          },
        ],
      }),
      () => null,
    );
    expect(seed.baseBranch).toBe("mobile/push");
    expect(seed.branch).toBe("task/ship-push-follow-up-2");
  });
});

describe("calendarMonth", () => {
  it("lays a month out in whole weeks from Monday", () => {
    // November 2026 starts on a Sunday.
    const month = calendarMonth(2026, 10);
    expect(month.title).toBe("November 2026");
    expect(month.weeks[0]!.map((day) => day.day)).toEqual([26, 27, 28, 29, 30, 31, 1]);
    expect(month.weeks[0]![6]!.inMonth).toBe(true);
    expect(month.weeks.at(-1)!.at(-1)!.inMonth).toBe(false);
    expect(month.weeks.every((week) => week.length === 7)).toBe(true);
  });

  it("moves across years", () => {
    expect(shiftCalendarMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftCalendarMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});
