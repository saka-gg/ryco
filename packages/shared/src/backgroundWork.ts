/** Compact background-only projection of normalized task activities. Agents keep
 * their existing projection; this module never creates agent identities. */
import { EventId } from "@ryco/contracts";
import { INERT_TASK_TYPES } from "./taskClassification.ts";

export const BACKGROUND_WORK_LIMIT = 100;
export const BACKGROUND_WORK_CHECKPOINT = "background-work.checkpoint";
export const BACKGROUND_WORK_BOUNDARY = "background-work.session-boundary";

export interface BackgroundTask {
  readonly id: string;
  readonly runtimeSessionId: string | null;
  readonly title: string;
  readonly status: "pending" | "running" | "waiting" | "idle";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly activeSince: string | null;
  readonly attempt: number;
  readonly canStop: boolean;
}
export interface BackgroundWork {
  readonly tasks: readonly BackgroundTask[];
  /** Details were dropped, not a claim that omitted work is still running. */
  readonly detailsOmitted: boolean;
}
interface Activity {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt?: string;
}
interface Tombstone {
  readonly id: string;
  readonly attempt: number;
}
interface Checkpoint extends BackgroundWork {
  readonly version: 1;
  readonly runtimeSessionId: string | null;
  readonly ended: boolean;
  readonly tombstones: readonly Tombstone[];
}
const terminal = new Set(["completed", "failed", "stopped", "cancelled", "interrupted"]);
const statuses = new Set(["pending", "running", "waiting", "idle"]);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function attemptOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function key(id: string, session: string | null): string {
  return JSON.stringify([session, id]);
}

function fold(activities: readonly Activity[], expectedSession?: string): Checkpoint {
  const tasks = new Map<string, BackgroundTask>();
  const tombstones = new Map<string, number>();
  let runtimeSessionId: string | null = expectedSession ?? null;
  let ended = false;
  let detailsOmitted = false;
  const rememberTerminal = (id: string, attempt: number) => {
    tombstones.delete(id);
    tombstones.set(id, attempt);
    if (tombstones.size > BACKGROUND_WORK_LIMIT) {
      const oldest = tombstones.keys().next().value;
      if (oldest !== undefined) tombstones.delete(oldest);
    }
  };
  for (const activity of activities) {
    const payload = record(activity.payload);
    if (activity.kind === BACKGROUND_WORK_CHECKPOINT && payload.version === 1) {
      if (expectedSession !== undefined && payload.runtimeSessionId !== expectedSession) continue;
      tasks.clear();
      tombstones.clear();
      runtimeSessionId = string(payload.runtimeSessionId);
      ended = payload.ended === true;
      detailsOmitted = payload.detailsOmitted === true;
      if (Array.isArray(payload.tasks)) {
        for (const value of payload.tasks.slice(0, BACKGROUND_WORK_LIMIT)) {
          const row = record(value);
          const id = string(row.id);
          const title = string(row.title);
          const startedAt = string(row.startedAt);
          const updatedAt = string(row.updatedAt);
          if (!id || !title || !startedAt || !updatedAt || !statuses.has(String(row.status)))
            continue;
          const session = string(row.runtimeSessionId);
          tasks.set(key(id, session), {
            id,
            runtimeSessionId: session,
            title: title.slice(0, 180),
            startedAt,
            updatedAt,
            status: row.status as BackgroundTask["status"],
            elapsedMs:
              typeof row.elapsedMs === "number" && Number.isFinite(row.elapsedMs)
                ? Math.max(0, row.elapsedMs)
                : 0,
            activeSince: string(row.activeSince),
            attempt: attemptOf(row.attempt),
            canStop: row.canStop === true,
          });
        }
      }
      if (Array.isArray(payload.tombstones)) {
        for (const value of payload.tombstones.slice(0, BACKGROUND_WORK_LIMIT)) {
          const row = record(value);
          const id = string(row.id);
          if (id) rememberTerminal(id, attemptOf(row.attempt));
        }
      }
      continue;
    }
    if (activity.kind === BACKGROUND_WORK_BOUNDARY) {
      const incomingSession = string(payload.runtimeSessionId);
      if (expectedSession !== undefined && incomingSession !== expectedSession) continue;
      if (
        payload.state === "started" &&
        incomingSession !== null &&
        incomingSession === runtimeSessionId
      )
        continue;
      tasks.clear();
      tombstones.clear();
      detailsOmitted = false;
      runtimeSessionId = string(payload.runtimeSessionId);
      ended = payload.state !== "started";
      continue;
    }
    if (activity.kind === "background-work.omitted") {
      if (expectedSession === undefined || payload.runtimeSessionId === expectedSession) {
        runtimeSessionId = string(payload.runtimeSessionId) ?? runtimeSessionId;
        detailsOmitted = true;
      }
      continue;
    }
    if (!activity.kind.startsWith("task.")) continue;
    const id = string(payload.taskId);
    if (!id) continue;
    const session = string(payload.runtimeSessionId);
    if (id.length > 512 || (session?.length ?? 0) > 512) {
      detailsOmitted = true;
      continue;
    }
    // The ingestion epoch guard owns admission. Persisted epochs additionally
    // prevent a previous process's retained work from reviving after reload.
    if (runtimeSessionId !== null && session !== runtimeSessionId) continue;
    if (runtimeSessionId === null && session !== null) runtimeSessionId = session;
    if (ended) continue;
    const identity = key(id, session);
    const previous = tasks.get(identity);
    const attempt =
      payload.attempt === undefined ? (previous?.attempt ?? 0) : attemptOf(payload.attempt);
    if (attempt < (previous?.attempt ?? 0)) continue;
    const settledAttempt = tombstones.get(identity);
    if (settledAttempt !== undefined && attempt <= settledAttempt) continue;
    const taskType = string(payload.taskType);
    if (
      payload.agentKind === "agent" ||
      string(payload.agentId) ||
      (taskType !== null && INERT_TASK_TYPES.has(taskType)) ||
      payload.isBackgrounded === false
    ) {
      tasks.delete(identity);
      continue;
    }
    if (activity.kind === "task.completed" || terminal.has(String(payload.status))) {
      tasks.delete(identity);
      if (previous || payload.agentKind === "background" || payload.isBackgrounded === true)
        rememberTerminal(identity, attempt);
      continue;
    }
    // Shell type alone also describes foreground commands. Require explicit
    // background evidence, except the provider's dedicated monitor types.
    if (
      !previous &&
      payload.isBackgrounded !== true &&
      taskType !== "monitor" &&
      taskType !== "monitor_mcp"
    )
      continue;
    if (!previous && activity.kind === "task.progress" && !statuses.has(String(payload.status))) {
      // A description tick cannot establish liveness when its lifecycle fell
      // outside retention (it could be a delayed tick from a settled task).
      detailsOmitted = true;
      continue;
    }
    if (!previous && tasks.size >= BACKGROUND_WORK_LIMIT) {
      detailsOmitted = true;
      continue;
    }
    const at = activity.createdAt ?? "";
    const newAttempt = attempt > (previous?.attempt ?? 0);
    const status = statuses.has(String(payload.status))
      ? (payload.status as BackgroundTask["status"])
      : newAttempt
        ? "running"
        : (previous?.status ?? "running");
    const wasActive = previous?.status !== "idle";
    const statusChanged = newAttempt || (previous !== undefined && previous.status !== status);
    const accrued =
      previous?.activeSince && statusChanged && wasActive
        ? Math.max(0, Date.parse(at) - Date.parse(previous.activeSince))
        : 0;
    tasks.set(identity, {
      id,
      runtimeSessionId: session,
      elapsedMs: newAttempt
        ? 0
        : (previous?.elapsedMs ?? 0) + (Number.isFinite(accrued) ? accrued : 0),
      activeSince: status === "idle" ? null : statusChanged ? at : (previous?.activeSince ?? at),
      title: (
        string(payload.detail) ??
        string(payload.title) ??
        string(payload.description) ??
        previous?.title ??
        "Background task"
      ).slice(0, 180),
      status,
      attempt,
      startedAt: newAttempt ? at : (previous?.startedAt ?? at),
      updatedAt: at,
      canStop:
        typeof payload.canStop === "boolean" ? payload.canStop : (previous?.canStop ?? false),
    });
  }
  return {
    version: 1,
    tasks: [...tasks.values()],
    tombstones: [...tombstones].map(([id, attempt]) => ({ id, attempt })),
    detailsOmitted,
    runtimeSessionId,
    ended,
  };
}

export function deriveBackgroundWork(
  activities: readonly Activity[],
  runtimeSessionId?: string,
): BackgroundWork {
  const { tasks, detailsOmitted } = fold(activities, runtimeSessionId);
  return { tasks, detailsOmitted };
}

/** A single bounded checkpoint replaces background evidence outside the normal
 * activity tail. Keep it BEFORE the tail so later completions still settle it.
 * This is a derived read-model artifact, never a new persisted agent registry. */
export function backgroundWorkCheckpoint<T extends Activity & { readonly id: EventId }>(
  prefix: readonly T[],
): T | undefined {
  const last = prefix.at(-1);
  if (
    !last ||
    !prefix.some(
      (activity) =>
        activity.kind.startsWith("task.") ||
        activity.kind === BACKGROUND_WORK_BOUNDARY ||
        activity.kind === BACKGROUND_WORK_CHECKPOINT ||
        activity.kind === "background-work.omitted",
    )
  )
    return undefined;
  const payload = fold(prefix);
  if (
    !payload.tasks.length &&
    !payload.tombstones.length &&
    !payload.detailsOmitted &&
    !payload.runtimeSessionId &&
    !payload.ended
  )
    return undefined;
  return {
    ...last,
    id: EventId.make("~background-work:checkpoint"),
    kind: BACKGROUND_WORK_CHECKPOINT,
    payload,
    summary: "Retained background work",
    tone: "info",
    turnId: null,
  };
}
