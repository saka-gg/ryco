import type { OrchestrationLatestTurnState, OrchestrationThreadActivity } from "@ryco/contracts";

import { deriveWorkLogEntries, type WorkLogEntry } from "./session-logic.ts";
import { assignSubagentIdentities, canonicalSubagentIdentityKey } from "./subagentIdentity.ts";

export type ThreadSubagentStatus = "running" | "idle" | "finished" | "failed" | "interrupted";

export interface ThreadSubagentMessageView {
  id: string;
  sequence?: number;
  text: string;
  createdAt: string;
  providerThreadId: string | null;
}

export interface ThreadSubagentView {
  key: string;
  /** Stable, unique abstract codename used as the subagent's primary identity. */
  name: string;
  /** Stable avatar seed shared with the runtime roster. */
  avatarKey?: string;
  /** Inferred descriptive role (e.g. "Code Reviewer"), shown as a subtitle. */
  role?: string | null;
  status: ThreadSubagentStatus;
  origin?: string | null;
  capability?: string | null;
  model?: string | null;
  effort?: string | null;
  tool: string | null;
  detail: string | null;
  providerThreadIds: string[];
  providerSessionIds?: string[];
  startedAt: string;
  updatedAt: string;
  entries: WorkLogEntry[];
  messages: ThreadSubagentMessageView[];
}

interface MutableThreadSubagentView {
  key: string;
  name: string | null;
  status: ThreadSubagentStatus;
  origin: string | null;
  capability: string | null;
  model: string | null;
  effort: string | null;
  tool: string | null;
  detail: string | null;
  providerThreadIds: Set<string>;
  providerSessionIds: Set<string>;
  attempt: number | null;
  startedAt: string;
  updatedAt: string;
  entries: WorkLogEntry[];
  messages: ThreadSubagentMessageView[];
}

type InternalThreadSubagentMessageView = ThreadSubagentMessageView & {
  subagentKey: string | null;
};

const GENERIC_SUBAGENT_TITLES = new Set([
  "agent",
  "subagent",
  "subagent task",
  "task",
  "tool call",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const text = asTrimmedString(entry);
        return text ? [text] : [];
      })
    : [];
}

function asNonNegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeForKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "agent";
}

function titleCaseCompact(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function payloadFromActivity(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | null {
  return asRecord(activity.payload);
}

function inputFromPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const data = asRecord(payload?.data);
  const input = asRecord(data?.input);
  if (input) {
    return input;
  }
  const state = asRecord(data?.state);
  return asRecord(state?.input);
}

function collabItemFromPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  return item?.type === "collabAgentToolCall" ? item : null;
}

function canonicalSubagentFromPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return asRecord(payload?.subagent);
}

function metadataFromSubagent(
  subagent: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return asRecord(subagent?.metadata);
}

function canonicalSubagentKey(subagentId: string): string {
  return `subagent:${subagentId}`;
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const state = asRecord(data?.state);
  const item = collabItemFromPayload(payload);
  const providerRefs = asRecord(payload?.providerRefs);
  return (
    asTrimmedString(payload?.providerItemId) ??
    asTrimmedString(providerRefs?.providerItemId) ??
    asTrimmedString(item?.id) ??
    asTrimmedString(data?.toolCallId) ??
    asTrimmedString(data?.callID) ??
    asTrimmedString(data?.callId) ??
    asTrimmedString(state?.callID) ??
    asTrimmedString(state?.callId) ??
    null
  );
}

function extractCanonicalSubagentId(payload: Record<string, unknown> | null): string | null {
  const subagent = canonicalSubagentFromPayload(payload);
  return (
    asTrimmedString(subagent?.subagentId) ??
    asTrimmedString(payload?.subagentId) ??
    asTrimmedString(payload?.taskId)
  );
}

function extractProviderThreadIds(payload: Record<string, unknown> | null): string[] {
  const subagent = canonicalSubagentFromPayload(payload);
  const canonicalIds = [
    asTrimmedString(subagent?.providerThreadId),
    ...asStringArray(subagent?.providerThreadIds),
    asTrimmedString(payload?.providerThreadId),
  ].filter((id): id is string => id !== null);
  if (canonicalIds.length > 0) {
    return [...new Set(canonicalIds)];
  }

  const item = collabItemFromPayload(payload);
  if (!item) {
    return [];
  }
  return asStringArray(item.receiverThreadIds);
}

function extractProviderSessionIds(payload: Record<string, unknown> | null): string[] {
  const subagent = canonicalSubagentFromPayload(payload);
  return [
    asTrimmedString(subagent?.providerSessionId),
    ...asStringArray(subagent?.providerSessionIds),
    asTrimmedString(payload?.providerSessionId),
  ].filter((id): id is string => id !== null);
}

function extractSubagentTool(payload: Record<string, unknown> | null): string | null {
  return (
    asTrimmedString(payload?.lastToolName) ??
    asTrimmedString(canonicalSubagentFromPayload(payload)?.providerTaskId) ??
    asTrimmedString(collabItemFromPayload(payload)?.tool)
  );
}

function extractSubagentOrigin(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(canonicalSubagentFromPayload(payload)?.origin);
}

function extractSubagentCapability(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(canonicalSubagentFromPayload(payload)?.capability);
}

function extractSubagentModel(payload: Record<string, unknown> | null): string | null {
  const subagent = canonicalSubagentFromPayload(payload);
  return asTrimmedString(subagent?.model) ?? asTrimmedString(payload?.model);
}

function extractSubagentEffort(payload: Record<string, unknown> | null): string | null {
  const subagent = canonicalSubagentFromPayload(payload);
  return asTrimmedString(subagent?.effort) ?? asTrimmedString(payload?.effort);
}

function detailPrefix(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex > 28) {
    return null;
  }
  const prefix = value.slice(0, separatorIndex).trim();
  if (!/^[\w -]+$/.test(prefix)) {
    return null;
  }
  const normalized = prefix.toLowerCase();
  return GENERIC_SUBAGENT_TITLES.has(normalized) ? null : prefix;
}

function labeledPromptValue(value: string | null, label: "role" | "task"): string | null {
  if (!value) {
    return null;
  }
  const match = new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([^\\n]+)`, "i").exec(value);
  return asTrimmedString(match?.[1]);
}

function roleFromLabeledPrompt(value: string | null): string | null {
  const role = labeledPromptValue(value, "role")
    ?.replace(/[.,;:]+$/, "")
    .trim();
  return role ? titleCaseCompact(role) : null;
}

function taskFromLabeledPrompt(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const focus = /(?:^|\n)\s*focus(?:\s+on)?\s*:?\s*([^\n]+)/i.exec(value);
  return asTrimmedString(focus?.[1]) ?? labeledPromptValue(value, "task");
}

function extractSubagentName(
  payload: Record<string, unknown> | null,
  fallbackDetail: string | null,
): string | null {
  const input = inputFromPayload(payload);
  const data = asRecord(payload?.data);
  const state = asRecord(data?.state);
  const item = collabItemFromPayload(payload);
  const subagent = canonicalSubagentFromPayload(payload);
  const metadata = metadataFromSubagent(subagent);
  const candidates = [
    subagent?.label,
    subagent?.displayName,
    subagent?.role,
    subagent?.name,
    metadata?.label,
    metadata?.displayName,
    metadata?.role,
    metadata?.name,
    metadata?.title,
    payload?.role,
    payload?.title,
    input?.subagent_type,
    input?.agent_type,
    input?.agent_role,
    input?.agent,
    input?.name,
    data?.agentName,
    state?.agentName,
    roleFromLabeledPrompt(asTrimmedString(item?.prompt)),
    roleFromLabeledPrompt(fallbackDetail),
    detailPrefix(fallbackDetail),
    inferRoleFromPrompt(fallbackDetail),
  ];

  for (const candidate of candidates) {
    const value = asTrimmedString(candidate);
    if (!value) {
      continue;
    }
    const normalized = value.toLowerCase();
    if (GENERIC_SUBAGENT_TITLES.has(normalized)) {
      continue;
    }
    return titleCaseCompact(value);
  }

  return null;
}

function inferRoleFromPrompt(prompt: string | null): string | null {
  if (!prompt) {
    return null;
  }
  const match =
    /\byou are an?\s+([a-z][a-z0-9 _-]{1,40}?)(?:[,.!?;:\n]|\s+who\s+|\s+tasked\s+|\s+responsible\s+|$)/i.exec(
      prompt,
    );
  const role = asTrimmedString(match?.[1]);
  if (!role) {
    return null;
  }
  const normalized = role.toLowerCase();
  if (GENERIC_SUBAGENT_TITLES.has(normalized)) {
    return null;
  }
  return titleCaseCompact(role);
}

function firstCollabAgentStateMessage(item: Record<string, unknown> | null): string | null {
  const states = asRecord(item?.agentsStates);
  if (!states) {
    return null;
  }
  for (const state of Object.values(states)) {
    const message = asTrimmedString(asRecord(state)?.message);
    if (message) {
      return message;
    }
  }
  return null;
}

function extractSubagentDetail(
  payload: Record<string, unknown> | null,
  fallback: string | null,
): string | null {
  const input = inputFromPayload(payload);
  const item = collabItemFromPayload(payload);
  const subagent = canonicalSubagentFromPayload(payload);
  const metadata = metadataFromSubagent(subagent);
  const detail =
    asTrimmedString(item?.prompt) ??
    firstCollabAgentStateMessage(item) ??
    asTrimmedString(payload?.summary) ??
    asTrimmedString(payload?.detail) ??
    asTrimmedString(subagent?.description) ??
    asTrimmedString(subagent?.detail) ??
    asTrimmedString(metadata?.description) ??
    asTrimmedString(metadata?.detail) ??
    asTrimmedString(input?.description) ??
    asTrimmedString(input?.prompt) ??
    asTrimmedString(input?.task) ??
    asTrimmedString(payload?.detail) ??
    fallback;
  return taskFromLabeledPrompt(detail) ?? detail;
}

function isSubagentPayload(payload: Record<string, unknown> | null): boolean {
  return payload?.itemType === "collab_agent_tool_call" || payload?.itemType === "subagent";
}

function isTaskAgentActivity(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): boolean {
  return activity.kind.startsWith("task.") && payload?.agentKind === "agent";
}

function statusFromCollabAgentStatus(status: string | null): ThreadSubagentStatus | null {
  switch (status) {
    case "pendingInit":
    case "running":
      return "running";
    case "completed":
    case "shutdown":
      return "finished";
    case "errored":
    case "notFound":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return null;
  }
}

function statusFromCollabItem(
  payload: Record<string, unknown> | null,
): ThreadSubagentStatus | null {
  const item = collabItemFromPayload(payload);
  const states = asRecord(item?.agentsStates);
  if (states && Object.keys(states).length > 0) {
    let sawRunning = false;
    let sawFinished = false;
    let sawInterrupted = false;
    for (const state of Object.values(states)) {
      const status = statusFromCollabAgentStatus(asTrimmedString(asRecord(state)?.status));
      if (status === "failed") {
        return "failed";
      }
      if (status === "interrupted") {
        sawInterrupted = true;
      }
      if (status === "running") {
        sawRunning = true;
      }
      if (status === "finished") {
        sawFinished = true;
      }
    }
    if (sawRunning) {
      return "running";
    }
    if (sawInterrupted) {
      return "interrupted";
    }
    if (sawFinished) {
      return "finished";
    }
  }

  // The collab tool itself completes as soon as a child has been launched;
  // that does not mean the child completed. Agent states above are therefore
  // authoritative whenever present, with tool status only as a fallback.
  const itemStatus = asTrimmedString(item?.status);
  if (itemStatus === "failed") {
    return "failed";
  }
  if (itemStatus === "completed") {
    return "finished";
  }
  if (itemStatus === "inProgress") {
    return "running";
  }
  return null;
}

function statusFromActivity(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): ThreadSubagentStatus | null {
  if (collabItemFromPayload(payload)) {
    const collabStatus = statusFromCollabItem(payload);
    if (collabStatus) {
      return collabStatus;
    }
  }
  if (
    payload?.status === "starting" ||
    payload?.status === "pending" ||
    payload?.status === "running" ||
    payload?.status === "waiting"
  ) {
    return "running";
  }
  if (payload?.status === "failed") {
    return "failed";
  }
  if (payload?.status === "interrupted") {
    return "interrupted";
  }
  if (
    payload?.status === "completed" ||
    payload?.status === "stopped" ||
    payload?.status === "cancelled"
  ) {
    return "finished";
  }
  if (payload?.status === "idle") {
    return "idle";
  }
  if (payload?.status === "inProgress") {
    return "running";
  }
  if (activity.kind === "tool.started" || activity.kind === "tool.updated") {
    return "running";
  }
  if (activity.kind === "tool.completed") {
    return activity.tone === "error" ? "failed" : "finished";
  }
  if (activity.kind === "task.started") {
    return "running";
  }
  if (activity.kind === "task.progress") {
    return payload?.usageSnapshot === true ? null : "running";
  }
  return null;
}

function statusFromWorkEntry(entry: WorkLogEntry): ThreadSubagentStatus {
  if (entry.tone === "error" || (entry.exitCode !== undefined && entry.exitCode !== 0)) {
    return "failed";
  }
  return "finished";
}

function subagentKey(input: {
  canonicalSubagentId?: string | null;
  toolCallId: string | null;
  name: string | null;
  detail: string | null;
  fallbackId: string;
}): string {
  if (input.canonicalSubagentId) {
    return canonicalSubagentKey(input.canonicalSubagentId);
  }
  if (input.toolCallId) {
    return `subagent:${normalizeForKey(input.toolCallId)}`;
  }
  if (input.name && input.detail) {
    return `subagent:${normalizeForKey(`${input.name}:${input.detail}`)}`;
  }
  if (input.detail) {
    return `subagent:${normalizeForKey(input.detail)}`;
  }
  if (input.name) {
    return `subagent:${normalizeForKey(input.name)}`;
  }
  return `subagent:${normalizeForKey(input.fallbackId)}`;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const leftSequence = left.sequence;
  const rightSequence = right.sequence;
  if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function applyStatus(
  previous: ThreadSubagentStatus,
  next: ThreadSubagentStatus,
  allowTerminalReactivation = false,
): ThreadSubagentStatus {
  if (
    (previous === "finished" || previous === "failed" || previous === "interrupted") &&
    !allowTerminalReactivation
  ) {
    return previous;
  }
  if (next === "failed") {
    return "failed";
  }
  if (previous === "failed") {
    return previous;
  }
  return next;
}

function mergeProviderThreadIds(target: Set<string>, ids: ReadonlyArray<string>): void {
  for (const id of ids) {
    target.add(id);
  }
}

function mergeStringSet(target: Set<string>, values: ReadonlyArray<string>): void {
  for (const value of values) {
    target.add(value);
  }
}

function toWorkEntrySubagentKey(entry: WorkLogEntry): string {
  const rawDetail = entry.detail ?? entry.output ?? null;
  const detail = taskFromLabeledPrompt(rawDetail) ?? rawDetail;
  const name = extractSubagentName(null, rawDetail ?? entry.toolTitle ?? entry.label);
  return subagentKey({
    canonicalSubagentId: null,
    toolCallId: null,
    name,
    detail: detail ?? entry.label,
    fallbackId: entry.id,
  });
}

function findSubagentByProviderThreadId(
  subagents: ReadonlyMap<string, MutableThreadSubagentView>,
  providerThreadId: string | null,
): MutableThreadSubagentView | null {
  if (!providerThreadId) {
    return null;
  }
  for (const subagent of subagents.values()) {
    if (subagent.providerThreadIds.has(providerThreadId)) {
      return subagent;
    }
  }
  return null;
}

function messageFromActivity(
  activity: OrchestrationThreadActivity,
): InternalThreadSubagentMessageView | null {
  if (activity.kind !== "agent.message" && !activity.kind.startsWith("subagent.message")) {
    return null;
  }
  const payload = payloadFromActivity(activity);
  const subagent = canonicalSubagentFromPayload(payload);
  const providerRefs = asRecord(payload?.providerRefs);
  const subagentId = extractCanonicalSubagentId(payload);
  const text =
    asTrimmedString(payload?.text) ??
    asTrimmedString(payload?.delta) ??
    asTrimmedString(payload?.summary);
  if (!text) {
    return null;
  }
  return {
    id:
      asTrimmedString(payload?.providerItemId) ??
      asTrimmedString(providerRefs?.providerItemId) ??
      activity.id,
    text,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    createdAt: activity.createdAt,
    providerThreadId:
      asTrimmedString(payload?.providerThreadId) ??
      asTrimmedString(subagent?.providerThreadId) ??
      asTrimmedString(payload?.providerSessionId) ??
      asTrimmedString(subagent?.providerSessionId),
    subagentKey: subagentId ? canonicalSubagentKey(subagentId) : null,
  };
}

function findSubagentByVisibleIdentity(
  subagents: ReadonlyMap<string, MutableThreadSubagentView>,
  input: { name: string | null; detail: string | null },
): MutableThreadSubagentView | null {
  for (const subagent of subagents.values()) {
    if (
      input.detail &&
      subagent.detail === input.detail &&
      (!input.name || !subagent.name || input.name === subagent.name)
    ) {
      return subagent;
    }
    if (input.name && input.detail && subagent.name === input.name && subagent.detail === null) {
      return subagent;
    }
  }
  return null;
}

function isSpawnCollabTool(toolName: string | null): boolean {
  const tool = toolName?.replace(/[_\s-]+/g, "").toLocaleLowerCase();
  return tool === "spawnagent" || tool === "spawnagents" || tool === "spawn";
}

function isSpawnCollabItem(item: Record<string, unknown>): boolean {
  return isSpawnCollabTool(asTrimmedString(item.tool));
}

function mergeCollabAgentStates(
  subagents: ReadonlyMap<string, MutableThreadSubagentView>,
  activity: OrchestrationThreadActivity,
  item: Record<string, unknown>,
): void {
  const states = asRecord(item.agentsStates);
  if (!states) {
    return;
  }
  for (const [providerThreadId, stateValue] of Object.entries(states)) {
    const subagent = findSubagentByProviderThreadId(subagents, providerThreadId);
    if (!subagent) {
      continue;
    }
    const state = asRecord(stateValue);
    const status = statusFromCollabAgentStatus(asTrimmedString(state?.status));
    const message = asTrimmedString(state?.message);
    if (status) {
      subagent.status = applyStatus(subagent.status, status);
    }
    if (message && subagent.messages.at(-1)?.text !== message) {
      subagent.messages.push({
        id: `${activity.id}:${providerThreadId}`,
        text: message,
        createdAt: activity.createdAt,
        providerThreadId,
      });
    }
    if (status || message) {
      subagent.updatedAt = activity.createdAt;
    }
  }
}

export function deriveThreadSubagents(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: {
    readonly sessionLive?: boolean;
    readonly parentTurnState?: OrchestrationLatestTurnState | null;
  },
): ThreadSubagentView[] {
  const subagents = new Map<string, MutableThreadSubagentView>();
  const coordinationActivityIds = new Set<string>();
  const subagentKeyByActivityId = new Map<string, string>();
  const orderedActivities = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of orderedActivities) {
    const payload = payloadFromActivity(activity);
    if (!isSubagentPayload(payload) && !isTaskAgentActivity(activity, payload)) {
      continue;
    }

    const collabItem = collabItemFromPayload(payload);
    if (collabItem && !isSpawnCollabItem(collabItem)) {
      // wait/send/resume/close calls coordinate already-known children. They
      // may carry the most authoritative per-child terminal state and final
      // message, but are not themselves agents.
      coordinationActivityIds.add(activity.id);
      mergeCollabAgentStates(subagents, activity, collabItem);
      continue;
    }

    const detail =
      payload?.usageSnapshot === true
        ? null
        : extractSubagentDetail(payload, asTrimmedString(activity.summary));
    const name = extractSubagentName(payload, detail);
    const explicitRole = asTrimmedString(payload?.role);
    const canonicalSubagentId = extractCanonicalSubagentId(payload);
    const providerThreadIds = extractProviderThreadIds(payload);
    const providerSessionIds = extractProviderSessionIds(payload);
    const origin = extractSubagentOrigin(payload);
    const capability = extractSubagentCapability(payload);
    const model = extractSubagentModel(payload);
    const effort = extractSubagentEffort(payload);
    const tool = extractSubagentTool(payload);
    const key = subagentKey({
      canonicalSubagentId,
      toolCallId: extractToolCallId(payload),
      name,
      detail,
      fallbackId: activity.id,
    });
    const existing = subagents.get(key);
    const status = statusFromActivity(activity, payload);
    subagentKeyByActivityId.set(activity.id, key);

    if (existing) {
      existing.name = explicitRole ? titleCaseCompact(explicitRole) : (existing.name ?? name);
      existing.detail = detail ?? existing.detail;
      existing.origin = existing.origin ?? origin;
      existing.capability = existing.capability ?? capability;
      existing.model = existing.model ?? model;
      existing.effort = existing.effort ?? effort;
      existing.tool = existing.tool ?? tool;
      mergeProviderThreadIds(existing.providerThreadIds, providerThreadIds);
      mergeStringSet(existing.providerSessionIds, providerSessionIds);
      const nextAttempt = asNonNegativeCount(payload?.attempt);
      const startsNewAttempt =
        nextAttempt !== null && existing.attempt !== null && nextAttempt > existing.attempt;
      if (nextAttempt !== null) {
        existing.attempt = nextAttempt;
      }
      if (status) {
        existing.status = applyStatus(existing.status, status, startsNewAttempt);
      }
      existing.updatedAt = activity.createdAt;
      if (collabItem) {
        mergeCollabAgentStates(subagents, activity, collabItem);
      }
      continue;
    }

    subagents.set(key, {
      key,
      name,
      status:
        status ??
        (isTaskAgentActivity(activity, payload) && payload?.usageSnapshot === true
          ? "running"
          : "idle"),
      origin,
      capability,
      model,
      effort,
      tool,
      detail,
      providerThreadIds: new Set(providerThreadIds),
      providerSessionIds: new Set(providerSessionIds),
      attempt: asNonNegativeCount(payload?.attempt),
      startedAt: activity.createdAt,
      updatedAt: activity.createdAt,
      entries: [],
      messages: [],
    });
    if (collabItem) {
      mergeCollabAgentStates(subagents, activity, collabItem);
    }
  }

  for (const activity of orderedActivities) {
    const message = messageFromActivity(activity);
    if (!message) {
      continue;
    }
    const subagent = message.subagentKey
      ? (subagents.get(message.subagentKey) ?? null)
      : findSubagentByProviderThreadId(subagents, message.providerThreadId);
    if (!subagent) {
      continue;
    }
    const { subagentKey: _subagentKey, ...messageView } = message;
    subagent.messages.push(messageView);
    subagent.updatedAt = activity.createdAt;
  }

  for (const entry of deriveWorkLogEntries(activities, undefined)) {
    if (entry.itemType !== "collab_agent_tool_call" || coordinationActivityIds.has(entry.id)) {
      continue;
    }

    const rawDetail = entry.detail ?? entry.output ?? null;
    const detail = taskFromLabeledPrompt(rawDetail) ?? rawDetail;
    const name = extractSubagentName(null, rawDetail ?? entry.toolTitle ?? entry.label);
    const key = toWorkEntrySubagentKey(entry);
    const lifecycleKey = subagentKeyByActivityId.get(entry.id);
    const existing =
      (lifecycleKey ? subagents.get(lifecycleKey) : undefined) ??
      subagents.get(key) ??
      findSubagentByVisibleIdentity(subagents, { name, detail });
    const status = statusFromWorkEntry(entry);
    if (existing) {
      existing.entries.push(entry);
      // A Codex spawn tool completes after launch, while the child remains
      // pending/running. Its embedded agentsStates drive lifecycle above.
      if (!isSpawnCollabTool(existing.tool)) {
        existing.status = applyStatus(existing.status, status);
      }
      existing.updatedAt = entry.createdAt;
      continue;
    }

    subagents.set(key, {
      key,
      name,
      status,
      origin: null,
      capability: null,
      model: null,
      effort: null,
      tool: null,
      detail,
      providerThreadIds: new Set(),
      providerSessionIds: new Set(),
      attempt: null,
      startedAt: entry.createdAt,
      updatedAt: entry.createdAt,
      entries: [entry],
      messages: [],
    });
  }

  // Agent-owned tools were deliberately removed from the parent work log.
  // Re-home them using explicit task / parent-tool / provider-thread linkage.
  // Build indexes before reading tools so late lifecycle discovery is safe.
  const byIdentity = new Map<string, MutableThreadSubagentView>();
  const byLaunchTool = new Map<string, MutableThreadSubagentView>();
  for (const agent of subagents.values())
    byIdentity.set(canonicalSubagentIdentityKey(agent.key), agent);
  for (const activity of orderedActivities) {
    const key = subagentKeyByActivityId.get(activity.id);
    const agent = key ? subagents.get(key) : undefined;
    if (!agent) continue;
    const payload = payloadFromActivity(activity);
    const launch =
      asTrimmedString(payload?.toolUseId) ??
      asTrimmedString(canonicalSubagentFromPayload(payload)?.parentProviderItemId);
    if (launch) byLaunchTool.set(launch, agent);
  }
  const toolsByAgent = new Map<MutableThreadSubagentView, OrchestrationThreadActivity[]>();
  for (const activity of orderedActivities) {
    if (!activity.kind.startsWith("tool.")) continue;
    const payload = payloadFromActivity(activity);
    const owner = asTrimmedString(payload?.agentId);
    const launch = asTrimmedString(payload?.parentToolUseId);
    const providerThread = asTrimmedString(asRecord(payload?.providerRefs)?.providerThreadId);
    const agent =
      (owner ? byIdentity.get(canonicalSubagentIdentityKey(owner)) : undefined) ??
      (launch ? byLaunchTool.get(launch) : undefined) ??
      (providerThread ? findSubagentByProviderThreadId(subagents, providerThread) : undefined);
    if (!agent) continue;
    const rows = toolsByAgent.get(agent) ?? [];
    rows.push(activity);
    toolsByAgent.set(agent, rows);
  }
  for (const [agent, rows] of toolsByAgent) {
    const tools = deriveWorkLogEntries(rows, undefined, { agentTimeline: true });
    const existingIds = new Set(agent.entries.map((entry) => entry.id));
    agent.entries.push(...tools.filter((entry) => !existingIds.has(entry.id)));
  }

  const ordered = [...subagents.values()].toSorted((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );

  // Legacy Codex collaboration rows can be missing their final wait/close
  // event when the parent is interrupted or the provider process exits. The
  // persisted parent lifecycle is then authoritative: no transcript-only
  // child from that activation may resurrect as Working after reload.
  if (
    options?.sessionLive === false ||
    options?.parentTurnState === "interrupted" ||
    options?.parentTurnState === "error"
  ) {
    for (const subagent of ordered) {
      if (subagent.status === "running") {
        subagent.status = "interrupted";
      }
    }
  }

  // Every subagent gets a stable, unique abstract codename as its primary
  // identity; any inferred descriptive label is demoted to `role` (a subtitle).
  const identitiesByKey = assignSubagentIdentities(
    ordered.map((subagent) => ({
      key: subagent.key,
      role: subagent.name,
      taskLabel: subagent.detail,
    })),
  );

  return ordered.map((subagent) => {
    const identity = identitiesByKey.get(subagent.key);
    return {
      key: subagent.key,
      name: identity?.codename ?? subagent.key,
      avatarKey: identity?.avatarKey ?? subagent.key,
      role: identity?.role ?? subagent.name,
      status: subagent.status,
      origin: subagent.origin,
      capability: subagent.capability,
      model: subagent.model,
      effort: subagent.effort,
      tool: subagent.tool,
      detail: subagent.detail,
      providerThreadIds: [...subagent.providerThreadIds],
      providerSessionIds: [...subagent.providerSessionIds],
      startedAt: subagent.startedAt,
      updatedAt: subagent.updatedAt,
      entries: subagent.entries,
      messages: subagent.messages.toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    };
  });
}

export function findThreadSubagent(
  subagents: ReadonlyArray<ThreadSubagentView>,
  key: string | null | undefined,
): ThreadSubagentView | null {
  if (!key) {
    return null;
  }
  return subagents.find((subagent) => subagent.key === key) ?? null;
}
