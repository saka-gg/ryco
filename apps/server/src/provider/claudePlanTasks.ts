/**
 * Claude's planning tools as the thread plan. With the Task tools on (Claude Code's default),
 * Claude plans with TaskCreate, TaskUpdate, TaskGet and TaskList instead of TodoWrite. The
 * tracker mirrors the session's task list from those calls' successful results, so the adapter
 * can emit it as `turn.plan.updated`.
 *
 * Named "plan tasks" so it is not confused with Claude's background tasks (`task.*` events,
 * TaskStop) or Ryco's Tasks page. Pure and bounded; loaded only by the lazy `ClaudeAdapter`, never
 * on the server boot path. It never reads Claude's on-disk task store: that layout is internal to
 * the CLI and may not even live under the instance's config root (a wrapper, a container). The
 * resume cursor carries the list instead, so a resumed session still knows the tasks an update
 * names by id.
 *
 * @module claudePlanTasks
 */
import type { RuntimePlanStep } from "@ryco/contracts";

/** The tools whose calls feed or describe the plan (exact, case-sensitive names). */
export const CLAUDE_PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
]);

/** The Task tools the tracker follows; TodoWrite carries its whole list in its input instead. */
export const CLAUDE_TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
]);

export type ClaudePlanTaskStatus = "pending" | "in_progress" | "completed";

export interface ClaudePlanTask {
  readonly id: string;
  readonly subject: string;
  readonly status: ClaudePlanTaskStatus;
}

/**
 * The resume cursor's `planTasks`: the list and the Claude session whose list it is. Holds only
 * ids, subjects and statuses, never a task's description or metadata (pasted content).
 */
export interface ClaudePlanTasksCursor {
  readonly nativeSessionId: string;
  readonly tasks: ReadonlyArray<ClaudePlanTask>;
  /**
   * Set while the thread's plan may show another list than this one: a checkpoint revert drops
   * the reverted turns' plans but leaves Claude's task store as it is. Kept even for an empty
   * list, and dropped once a plan was sent again.
   */
  readonly shown?: false;
}

/** What a resumed session's tracker starts from. */
export interface ClaudePlanTasksSeed {
  readonly tasks: ReadonlyArray<ClaudePlanTask>;
  /** Whether the thread's plan shows `tasks`. When not, the next applied result is sent. */
  readonly shown: boolean;
}

export interface ClaudePlanToolResult {
  readonly toolUseId: string;
  /** The tool_result block's text. */
  readonly text: string;
  readonly isError: boolean;
  /**
   * The message's `tool_use_result`, only when the message holds exactly one tool_result block:
   * one structured result cannot be matched to several blocks. Subagent results carry none.
   */
  readonly structured: Record<string, unknown> | undefined;
}

const PLAN_TASKS_CAP = 100;
const PLAN_TASK_SUBJECT_MAX_CHARS = 200;
/** Ids come from the CLI as small integers; a longer one is not an id worth keeping. */
const PLAN_TASK_ID_MAX_CHARS = 64;
/**
 * Calls whose result has not arrived. Never cleared at turn end: a background subagent's result
 * can land after its turn settled. A call whose result never comes ages out first.
 */
const PENDING_TASK_TOOL_CALLS_CAP = 64;
const PLAN_TOOL_DETAIL_MAX_CHARS = 200;

const NUMERIC_TASK_ID = /^\d+$/;
const TASK_CREATED_TEXT = /^Task #(\S+) created successfully: (.+)$/s;
const TASK_UPDATED_TEXT = /^Updated task #(\S+)/;
const TASK_GET_TEXT = /^Task #(\S+): (.+)\nStatus: (pending|in_progress|completed)/;
const TASK_LIST_LINE = /^#(\S+) \[(pending|in_progress|completed)\] (.+)$/;
const TASK_LIST_BLOCKED_BY_SUFFIX = / \[blocked by [^\]]*\]$/;

interface PendingTaskToolCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  ...keys: ReadonlyArray<string>
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function normalizeTaskId(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= PLAN_TASK_ID_MAX_CHARS ? value : undefined;
}

/** Streamed input is raw: the CLI repairs these aliases only before it runs the tool. */
function readTaskId(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  for (const key of ["taskId", "id", "task_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return normalizeTaskId(value.trim());
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return String(value);
    }
  }
  return undefined;
}

function readTaskStatus(value: unknown): ClaudePlanTaskStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}

/**
 * Cuts at `max` UTF-16 units without splitting a surrogate pair. Not `truncateUnicodeSafe` from
 * `@ryco/shared/String`: importing it here moves it out of the server's boot chunk into a chunk
 * shared with this lazy module, which grows the boot closure.
 */
function capText(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Collapsed, capped and never blank: a plan step must be a non-empty trimmed string. */
function normalizeSubject(value: string | undefined, id: string): string {
  const collapsed = value?.replace(/\s+/g, " ").trim() ?? "";
  if (collapsed.length === 0) return `Task #${id}`;
  return capText(collapsed, PLAN_TASK_SUBJECT_MAX_CHARS).trimEnd();
}

function isCompleted(task: ClaudePlanTask): boolean {
  return task.status === "completed";
}

/** Numeric ids ascending when every id is numeric (the CLI counts up), else insertion order. */
function orderTasks(tasks: Iterable<ClaudePlanTask>): Array<ClaudePlanTask> {
  const ordered = Array.from(tasks);
  if (ordered.every((task) => NUMERIC_TASK_ID.test(task.id))) {
    ordered.sort((left, right) => Number(left.id) - Number(right.id));
  }
  return ordered;
}

/** Past the cap, the lowest completed tasks go first, then the lowest ones. */
function enforcePlanTasksCap(tasks: Map<string, ClaudePlanTask>): void {
  let excess = tasks.size - PLAN_TASKS_CAP;
  if (excess <= 0) return;
  const ordered = orderTasks(tasks.values());
  for (const task of ordered) {
    if (excess === 0) return;
    if (!isCompleted(task)) continue;
    tasks.delete(task.id);
    excess -= 1;
  }
  for (const task of ordered) {
    if (excess === 0) return;
    if (tasks.delete(task.id)) excess -= 1;
  }
}

/** A seeded or persisted task, normalized; undefined when its id or status is not usable. */
function readStoredTask(value: unknown): ClaudePlanTask | undefined {
  const record = readRecord(value);
  const id = typeof record?.id === "string" ? normalizeTaskId(record.id.trim()) : undefined;
  const status = readTaskStatus(record?.status);
  if (!id || status === undefined) return undefined;
  const subject = typeof record?.subject === "string" ? record.subject : undefined;
  return { id, subject: normalizeSubject(subject, id), status };
}

/** Stored tasks by id (a repeated id keeps its last entry), capped like a live list. */
function readStoredTasks(entries: Iterable<unknown>): Map<string, ClaudePlanTask> {
  const tasks = new Map<string, ClaudePlanTask>();
  for (const entry of entries) {
    const task = readStoredTask(entry);
    if (task) tasks.set(task.id, task);
  }
  enforcePlanTasksCap(tasks);
  return tasks;
}

function toPlanSteps(tasks: ReadonlyArray<ClaudePlanTask>): Array<RuntimePlanStep> {
  // The subject, never activeForm: a row's label must not flip while its task runs.
  return tasks.map((task) => ({
    step: task.subject,
    status: task.status === "in_progress" ? "inProgress" : task.status,
  }));
}

/**
 * The task list of one Claude session, rebuilt from its Task tool calls. Calls are noted when
 * their input is known and applied only on a successful result, so a rejected update never shows.
 * Subagent calls count too: in-process subagents write to the session's list.
 */
export class ClaudePlanTaskTracker {
  private readonly tasks: Map<string, ClaudePlanTask>;
  private readonly pending = new Map<string, PendingTaskToolCall>();
  /**
   * The tasks in plan order, rebuilt only when a result was applied: the resume cursor reads it
   * on every SDK message.
   */
  private ordered: ReadonlyArray<ClaudePlanTask>;
  /** The plan the thread shows; undefined while it may show another list (after a revert). */
  private lastFingerprint: string | undefined;

  constructor(seed: ClaudePlanTasksSeed = { tasks: [], shown: true }) {
    this.tasks = readStoredTasks(seed.tasks);
    this.ordered = orderTasks(this.tasks.values());
    // A shown list makes only a change from it news. An unshown one is sent with the next applied
    // result, even when that result changes nothing.
    this.lastFingerprint = seed.shown ? JSON.stringify(toPlanSteps(this.ordered)) : undefined;
  }

  /** Whether the thread's plan shows the tracked list. */
  get shown(): boolean {
    return this.lastFingerprint !== undefined;
  }

  /** Remembers a Task tool call's input (latest input wins); other tools are ignored. */
  noteToolUse(toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    if (!CLAUDE_TASK_TOOL_NAMES.has(toolName)) return;
    this.pending.set(toolUseId, { toolName, input });
    if (this.pending.size > PENDING_TASK_TOOL_CALLS_CAP) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
  }

  /**
   * Applies a tool result to the list. Returns the plan when its rendering changed or the thread
   * did not show it yet; undefined for a result of no noted call, an error, or no visible change.
   * An emptied list returns `[]`.
   */
  applyResult(result: ClaudePlanToolResult): ReadonlyArray<RuntimePlanStep> | undefined {
    const call = this.pending.get(result.toolUseId);
    if (!call) return undefined;
    this.pending.delete(result.toolUseId);
    if (result.isError) return undefined;

    switch (call.toolName) {
      case "TaskCreate":
        this.applyCreate(call.input, result);
        break;
      case "TaskUpdate":
        this.applyUpdate(call.input, result);
        break;
      case "TaskGet":
        this.applyGet(call.input, result);
        break;
      case "TaskList":
        this.applyList(result);
        break;
      default:
        return undefined;
    }

    this.ordered = orderTasks(this.tasks.values());
    const steps = toPlanSteps(this.ordered);
    const fingerprint = JSON.stringify(steps);
    if (fingerprint === this.lastFingerprint) return undefined;
    this.lastFingerprint = fingerprint;
    return steps;
  }

  /** The tracked tasks in plan order. */
  snapshot(): ReadonlyArray<ClaudePlanTask> {
    return this.ordered;
  }

  private applyCreate(input: Record<string, unknown>, result: ClaudePlanToolResult): void {
    // Claude Code's own bookkeeping tasks; TaskList hides them too.
    if (readRecord(input.metadata)?._internal) return;
    const task = readRecord(result.structured?.task);
    const textMatch = TASK_CREATED_TEXT.exec(result.text.trim());
    const id = readTaskId(task) ?? normalizeTaskId(textMatch?.[1]);
    if (id === undefined) return;
    const subject = readString(task, "subject") ?? textMatch?.[2] ?? readString(input, "subject");
    // A new task after every tracked one completed starts a new list, as Claude Code resets a
    // fully completed list (and TodoWrite empties one).
    if (this.tasks.size > 0 && Array.from(this.tasks.values()).every(isCompleted)) {
      this.tasks.clear();
    }
    this.tasks.set(id, { id, subject: normalizeSubject(subject, id), status: "pending" });
    enforcePlanTasksCap(this.tasks);
  }

  private applyUpdate(input: Record<string, unknown>, result: ClaudePlanToolResult): void {
    const structured = result.structured;
    if (structured?.success === false) return;
    const text = result.text.trim();
    if (!structured && !text.startsWith("Updated task #")) return;
    const id =
      normalizeTaskId(readString(structured, "taskId")) ??
      readTaskId(input) ??
      normalizeTaskId(TASK_UPDATED_TEXT.exec(text)?.[1]);
    if (id === undefined) return;
    const nextStatus = readString(readRecord(structured?.statusChange), "to") ?? input.status;
    if (nextStatus === "deleted") {
      this.tasks.delete(id);
      return;
    }
    // An unknown status string leaves the status alone.
    this.upsert(id, readString(input, "subject"), readTaskStatus(nextStatus));
  }

  private applyGet(input: Record<string, unknown>, result: ClaudePlanToolResult): void {
    const requestedId = readTaskId(input);
    const structured = result.structured;
    if (structured && "task" in structured) {
      if (structured.task === null) {
        if (requestedId !== undefined) this.tasks.delete(requestedId);
        return;
      }
      const task = readRecord(structured.task);
      const id = readTaskId(task) ?? requestedId;
      if (id === undefined) return;
      this.upsert(id, readString(task, "subject"), readTaskStatus(task?.status));
      return;
    }
    const text = result.text.trim();
    if (text === "Task not found") {
      if (requestedId !== undefined) this.tasks.delete(requestedId);
      return;
    }
    const match = TASK_GET_TEXT.exec(text);
    const id = normalizeTaskId(match?.[1]);
    if (!match || id === undefined) return;
    this.upsert(id, match[2], readTaskStatus(match[3]));
  }

  /** TaskList is authoritative: it replaces the whole list, in its order. */
  private applyList(result: ClaudePlanToolResult): void {
    const listed = result.structured?.tasks;
    const next = new Map<string, ClaudePlanTask>();
    if (Array.isArray(listed)) {
      for (const entry of listed) {
        const record = readRecord(entry);
        const id = readTaskId(record);
        if (id === undefined) continue;
        const known = this.tasks.get(id);
        next.set(id, {
          id,
          subject: normalizeSubject(readString(record, "subject") ?? known?.subject, id),
          status: readTaskStatus(record?.status) ?? known?.status ?? "pending",
        });
      }
    } else {
      const text = result.text.trim();
      if (text !== "No tasks found") {
        for (const line of text.split("\n")) {
          const match = TASK_LIST_LINE.exec(line.trim());
          const id = normalizeTaskId(match?.[1]);
          if (!match || id === undefined) continue;
          // The line may end with ` (owner)` too; a known task keeps its known subject.
          const known = this.tasks.get(id);
          const subject =
            known?.subject ??
            normalizeSubject(match[3]?.replace(TASK_LIST_BLOCKED_BY_SUFFIX, ""), id);
          next.set(id, { id, subject, status: readTaskStatus(match[2]) ?? "pending" });
        }
        // Not a format this tracker knows (a newer CLI, team mode): keep the list as it is.
        if (next.size === 0) return;
      }
    }
    this.tasks.clear();
    for (const [id, task] of next) this.tasks.set(id, task);
    enforcePlanTasksCap(this.tasks);
  }

  /** Merges into a known task; inserts an unknown one only when its subject is known. */
  private upsert(
    id: string,
    subject: string | undefined,
    status: ClaudePlanTaskStatus | undefined,
  ): void {
    const known = this.tasks.get(id);
    if (known) {
      this.tasks.set(id, {
        id,
        subject: subject !== undefined ? normalizeSubject(subject, id) : known.subject,
        status: status ?? known.status,
      });
      return;
    }
    if (subject === undefined) return;
    this.tasks.set(id, { id, subject: normalizeSubject(subject, id), status: status ?? "pending" });
    enforcePlanTasksCap(this.tasks);
  }
}

/**
 * The resume cursor's `planTasks` field, tied to the Claude session whose list it is. Empty for
 * an unknown session, and for an empty list the thread shows. `shown: false` marks the list
 * unshown whatever the tracker says (a checkpoint revert).
 */
export function planTasksCursorField(
  tracker: ClaudePlanTaskTracker,
  nativeSessionId: string | undefined,
  options: { readonly shown?: false } = {},
): { readonly planTasks?: ClaudePlanTasksCursor } {
  if (nativeSessionId === undefined) return {};
  const tasks = tracker.snapshot();
  if (tracker.shown && options.shown !== false) {
    return tasks.length > 0 ? { planTasks: { nativeSessionId, tasks } } : {};
  }
  return { planTasks: { nativeSessionId, tasks, shown: false } };
}

/**
 * The task list a resume cursor carries for `nativeSessionId`, the session the cursor resumes.
 * Undefined for any other session: a list belongs to the session that wrote it. Tolerant of a
 * cursor from another build: drops malformed entries and caps the list again.
 */
export function readClaudePlanTasksFromCursor(
  cursor: unknown,
  nativeSessionId: string | undefined,
): ClaudePlanTasksSeed | undefined {
  if (nativeSessionId === undefined) return undefined;
  const field = readRecord(readRecord(cursor)?.planTasks);
  if (field?.nativeSessionId !== nativeSessionId || !Array.isArray(field.tasks)) return undefined;
  return {
    tasks: orderTasks(readStoredTasks(field.tasks).values()),
    shown: field.shown !== false,
  };
}

/** Readable work-log detail for a planning tool row; undefined for any other tool. */
export function claudePlanToolDetail(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!CLAUDE_PLAN_TOOL_NAMES.has(toolName)) return undefined;
  return capText(planToolDetail(toolName, input), PLAN_TOOL_DETAIL_MAX_CHARS).trimEnd();
}

function planToolDetail(toolName: string, input: Record<string, unknown>): string {
  const subject = readString(input, "subject")?.replace(/\s+/g, " ");
  switch (toolName) {
    case "TaskCreate":
      return subject ? `TaskCreate: ${subject}` : toolName;
    case "TaskUpdate": {
      const id = readTaskId(input);
      if (id === undefined) return toolName;
      const status = readString(input, "status");
      return `TaskUpdate: #${id}${status ? ` → ${status}` : ""}${subject ? ` · ${subject}` : ""}`;
    }
    case "TaskGet": {
      const id = readTaskId(input);
      return id === undefined ? toolName : `TaskGet: #${id}`;
    }
    case "TodoWrite": {
      const todos = input.todos;
      if (!Array.isArray(todos)) return toolName;
      return `TodoWrite: ${todos.length} ${todos.length === 1 ? "item" : "items"}`;
    }
    default:
      return toolName;
  }
}
