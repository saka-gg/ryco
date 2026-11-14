/**
 * Typed access to thread activities. `OrchestrationThreadActivity` keeps `kind` an open string and
 * `payload` unknown on the wire: a newer node's kinds, legacy rows and bounded previews
 * (`payloadPreview`) must all still decode, so nothing here decodes at the boundary. Instead:
 *
 * - `ThreadActivityKind` (contracts) names every kind; `isThreadActivityKind` is its guard.
 * - Each payload family has an interface that producers `satisfies` and a lenient reader that
 *   consumers call where they use the payload. A reader checks the kind, then each field's
 *   runtime type, and drops a field whose type is wrong instead of failing the whole row. Strings,
 *   numbers and booleans are checked by `typeof`; arrays and records only by shape, their contents
 *   are trusted as written. The payload object itself is returned when every field checks out, so
 *   the common path allocates nothing.
 *
 * Pure module. Keep it small: the server imports it on its boot path.
 */
import {
  ThreadActivityKind,
  type OrchestrationThreadActivity,
} from "@ryco/contracts/orchestration";
import type {
  RuntimeTaskUsage,
  TaskAgentLinkage,
  ThreadTokenUsageSnapshot,
} from "@ryco/contracts/provider-runtime";

let threadActivityKinds: ReadonlySet<string> | undefined;

/** Whether this version knows the kind. Unknown kinds come from newer nodes; keep them as is. */
export function isThreadActivityKind(kind: string): kind is ThreadActivityKind {
  threadActivityKinds ??= new Set(ThreadActivityKind.literals);
  return threadActivityKinds.has(kind);
}

type ActivityKindSource = Pick<OrchestrationThreadActivity, "kind">;
type ActivitySource = Pick<OrchestrationThreadActivity, "kind" | "payload">;

/**
 * What a reader returns: every field optional, since a legacy row or a preview may lack any of
 * them, and present only when its runtime type matched.
 */
export type ActivityPayloadView<T> = { readonly [K in keyof T]?: Exclude<T[K], undefined> };

type FieldType = "string" | "number" | "boolean" | "array" | "record";

/** The field type a reader checks for a value type; `unknown` fields pass through unchecked. */
type FieldTypeOf<V> = unknown extends V
  ? "unknown"
  : [Exclude<V, undefined>] extends [string]
    ? "string"
    : [Exclude<V, undefined>] extends [number]
      ? "number"
      : [Exclude<V, undefined>] extends [boolean]
        ? "boolean"
        : [Exclude<V, undefined>] extends [ReadonlyArray<unknown>]
          ? "array"
          : "record";

/**
 * One entry per payload field whose type a reader checks, typed from the payload interface so the
 * two cannot drift. `unknown` fields (identities, provider data) pass through and are not listed.
 */
type PayloadFields<T> = {
  readonly [K in keyof Required<T> as FieldTypeOf<T[K]> extends "unknown" ? never : K]: FieldTypeOf<
    T[K]
  >;
};

function fieldMatches(value: unknown, type: FieldType): boolean {
  if (type === "record") return activityPayloadRecord(value) !== null;
  if (type === "array") return Array.isArray(value);
  return typeof value === type;
}

/** A payload's own record: a non-null, non-array object. */
export function activityPayloadRecord(payload: unknown): Readonly<Record<string, unknown>> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function readPayloadFields<T>(
  payload: unknown,
  fields: PayloadFields<T>,
): ActivityPayloadView<T> | undefined {
  const record = activityPayloadRecord(payload);
  if (record === null) return undefined;
  let copy: Record<string, unknown> | null = null;
  for (const key in fields) {
    const value = record[key];
    if (value === undefined || fieldMatches(value, fields[key as keyof typeof fields] as FieldType))
      continue;
    // Copy on the first wrong field only; a well-formed payload is returned as is.
    copy ??= { ...record };
    delete copy[key];
  }
  return (copy ?? record) as ActivityPayloadView<T>;
}

function kindGuard<const K extends ThreadActivityKind>(kinds: ReadonlyArray<K>) {
  const set: ReadonlySet<string> = new Set(kinds);
  return <A extends ActivityKindSource>(activity: A): activity is A & { readonly kind: K } =>
    set.has(activity.kind);
}

function kindReader<const K extends ThreadActivityKind, T>(
  is: (activity: ActivityKindSource) => activity is ActivityKindSource & { readonly kind: K },
  fields: PayloadFields<T>,
) {
  return (activity: ActivitySource): ActivityPayloadView<T> | undefined =>
    is(activity) ? readPayloadFields(activity.payload, fields) : undefined;
}

// ── Approval and question requests ────────────────────────────────────

export const APPROVAL_ACTIVITY_KINDS = [
  "approval.requested",
  "approval.resolved",
  "approval.response.submitted",
  "provider.approval.respond.failed",
] as const satisfies ReadonlyArray<ThreadActivityKind>;

export const USER_INPUT_ACTIVITY_KINDS = [
  "user-input.requested",
  "user-input.resolved",
  "user-input.response.submitted",
  "provider.user-input.respond.failed",
] as const satisfies ReadonlyArray<ThreadActivityKind>;

export type ApprovalActivityKind = (typeof APPROVAL_ACTIVITY_KINDS)[number];
export type UserInputActivityKind = (typeof USER_INPUT_ACTIVITY_KINDS)[number];

export const isApprovalActivity = /* @__PURE__ */ kindGuard(APPROVAL_ACTIVITY_KINDS);
export const isUserInputActivity = /* @__PURE__ */ kindGuard(USER_INPUT_ACTIVITY_KINDS);

/**
 * What every approval and question activity may carry: the request, the person's response
 * attempt, the provider's resolution or the failure that cleared it.
 */
export interface RequestActivityPayload {
  readonly requestId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly detail?: string | undefined;
  readonly responseAttemptId?: string | undefined;
  readonly responseState?: string | undefined;
}

/** An approval activity's payload. The identity keeps its own schema; consumers check it. */
export interface ApprovalActivityPayload extends RequestActivityPayload {
  /** `command`, `file-read` or `file-change`. */
  readonly requestKind?: string | undefined;
  /** The provider's canonical request type. */
  readonly requestType?: string | undefined;
  readonly reason?: string | undefined;
  readonly decision?: string | undefined;
  readonly acceptForSessionOffered?: boolean | undefined;
  readonly approvalIdentity?: unknown;
}

/** A question activity's payload. Identity, questions and answers keep their own parsing. */
export interface UserInputActivityPayload extends RequestActivityPayload {
  /** An optional question the agent does not wait for. */
  readonly nonBlocking?: boolean | undefined;
  readonly itemId?: string | undefined;
  readonly cancelled?: boolean | undefined;
  readonly userInputIdentity?: unknown;
  readonly questions?: unknown;
  readonly answers?: unknown;
  readonly providerRefs?: unknown;
}

const REQUEST_FIELDS: PayloadFields<RequestActivityPayload> = {
  requestId: "string",
  runtimeSessionId: "string",
  detail: "string",
  responseAttemptId: "string",
  responseState: "string",
};

/** The payload of an approval activity (`APPROVAL_ACTIVITY_KINDS`), else undefined. */
export const readApprovalActivityPayload = /* @__PURE__ */ kindReader<
  ApprovalActivityKind,
  ApprovalActivityPayload
>(isApprovalActivity, {
  ...REQUEST_FIELDS,
  requestKind: "string",
  requestType: "string",
  reason: "string",
  decision: "string",
  acceptForSessionOffered: "boolean",
});

/** The payload of a question activity (`USER_INPUT_ACTIVITY_KINDS`), else undefined. */
export const readUserInputActivityPayload = /* @__PURE__ */ kindReader<
  UserInputActivityKind,
  UserInputActivityPayload
>(isUserInputActivity, {
  ...REQUEST_FIELDS,
  nonBlocking: "boolean",
  itemId: "string",
  cancelled: "boolean",
});

// ── Provider tasks ────────────────────────────────────────────────────

export const TASK_ACTIVITY_KINDS = [
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
] as const satisfies ReadonlyArray<ThreadActivityKind>;

export type TaskActivityKind = (typeof TASK_ACTIVITY_KINDS)[number];

export const isTaskActivity = /* @__PURE__ */ kindGuard(TASK_ACTIVITY_KINDS);

/**
 * A provider task's activity payload. Every row repeats the task's agent linkage
 * (`TaskAgentLinkage`) so a client fold survives retention dropping the start row.
 */
export interface TaskActivityPayload extends TaskAgentLinkage {
  readonly taskId?: string | undefined;
  readonly detail?: string | undefined;
  readonly summary?: string | undefined;
  readonly status?: string | undefined;
  readonly error?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly lastToolName?: string | undefined;
  readonly usage?: unknown | undefined;
  /** A usage-only `task.progress` row, kept apart from the activity row. */
  readonly usageSnapshot?: boolean | undefined;
  readonly typedUsage?: RuntimeTaskUsage | undefined;
  readonly runtimeSessionId?: string | undefined;
}

const TASK_FIELDS: PayloadFields<TaskActivityPayload> = {
  taskId: "string",
  detail: "string",
  summary: "string",
  status: "string",
  error: "string",
  endedAt: "string",
  lastToolName: "string",
  usageSnapshot: "boolean",
  typedUsage: "record",
  runtimeSessionId: "string",
  isBackgrounded: "boolean",
  canStop: "boolean",
  canMessage: "boolean",
  taskType: "string",
  agentKind: "string",
  agentId: "string",
  title: "string",
  role: "string",
  model: "string",
  effort: "string",
  toolUseId: "string",
  parentAgentId: "string",
  workflowName: "string",
  agentIndex: "number",
  phaseIndex: "number",
  phaseTitle: "string",
  phases: "array",
  attempt: "number",
  runHandles: "record",
  outputFile: "string",
  agentPath: "string",
  timelineBypass: "boolean",
};

/** The payload of a task activity (`TASK_ACTIVITY_KINDS`), else undefined. */
export const readTaskActivityPayload = /* @__PURE__ */ kindReader(isTaskActivity, TASK_FIELDS);

// ── Tool lifecycle ────────────────────────────────────────────────────

export const TOOL_LIFECYCLE_ACTIVITY_KINDS = [
  "tool.started",
  "tool.updated",
  "tool.completed",
] as const satisfies ReadonlyArray<ThreadActivityKind>;

export const TOOL_ACTIVITY_KINDS = [
  ...TOOL_LIFECYCLE_ACTIVITY_KINDS,
  "tool.progress",
  "tool.denied",
] as const satisfies ReadonlyArray<ThreadActivityKind>;

export type ToolActivityKind = (typeof TOOL_ACTIVITY_KINDS)[number];

export const isToolLifecycleActivity = /* @__PURE__ */ kindGuard(TOOL_LIFECYCLE_ACTIVITY_KINDS);
export const isToolActivity = /* @__PURE__ */ kindGuard(TOOL_ACTIVITY_KINDS);

/**
 * A tool activity's payload: the lifecycle rows of a provider item (`data` is the provider's own,
 * bounded at ingestion), an agent's progress heartbeat, or a denial.
 */
export interface ToolActivityPayload {
  readonly itemType?: string | undefined;
  readonly status?: string | undefined;
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly providerItemId?: string | undefined;
  readonly providerRefs?: unknown | undefined;
  readonly data?: unknown | undefined;
  readonly agentId?: string | undefined;
  readonly parentToolUseId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolUseId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly elapsedSeconds?: number | undefined;
}

const TOOL_FIELDS: PayloadFields<ToolActivityPayload> = {
  itemType: "string",
  status: "string",
  title: "string",
  detail: "string",
  providerItemId: "string",
  agentId: "string",
  parentToolUseId: "string",
  toolName: "string",
  toolUseId: "string",
  taskId: "string",
  elapsedSeconds: "number",
};

/** The payload of a tool activity (`TOOL_ACTIVITY_KINDS`), else undefined. */
export const readToolActivityPayload = /* @__PURE__ */ kindReader(isToolActivity, TOOL_FIELDS);

// ── Subagents ─────────────────────────────────────────────────────────

export const SUBAGENT_ACTIVITY_KINDS = [
  "subagent.started",
  "subagent.updated",
  "subagent.completed",
] as const satisfies ReadonlyArray<ThreadActivityKind>;

export interface SubagentActivityPayload {
  readonly itemType?: string | undefined;
  readonly status?: string | undefined;
  readonly subagent?: Readonly<Record<string, unknown>> | undefined;
  readonly detail?: string | undefined;
  readonly summary?: string | undefined;
  readonly usage?: unknown | undefined;
}

const SUBAGENT_FIELDS: PayloadFields<SubagentActivityPayload> = {
  itemType: "string",
  status: "string",
  subagent: "record",
  detail: "string",
  summary: "string",
};

/** The payload of a subagent activity (`SUBAGENT_ACTIVITY_KINDS`), else undefined. */
export const readSubagentActivityPayload = /* @__PURE__ */ kindReader(
  /* @__PURE__ */ kindGuard(SUBAGENT_ACTIVITY_KINDS),
  SUBAGENT_FIELDS,
);

// ── Session state ─────────────────────────────────────────────────────

/** A `context-window.updated` payload: the provider's usage snapshot. */
export interface ContextWindowActivityPayload extends ThreadTokenUsageSnapshot {
  /** What Statistics counts the snapshot under: provider, model and speed. */
  readonly statisticsProvider?: string | undefined;
  readonly statisticsModel?: string | undefined;
  readonly statisticsSpeed?: string | undefined;
}

const CONTEXT_WINDOW_FIELDS: PayloadFields<ContextWindowActivityPayload> = {
  processedUsage: "record",
  claudeCache: "record",
  usedTokens: "number",
  totalProcessedTokens: "number",
  maxTokens: "number",
  inputTokens: "number",
  cachedInputTokens: "number",
  outputTokens: "number",
  reasoningOutputTokens: "number",
  lastUsedTokens: "number",
  lastInputTokens: "number",
  lastCachedInputTokens: "number",
  lastOutputTokens: "number",
  lastReasoningOutputTokens: "number",
  toolUses: "number",
  durationMs: "number",
  compactsAutomatically: "boolean",
  compactsOnRequest: "boolean",
  statisticsProvider: "string",
  statisticsModel: "string",
  statisticsSpeed: "string",
};

/** The payload of a `context-window.updated` activity, else undefined. */
export const readContextWindowActivityPayload = /* @__PURE__ */ kindReader(
  /* @__PURE__ */ kindGuard(["context-window.updated"]),
  CONTEXT_WINDOW_FIELDS,
);

/** A `turn.plan.updated` payload: the plan steps (`{ step, status }` records) and why. */
export interface TurnPlanActivityPayload {
  readonly plan?: ReadonlyArray<unknown> | undefined;
  /** A string, or null when the provider cleared it. */
  readonly explanation?: unknown;
}

const TURN_PLAN_FIELDS: PayloadFields<TurnPlanActivityPayload> = {
  plan: "array",
};

/** The payload of a `turn.plan.updated` activity, else undefined. */
export const readTurnPlanActivityPayload = /* @__PURE__ */ kindReader(
  /* @__PURE__ */ kindGuard(["turn.plan.updated"]),
  TURN_PLAN_FIELDS,
);

/** A `runtime.error` payload; a usage limit carries its class and reset time. */
export interface RuntimeErrorActivityPayload {
  readonly message?: string | undefined;
  readonly class?: string | undefined;
  /** An ISO time, or null when the provider gave none. */
  readonly resetAt?: unknown;
}

const RUNTIME_ERROR_FIELDS: PayloadFields<RuntimeErrorActivityPayload> = {
  message: "string",
  class: "string",
};

/** The payload of a `runtime.error` activity, else undefined. */
export const readRuntimeErrorActivityPayload = /* @__PURE__ */ kindReader(
  /* @__PURE__ */ kindGuard(["runtime.error"]),
  RUNTIME_ERROR_FIELDS,
);
