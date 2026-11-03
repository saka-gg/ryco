import { describe, expect, it } from "vitest";

import {
  CLAUDE_PLAN_TOOL_NAMES,
  CLAUDE_TASK_TOOL_NAMES,
  ClaudePlanTaskTracker,
  claudePlanToolDetail,
  planTasksCursorField,
  readClaudePlanTasksFromCursor,
  type ClaudePlanTask,
} from "./claudePlanTasks.ts";

let nextToolUseId = 0;

/** Notes one call and applies its result, as the adapter does. */
function run(
  tracker: ClaudePlanTaskTracker,
  toolName: string,
  input: Record<string, unknown>,
  result: {
    readonly text?: string;
    readonly isError?: boolean;
    readonly structured?: Record<string, unknown>;
  } = {},
) {
  nextToolUseId += 1;
  const toolUseId = `toolu_${nextToolUseId}`;
  tracker.noteToolUse(toolUseId, toolName, input);
  return tracker.applyResult({
    toolUseId,
    text: result.text ?? "",
    isError: result.isError ?? false,
    structured: result.structured,
  });
}

const create = (tracker: ClaudePlanTaskTracker, id: string, subject: string) =>
  run(
    tracker,
    "TaskCreate",
    { subject, description: "details" },
    { structured: { task: { id, subject } } },
  );

const update = (
  tracker: ClaudePlanTaskTracker,
  input: Record<string, unknown>,
  structured?: Record<string, unknown>,
) =>
  run(tracker, "TaskUpdate", input, {
    text: `Updated task #${String(input.taskId ?? input.id ?? input.task_id)} status`,
    ...(structured ? { structured } : {}),
  });

const tasks = (...entries: Array<[string, string, ClaudePlanTask["status"]]>) =>
  entries.map(([id, subject, status]) => ({ id, subject, status }));

describe("claudePlanTasks", () => {
  it("names the planning tools exactly", () => {
    expect([...CLAUDE_TASK_TOOL_NAMES]).toEqual([
      "TaskCreate",
      "TaskUpdate",
      "TaskGet",
      "TaskList",
    ]);
    expect(CLAUDE_PLAN_TOOL_NAMES.has("TodoWrite")).toBe(true);
    expect(CLAUDE_PLAN_TOOL_NAMES.has("taskcreate")).toBe(false);
    expect(CLAUDE_PLAN_TOOL_NAMES.has("TaskStop")).toBe(false);
  });

  describe("TaskCreate", () => {
    it("adds a pending step with the id and subject from the structured result", () => {
      const tracker = new ClaudePlanTaskTracker();
      const plan = run(
        tracker,
        "TaskCreate",
        { subject: "Draft subject", description: "details" },
        { structured: { task: { id: "1", subject: "Write tests" } } },
      );
      expect(plan).toEqual([{ step: "Write tests", status: "pending" }]);
      expect(tracker.snapshot()).toEqual(tasks(["1", "Write tests", "pending"]));
    });

    it("parses the id and subject of a text-only result (a subagent's)", () => {
      const tracker = new ClaudePlanTaskTracker();
      const plan = run(
        tracker,
        "TaskCreate",
        { subject: "Input subject" },
        { text: "Task #7 created successfully: Review the diff" },
      );
      expect(plan).toEqual([{ step: "Review the diff", status: "pending" }]);
      expect(tracker.snapshot()[0]?.id).toBe("7");
    });

    it("changes nothing on an error, a missing id, or an internal task", () => {
      const tracker = new ClaudePlanTaskTracker();
      expect(
        run(
          tracker,
          "TaskCreate",
          { subject: "Write tests" },
          { isError: true, text: "Task #1 created successfully: Write tests" },
        ),
      ).toBeUndefined();
      expect(
        run(tracker, "TaskCreate", { subject: "Write tests" }, { text: "Created." }),
      ).toBeUndefined();
      expect(
        run(
          tracker,
          "TaskCreate",
          { subject: "Bookkeeping", metadata: { _internal: true } },
          { structured: { task: { id: "1", subject: "Bookkeeping" } } },
        ),
      ).toBeUndefined();
      expect(tracker.snapshot()).toEqual([]);
    });

    it("falls back to the input subject when the result has none", () => {
      const tracker = new ClaudePlanTaskTracker();
      expect(
        run(
          tracker,
          "TaskCreate",
          { subject: "From input" },
          { structured: { task: { id: "3" } } },
        ),
      ).toEqual([{ step: "From input", status: "pending" }]);
    });

    it("starts a new list when every tracked task is completed", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "First");
      create(tracker, "2", "Second");
      update(tracker, { taskId: "1", status: "completed" });
      // Not every task is completed yet: the list keeps growing.
      expect(create(tracker, "3", "Third")).toHaveLength(3);
      update(tracker, { taskId: "2", status: "completed" });
      update(tracker, { taskId: "3", status: "completed" });
      expect(create(tracker, "4", "Next round")).toEqual([
        { step: "Next round", status: "pending" },
      ]);
    });
  });

  describe("TaskUpdate", () => {
    it("takes the status from statusChange.to", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "Write tests");
      const plan = update(
        tracker,
        { taskId: "1", status: "completed" },
        {
          success: true,
          taskId: "1",
          updatedFields: ["status"],
          statusChange: { from: "pending", to: "in_progress" },
        },
      );
      expect(plan).toEqual([{ step: "Write tests", status: "inProgress" }]);
    });

    it("takes the status from the input on a text-only result, with any id alias", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      create(tracker, "2", "Two");
      create(tracker, "3", "Three");
      update(tracker, { taskId: "1", status: "in_progress" });
      update(tracker, { id: "2", status: "completed" });
      const plan = update(tracker, { task_id: "3", status: "in_progress" });
      expect(plan).toEqual([
        { step: "One", status: "inProgress" },
        { step: "Two", status: "completed" },
        { step: "Three", status: "inProgress" },
      ]);
    });

    it("reads the id from the result text when the input has none", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "4", "Four");
      expect(
        run(tracker, "TaskUpdate", { status: "completed" }, { text: "Updated task #4 status" }),
      ).toEqual([{ step: "Four", status: "completed" }]);
    });

    it("accepts a numeric id in raw streamed input", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "2", "Two");
      expect(update(tracker, { taskId: 2, status: "completed" })).toEqual([
        { step: "Two", status: "completed" },
      ]);
    });

    it("ignores a failed update", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "9", "Nine");
      expect(
        update(
          tracker,
          { taskId: "9", status: "completed" },
          { success: false, taskId: "9", updatedFields: [], error: "Task not found" },
        ),
      ).toBeUndefined();
      expect(
        run(
          tracker,
          "TaskUpdate",
          { taskId: "9", status: "completed" },
          { text: "Task #9 not found" },
        ),
      ).toBeUndefined();
      expect(tracker.snapshot()).toEqual(tasks(["9", "Nine", "pending"]));
    });

    it("merges a new subject and leaves an unknown status alone", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "Old");
      expect(update(tracker, { taskId: "1", subject: "New", status: "blocked" })).toEqual([
        { step: "New", status: "pending" },
      ]);
    });

    it("removes a deleted task; the last deletion empties the plan", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      create(tracker, "2", "Two");
      expect(update(tracker, { taskId: "1", status: "deleted" })).toEqual([
        { step: "Two", status: "pending" },
      ]);
      expect(
        update(
          tracker,
          { taskId: "2", status: "deleted" },
          { success: true, taskId: "2", updatedFields: ["deleted"] },
        ),
      ).toEqual([]);
    });

    it("inserts an unknown id only when the update names its subject", () => {
      const tracker = new ClaudePlanTaskTracker();
      expect(update(tracker, { taskId: "5", status: "completed" })).toBeUndefined();
      expect(update(tracker, { taskId: "5", status: "in_progress", subject: "Recovered" })).toEqual(
        [{ step: "Recovered", status: "inProgress" }],
      );
    });
  });

  describe("TaskGet", () => {
    it("removes a task the CLI no longer has", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      create(tracker, "2", "Two");
      expect(run(tracker, "TaskGet", { taskId: "1" }, { structured: { task: null } })).toEqual([
        { step: "Two", status: "pending" },
      ]);
      expect(run(tracker, "TaskGet", { taskId: "2" }, { text: "Task not found" })).toEqual([]);
    });

    it("upserts from the structured and the text form", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      expect(
        run(
          tracker,
          "TaskGet",
          { taskId: "1" },
          {
            structured: {
              task: {
                id: "1",
                subject: "One, renamed",
                description: "",
                status: "in_progress",
                blocks: [],
                blockedBy: [],
              },
            },
          },
        ),
      ).toEqual([{ step: "One, renamed", status: "inProgress" }]);
      expect(
        run(
          tracker,
          "TaskGet",
          { taskId: "2" },
          { text: "Task #2: Two\nStatus: completed\nDescription: done" },
        ),
      ).toEqual([
        { step: "One, renamed", status: "inProgress" },
        { step: "Two", status: "completed" },
      ]);
    });
  });

  describe("TaskList", () => {
    it("replaces the list with a structured snapshot, in its order", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "a", "Alpha");
      create(tracker, "b", "Beta");
      const plan = run(
        tracker,
        "TaskList",
        {},
        {
          structured: {
            tasks: [
              { id: "c", subject: "Gamma", status: "pending", blockedBy: [] },
              { id: "a", subject: "Alpha", status: "completed", blockedBy: [] },
            ],
          },
        },
      );
      expect(plan).toEqual([
        { step: "Gamma", status: "pending" },
        { step: "Alpha", status: "completed" },
      ]);
    });

    it("clears the list on No tasks found", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      expect(run(tracker, "TaskList", {}, { text: "No tasks found" })).toEqual([]);
    });

    it("parses text lines with blocked-by and owner suffixes", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "Known subject");
      const plan = run(
        tracker,
        "TaskList",
        {},
        {
          text: [
            "#1 [in_progress] Known subject (researcher)",
            "#2 [pending] Write docs [blocked by #1]",
            "#3 [completed] Ship it (lead) [blocked by #1, #2]",
          ].join("\n"),
        },
      );
      expect(plan).toEqual([
        { step: "Known subject", status: "inProgress" },
        { step: "Write docs", status: "pending" },
        { step: "Ship it (lead)", status: "completed" },
      ]);
    });

    it("keeps the list when the text is in no known format", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      expect(run(tracker, "TaskList", {}, { text: "Something new" })).toBeUndefined();
      expect(tracker.snapshot()).toEqual(tasks(["1", "One", "pending"]));
    });

    it("emits nothing when the snapshot matches the list", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      expect(
        run(
          tracker,
          "TaskList",
          {},
          { structured: { tasks: [{ id: "1", subject: "One", status: "pending" }] } },
        ),
      ).toBeUndefined();
    });
  });

  describe("list shape", () => {
    it("orders numeric ids numerically", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "10", "Ten");
      create(tracker, "2", "Two");
      expect(create(tracker, "1", "One")?.map((step) => step.step)).toEqual(["One", "Two", "Ten"]);
    });

    it("keeps insertion order when an id is not numeric", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "10", "Ten");
      create(tracker, "b", "Bee");
      expect(create(tracker, "2", "Two")?.map((step) => step.step)).toEqual(["Ten", "Bee", "Two"]);
    });

    it("trims, collapses, caps and falls back for subjects", () => {
      const tracker = new ClaudePlanTaskTracker();
      expect(create(tracker, "1", "  Write \n\t tests  ")?.[0]?.step).toBe("Write tests");
      // Cut at 200 characters, without the space the cut leaves at the end.
      expect(create(tracker, "2", `${"a".repeat(199)} tail`)?.[1]?.step).toBe("a".repeat(199));
      expect(create(tracker, "3", "   ")?.[2]?.step).toBe("Task #3");
      // A subject cut inside a surrogate pair keeps the pair whole.
      const emoji = `${"a".repeat(199)}😀`;
      expect(create(tracker, "4", emoji)?.[3]?.step).toBe("a".repeat(199));
    });

    it("caps the list, evicting the lowest completed task first", () => {
      const tracker = new ClaudePlanTaskTracker();
      for (let id = 1; id <= 100; id += 1) create(tracker, String(id), `Task ${id}`);
      update(tracker, { taskId: "5", status: "completed" });
      update(tracker, { taskId: "7", status: "completed" });
      create(tracker, "101", "Task 101");
      let ids = tracker.snapshot().map((task) => task.id);
      expect(ids).toHaveLength(100);
      expect(ids).not.toContain("5");
      expect(ids).toContain("7");
      create(tracker, "102", "Task 102");
      create(tracker, "103", "Task 103");
      ids = tracker.snapshot().map((task) => task.id);
      expect(ids).toHaveLength(100);
      expect(ids).not.toContain("7");
      // No completed task is left: the lowest id goes.
      expect(ids).not.toContain("1");
      expect(ids.at(-1)).toBe("103");
    });

    it("renders in_progress as inProgress", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      expect(update(tracker, { taskId: "1", status: "in_progress" })?.[0]?.status).toBe(
        "inProgress",
      );
    });
  });

  describe("results", () => {
    it("returns undefined for an unchanged list and for an unknown tool use", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      expect(update(tracker, { taskId: "1", status: "pending" })).toBeUndefined();
      expect(
        tracker.applyResult({
          toolUseId: "toolu_unknown",
          text: "Task #2 created successfully: Two",
          isError: false,
          structured: undefined,
        }),
      ).toBeUndefined();
    });

    it("ignores tools other than the Task tools", () => {
      const tracker = new ClaudePlanTaskTracker();
      tracker.noteToolUse("toolu_todo", "TodoWrite", { todos: [] });
      tracker.noteToolUse("toolu_bash", "Bash", { command: "ls" });
      expect(
        tracker.applyResult({
          toolUseId: "toolu_todo",
          text: "Task #1 created successfully: One",
          isError: false,
          structured: undefined,
        }),
      ).toBeUndefined();
    });

    it("lets the latest input of a call win", () => {
      const tracker = new ClaudePlanTaskTracker();
      tracker.noteToolUse("toolu_create", "TaskCreate", {});
      tracker.noteToolUse("toolu_create", "TaskCreate", { subject: "Final subject" });
      expect(
        tracker.applyResult({
          toolUseId: "toolu_create",
          text: "",
          isError: false,
          structured: { task: { id: "1" } },
        }),
      ).toEqual([{ step: "Final subject", status: "pending" }]);
    });

    it("keeps at most 64 pending calls, dropping the oldest", () => {
      const tracker = new ClaudePlanTaskTracker();
      for (let index = 0; index <= 64; index += 1) {
        tracker.noteToolUse(`toolu_${index}-pending`, "TaskCreate", { subject: `Task ${index}` });
      }
      expect(
        tracker.applyResult({
          toolUseId: "toolu_0-pending",
          text: "Task #1 created successfully: Task 0",
          isError: false,
          structured: undefined,
        }),
      ).toBeUndefined();
      expect(
        tracker.applyResult({
          toolUseId: "toolu_1-pending",
          text: "Task #2 created successfully: Task 1",
          isError: false,
          structured: undefined,
        }),
      ).toEqual([{ step: "Task 1", status: "pending" }]);
    });

    it("applies a result once", () => {
      const tracker = new ClaudePlanTaskTracker();
      tracker.noteToolUse("toolu_once", "TaskCreate", { subject: "Once" });
      const result = {
        toolUseId: "toolu_once",
        text: "",
        isError: false,
        structured: { task: { id: "1", subject: "Once" } },
      };
      expect(tracker.applyResult(result)).toHaveLength(1);
      expect(tracker.applyResult(result)).toBeUndefined();
    });
  });

  describe("seed", () => {
    it("starts from the seed without reporting it again", () => {
      const tracker = new ClaudePlanTaskTracker({
        tasks: tasks(["2", "Two", "pending"], ["1", "One", "in_progress"]),
        shown: true,
      });
      expect(tracker.shown).toBe(true);
      expect(tracker.snapshot()).toEqual(
        tasks(["1", "One", "in_progress"], ["2", "Two", "pending"]),
      );
      expect(
        run(tracker, "TaskList", {}, { text: "#1 [in_progress] One\n#2 [pending] Two" }),
      ).toBeUndefined();
      expect(update(tracker, { taskId: "1", status: "completed" })).toEqual([
        { step: "One", status: "completed" },
        { step: "Two", status: "pending" },
      ]);
    });

    it("reports an unshown seed with the next result, even an unchanged one", () => {
      const tracker = new ClaudePlanTaskTracker({
        tasks: tasks(["1", "One", "completed"]),
        shown: false,
      });
      expect(tracker.shown).toBe(false);
      // An error or a result of no noted call is no news.
      expect(
        run(tracker, "TaskUpdate", { taskId: "1" }, { text: "Task #1 not found", isError: true }),
      ).toBeUndefined();
      expect(tracker.shown).toBe(false);
      expect(update(tracker, { taskId: "1", status: "completed" })).toEqual([
        { step: "One", status: "completed" },
      ]);
      expect(tracker.shown).toBe(true);
      expect(update(tracker, { taskId: "1", status: "completed" })).toBeUndefined();
    });

    it("reports an unshown empty seed as an empty plan", () => {
      const tracker = new ClaudePlanTaskTracker({ tasks: [], shown: false });
      expect(run(tracker, "TaskList", {}, { text: "No tasks found" })).toEqual([]);
      expect(run(tracker, "TaskList", {}, { text: "No tasks found" })).toBeUndefined();
    });
  });

  describe("resume cursor", () => {
    const SESSION = "11111111-1111-4111-8111-111111111111";
    const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";

    /** A cursor as the binding stores it: JSON, with the adapter's other fields beside it. */
    const persistedCursor = (tracker: ClaudePlanTaskTracker, sessionId = SESSION): unknown =>
      JSON.parse(
        JSON.stringify({
          threadId: "thread-1",
          resume: SESSION,
          turnCount: 2,
          ...planTasksCursorField(tracker, sessionId),
        }),
      );

    const cursorWith = (entries: unknown, nativeSessionId: unknown = SESSION) => ({
      resume: SESSION,
      planTasks: { nativeSessionId, tasks: entries },
    });

    it("round-trips the list, so a resumed tracker updates tasks by id", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "Write tests");
      create(tracker, "2", "Ship it");
      update(tracker, { taskId: "1", status: "in_progress" });
      expect(planTasksCursorField(tracker, SESSION)).toEqual({
        planTasks: {
          nativeSessionId: SESSION,
          tasks: tasks(["1", "Write tests", "in_progress"], ["2", "Ship it", "pending"]),
        },
      });

      const seed = readClaudePlanTasksFromCursor(persistedCursor(tracker), SESSION);
      expect(seed).toEqual({ tasks: tracker.snapshot(), shown: true });
      const resumed = new ClaudePlanTaskTracker(seed);
      // The update names no subject; the seeded one fills the step.
      expect(update(resumed, { taskId: "1", status: "completed" })).toEqual([
        { step: "Write tests", status: "completed" },
        { step: "Ship it", status: "pending" },
      ]);
    });

    it("adds no field for an empty list or an unknown session", () => {
      const tracker = new ClaudePlanTaskTracker();
      expect(planTasksCursorField(tracker, SESSION)).toEqual({});
      create(tracker, "1", "One");
      expect(planTasksCursorField(tracker, undefined)).toEqual({});
      // The last deletion empties the field again.
      update(tracker, { taskId: "1", status: "deleted" });
      expect(planTasksCursorField(tracker, SESSION)).toEqual({});
    });

    it("keeps an unshown list unshown until a plan was sent, empty or not", () => {
      const tracker = new ClaudePlanTaskTracker();
      // A revert marks the list it carries unshown, an empty one included.
      expect(planTasksCursorField(tracker, SESSION, { shown: false })).toEqual({
        planTasks: { nativeSessionId: SESSION, tasks: [], shown: false },
      });
      create(tracker, "1", "One");
      const reverted = readClaudePlanTasksFromCursor(
        JSON.parse(
          JSON.stringify({
            resume: SESSION,
            ...planTasksCursorField(tracker, SESSION, { shown: false }),
          }),
        ),
        SESSION,
      );
      expect(reverted).toEqual({ tasks: tasks(["1", "One", "pending"]), shown: false });

      // A restart before the next plan keeps the mark.
      const resumed = new ClaudePlanTaskTracker(reverted);
      const restarted = readClaudePlanTasksFromCursor(
        { resume: SESSION, ...planTasksCursorField(resumed, SESSION) },
        SESSION,
      );
      expect(restarted?.shown).toBe(false);
      expect(run(resumed, "TaskList", {}, { text: "#1 [pending] One" })).toEqual([
        { step: "One", status: "pending" },
      ]);
      expect(planTasksCursorField(resumed, SESSION)).toEqual({
        planTasks: { nativeSessionId: SESSION, tasks: tasks(["1", "One", "pending"]) },
      });
    });

    it("reads nothing for another session, no session or no list", () => {
      const tracker = new ClaudePlanTaskTracker();
      create(tracker, "1", "One");
      expect(
        readClaudePlanTasksFromCursor(persistedCursor(tracker, OTHER_SESSION), SESSION),
      ).toBeUndefined();
      expect(readClaudePlanTasksFromCursor(persistedCursor(tracker), undefined)).toBeUndefined();
      expect(readClaudePlanTasksFromCursor({ resume: SESSION }, SESSION)).toBeUndefined();
      expect(readClaudePlanTasksFromCursor(undefined, SESSION)).toBeUndefined();
      expect(readClaudePlanTasksFromCursor("cursor", SESSION)).toBeUndefined();
      expect(
        readClaudePlanTasksFromCursor({ planTasks: { nativeSessionId: SESSION } }, SESSION),
      ).toBeUndefined();
      expect(readClaudePlanTasksFromCursor(cursorWith([], 42), SESSION)).toBeUndefined();
    });

    it("drops malformed entries and normalizes the rest", () => {
      const read = readClaudePlanTasksFromCursor(
        cursorWith([
          null,
          "#1 [pending] One",
          { subject: "No id", status: "pending" },
          { id: 3, subject: "Numeric id", status: "pending" },
          { id: "  ", subject: "Blank id", status: "pending" },
          { id: "x".repeat(65), subject: "Long id", status: "pending" },
          { id: "4", subject: "Deleted", status: "deleted" },
          { id: "5", subject: "No status" },
          { id: "6", status: "completed" },
          { id: " 7 ", subject: "  Spaced \n subject  ", status: "in_progress" },
          { id: "8", subject: "First", status: "pending" },
          { id: "8", subject: "Second", status: "completed" },
          { id: "9", subject: "x".repeat(300), status: "pending", description: "pasted" },
        ]),
        SESSION,
      );
      expect(read).toEqual({
        tasks: tasks(
          ["6", "Task #6", "completed"],
          ["7", "Spaced subject", "in_progress"],
          ["8", "Second", "completed"],
          ["9", "x".repeat(200), "pending"],
        ),
        shown: true,
      });
    });

    it("caps the list on read, dropping the lowest completed tasks first", () => {
      const entries = Array.from({ length: 103 }, (_, index) => ({
        id: String(index + 1),
        subject: `Task ${index + 1}`,
        status: index === 4 || index === 9 ? "completed" : "pending",
      }));
      const ids = readClaudePlanTasksFromCursor(cursorWith(entries), SESSION)?.tasks.map(
        (task) => task.id,
      );
      expect(ids).toHaveLength(100);
      expect(ids).not.toContain("5");
      expect(ids).not.toContain("10");
      // No completed task is left for the third: the lowest id goes.
      expect(ids).not.toContain("1");
      expect(ids?.at(0)).toBe("2");
      expect(ids?.at(-1)).toBe("103");
    });
  });

  describe("claudePlanToolDetail", () => {
    it("describes each planning tool", () => {
      expect(claudePlanToolDetail("TaskCreate", { subject: "Write tests" })).toBe(
        "TaskCreate: Write tests",
      );
      expect(claudePlanToolDetail("TaskCreate", {})).toBe("TaskCreate");
      expect(claudePlanToolDetail("TaskUpdate", { taskId: "2", status: "completed" })).toBe(
        "TaskUpdate: #2 → completed",
      );
      expect(
        claudePlanToolDetail("TaskUpdate", { id: "2", status: "in_progress", subject: "Docs" }),
      ).toBe("TaskUpdate: #2 → in_progress · Docs");
      expect(claudePlanToolDetail("TaskUpdate", { taskId: "3", subject: "Rename" })).toBe(
        "TaskUpdate: #3 · Rename",
      );
      expect(claudePlanToolDetail("TaskGet", { taskId: "4" })).toBe("TaskGet: #4");
      expect(claudePlanToolDetail("TaskList", {})).toBe("TaskList");
      expect(claudePlanToolDetail("TodoWrite", { todos: [{}, {}] })).toBe("TodoWrite: 2 items");
      expect(claudePlanToolDetail("TodoWrite", { todos: [{}] })).toBe("TodoWrite: 1 item");
      expect(claudePlanToolDetail("Bash", { command: "ls" })).toBeUndefined();
    });

    it("caps the detail at 200 characters", () => {
      const detail = claudePlanToolDetail("TaskCreate", { subject: "x".repeat(500) });
      expect(detail?.length).toBe(200);
    });
  });
});
