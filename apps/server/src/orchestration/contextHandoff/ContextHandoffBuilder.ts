import { createHash } from "node:crypto";

import {
  CONTEXT_HANDOFF_CONTEXT_VERSION,
  ContextHandoffActivityPayload,
  ContextHandoffEndpointSnapshot,
  ContextHandoffId,
  ContextHandoffMode,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  type OrchestrationThread,
  OrchestrationMessageRole,
  RuntimeSubagentStatus,
  ThreadId,
  ToolLifecycleItemType,
  TrimmedNonEmptyString,
  TurnId,
} from "@ryco/contracts";
import { truncateUnicodeSafe } from "@ryco/shared/String";
import { Option, Schema } from "effect";

const MESSAGE_TEXT_MAX_CHARS = 32_000;
const PLAN_TEXT_MAX_CHARS = 16_000;
const TOOL_COMMAND_MAX_CHARS = 4_000;
const TOOL_OUTPUT_MAX_CHARS = 16_000;
const DETAIL_MAX_CHARS = 2_000;
const PATH_MAX_CHARS = 2_000;
const LABEL_MAX_CHARS = 512;
const QUESTION_MAX_CHARS = 4_000;
const MAX_PATHS_PER_TOOL = 24;
const MAX_PLAN_STEPS = 100;
const MAX_QUESTIONS_PER_REQUEST = 20;
const MAX_OPTIONS_PER_QUESTION = 12;

const ContextHandoffTimelineFields = {
  id: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  sequence: Schema.optional(NonNegativeInt),
} as const;

export const ContextHandoffMessageEntry = Schema.Struct({
  ...ContextHandoffTimelineFields,
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  turnId: Schema.NullOr(TurnId),
  truncated: Schema.optional(Schema.Boolean),
});
export type ContextHandoffMessageEntry = typeof ContextHandoffMessageEntry.Type;

const ContextHandoffPlanStep = Schema.Struct({
  step: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "inProgress", "completed"]),
});

export const ContextHandoffPlanEntry = Schema.Struct({
  ...ContextHandoffTimelineFields,
  source: Schema.Literals(["proposed-plan", "runtime-plan"]),
  turnId: Schema.NullOr(TurnId),
  planMarkdown: Schema.optional(TrimmedNonEmptyString),
  explanation: Schema.optional(TrimmedNonEmptyString),
  steps: Schema.Array(ContextHandoffPlanStep),
  truncated: Schema.optional(Schema.Boolean),
});
export type ContextHandoffPlanEntry = typeof ContextHandoffPlanEntry.Type;

const ContextHandoffFileChange = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
});

export const ContextHandoffToolEntry = Schema.Struct({
  ...ContextHandoffTimelineFields,
  turnId: Schema.NullOr(TurnId),
  lifecycle: Schema.Literals(["started", "updated", "completed"]),
  itemType: ToolLifecycleItemType,
  summary: TrimmedNonEmptyString,
  status: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(TrimmedNonEmptyString),
  toolCallId: Schema.optional(TrimmedNonEmptyString),
  startedAt: Schema.optional(IsoDateTime),
  command: Schema.optional(TrimmedNonEmptyString),
  output: Schema.optional(TrimmedNonEmptyString),
  exitCode: Schema.optional(Schema.Int),
  detail: Schema.optional(TrimmedNonEmptyString),
  paths: Schema.Array(TrimmedNonEmptyString),
  fileChanges: Schema.Array(ContextHandoffFileChange),
  truncated: Schema.optional(Schema.Boolean),
});
export type ContextHandoffToolEntry = typeof ContextHandoffToolEntry.Type;

export const ContextHandoffCheckpointEntry = Schema.Struct({
  ...ContextHandoffTimelineFields,
  id: TurnId,
  checkpointTurnCount: NonNegativeInt,
  status: Schema.Literals(["ready", "missing", "error"]),
  files: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      kind: TrimmedNonEmptyString,
      additions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
});
export type ContextHandoffCheckpointEntry = typeof ContextHandoffCheckpointEntry.Type;

const ContextHandoffQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(TrimmedNonEmptyString),
  multiSelect: Schema.Boolean,
  truncated: Schema.optional(Schema.Boolean),
});

export const ContextHandoffNoticeEntry = Schema.Struct({
  ...ContextHandoffTimelineFields,
  turnId: Schema.NullOr(TurnId),
  kind: Schema.Literals(["failure", "pending-question"]),
  summary: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
  questions: Schema.Array(ContextHandoffQuestion),
  truncated: Schema.optional(Schema.Boolean),
});
export type ContextHandoffNoticeEntry = typeof ContextHandoffNoticeEntry.Type;

export const ContextHandoffSubagentEntry = Schema.Struct({
  ...ContextHandoffTimelineFields,
  turnId: Schema.NullOr(TurnId),
  subagentId: TrimmedNonEmptyString,
  status: RuntimeSubagentStatus,
  label: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  summary: TrimmedNonEmptyString,
  truncated: Schema.optional(Schema.Boolean),
});
export type ContextHandoffSubagentEntry = typeof ContextHandoffSubagentEntry.Type;

export const ContextHandoffBoundaryEntry = Schema.Struct({
  ...ContextHandoffTimelineFields,
  id: ContextHandoffId,
  status: Schema.Literals(["consumed", "failed", "delivery-uncertain"]),
  targetMessageId: MessageId,
  sources: Schema.Array(ContextHandoffEndpointSnapshot),
  target: ContextHandoffEndpointSnapshot,
  error: Schema.optional(TrimmedNonEmptyString),
});
export type ContextHandoffBoundaryEntry = typeof ContextHandoffBoundaryEntry.Type;

export const ContextHandoffDocument = Schema.Struct({
  version: Schema.Literal(CONTEXT_HANDOFF_CONTEXT_VERSION),
  mode: ContextHandoffMode,
  thread: Schema.Struct({
    id: ThreadId,
    title: TrimmedNonEmptyString,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  }),
  provenance: Schema.Struct({
    sources: Schema.Array(ContextHandoffEndpointSnapshot).check(Schema.isMinLength(1)),
    target: ContextHandoffEndpointSnapshot,
  }),
  messages: Schema.Array(ContextHandoffMessageEntry),
  plans: Schema.Array(ContextHandoffPlanEntry),
  tools: Schema.Array(ContextHandoffToolEntry),
  checkpoints: Schema.Array(ContextHandoffCheckpointEntry),
  notices: Schema.Array(ContextHandoffNoticeEntry),
  subagents: Schema.Array(ContextHandoffSubagentEntry),
  priorHandoffs: Schema.Array(ContextHandoffBoundaryEntry),
});
export type ContextHandoffDocument = typeof ContextHandoffDocument.Type;

export interface BuildContextHandoffDocumentInput {
  readonly thread: OrchestrationThread;
  readonly targetMessageId: MessageId;
  readonly source: ContextHandoffEndpointSnapshot;
  readonly target: ContextHandoffEndpointSnapshot;
}

export interface ContextHandoffArtifact {
  readonly document: ContextHandoffDocument;
  readonly canonicalJson: string;
  readonly digest: string;
  readonly entryCount: number;
}

interface OrderedValue {
  readonly id: string;
  readonly createdAt: string;
  readonly sequence?: number | undefined;
}

type JsonCompatible = null | boolean | number | string | JsonCompatible[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonCompatible;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function boundedString(
  value: unknown,
  maxChars: number,
): { readonly value?: string; readonly truncated: boolean } {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return { truncated: false };
  }
  const bounded = truncateUnicodeSafe(normalized, maxChars);
  return {
    value: bounded,
    truncated: bounded.length !== normalized.length,
  };
}

function compareOrdered(left: OrderedValue, right: OrderedValue): number {
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  if (createdAt !== 0) {
    return createdAt;
  }
  const sequence =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (sequence !== 0) {
    return sequence;
  }
  return left.id.localeCompare(right.id);
}

function stableJsonValue(value: unknown): JsonCompatible {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value && typeof value === "object") {
    const result: Record<string, JsonCompatible> = {};
    for (const key of Object.keys(value).toSorted()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        result[key] = stableJsonValue(entry);
      }
    }
    return result;
  }
  return null;
}

export function stableStringifyContextHandoff(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export function digestContextHandoffDocument(document: ContextHandoffDocument): string {
  return createHash("sha256").update(stableStringifyContextHandoff(document)).digest("hex");
}

function endpointKey(endpoint: ContextHandoffEndpointSnapshot): string {
  return `${endpoint.providerInstanceId}\u0000${endpoint.modelSlug}`;
}

function boundedEndpoint(endpoint: ContextHandoffEndpointSnapshot): ContextHandoffEndpointSnapshot {
  const providerDisplayName = boundedString(endpoint.providerDisplayName, LABEL_MAX_CHARS).value;
  const providerAccentColor = boundedString(endpoint.providerAccentColor, LABEL_MAX_CHARS).value;
  const modelDisplayName = boundedString(endpoint.modelDisplayName, LABEL_MAX_CHARS).value;
  return {
    providerInstanceId: endpoint.providerInstanceId,
    driverKind: endpoint.driverKind,
    modelSlug: truncateUnicodeSafe(endpoint.modelSlug, LABEL_MAX_CHARS),
    ...(providerDisplayName ? { providerDisplayName } : {}),
    ...(providerAccentColor ? { providerAccentColor } : {}),
    ...(modelDisplayName ? { modelDisplayName } : {}),
  };
}

function activityPayload(activity: OrchestrationThread["activities"][number]) {
  return asRecord(activity.payload);
}

function decodeHandoffPayload(activity: OrchestrationThread["activities"][number]) {
  if (activity.kind !== "context-handoff") {
    return undefined;
  }
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(ContextHandoffActivityPayload)(activity.payload),
  );
}

function beforeTarget<T extends { readonly createdAt: string }>(
  value: T,
  targetCreatedAt: string | undefined,
): boolean {
  return targetCreatedAt === undefined || value.createdAt <= targetCreatedAt;
}

function collectPriorHandoffs(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  targetMessageId: MessageId,
): ContextHandoffBoundaryEntry[] {
  const result: ContextHandoffBoundaryEntry[] = [];
  for (const activity of activities.toSorted(compareOrdered)) {
    const payload = decodeHandoffPayload(activity);
    if (
      !payload ||
      payload.targetMessageId === targetMessageId ||
      (payload.status !== "consumed" &&
        payload.status !== "failed" &&
        payload.status !== "delivery-uncertain")
    ) {
      continue;
    }
    result.push({
      id: payload.handoffId,
      createdAt: activity.createdAt,
      ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      status: payload.status,
      targetMessageId: payload.targetMessageId,
      sources: payload.sources.map(boundedEndpoint),
      target: boundedEndpoint(payload.target),
      ...(payload.status === "failed" || payload.status === "delivery-uncertain"
        ? { error: truncateUnicodeSafe(payload.error, DETAIL_MAX_CHARS) }
        : {}),
    });
  }
  return result;
}

function collectSources(
  priorHandoffs: ReadonlyArray<ContextHandoffBoundaryEntry>,
  immediateSource: ContextHandoffEndpointSnapshot,
): ContextHandoffEndpointSnapshot[] {
  const sources: ContextHandoffEndpointSnapshot[] = [];
  const seen = new Set<string>();
  for (const handoff of priorHandoffs) {
    if (handoff.status !== "consumed") {
      continue;
    }
    for (const endpoint of handoff.sources) {
      const key = endpointKey(endpoint);
      if (!seen.has(key)) {
        seen.add(key);
        sources.push(endpoint);
      }
    }
  }
  const source = boundedEndpoint(immediateSource);
  const key = endpointKey(source);
  if (!seen.has(key)) {
    sources.push(source);
  }
  return sources;
}

function collectMessages(
  thread: OrchestrationThread,
  targetIndex: number,
): ContextHandoffMessageEntry[] {
  const history = targetIndex >= 0 ? thread.messages.slice(0, targetIndex) : thread.messages;
  const messages: ContextHandoffMessageEntry[] = [];
  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = truncateUnicodeSafe(message.text, MESSAGE_TEXT_MAX_CHARS);
    messages.push({
      id: message.id,
      role: message.role,
      text,
      turnId: message.turnId,
      createdAt: message.createdAt,
      ...(text.length !== message.text.length ? { truncated: true } : {}),
    });
  }
  return messages.toSorted(compareOrdered);
}

function collectProposedPlans(
  thread: OrchestrationThread,
  targetCreatedAt: string | undefined,
): ContextHandoffPlanEntry[] {
  const plans: ContextHandoffPlanEntry[] = [];
  for (const plan of thread.proposedPlans) {
    if (plan.implementedAt !== null || !beforeTarget(plan, targetCreatedAt)) {
      continue;
    }
    const planMarkdown = truncateUnicodeSafe(plan.planMarkdown, PLAN_TEXT_MAX_CHARS);
    plans.push({
      id: plan.id,
      source: "proposed-plan",
      turnId: plan.turnId,
      createdAt: plan.createdAt,
      planMarkdown,
      steps: [],
      ...(planMarkdown.length !== plan.planMarkdown.length ? { truncated: true } : {}),
    });
  }
  return plans;
}

function collectRuntimePlan(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
): ContextHandoffPlanEntry[] {
  let latest: ContextHandoffPlanEntry | undefined;
  for (const activity of activities.toSorted(compareOrdered)) {
    if (activity.kind !== "turn.plan.updated") {
      continue;
    }
    const payload = activityPayload(activity);
    if (!Array.isArray(payload?.plan)) {
      continue;
    }
    let truncated = payload.plan.length > MAX_PLAN_STEPS;
    const steps = payload.plan.slice(0, MAX_PLAN_STEPS).flatMap((entry) => {
      const record = asRecord(entry);
      const step = boundedString(record?.step, DETAIL_MAX_CHARS);
      if (!step.value) {
        return [];
      }
      truncated ||= step.truncated;
      const status: "pending" | "inProgress" | "completed" =
        record?.status === "completed" || record?.status === "inProgress"
          ? record.status
          : "pending";
      return [{ step: step.value, status }];
    });
    if (steps.length === 0 || !steps.some((step) => step.status !== "completed")) {
      continue;
    }
    const explanation = boundedString(payload.explanation, DETAIL_MAX_CHARS);
    truncated ||= explanation.truncated;
    latest = {
      id: activity.id,
      source: "runtime-plan",
      turnId: activity.turnId,
      createdAt: activity.createdAt,
      ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      ...(explanation.value ? { explanation: explanation.value } : {}),
      steps,
      ...(truncated ? { truncated: true } : {}),
    };
  }
  return latest ? [latest] : [];
}

function normalizeCommand(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((entry) => {
    const part = asTrimmedString(entry);
    return part ? [part] : [];
  });
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommand(payload: Record<string, unknown>): string | undefined {
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const input = asRecord(item?.input);
  const result = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  for (const candidate of [
    item?.command,
    input?.command,
    result?.command,
    data?.command,
    rawInput?.command,
  ]) {
    const command = normalizeCommand(candidate);
    if (command) {
      return command;
    }
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommand(rawInput?.args);
  return executable ? (args ? `${executable} ${args}` : executable) : undefined;
}

function textFromContentArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const direct = asTrimmedString(record?.text);
    const nested = asTrimmedString(asRecord(record?.content)?.text);
    if (direct) {
      chunks.push(direct);
    } else if (nested) {
      chunks.push(nested);
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function extractOutput(payload: Record<string, unknown>): string | undefined {
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  if (item?.type === "commandExecution") {
    return asTrimmedString(item.aggregatedOutput);
  }
  if (item?.type === "mcpToolCall") {
    const error = asTrimmedString(asRecord(item.error)?.message);
    if (error) {
      return error;
    }
    const result = asRecord(item.result);
    const content = textFromContentArray(result?.content);
    if (content) {
      return content;
    }
  }
  if (item?.type === "dynamicToolCall") {
    const content = textFromContentArray(item.contentItems);
    if (content) {
      return content;
    }
  }
  const rawOutput = asRecord(data?.rawOutput);
  return (
    asTrimmedString(rawOutput?.stdout) ??
    asTrimmedString(rawOutput?.stderr) ??
    asTrimmedString(rawOutput?.content) ??
    textFromContentArray(data?.content)
  );
}

function extractExitCode(payload: Record<string, unknown>): number | undefined {
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  for (const candidate of [item?.exitCode, itemResult?.exitCode, rawOutput?.exitCode]) {
    const exitCode = asInteger(candidate);
    if (exitCode !== undefined) {
      return exitCode;
    }
  }
  const detail = asTrimmedString(payload.detail);
  const match = detail ? /<exited with exit code (?<code>-?\d+)>\s*$/iu.exec(detail) : null;
  const parsed = Number.parseInt(match?.groups?.code ?? "", 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function pathFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const path = asTrimmedString(record[key]);
    if (path) {
      return truncateUnicodeSafe(path, PATH_MAX_CHARS);
    }
  }
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = asInteger(value);
  return number === undefined ? undefined : Math.max(0, number);
}

function collectPathsAndChanges(value: unknown): {
  readonly paths: string[];
  readonly fileChanges: Array<{ path: string; additions?: number; deletions?: number }>;
} {
  const paths: string[] = [];
  const changes = new Map<string, { path: string; additions?: number; deletions?: number }>();
  const seenPaths = new Set<string>();
  const seenObjects = new WeakSet<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 4 || paths.length >= MAX_PATHS_PER_TOOL) {
      return;
    }
    if (Array.isArray(current)) {
      if (seenObjects.has(current)) {
        return;
      }
      seenObjects.add(current);
      for (const entry of current) {
        visit(entry, depth + 1);
      }
      return;
    }
    const record = asRecord(current);
    if (!record || seenObjects.has(record)) {
      return;
    }
    seenObjects.add(record);
    const path = pathFromRecord(record);
    if (path && !seenPaths.has(path)) {
      seenPaths.add(path);
      paths.push(path);
    }
    if (path) {
      const additions = nonNegativeInteger(
        record.additions ?? record.insertions ?? record.addedLines ?? record.additionLines,
      );
      const deletions = nonNegativeInteger(
        record.deletions ??
          record.deletedLines ??
          record.deletionLines ??
          record.removedLines ??
          record.removals,
      );
      if (additions !== undefined || deletions !== undefined) {
        changes.set(path, {
          path,
          ...(additions !== undefined ? { additions } : {}),
          ...(deletions !== undefined ? { deletions } : {}),
        });
      }
    }
    for (const key of [
      "item",
      "result",
      "input",
      "rawInput",
      "rawOutput",
      "data",
      "changes",
      "files",
      "edits",
      "patch",
      "patches",
      "operations",
      "locations",
    ]) {
      if (key in record) {
        visit(record[key], depth + 1);
      }
    }
  };
  visit(value, 0);
  return { paths, fileChanges: [...changes.values()] };
}

function toolLifecycle(kind: string): ContextHandoffToolEntry["lifecycle"] | undefined {
  switch (kind) {
    case "tool.started":
      return "started";
    case "tool.updated":
      return "updated";
    case "tool.completed":
      return "completed";
    default:
      return undefined;
  }
}

function lifecycleRank(lifecycle: ContextHandoffToolEntry["lifecycle"]): number {
  return lifecycle === "completed" ? 2 : lifecycle === "updated" ? 1 : 0;
}

function extractTool(
  activity: OrchestrationThread["activities"][number],
): ContextHandoffToolEntry | undefined {
  const lifecycle = toolLifecycle(activity.kind);
  const payload = activityPayload(activity);
  if (!lifecycle || !payload || !Schema.is(ToolLifecycleItemType)(payload.itemType)) {
    return undefined;
  }
  const data = asRecord(payload.data);
  const providerRefs = asRecord(payload.providerRefs);
  const providerItemId =
    asTrimmedString(payload.providerItemId) ?? asTrimmedString(providerRefs?.providerItemId);
  const toolCallId = asTrimmedString(data?.toolCallId);
  const command = boundedString(extractCommand(payload), TOOL_COMMAND_MAX_CHARS);
  const output = boundedString(extractOutput(payload), TOOL_OUTPUT_MAX_CHARS);
  const detail = boundedString(payload.detail, DETAIL_MAX_CHARS);
  const summary = boundedString(activity.summary, LABEL_MAX_CHARS);
  const { paths, fileChanges } = collectPathsAndChanges(data);
  const status = boundedString(payload.status, LABEL_MAX_CHARS);
  const truncated =
    command.truncated ||
    output.truncated ||
    detail.truncated ||
    summary.truncated ||
    status.truncated;
  return {
    id: activity.id,
    createdAt: activity.createdAt,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    turnId: activity.turnId,
    lifecycle,
    itemType: payload.itemType,
    summary: summary.value ?? "Tool",
    ...(status.value ? { status: status.value } : {}),
    ...(providerItemId ? { providerItemId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(lifecycle === "started" ? { startedAt: activity.createdAt } : {}),
    ...(command.value ? { command: command.value } : {}),
    ...(output.value ? { output: output.value } : {}),
    ...(extractExitCode(payload) !== undefined ? { exitCode: extractExitCode(payload) } : {}),
    ...(detail.value ? { detail: detail.value } : {}),
    paths,
    fileChanges,
    ...(truncated ? { truncated: true } : {}),
  };
}

function mergeTools(
  previous: ContextHandoffToolEntry,
  next: ContextHandoffToolEntry,
): ContextHandoffToolEntry {
  const winner =
    lifecycleRank(next.lifecycle) >= lifecycleRank(previous.lifecycle) ? next : previous;
  const fallback = winner === next ? previous : next;
  const paths = [...new Set([...previous.paths, ...next.paths])];
  const fileChanges = new Map<string, ContextHandoffToolEntry["fileChanges"][number]>();
  for (const change of [...previous.fileChanges, ...next.fileChanges]) {
    const existing = fileChanges.get(change.path);
    fileChanges.set(change.path, {
      path: change.path,
      additions: change.additions ?? existing?.additions,
      deletions: change.deletions ?? existing?.deletions,
    });
  }
  return {
    ...winner,
    summary: winner.summary || fallback.summary,
    command: winner.command ?? fallback.command,
    output: winner.output ?? fallback.output,
    exitCode: winner.exitCode ?? fallback.exitCode,
    detail: winner.detail ?? fallback.detail,
    status: winner.status ?? fallback.status,
    providerItemId: winner.providerItemId ?? fallback.providerItemId,
    toolCallId: winner.toolCallId ?? fallback.toolCallId,
    startedAt: previous.startedAt ?? next.startedAt,
    paths,
    fileChanges: [...fileChanges.values()],
    ...(previous.truncated || next.truncated ? { truncated: true } : {}),
  };
}

function collectTools(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
): ContextHandoffToolEntry[] {
  const tools = new Map<string, ContextHandoffToolEntry>();
  for (const activity of activities.toSorted(compareOrdered)) {
    const tool = extractTool(activity);
    if (!tool) {
      continue;
    }
    const stableItemId = tool.providerItemId ?? tool.toolCallId;
    const key = stableItemId ? `${tool.turnId ?? ""}\u0000${stableItemId}` : `event:${tool.id}`;
    const previous = tools.get(key);
    tools.set(key, previous ? mergeTools(previous, tool) : tool);
  }
  return [...tools.values()].toSorted(compareOrdered);
}

function collectCheckpoints(
  thread: OrchestrationThread,
  targetCreatedAt: string | undefined,
): ContextHandoffCheckpointEntry[] {
  return thread.checkpoints
    .filter((checkpoint) => beforeTarget({ createdAt: checkpoint.completedAt }, targetCreatedAt))
    .map((checkpoint) => ({
      id: checkpoint.turnId,
      createdAt: checkpoint.completedAt,
      checkpointTurnCount: checkpoint.checkpointTurnCount,
      status: checkpoint.status,
      files: checkpoint.files.map((file) => ({
        path: truncateUnicodeSafe(file.path, PATH_MAX_CHARS),
        kind: truncateUnicodeSafe(file.kind, LABEL_MAX_CHARS),
        additions: file.additions,
        deletions: file.deletions,
      })),
    }))
    .toSorted(compareOrdered);
}

function parseQuestions(payload: Record<string, unknown>): {
  readonly questions: ContextHandoffNoticeEntry["questions"];
  readonly truncated: boolean;
} {
  if (!Array.isArray(payload.questions)) {
    return { questions: [], truncated: false };
  }
  let truncated = payload.questions.length > MAX_QUESTIONS_PER_REQUEST;
  const questions = payload.questions.slice(0, MAX_QUESTIONS_PER_REQUEST).flatMap((value) => {
    const record = asRecord(value);
    const id = boundedString(record?.id, LABEL_MAX_CHARS);
    const header = boundedString(record?.header, LABEL_MAX_CHARS);
    const question = boundedString(record?.question, QUESTION_MAX_CHARS);
    if (!id.value || !header.value || !question.value) {
      return [];
    }
    truncated ||= id.truncated || header.truncated || question.truncated;
    const rawOptions = Array.isArray(record?.options) ? record.options : [];
    truncated ||= rawOptions.length > MAX_OPTIONS_PER_QUESTION;
    const options = rawOptions.slice(0, MAX_OPTIONS_PER_QUESTION).flatMap((option) => {
      const label = boundedString(asRecord(option)?.label, LABEL_MAX_CHARS);
      truncated ||= label.truncated;
      return label.value ? [label.value] : [];
    });
    return [
      {
        id: id.value,
        header: header.value,
        question: question.value,
        options,
        multiSelect: record?.multiSelect === true,
        ...(id.truncated || header.truncated || question.truncated ? { truncated: true } : {}),
      },
    ];
  });
  return { questions, truncated };
}

function failureFromActivity(
  activity: OrchestrationThread["activities"][number],
): ContextHandoffNoticeEntry | undefined {
  const payload = activityPayload(activity);
  if (!payload) {
    return undefined;
  }
  const isFailure =
    activity.kind === "runtime.error" ||
    activity.kind === "tool.denied" ||
    activity.kind === "provider.approval.respond.failed" ||
    activity.kind === "provider.user-input.respond.failed" ||
    (activity.kind === "task.completed" && payload.status === "failed");
  if (!isFailure) {
    return undefined;
  }
  const summary = boundedString(activity.summary, LABEL_MAX_CHARS);
  const detail = boundedString(
    payload.message ?? payload.detail ?? payload.reason,
    DETAIL_MAX_CHARS,
  );
  return {
    id: activity.id,
    createdAt: activity.createdAt,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    turnId: activity.turnId,
    kind: "failure",
    summary: summary.value ?? "Failure",
    ...(detail.value ? { detail: detail.value } : {}),
    questions: [],
    ...(summary.truncated || detail.truncated ? { truncated: true } : {}),
  };
}

function collectNotices(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
): ContextHandoffNoticeEntry[] {
  const failures: ContextHandoffNoticeEntry[] = [];
  const pendingQuestions = new Map<string, ContextHandoffNoticeEntry>();
  for (const activity of activities.toSorted(compareOrdered)) {
    const failure = failureFromActivity(activity);
    if (failure) {
      failures.push(failure);
    }
    const payload = activityPayload(activity);
    const requestId = asTrimmedString(payload?.requestId);
    if (!requestId) {
      continue;
    }
    if (activity.kind === "user-input.resolved") {
      pendingQuestions.delete(requestId);
      continue;
    }
    if (activity.kind !== "user-input.requested" || !payload) {
      continue;
    }
    const parsed = parseQuestions(payload);
    if (parsed.questions.length === 0) {
      continue;
    }
    pendingQuestions.set(requestId, {
      id: activity.id,
      createdAt: activity.createdAt,
      ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      turnId: activity.turnId,
      kind: "pending-question",
      summary: "Pending user question",
      questions: parsed.questions,
      ...(parsed.truncated ? { truncated: true } : {}),
    });
  }
  return [...failures, ...pendingQuestions.values()].toSorted(compareOrdered);
}

function collectSubagents(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
): ContextHandoffSubagentEntry[] {
  const result: ContextHandoffSubagentEntry[] = [];
  for (const activity of activities.toSorted(compareOrdered)) {
    if (activity.kind !== "subagent.completed") {
      continue;
    }
    const payload = activityPayload(activity);
    const subagent = asRecord(payload?.subagent);
    const subagentId = boundedString(subagent?.subagentId, LABEL_MAX_CHARS);
    const status = payload?.status;
    if (!subagentId.value || !Schema.is(RuntimeSubagentStatus)(status)) {
      continue;
    }
    const summary = boundedString(payload?.detail ?? payload?.summary, DETAIL_MAX_CHARS);
    if (!summary.value) {
      continue;
    }
    const label = boundedString(subagent?.label, LABEL_MAX_CHARS);
    const description = boundedString(subagent?.description, DETAIL_MAX_CHARS);
    result.push({
      id: activity.id,
      createdAt: activity.createdAt,
      ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      turnId: activity.turnId,
      subagentId: subagentId.value,
      status,
      ...(label.value ? { label: label.value } : {}),
      ...(description.value ? { description: description.value } : {}),
      summary: summary.value,
      ...(subagentId.truncated || summary.truncated || label.truncated || description.truncated
        ? { truncated: true }
        : {}),
    });
  }
  return result;
}

export function countContextHandoffEntries(document: ContextHandoffDocument): number {
  return (
    document.messages.length +
    document.plans.length +
    document.tools.length +
    document.checkpoints.length +
    document.notices.length +
    document.subagents.length +
    document.priorHandoffs.length
  );
}

export function buildContextHandoffDocument(
  input: BuildContextHandoffDocumentInput,
): ContextHandoffArtifact {
  const targetIndex = input.thread.messages.findIndex(
    (message) => message.id === input.targetMessageId,
  );
  const targetCreatedAt =
    targetIndex >= 0 ? input.thread.messages[targetIndex]?.createdAt : undefined;
  const activities = input.thread.activities.filter(
    (activity) =>
      beforeTarget(activity, targetCreatedAt) &&
      decodeHandoffPayload(activity)?.targetMessageId !== input.targetMessageId,
  );
  const priorHandoffs = collectPriorHandoffs(activities, input.targetMessageId);
  const plans = [
    ...collectProposedPlans(input.thread, targetCreatedAt),
    ...collectRuntimePlan(activities),
  ].toSorted(compareOrdered);
  const document: ContextHandoffDocument = {
    version: CONTEXT_HANDOFF_CONTEXT_VERSION,
    mode: "full-context-fresh-session",
    thread: {
      id: input.thread.id,
      title: truncateUnicodeSafe(input.thread.title, LABEL_MAX_CHARS),
      branch: input.thread.branch ? truncateUnicodeSafe(input.thread.branch, PATH_MAX_CHARS) : null,
      worktreePath: input.thread.worktreePath
        ? truncateUnicodeSafe(input.thread.worktreePath, PATH_MAX_CHARS)
        : null,
    },
    provenance: {
      sources: collectSources(priorHandoffs, input.source),
      target: boundedEndpoint(input.target),
    },
    messages: collectMessages(input.thread, targetIndex),
    plans,
    tools: collectTools(activities),
    checkpoints: collectCheckpoints(input.thread, targetCreatedAt),
    notices: collectNotices(activities),
    subagents: collectSubagents(activities),
    priorHandoffs,
  };
  const canonicalJson = stableStringifyContextHandoff(document);
  return {
    document,
    canonicalJson,
    digest: createHash("sha256").update(canonicalJson).digest("hex"),
    entryCount: countContextHandoffEntries(document),
  };
}
