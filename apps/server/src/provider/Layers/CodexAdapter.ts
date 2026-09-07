/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps the typed Codex session runtime behind the `CodexAdapter` service
 * contract and maps runtime failures into the shared `ProviderAdapterError`
 * algebra.
 *
 * @module CodexAdapterLive
 */
import {
  isToolLifecycleItemType,
  type AgentTokenMode,
  type CanonicalItemType,
  type CanonicalRequestType,
  type CodexSettings,
  type ChatAttachment,
  ProviderDriverKind,
  type ProviderEvent,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRequestKind,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeSessionId,
  RuntimeItemId,
  RuntimeSubagentId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeTaskUsage,
  ProviderApprovalDecision,
  ThreadId,
  TurnId,
  MessageId,
  EventId,
  ProviderItemId,
  ProviderSendTurnInput,
  ProviderSteerTurnInput,
  DEFAULT_AGENT_TOKEN_MODE,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadGoal as ThreadGoalSchema,
  type ThreadGoal,
} from "@ryco/contracts";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@ryco/shared/model";
import {
  appendAttachmentPathLines,
  formatAttachmentPathLines,
  type AttachmentPathLineEntry,
} from "@ryco/shared/attachmentPrompt";
import { formatSourceControlContextsForAgent } from "@ryco/shared/sourceControlContextFormatter";

import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { makeServerQueueMetrics } from "../../observability/QueueMetrics.ts";
import { buildTokenReductionInstructions, checkRtkAvailability } from "../../tokenReduction.ts";
import {
  CODEX_AGENT_CONTROL_SERVER_NAME,
  CodexResumeCursorSchema,
  CodexSessionRuntimeThreadIdMissingError,
  makeCodexSessionRuntime,
  readStoredCodexThread,
  type CodexAgentControlInjection,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
} from "./CodexSessionRuntime.ts";
import {
  installAgentControlNativeHttp,
  type AgentControlProviderBridge,
  type AgentControlRuntimeLease,
} from "../../agentControl/ProviderInjection.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { requireRuntimeSessionId, stampRuntimeEvent } from "../runtimeSession.ts";
import type { ProviderThreadHistory } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("codex");
const PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES =
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS * PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;

/**
 * Narrow Agent Control surface the adapter consumes: lease issuance at
 * runtime start and revocation on every teardown path. The adapter never
 * sees the listener, the tool catalog, or any credential it did not issue.
 */
export type CodexAgentControlBridge = AgentControlProviderBridge;

/**
 * Truthful host-context note injected only when a lease was actually
 * issued. A runtime without a lease receives no mention of these tools.
 * The revocation sentence keeps the note truthful for the runtime's whole
 * lifetime: instructions are fixed at session start, but the lease can be
 * revoked mid-session (feature disabled, listener stopped), after which
 * every request is rejected as unauthorized.
 */
export const CODEX_AGENT_CONTROL_INSTRUCTIONS =
  "Ryco Agent Control tools (ryco_*) are available through the " +
  `'${CODEX_AGENT_CONTROL_SERVER_NAME}' MCP server on a private local connection. They can ` +
  "inspect Ryco projects, threads, transcripts, and request status. During an active turn, " +
  "the four thread-action tools create immutable requests that require user approval in Ryco; " +
  "they never mutate immediately. If the server is " +
  "unreachable or rejects requests as unauthorized, Ryco has revoked this session's " +
  "access — treat the tools as unavailable instead of retrying.";

export interface CodexAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly agentControl?: CodexAgentControlBridge;
  readonly makeRuntime?: (
    options: CodexSessionRuntimeOptions,
  ) => Effect.Effect<
    CodexSessionRuntimeShape,
    CodexSessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface CodexAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly runtimeSessionId: RuntimeSessionId;
  readonly scope: Scope.Closeable;
  readonly runtime: CodexSessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  /** Unique Agent Control lease id for this exact runtime, when issued. */
  readonly agentControl?: AgentControlRuntimeLease;
  stopped: boolean;
}

interface ResolvedCodexAttachment {
  readonly attachment: ChatAttachment;
  readonly path: string;
  readonly sizeBytes: number;
}

function formatCodexRuntimeErrorDetail(error: Error): string {
  const serviceTierSchemaMismatch =
    error.message.includes('Expected "fast" | "flex"') && error.message.includes('["serviceTier"]');
  if (!serviceTierSchemaMismatch) {
    return error.message;
  }
  return `${error.message}. This usually means the installed Codex CLI returned a newer service tier name than Ryco's generated app-server schema knows about. Rebuild effect-codex-app-server before rebuilding the server bundle.`;
}

function mapCodexRuntimeError(
  threadId: ThreadId,
  method: string,
  error: CodexSessionRuntimeError,
): ProviderAdapterError {
  if (
    Schema.is(CodexErrors.CodexAppServerProcessExitedError)(error) ||
    Schema.is(CodexErrors.CodexAppServerTransportError)(error)
  ) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  if (Schema.is(CodexSessionRuntimeThreadIdMissingError)(error)) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: formatCodexRuntimeErrorDetail(error),
    cause: error,
  });
}

function normalizeCodexThreadGoal(goal: {
  readonly objective: string;
  readonly status: ThreadGoal["status"];
  readonly tokenBudget?: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}): ThreadGoal | null {
  try {
    return Schema.decodeUnknownSync(ThreadGoalSchema)({
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget ?? null,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
      createdAt: new Date(goal.createdAt * 1_000).toISOString(),
      updatedAt: new Date(goal.updatedAt * 1_000).toISOString(),
    });
  } catch {
    return null;
  }
}

type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"];

type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  return Schema.is(schema)(payload) ? payload : undefined;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeFileSizeBytes(size: number | bigint | undefined): number {
  if (typeof size === "bigint") {
    return size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size);
  }
  return typeof size === "number" && Number.isFinite(size) ? size : 0;
}

const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function readTokenReductionInstructions(tokenMode: AgentTokenMode) {
  return Effect.promise(() => checkRtkAvailability()).pipe(
    Effect.map((availability) =>
      buildTokenReductionInstructions({
        tokenMode,
        rtkInstalled: availability.installed,
      }),
    ),
  );
}

function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): ThreadTokenUsageSnapshot | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens < 0) {
    return undefined;
  }

  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function itemDetail(item: CodexLifecycleItem): string | undefined {
  const candidates = [
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions
    .map((question) => {
      const options =
        question.options
          ?.map((option) => {
            const label = trimText(option.label);
            const description = trimText(option.description);
            if (!label || !description) {
              return undefined;
            }
            return { label, description };
          })
          .filter((option) => option !== undefined) ?? [];

      const id = trimText(question.id);
      const header = trimText(question.header);
      const prompt = trimText(question.question);
      if (!id || !header || !prompt || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      };
    })
    .filter((question) => question !== undefined);

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item) {
    return undefined;
  }
  const itemType = toCanonicalItemType(item.type);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(item);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: event.payload } : {}),
    },
  };
}

/**
 * Maps the session runtime's synthetic `collabAgent/*` events (native
 * multi-agent v2 child-thread signals) into the shared task.* lifecycle.
 * Agent identity = child thread id; nickname is the display title, role is
 * agentRole (fallback: last agentPath segment, then "general-purpose").
 * A completed child turn is idle (resumable), not terminal. timelineBypass
 * keeps these rows out of the parent chat.
 */
function mapCollabAgentEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : undefined;
  const agentThreadId = typeof payload?.agentThreadId === "string" ? payload.agentThreadId : "";
  if (!payload || agentThreadId.length === 0) {
    return [];
  }
  const base = runtimeEventBase(event, canonicalThreadId);
  const taskId = RuntimeTaskId.make(agentThreadId);
  const agentPath = typeof payload.agentPath === "string" ? payload.agentPath : undefined;
  const pathLeaf = agentPath?.split("/").findLast((segment) => segment.length > 0);
  const nickname = typeof payload.nickname === "string" ? payload.nickname : undefined;
  const role =
    (typeof payload.role === "string" ? payload.role : undefined) ?? pathLeaf ?? "general-purpose";
  // A bare thread id is not a name. Omitting the title lets the client fold
  // keep the real one from task.started instead of clobbering it (progress
  // rows would otherwise rename a child to its UUID).
  const knownName = nickname ?? pathLeaf;
  const title = knownName ?? agentThreadId;
  // Identity repeated on every status patch so rows are self-describing when
  // the start row ages out of activity retention.
  const statusLinkage = {
    role,
    ...(knownName ? { title: knownName } : {}),
    ...(agentPath ? { agentPath } : {}),
    timelineBypass: true,
  } as const;

  switch (event.method) {
    case "collabAgent/started":
      return [
        {
          ...base,
          type: "task.started",
          payload: {
            taskId,
            description: title,
            title,
            role,
            ...(agentPath ? { agentPath } : {}),
            ...(typeof payload.parentThreadId === "string"
              ? { parentAgentId: payload.parentThreadId }
              : {}),
            timelineBypass: true,
          },
        },
      ];
    case "collabAgent/activity": {
      const activityKind = typeof payload.activityKind === "string" ? payload.activityKind : "";
      if (activityKind === "interrupted") {
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "interrupted", ...statusLinkage },
          },
        ];
      }
      if (activityKind === "started") {
        // Children often register via subAgentActivity alone (no
        // thread/started with a spawn source), so this is the one shot at a
        // task.started with a real name — agentPath leaf beats a bare
        // thread-id title.
        return [
          {
            ...base,
            type: "task.started",
            payload: {
              taskId,
              description: title,
              title,
              role,
              ...(agentPath ? { agentPath } : {}),
              timelineBypass: true,
            },
          },
        ];
      }
      // interacted → the child is (again) actively driven.
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "running", ...statusLinkage },
        },
      ];
    }
    case "collabAgent/turnStarted":
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "running", ...statusLinkage },
        },
      ];
    case "collabAgent/turnCompleted": {
      // Idle, not terminal: the identity is resumable via sendInput/resume.
      const turn =
        typeof payload.turn === "object" && payload.turn !== null
          ? (payload.turn as Record<string, unknown>)
          : undefined;
      const turnStatus = typeof turn?.status === "string" ? turn.status : undefined;
      const status =
        turnStatus === "failed"
          ? ("failed" as const)
          : turnStatus === "interrupted"
            ? ("interrupted" as const)
            : ("idle" as const);
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status, ...statusLinkage },
        },
      ];
    }
    case "collabAgent/statusChanged": {
      const status =
        typeof payload.status === "object" && payload.status !== null
          ? (payload.status as Record<string, unknown>)
          : undefined;
      const statusType = typeof status?.type === "string" ? status.type : undefined;
      if (statusType === "systemError") {
        // Silently dropping this once left children stuck running forever.
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "failed", ...statusLinkage },
          },
        ];
      }
      if (statusType === "active") {
        const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
        const waiting = flags.some(
          (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
        );
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: waiting ? "waiting" : "running", ...statusLinkage },
          },
        ];
      }
      if (statusType === "idle") {
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "idle", ...statusLinkage },
          },
        ];
      }
      return [];
    }
    case "collabAgent/tokenUsage": {
      // Cumulative per child thread: always the `total` breakdown, never
      // `last` (which shrinks on follow-ups). Client folds max-merge.
      const tokenUsage =
        typeof payload.tokenUsage === "object" && payload.tokenUsage !== null
          ? (payload.tokenUsage as Record<string, unknown>)
          : undefined;
      const total =
        typeof tokenUsage?.total === "object" && tokenUsage.total !== null
          ? (tokenUsage.total as Record<string, unknown>)
          : undefined;
      const count = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
      // Same validation as every other field: RuntimeTaskUsage.totalTokens
      // is NonNegativeInt, so NaN/Infinity/negative/fractional wire values
      // must miss — a fraction would fail schema validation at ingestion.
      const totalTokens = count(total?.totalTokens);
      if (totalTokens === undefined) {
        return [];
      }
      const typedUsage: RuntimeTaskUsage = {
        totalTokens,
        ...(count(total?.inputTokens) !== undefined
          ? { inputTokens: count(total?.inputTokens) }
          : {}),
        ...(count(total?.cachedInputTokens) !== undefined
          ? { cachedInputTokens: count(total?.cachedInputTokens) }
          : {}),
        ...(count(total?.outputTokens) !== undefined
          ? { outputTokens: count(total?.outputTokens) }
          : {}),
        ...(count(total?.reasoningOutputTokens) !== undefined
          ? { reasoningOutputTokens: count(total?.reasoningOutputTokens) }
          : {}),
      };
      return [
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            description: title,
            ...(knownName ? { title: knownName } : {}),
            typedUsage,
            timelineBypass: true,
          },
        },
      ];
    }
    case "collabAgent/item": {
      const item =
        typeof payload.item === "object" && payload.item !== null
          ? (payload.item as Record<string, unknown>)
          : undefined;
      const itemTypeRaw = typeof item?.type === "string" ? item.type : undefined;
      if (!itemTypeRaw) return [];
      // A loose summary from the raw item: the child stream is untyped at
      // this boundary (synthetic event payload), so read best-effort fields
      // rather than force a schema decode.
      const looseSummary =
        (typeof item?.command === "string" ? item.command : undefined) ??
        (typeof item?.title === "string" ? item.title : undefined) ??
        (typeof item?.query === "string" ? item.query : undefined);
      const canonical = toCanonicalItemType(itemTypeRaw);
      const summary = looseSummary ?? canonical.replaceAll("_", " ");
      // Child message snapshots are authoritative at completion. Preserve their
      // full text in the child transcript rather than a generic progress label.
      if (
        canonical === "assistant_message" &&
        payload.lifecycle === "item/completed" &&
        typeof item?.text === "string" &&
        typeof item.id === "string"
      ) {
        return [
          {
            ...base,
            type: "subagent.message.delta",
            payload: {
              subagentId: RuntimeSubagentId.make(agentThreadId),
              providerThreadId: agentThreadId,
              providerMessageId: item.id,
              delta: item.text,
              role: "assistant",
            },
          },
        ];
      }

      const toolEvents: ProviderRuntimeEvent[] = [];
      if (isToolLifecycleItemType(canonical) && typeof item?.id === "string") {
        const completed =
          payload.lifecycle === "item/completed" ||
          item.status === "completed" ||
          item.status === "failed";
        toolEvents.push({
          ...base,
          eventId: EventId.make(`${base.eventId}:tool`),
          itemId: RuntimeItemId.make(`${agentThreadId}:${item.id}`),
          type: completed ? "item.completed" : "item.updated",
          payload: {
            itemType: canonical,
            status: item.status === "failed" ? "failed" : completed ? "completed" : "inProgress",
            title: summary,
            agentId: agentThreadId,
            data: { item },
          },
        });
      }
      return [
        ...toolEvents,
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            description: title,
            ...(knownName ? { title: knownName } : {}),
            summary,
            timelineBypass: true,
          },
        },
      ];
    }
    case "collabAgent/closed":
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "interrupted", ...statusLinkage },
        },
      ];
    default:
      return [];
  }
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "notification" && event.method.startsWith("collabAgent/")) {
    return mapCollabAgentEvent(event, canonicalThreadId);
  }
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);
      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );
          return payload?.command ?? payload?.reason ?? undefined;
        }
        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );
          return payload?.reason ?? payload?.command.join(" ");
        }
        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );
          return payload?.tool ?? undefined;
        }
        default:
          return undefined;
      }
    })();

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = readPayload(ApprovalDecisionPayload, event.payload);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(payload ? { decision: payload.decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payload = readPayload(EffectCodexSchema.V2ThreadStartedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId: payload.thread.id,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    const payload =
      event.method === "thread/status/changed"
        ? readPayload(EffectCodexSchema.V2ThreadStatusChangedNotification, event.payload)
        : undefined;
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : payload
                    ? toThreadState(payload.status)
                    : "active",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadNameUpdatedNotification, event.payload);
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(trimText(payload?.threadName) ? { name: trimText(payload?.threadName) } : {}),
          ...(payload
            ? {
                metadata: {
                  threadId: payload.threadId,
                  ...(payload.threadName !== undefined && payload.threadName !== null
                    ? { threadName: payload.threadName }
                    : {}),
                },
              }
            : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
      event.payload,
    );
    const normalizedUsage = payload ? normalizeCodexTokenUsage(payload.tokenUsage) : undefined;
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "thread/goal/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadGoalUpdatedNotification, event.payload);
    const goal = payload ? normalizeCodexThreadGoal(payload.goal) : null;
    if (!goal) {
      return [];
    }
    return [
      {
        type: "thread.goal.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: { goal },
      },
    ];
  }

  if (event.method === "thread/goal/cleared") {
    if (!readPayload(EffectCodexSchema.V2ThreadGoalClearedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "thread.goal.cleared",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {},
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const errorMessage = trimText(payload.turn.error?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(payload.turn.status),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnPlanUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(trimText(payload.explanation) ? { explanation: trimText(payload.explanation) } : {}),
          plan: payload.plan.map((step) => ({
            step: trimText(step.step) ?? "step",
            status:
              step.status === "completed" || step.status === "inProgress" ? step.status : "pending",
          })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnDiffUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff: payload.diff,
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
    const item = payload?.item;
    if (!item) {
      return [];
    }
    const itemType = toCanonicalItemType(item.type);
    if (itemType === "plan") {
      const detail = itemDetail(item);
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType:
            event.method === "item/reasoning/summaryPartAdded" ? "reasoning" : "command_execution",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/plan/delta") {
    const payload = readPayload(EffectCodexSchema.V2PlanDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    const payload = readPayload(EffectCodexSchema.V2AgentMessageDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
        },
      },
    ];
  }

  if (event.method === "item/commandExecution/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2CommandExecutionOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "command_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/fileChange/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2FileChangeOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "file_change_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2ReasoningSummaryTextDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_summary_text",
          delta,
          ...(payload ? { summaryIndex: payload.summaryIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/reasoning/textDelta") {
    const payload = readPayload(EffectCodexSchema.V2ReasoningTextDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta,
          ...(payload ? { contentIndex: payload.contentIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const payload = readPayload(EffectCodexSchema.V2McpToolCallProgressNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          summary: payload.message,
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const payload = readPayload(
      EffectCodexSchema.V2ServerRequestResolvedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const requestType = toRequestTypeFromKind(event.requestKind);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    const payload = readPayload(EffectCodexSchema.ToolRequestUserInputResponse, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(payload.answers),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    const payload = readPayload(EffectCodexSchema.V2ModelReroutedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: payload.fromModel,
          toModel: payload.toModel,
          reason: payload.reason,
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    const payload = readPayload(EffectCodexSchema.V2DeprecationNoticeNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const payload = readPayload(EffectCodexSchema.V2ConfigWarningNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
          ...(trimText(payload.path) ? { path: trimText(payload.path) } : {}),
          ...(payload.range !== undefined && payload.range !== null
            ? { range: payload.range }
            : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountRateLimitsUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2McpServerOauthLoginCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload.success,
          name: payload.name,
          ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeStartedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId: payload.realtimeSessionId ?? undefined,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeItemAddedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: payload.item,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: payload.audio,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const payload = readPayload(EffectCodexSchema.V2ThreadRealtimeErrorNotification, event.payload);
    const message = payload?.message ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeClosedNotification,
      event.payload,
    );
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: payload?.reason ?? event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
    const message = payload?.error.message ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              class: "provider_error" as const,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    if (!readPayload(EffectCodexSchema.V2WindowsWorldWritableWarningNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payload = readPayload(
      EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: payload.success === false ? "error" : "ready",
          reason: payload.success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(payload.success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

/**
 * Build a Codex provider adapter bound to a specific `CodexSettings` payload.
 *
 * The adapter is a captured closure over `codexConfig` — the `binaryPath` and
 * `homePath` are read from that payload, not from `ServerSettingsService`.
 * This is what makes multi-instance routing possible: each `ProviderInstance`
 * in the registry owns its own closure with its own config, so two Codex
 * instances with different `homePath`s cannot step on each other.
 */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  codexConfig: CodexSettings,
  options?: CodexAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("codex");
  const adapterScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(2_048);
  const runtimeEventQueueMetrics = yield* makeServerQueueMetrics({
    queue: "provider.adapter.runtimeEvents",
    component: "CodexAdapter",
    provider: PROVIDER,
    providerInstanceId: boundInstanceId,
  });
  const sessions = new Map<ThreadId, CodexAdapterSessionContext>();

  const startSession: CodexAdapterShape["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (
          input.providerInstanceId !== undefined &&
          input.providerInstanceId !== boundInstanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider instance '${boundInstanceId}' but received '${input.providerInstanceId}'.`,
          });
        }
        const runtimeSessionId = yield* requireRuntimeSessionId(PROVIDER, input);

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          if (existing.runtimeSessionId === runtimeSessionId) {
            return {
              ...(yield* existing.runtime.getSession),
              providerInstanceId: boundInstanceId,
              runtimeSessionId,
            };
          }
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Thread '${input.threadId}' still has runtime '${existing.runtimeSessionId}'; stop it before starting '${runtimeSessionId}'.`,
          });
        }

        const tokenMode = input.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE;
        const tokenReductionInstructions = yield* readTokenReductionInstructions(tokenMode);

        // Agent Control: a fresh per-runtime credential, or none. `none`
        // (feature disabled, listener unhealthy, no bridge wired) starts
        // the provider without Agent Control — no MCP server entry and no
        // instruction text may claim tools that do not exist.
        const agentControlLease = yield* installAgentControlNativeHttp(options?.agentControl, {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          runtimeSessionId,
          injectionMode: "codex-http",
        });
        const agentControlInjection: CodexAgentControlInjection | undefined = Option.isSome(
          agentControlLease,
        )
          ? {
              serverName: CODEX_AGENT_CONTROL_SERVER_NAME,
              endpointUrl: agentControlLease.value.mcpServer.url,
              authorization: agentControlLease.value.credential,
              instructions: CODEX_AGENT_CONTROL_INSTRUCTIONS,
            }
          : undefined;

        const runtimeInput: CodexSessionRuntimeOptions = {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          runtimeSessionId,
          cwd: input.cwd ?? process.cwd(),
          binaryPath: codexConfig.binaryPath,
          ...(tokenReductionInstructions ? { tokenReductionInstructions } : {}),
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
          ...(agentControlInjection ? { agentControl: agentControlInjection } : {}),
          ...(input.resumePolicy !== "fresh" &&
          Schema.is(CodexResumeCursorSchema)(input.resumeCursor)
            ? { resumeCursor: input.resumeCursor }
            : {}),
          runtimeMode: input.runtimeMode,
          tokenMode,
          ...(input.modelSelection?.instanceId === boundInstanceId
            ? { model: input.modelSelection.model }
            : {}),
          ...(input.modelSelection?.instanceId === boundInstanceId &&
          getModelSelectionBooleanOptionValue(input.modelSelection, "fastMode") === true
            ? { serviceTier: "fast" }
            : {}),
        };
        const agentControl = Option.getOrUndefined(agentControlLease);
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        // The session scope is a teardown backstop: start-failure cleanup,
        // epoch mismatch, instance rebuild, and server shutdown all close
        // it. `stopSessionInternal` additionally revokes eagerly before the
        // (interruptible, potentially wedged) runtime close, so a timed-out
        // stop cannot leave the credential alive. Revocation targets the
        // unique lease id — never the (thread, epoch) pair, which a
        // recovered successor runtime may legitimately reuse.
        if (agentControl) yield* agentControl.addScopeFinalizer(sessionScope);
        const createRuntime = options?.makeRuntime ?? makeCodexSessionRuntime;
        const runtime = yield* createRuntime(runtimeInput).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: formatCodexRuntimeErrorDetail(cause),
                cause,
              }),
          ),
        );

        // Fork into the session scope, not the calling fiber. `forkChild` makes
        // this a child of `startSession`, and Effect interrupts a fiber's
        // children when it completes, so the consumer died on return and every
        // runtime event the session emitted afterwards was dropped.
        let runtimeExited = false;
        const retireRuntime = Effect.gen(function* () {
          const current = sessions.get(input.threadId);
          if (current?.runtime === runtime) yield* stopSessionInternal(current);
        });
        const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event);
            const runtimeEvents = mapToRuntimeEvents(event, event.threadId).map((runtimeEvent) =>
              stampRuntimeEvent(runtimeEvent, {
                providerInstanceId: boundInstanceId,
                runtimeSessionId,
              }),
            );
            // A dead codex process cannot use its lease, but the read tools
            // must not outlive the runtime either — revoke on exit even
            // before anything calls stopSession on the stale record. By
            // unique lease id: this fiber may outlive a replacement, and
            // must never touch a successor's lease.
            if (
              agentControl &&
              runtimeEvents.some((runtimeEvent) => runtimeEvent.type === "session.exited")
            ) {
              yield* agentControl.revoke("runtime-teardown");
            }
            if (agentControl) {
              for (const runtimeEvent of runtimeEvents) {
                if (runtimeEvent.type !== "turn.completed") continue;
                yield* agentControl.retireTurn(runtimeEvent.turnId);
              }
            }
            if (runtimeEvents.length === 0) {
              yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                method: event.method,
                threadId: event.threadId,
                turnId: event.turnId,
                itemId: event.itemId,
              });
              return;
            }
            yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
            yield* runtimeEventQueueMetrics.recordEnqueued(runtimeEvents.length);
            if (runtimeEvents.some((runtimeEvent) => runtimeEvent.type === "session.exited")) {
              runtimeExited = true;
              yield* retireRuntime.pipe(Effect.forkIn(adapterScope));
            }
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.gen(function* () {
                  runtimeExited = true;
                  if (agentControl) yield* agentControl.revoke("runtime-teardown");
                  yield* Effect.logWarning("Codex event consumer failed; retiring its runtime", {
                    threadId: input.threadId,
                  });
                  yield* Queue.offer(runtimeEventQueue, {
                    eventId: EventId.make(crypto.randomUUID()),
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    runtimeSessionId,
                    threadId: input.threadId,
                    createdAt: new Date().toISOString(),
                    type: "session.exited",
                    payload: {
                      reason: "Codex event stream failed. Reopen the chat to recover.",
                      recoverable: true,
                      exitKind: "error",
                    },
                  });
                  yield* runtimeEventQueueMetrics.recordEnqueued(1);
                  yield* retireRuntime.pipe(Effect.forkIn(adapterScope));
                }),
          ),
          Effect.forkIn(sessionScope),
        );

        const started = yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: formatCodexRuntimeErrorDetail(cause),
                cause,
              }),
          ),
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
              Effect.andThen(Fiber.interrupt(eventFiber)),
              Effect.ignore,
            ),
          ),
        );
        if (
          runtimeExited ||
          (started.runtimeSessionId !== undefined && started.runtimeSessionId !== runtimeSessionId)
        ) {
          yield* runtime.close.pipe(
            Effect.andThen(Fiber.interrupt(eventFiber)),
            Effect.andThen(Scope.close(sessionScope, Exit.void)),
            Effect.ignore,
          );
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: runtimeExited
              ? "Codex runtime exited while the session was starting."
              : `Codex runtime returned epoch '${started.runtimeSessionId}' for requested epoch '${runtimeSessionId}'.`,
          });
        }

        sessions.set(input.threadId, {
          threadId: input.threadId,
          runtimeSessionId,
          scope: sessionScope,
          runtime,
          eventFiber,
          ...(agentControl ? { agentControl } : {}),
          stopped: false,
        });
        sessionScopeTransferred = true;

        return {
          ...started,
          providerInstanceId: boundInstanceId,
          runtimeSessionId,
        };
      }),
    );

  const resolveAttachmentForPreflight = Effect.fn("resolveAttachmentForPreflight")(function* (
    attachment: ChatAttachment,
    method: "turn/start" | "turn/steer",
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const fileInfo = yield* fileSystem.stat(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: `Failed to stat attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    if (fileInfo.type !== "File") {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Attachment '${attachment.name}' is not a regular file.`,
      });
    }

    const sizeBytes = normalizeFileSizeBytes(fileInfo.size);
    if (sizeBytes <= 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Attachment '${attachment.name}' is empty.`,
      });
    }
    if (sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Attachment '${attachment.name}' is ${sizeBytes} bytes; limit is ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES} bytes.`,
      });
    }

    return {
      attachment,
      path: attachmentPath,
      sizeBytes,
    };
  });

  const preflightAttachments = Effect.fn("preflightAttachments")(function* (
    input: Pick<ProviderSendTurnInput | ProviderSteerTurnInput, "threadId" | "attachments">,
    method: "turn/start" | "turn/steer",
  ) {
    const attachments = input.attachments ?? [];
    if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Turn has ${attachments.length} attachments; limit is ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      });
    }

    const native = attachments.filter((attachment) => attachment.type === "image");
    const resolved = yield* Effect.forEach(
      native,
      (attachment) => resolveAttachmentForPreflight(attachment, method),
      { concurrency: 1 },
    );
    const totalBytes = resolved.reduce((total, entry) => total + entry.sizeBytes, 0);
    if (totalBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Turn attachments total ${totalBytes} bytes; limit is ${PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
      });
    }

    const pathLineEntries: AttachmentPathLineEntry[] = attachments
      .filter((attachment) => attachment.type !== "image")
      .map((attachment) => ({
        attachment,
        ...(attachment.id === undefined
          ? {}
          : {
              resolvedPath:
                resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                }) ?? undefined,
            }),
      }));

    if (resolved.length > 0) {
      yield* Effect.annotateCurrentSpan({
        "provider.attachment_count": resolved.length,
        "provider.attachment_total_bytes": totalBytes,
      });
      yield* Effect.logDebug("resolved Codex turn attachments", {
        threadId: input.threadId,
        attachmentCount: resolved.length,
        attachmentTotalBytes: totalBytes,
        attachmentBytes: resolved.map((entry) => ({
          id: entry.attachment.id,
          name: entry.attachment.name,
          sizeBytes: entry.sizeBytes,
        })),
      });
    }

    return {
      native: resolved,
      pathLines: formatAttachmentPathLines(pathLineEntries),
    };
  });

  const toCodexAttachment = Effect.fn("toCodexAttachment")(function* (
    resolved: ResolvedCodexAttachment,
    method: "turn/start" | "turn/steer",
  ) {
    const bytes = yield* fileSystem.readFile(resolved.path).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    const attachment = resolved.attachment;
    return {
      type: "image" as const,
      url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const { native, pathLines } = yield* preflightAttachments(input, "turn/start");
    const codexAttachments = yield* Effect.forEach(
      native,
      (attachment) => toCodexAttachment(attachment, "turn/start"),
      { concurrency: 1 },
    );

    const session = yield* requireSession(input.threadId);
    const reasoningEffort =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
        : undefined;
    const fastMode =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionBooleanOptionValue(input.modelSelection, "fastMode")
        : undefined;
    const formatted = formatSourceControlContextsForAgent(input.sourceControlContexts ?? []);
    const codexInput = appendAttachmentPathLines(
      formatted ? formatted + "\n\n" + (input.input ?? "") : input.input,
      pathLines,
    );
    const result = yield* session.runtime
      .sendTurn({
        ...(codexInput !== undefined ? { input: codexInput } : {}),
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        ...(reasoningEffort
          ? {
              effort: reasoningEffort as EffectCodexSchema.V2TurnStartParams__ReasoningEffort,
            }
          : {}),
        ...(fastMode === true ? { serviceTier: "fast" } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(input.customSystemPrompt !== undefined
          ? { customSystemPrompt: input.customSystemPrompt }
          : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
      })
      .pipe(Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/start", cause)));
    if (session.agentControl) {
      yield* session.agentControl.bindTurn(result.turnId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to bind Agent Control turn authority", {
            threadId: input.threadId,
            turnId: result.turnId,
            cause,
          }),
        ),
      );
    }
    return result;
  });

  const steerTurn: NonNullable<CodexAdapterShape["steerTurn"]> = Effect.fn("steerTurn")(
    function* (input) {
      const { native, pathLines } = yield* preflightAttachments(input, "turn/steer");
      const codexAttachments = yield* Effect.forEach(
        native,
        (attachment) => toCodexAttachment(attachment, "turn/steer"),
        { concurrency: 1 },
      );
      const session = yield* requireSession(input.threadId);
      const steerInput = appendAttachmentPathLines(input.input, pathLines);
      return yield* session.runtime
        .steerTurn({
          expectedTurnId: input.expectedTurnId,
          messageId: input.messageId,
          ...(steerInput !== undefined ? { input: steerInput } : {}),
          ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
        })
        .pipe(
          Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/steer", cause)),
        );
    },
  );

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return session;
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    session: CodexAdapterSessionContext,
  ) {
    if (session.stopped) {
      return;
    }
    // Revoke the Agent Control lease first, in one uninterruptible step
    // with the map removal: `ProviderService.stopExactBinding` wraps this
    // stop in a timeout, and an interruption striking during the
    // (potentially wedged) `runtime.close` below must not leave a dead
    // runtime holding a valid credential. The session-scope finalizer
    // repeats the revocation idempotently on the paths that do reach it.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        session.stopped = true;
        sessions.delete(session.threadId);
        if (session.agentControl) yield* session.agentControl.revoke("runtime-teardown");
      }),
    );
    yield* session.runtime.close.pipe(Effect.ignore);
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
  });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        (session.agentControl ? session.agentControl.retireTurn(turnId) : Effect.void).pipe(
          Effect.andThen(session.runtime.interruptTurn(turnId)),
          Effect.timeoutOption("15 seconds"),
          Effect.flatMap(
            Option.match({
              onSome: () => Effect.void,
              onNone: () =>
                Effect.logWarning(
                  "Codex turn interrupt timed out; recycling the wedged provider session.",
                  { threadId },
                ).pipe(Effect.andThen(stopSessionInternal(session))),
            }),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "turn/interrupt", cause),
      ),
    );

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.readThread),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/read", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const readThreadHistory: NonNullable<CodexAdapterShape["readThreadHistory"]> = (input) =>
    Effect.gen(function* () {
      if (!Schema.is(CodexResumeCursorSchema)(input.resumeCursor)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "readThreadHistory",
          issue: "Missing Codex thread identity.",
        });
      }
      // A separate read-only client also works when the live runtime's reader
      // is broken or the Codex app owns the thread's writer lease.
      const existing = sessions.get(input.threadId);
      const liveSession =
        existing && !existing.stopped ? yield* existing.runtime.getSession : undefined;
      const liveSnapshot =
        existing &&
        liveSession &&
        (liveSession.status === "ready" || liveSession.status === "running") &&
        Schema.is(CodexResumeCursorSchema)(liveSession.resumeCursor) &&
        liveSession.resumeCursor.threadId === input.resumeCursor.threadId
          ? yield* existing.runtime.readThread.pipe(
              Effect.timeoutOption("2 seconds"),
              Effect.orElseSucceed(() => Option.none()),
            )
          : Option.none();
      const snapshot = Option.isSome(liveSnapshot)
        ? liveSnapshot.value
        : yield* readStoredCodexThread({
            binaryPath: codexConfig.binaryPath,
            cwd: input.cwd ?? process.cwd(),
            providerThreadId: input.resumeCursor.threadId,
            ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
            ...(options?.environment ? { environment: options.environment } : {}),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "thread/read", cause)),
          );
      const messages: Array<ProviderThreadHistory["messages"][number]> = [];
      const items: Array<ProviderRuntimeEvent> = [];
      const completedTurnIds: Array<TurnId> = [];
      const failedTurnIds: Array<TurnId> = [];
      for (const turn of snapshot.turns) {
        // Partial snapshots must never overwrite newer streamed text.
        if (!turn.status || turn.status === "inProgress") continue;
        completedTurnIds.push(turn.id);
        if (turn.status === "failed") failedTurnIds.push(turn.id);
        const createdAt = new Date((turn.startedAt ?? 0) * 1_000).toISOString();
        for (const item of turn.items) {
          if (item.type === "agentMessage" || item.type === "userMessage") {
            messages.push({
              id: MessageId.make(
                item.type === "agentMessage"
                  ? `assistant:${item.id}`
                  : (item.clientId ?? `user:${item.id}`),
              ),
              turnId: turn.id,
              role: item.type === "agentMessage" ? "assistant" : "user",
              text:
                item.type === "agentMessage"
                  ? item.text
                  : item.content
                      .flatMap((part) => (part.type === "text" ? [part.text] : []))
                      .join("\n"),
              createdAt,
            });
          } else {
            const event = mapItemLifecycle(
              {
                id: EventId.make(
                  `history:${input.threadId}:${snapshot.threadId}:${turn.id}:${item.id}`,
                ),
                provider: PROVIDER,
                threadId: input.threadId,
                kind: "notification",
                method: "item/completed",
                turnId: turn.id,
                itemId: ProviderItemId.make(item.id),
                createdAt,
                payload: { threadId: snapshot.threadId, turnId: turn.id, item },
              },
              input.threadId,
              "item.completed",
            );
            if (event) items.push(event);
          }
        }
      }
      return { messages, items, completedTurnIds, failedTurnIds };
    });

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.rollbackThread(numTurns)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/rollback", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const setThreadGoal: NonNullable<CodexAdapterShape["setThreadGoal"]> = (threadId, goal) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => {
        const fields = goal.synchronization?.fields ?? ["objective", "status", "tokenBudget"];
        return session.runtime.setGoal({
          ...(fields.includes("objective") ? { objective: goal.objective } : {}),
          ...(fields.includes("status") ? { status: goal.status } : {}),
          ...(fields.includes("tokenBudget") ? { tokenBudget: goal.tokenBudget } : {}),
        });
      }),
      Effect.flatMap((response) => {
        const goal = normalizeCodexThreadGoal(response.goal);
        return goal
          ? Effect.succeed(goal)
          : Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread/goal/set",
                detail: "Codex returned an invalid goal.",
              }),
            );
      }),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError" ||
        cause._tag === "ProviderAdapterRequestError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/goal/set", cause),
      ),
    );

  const getThreadGoal: NonNullable<CodexAdapterShape["getThreadGoal"]> = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.getGoal),
      Effect.flatMap((response) => {
        if (!response.goal) return Effect.succeed(null);
        const goal = normalizeCodexThreadGoal(response.goal);
        return goal
          ? Effect.succeed(goal)
          : Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread/goal/get",
                detail: "Codex returned an invalid goal.",
              }),
            );
      }),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError" ||
        cause._tag === "ProviderAdapterRequestError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/goal/get", cause),
      ),
    );

  const clearThreadGoal: NonNullable<CodexAdapterShape["clearThreadGoal"]> = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.clearGoal),
      Effect.asVoid,
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/goal/clear", cause),
      ),
    );

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToRequest(requestId, decision)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/requestApproval/decision", cause),
      ),
    );

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToUserInput(requestId, answers)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/tool/requestUserInput", cause),
      ),
    );

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return;
      }
      yield* stopSessionInternal(session);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter((session) => !session.stopped),
      (session) => session.runtime.getSession,
      { concurrency: 1 },
    );

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(runtimeEventQueueMetrics.reset),
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(managedNativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      turnSteering: "native",
    },
    startSession,
    sendTurn,
    steerTurn,
    interruptTurn,
    readThread,
    readThreadHistory,
    rollbackThread,
    setThreadGoal,
    getThreadGoal,
    clearThreadGoal,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue).pipe(
        Stream.tap(() => runtimeEventQueueMetrics.recordDequeued()),
      );
    },
  } satisfies CodexAdapterShape;
});

// NOTE: the old `CodexAdapterLive` / `makeCodexAdapterLive` singleton Layer
// exports have been removed as part of the per-instance-driver refactor.
// `makeCodexAdapter(codexConfig, options?)` is now invoked directly by
// `CodexDriver.create()` for each configured instance; downstream consumers
// (server bootstrap, integration harness, this module's tests) will be
// migrated to the registry in a follow-up pass.
