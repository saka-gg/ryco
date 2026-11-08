import { dueAtForDay, type LocalTaskView } from "@ryco/client-runtime/state/tasks";
import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTaskRow,
  buildTaskSections,
  countTasksDueToday,
  openableTaskChats,
  taskChips,
  taskMatchesQuery,
  type TaskRowContext,
} from "./tasksListModel";
import { taskSearchResults } from "./taskSearchModel";

// Sunday, Oct 18 2026, 10:00 local time.
const NOW = new Date(2026, 9, 18, 10).getTime();
const day = (offset: number) => dueAtForDay(new Date(2026, 9, 18 + offset, 12).getTime());
const RYCO = ProjectId.make("p-ryco");

function task(taskId: string, overrides: Partial<LocalTaskView> = {}): LocalTaskView {
  return {
    taskId,
    revision: 1,
    title: `Task ${taskId}`,
    notes: "",
    priority: "normal",
    dueAt: null,
    projectId: null,
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

const MAC = EnvironmentId.make("env-mac");
const MINI = EnvironmentId.make("env-mini");

const context: TaskRowContext = {
  environmentId: MAC,
  machineLabel: null,
  offline: false,
  nowMs: NOW,
  projectNames: new Map([[RYCO, "ryco"]]),
  getSummary: () => undefined,
  canStart: true,
};

function delegation(threadId: string, status: LocalTaskView["delegations"][number]["status"]) {
  return {
    commandId: CommandId.make(`command-${threadId}`),
    threadId: ThreadId.make(threadId),
    messageId: MessageId.make(`message-${threadId}`),
    sequence: 1,
    branch: null,
    dispatched: true,
    status,
    error: null,
    createdAt: "2026-10-11T00:00:00.000Z",
  };
}

/** Tasks of one machine, as the merged list takes them. */
const on = (...tasks: LocalTaskView[]) =>
  tasks.map((subject) => ({ environmentId: MAC, task: subject }));
const contextOf = () => context;

describe("buildTaskSections", () => {
  it("files overdue and today under Today, then Upcoming, No date and Done, with counts", () => {
    const sections = buildTaskSections(
      on(
        task("late", { dueAt: day(-2) }),
        task("today", { dueAt: day(0) }),
        task("friday", { dueAt: day(5) }),
        task("someday"),
        task("done", { state: "done", status: "done" }),
      ),
      { environmentId: null, projectId: null, query: "" },
      contextOf,
    );
    expect(sections.map((section) => [section.key, section.count])).toEqual([
      ["today", 2],
      ["upcoming", 1],
      ["none", 1],
      ["done", 1],
    ]);
    expect(sections[0]!.rows.map((row) => row.taskId)).toEqual(["late", "today"]);
  });

  it("sorts a day's tasks by priority, then newest first", () => {
    const sections = buildTaskSections(
      on(
        task("normal-old", { dueAt: day(0), createdAt: "2026-10-01T00:00:00.000Z" }),
        task("normal-new", { dueAt: day(0), createdAt: "2026-10-12T00:00:00.000Z" }),
        task("urgent", { dueAt: day(0), priority: "urgent" }),
      ),
      { environmentId: null, projectId: null, query: "" },
      contextOf,
    );
    expect(sections[0]!.rows.map((row) => row.taskId)).toEqual([
      "urgent",
      "normal-new",
      "normal-old",
    ]);
  });

  it("offers Start on what is due now, and Chat wherever a task has one", () => {
    const sections = buildTaskSections(
      on(
        task("today", { dueAt: day(0) }),
        task("later", { dueAt: day(3) }),
        task("later-chat", { dueAt: day(3), delegations: [delegation("c", "running")] }),
      ),
      { environmentId: null, projectId: null, query: "" },
      contextOf,
    );
    const actions = Object.fromEntries(
      sections.flatMap((section) =>
        section.rows.map((row) => [row.taskId, row.chatAction?.kind ?? null]),
      ),
    );
    expect(actions).toEqual({ today: "start", later: null, "later-chat": "open" });
  });

  it("leaves out other projects' tasks and those the search does not match", () => {
    const sections = buildTaskSections(
      on(
        task("a", { projectId: RYCO, title: "Fix the login loop" }),
        task("b", { projectId: RYCO, title: "Write docs" }),
        task("c", { title: "Fix the login loop elsewhere" }),
      ),
      { environmentId: null, projectId: RYCO, query: "login" },
      contextOf,
    );
    expect(sections.flatMap((section) => section.rows.map((row) => row.taskId))).toEqual(["a"]);
  });
});

describe("buildTaskRow", () => {
  it("reads the project, the due day and the priority", () => {
    const row = buildTaskRow(
      task("t", { projectId: RYCO, dueAt: day(0), priority: "high" }),
      context,
    );
    expect(row).toMatchObject({
      projectName: "ryco",
      dueLabel: "Today",
      dueTone: "soon",
      meta: "ryco · due today",
      priorityMark: "high",
      chatAction: { kind: "start" },
    });
    expect(buildTaskRow(task("late", { dueAt: day(-1) }), context).dueTone).toBe("overdue");
    expect(buildTaskRow(task("later", { dueAt: day(9) }), context).dueTone).toBe("later");
  });

  it("opens the most urgent chat, and shows its word", () => {
    const row = buildTaskRow(
      task("t", {
        delegations: [delegation("old", "review"), delegation("waiting", "needs-you")],
      }),
      context,
    );
    expect(row.chatAction).toEqual({ kind: "open", threadId: ThreadId.make("waiting") });
    expect(row.chatWord).toBe("needs-you");
  });

  it("offers nothing on a done task, nor Start where no chat can start", () => {
    expect(buildTaskRow(task("d", { state: "done" }), context).chatAction).toBeNull();
    expect(buildTaskRow(task("t"), { ...context, canStart: false }).chatAction).toBeNull();
  });
});

describe("taskChips", () => {
  it("shows links in order, then how many chats and files", () => {
    const chips = taskChips(
      task("t", {
        links: [
          { kind: "pr", number: 1138 },
          { kind: "branch", name: "mobile/push" },
          { kind: "thread", threadId: ThreadId.make("linked") },
          { kind: "pr", number: 1138, url: "https://github.com/a/b/pull/1138" },
        ],
        files: [
          {
            fileId: "f1" as never,
            type: "file",
            name: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
            addedAt: "2026-10-10T00:00:00.000Z",
          },
        ],
      }),
      [
        {
          key: "thread:linked",
          threadId: ThreadId.make("linked"),
          status: "review",
          branch: null,
          linked: true,
          optimistic: false,
          error: null,
          startFailed: false,
        },
      ],
    );
    expect(chips.map((chip) => chip.label)).toEqual([
      "PR #1138",
      "mobile/push",
      "1 chat",
      "1 file",
    ]);
  });
});

describe("openableTaskChats", () => {
  it("skips chats that are gone and puts the latest of a kind first", () => {
    const base = {
      branch: null,
      linked: false,
      optimistic: false,
      error: null,
      startFailed: false,
    };
    const chats = openableTaskChats([
      { ...base, key: "a", threadId: ThreadId.make("a"), status: "review" },
      { ...base, key: "b", threadId: ThreadId.make("b"), status: "unavailable" },
      { ...base, key: "c", threadId: ThreadId.make("c"), status: "review" },
      { ...base, key: "d", threadId: ThreadId.make("d"), status: "running" },
    ]);
    expect(chats.map((chat) => chat.key)).toEqual(["d", "c", "a"]);
  });
});

describe("taskMatchesQuery", () => {
  it("matches every word across the title, notes and links", () => {
    const subject = task("t", {
      title: "Ship push",
      notes: "Needs the Hub deploy",
      links: [{ kind: "pr", number: 42, title: "Live Activity counts" }],
    });
    expect(taskMatchesQuery(subject, "push hub")).toBe(true);
    expect(taskMatchesQuery(subject, "#42 activity")).toBe(true);
    expect(taskMatchesQuery(subject, "push android")).toBe(false);
  });
});

describe("buildTaskSections across machines", () => {
  it("merges every machine's tasks, names the machine and keeps offline ones read-only", () => {
    const sections = buildTaskSections(
      [
        { environmentId: MAC, task: task("a", { dueAt: day(0) }) },
        { environmentId: MINI, task: task("a", { dueAt: day(0), title: "Same id elsewhere" }) },
      ],
      { environmentId: null, projectId: null, query: "" },
      (environmentId) =>
        environmentId === MAC
          ? { ...context, machineLabel: "MacBook" }
          : { ...context, environmentId: MINI, machineLabel: "Mac mini", offline: true },
    );
    const rows = sections[0]!.rows;
    expect(rows.map((row) => row.key)).toEqual(["env-mac:a", "env-mini:a"]);
    expect(rows[0]).toMatchObject({ meta: "MacBook · due today", chatAction: { kind: "start" } });
    expect(rows[1]).toMatchObject({
      offline: true,
      meta: "Mac mini · offline · due today",
      chatAction: null,
    });
  });

  it("filters to one machine", () => {
    const sections = buildTaskSections(
      [
        { environmentId: MAC, task: task("a") },
        { environmentId: MINI, task: task("b") },
      ],
      { environmentId: MINI, projectId: null, query: "" },
      (environmentId) => ({ ...context, environmentId }),
    );
    expect(sections.flatMap((section) => section.rows.map((row) => row.key))).toEqual([
      "env-mini:b",
    ]);
  });
});

describe("countTasksDueToday", () => {
  it("counts open tasks due today or overdue", () => {
    expect(
      countTasksDueToday(
        [
          task("a", { dueAt: day(0) }),
          task("b", { dueAt: day(-3) }),
          task("c", { dueAt: day(2) }),
          task("d", { dueAt: day(0), state: "done" }),
        ],
        NOW,
      ),
    ).toBe(2);
  });
});

describe("taskSearchResults", () => {
  const MAC = "env-mac" as never;
  const MINI = "env-mini" as never;
  it("finds tasks on every machine, open title matches first, with their route", () => {
    const results = taskSearchResults(
      [
        {
          environmentId: MAC,
          label: "MacBook",
          projectNames: new Map([[RYCO, "ryco"]]),
          tasks: [
            task("notes-match", { notes: "check the redirect" }),
            task("done-match", { title: "Redirect done", state: "done" }),
            task("title-match", {
              title: "Check redirect on Safari",
              projectId: RYCO,
              dueAt: day(2),
            }),
            task("no-match", { title: "Other" }),
          ],
        },
        { environmentId: MINI, label: "Mac mini", projectNames: new Map(), tasks: [] },
      ],
      "redirect",
      NOW,
    );
    expect(results.map((result) => result.taskId)).toEqual([
      "title-match",
      "notes-match",
      "done-match",
    ]);
    expect(results[0]).toMatchObject({
      subtitle: "MacBook · ryco · due Tue",
      trailing: "Tue",
      route: { name: "TaskDetail", params: { environmentId: MAC, taskId: "title-match" } },
    });
    expect(results[2]!.subtitle).toBe("MacBook · done");
    expect(taskSearchResults([], "  ", NOW)).toEqual([]);
  });
});
