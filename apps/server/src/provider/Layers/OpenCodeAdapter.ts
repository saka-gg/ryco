import { Option } from "effect";
import { computerTurnPlan } from "../../computer/computerTurnLifecycle.ts";
import { createHash } from "node:crypto";

import {
  DEFAULT_AGENT_TOKEN_MODE,
  EventId,
  type OpenCodeSettings,
  ProviderItemId,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  type ProviderProjectCommands,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeSubagentId,
  type RuntimeSubagentStatus,
  RuntimeItemId,
  RuntimeRequestId,
  type SubagentRef,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@ryco/contracts";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type {
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
} from "@opencode-ai/sdk/v2";
import { appendAttachmentPathLines } from "@ryco/shared/attachmentPrompt";
import { getModelSelectionStringOptionValue } from "@ryco/shared/model";
import { formatSourceControlContextsForAgent } from "@ryco/shared/sourceControlContextFormatter";

import { attachmentPathLines, readPersistedAttachment } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { makeServerQueueMetrics } from "../../observability/QueueMetrics.ts";
import { createProcessDeviceToolBinding } from "../../providerTools/deviceToolGateway.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  agentControlHostContext,
  installAgentControlNativeHttp,
  type AgentControlNativeHttpInjection,
  type AgentControlProviderBridge,
} from "../../agentControl/ProviderInjection.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { requireRuntimeSessionId, stampRuntimeEvent } from "../runtimeSession.ts";
import type { OpenCodeServerOwner } from "../OpenCodeServerOwner.ts";
import type { OpenCodeApi } from "../openCodeApi.ts";
import type { AgentProcessPriorityShape } from "../agentProcessPriority.ts";
import {
  buildOpenCodePermissionRules,
  isOpenCodeNativeAttachment,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
  verifyOpenCodeServerVersion,
} from "../opencodeRuntime.ts";

import { OpenCodeTaskLifecycle, type OpenCodeTaskTransition } from "../openCodeTaskLifecycle.ts";
import { OpenCodePartIndex } from "../openCodePartIndex.ts";
import { openCodeCommandsToSlashCommands } from "../openCodeCommands.ts";
import { parseSlashCommandInput } from "../providerSlashCommands.ts";
import { ToolUpdateGate, toolUpdateVisibleKey } from "../toolUpdateGate.ts";

const PROVIDER = ProviderDriverKind.make("opencode");
const OPENCODE_RESUME_VERSION = 1;
/** How long a send waits for the directory's command list before it sends a plain prompt. */
const OPENCODE_COMMAND_LIST_TIMEOUT = "10 seconds";
/**
 * How long a send waits to see OpenCode take a `session.command`. A call still pending then is
 * taken as admitted: OpenCode resolves the command's template (shell substitutions, an MCP
 * prompt) before it starts the turn, and it runs the command even when the request is aborted.
 */
const OPENCODE_COMMAND_ADMISSION_TIMEOUT = "10 seconds";
const EMPTY_PROJECT_COMMANDS: ProviderProjectCommands = { skills: [], slashCommands: [] };

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpenCodeApi["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

interface OpenCodeSessionContext {
  readonly computerLease?: AgentControlNativeHttpInjection;
  session: ProviderSession;
  readonly client: OpenCodeApi;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  /** Root OpenCode session. A checkpoint revert rebinds it to a fork. */
  openCodeSessionId: string;
  /**
   * Ryco turns the latest fork dropped, persisted in the resume cursor. A revert
   * whose projection never landed is retried with the same turns, which OpenCode
   * must not drop a second time.
   */
  forgottenTurnIds: ReadonlyArray<string>;
  /** Set while a revert forks the session, so the fork is not adopted as a child. */
  rewinding: boolean;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly resolvedRequestIds: Set<string>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly parts: OpenCodePartIndex;
  readonly childSessionIds: Set<string>;
  readonly subagentBySessionId: Map<string, SubagentRef>;
  readonly subagentBySubtaskPartId: Map<string, SubagentRef>;
  readonly unboundSubtaskPartIds: Array<string>;
  readonly startedSubagentIds: Set<string>;
  readonly completedSubagentIds: Set<string>;
  readonly tasks: OpenCodeTaskLifecycle;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  /** Dedup guard: last emitted todo fingerprint (root session only). */
  lastPlanFingerprint: string | undefined;
  /** Dedup guard: `${attempt}:${message}` of the last emitted retry warning. */
  lastRetryKey: string | undefined;
  /**
   * Drops repeats of a tool part's visible state (bash streams its output into metadata the
   * projection discards).
   */
  readonly toolUpdates: ToolUpdateGate;
  readonly promptSemaphore: Semaphore.Semaphore;
  pendingPrompt:
    | {
        readonly turnId: TurnId;
        readonly fiber: Fiber.Fiber<unknown, ProviderAdapterRequestError>;
        idleEvent?: OpenCodeSubscribedEvent;
      }
    | undefined;
  /** The newest `session.command` call; it outlives its admission (see `PendingOpenCodeCommand`). */
  pendingCommand: PendingOpenCodeCommand | undefined;
  promptGeneration: number;
  agentControlHostContextDelivered: boolean;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

/**
 * A command run with `session.command`, which answers only when the command's generation ends.
 * The turn is admitted earlier: when the call settles, when the event stream shows OpenCode
 * took it (the root session busy, or its user message stored), or when the call is still
 * pending at `OPENCODE_COMMAND_ADMISSION_TIMEOUT`.
 */
interface PendingOpenCodeCommand {
  readonly turnId: TurnId;
  readonly admitted: Deferred.Deferred<void, ProviderAdapterRequestError>;
  /** The event stream showed OpenCode starting the command's turn. */
  started: boolean;
  /** Set right after the call is forked; the admission signal exists before it starts. */
  fiber: Fiber.Fiber<void> | undefined;
}

export interface OpenCodeAdapterLiveOptions {
  readonly agentControl?: AgentControlProviderBridge;
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly serverOwner?: OpenCodeServerOwner;
  /** Lowers a server this adapter starts itself (the computer-use path); undefined: unchanged. */
  readonly processPriority?: AgentProcessPriorityShape | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseOpenCodeResume(
  value: unknown,
): { readonly sessionId: string; readonly forgottenTurnIds: ReadonlyArray<string> } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const cursor = value as {
    readonly schemaVersion?: unknown;
    readonly sessionId?: unknown;
    readonly forgottenTurnIds?: unknown;
  };
  if (
    cursor.schemaVersion !== OPENCODE_RESUME_VERSION ||
    typeof cursor.sessionId !== "string" ||
    cursor.sessionId.trim().length === 0
  ) {
    return undefined;
  }
  const forgottenTurnIds = Array.isArray(cursor.forgottenTurnIds)
    ? cursor.forgottenTurnIds.filter((id): id is string => typeof id === "string")
    : [];
  return { sessionId: cursor.sessionId, forgottenTurnIds };
}

function openCodeResumeCursor(sessionId: string, forgottenTurnIds: ReadonlyArray<string>) {
  return {
    schemaVersion: OPENCODE_RESUME_VERSION,
    sessionId,
    ...(forgottenTurnIds.length > 0 ? { forgottenTurnIds: [...forgottenTurnIds] } : {}),
  };
}

/**
 * The HTTP status the server answered an SDK call with; undefined when no response arrived (a
 * refused or dropped connection, a fetch timeout, an abort). The SDK throws an `Error` whose
 * `cause` carries the status; older SDKs threw an object with the `response` itself.
 */
function openCodeResponseStatus(error: OpenCodeRuntimeError): number | undefined {
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  const statusOf = (value: unknown) => {
    const status =
      typeof value === "object" && value !== null ? Reflect.get(value, "status") : undefined;
    return typeof status === "number" ? status : undefined;
  };
  return statusOf(Reflect.get(cause, "response")) ?? statusOf(Reflect.get(cause, "cause"));
}

/** An SDK call the server answered with 404. */
function isOpenCodeNotFound(error: OpenCodeRuntimeError): boolean {
  return openCodeResponseStatus(error) === 404;
}

function scopedOpenCodeId(sessionId: string, id: string): string {
  return `${sessionId}:${id}`;
}

function openCodeSubagentId(kind: "session" | "subtask", id: string): RuntimeSubagentId {
  return RuntimeSubagentId.make(`opencode:${kind}:${id}`);
}

function subagentKey(subagentId: RuntimeSubagentId): string {
  return String(subagentId);
}

function statusFromOpenCodeSubagentState(
  status: "starting" | "running" | "completed" | "failed" | "stopped",
): RuntimeSubagentStatus {
  return status;
}

function isOpenCodeRequestEvent(event: OpenCodeSubscribedEvent): boolean {
  return (
    event.type === "permission.asked" ||
    event.type === "permission.replied" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected"
  );
}

function subagentCompletionStatus(
  status: "completed" | "failed" | "stopped",
): Extract<RuntimeSubagentStatus, "completed" | "failed" | "stopped"> {
  return status;
}

function metadataWithEntries(
  entries: ReadonlyArray<readonly [string, unknown]>,
): Record<string, unknown> | undefined {
  const metadata = Object.fromEntries(
    entries.filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function makeSubtaskSubagentRef(part: Extract<Part, { type: "subtask" }>): SubagentRef {
  const description = nonEmptyString(part.description) ?? nonEmptyString(part.prompt);
  const model = part.model ? `${part.model.providerID}/${part.model.modelID}` : undefined;
  const label =
    nonEmptyString(part.agent) ??
    nonEmptyString(part.command) ??
    (description ? "OpenCode subtask" : undefined);
  return {
    subagentId: openCodeSubagentId("subtask", part.id),
    origin: "native",
    capability: "summary",
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    parentProviderItemId: ProviderItemId.make(part.id),
    metadata: metadataWithEntries([
      ["source", "opencode.subtask"],
      ["prompt", nonEmptyString(part.prompt)],
      ["agent", nonEmptyString(part.agent)],
      ["command", nonEmptyString(part.command)],
      ["model", part.model],
    ]),
  };
}

function mergeOpenCodeChildSessionRef(
  existing: SubagentRef | undefined,
  session: Session,
  parentSessionId: string,
): SubagentRef {
  const label = nonEmptyString(session.title) ?? existing?.label ?? "OpenCode subagent";
  return {
    subagentId: existing?.subagentId ?? openCodeSubagentId("session", session.id),
    origin: "native",
    capability: "transcript",
    label,
    ...(existing?.description ? { description: existing.description } : {}),
    ...(existing?.model ? { model: existing.model } : {}),
    ...(existing?.effort ? { effort: existing.effort } : {}),
    providerSessionId: session.id,
    providerThreadId: session.id,
    ...(existing?.parentProviderItemId && { parentProviderItemId: existing.parentProviderItemId }),
    metadata: {
      ...existing?.metadata,
      source: "opencode.session",
      parentSessionId,
      slug: session.slug,
      directory: session.directory,
    },
  };
}

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

const abortOpenCodeSession = (context: OpenCodeSessionContext, sessionID: string) =>
  runOpenCodeSdk("session.abort", (signal) =>
    context.client.session.abort({ sessionID }, { signal }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () =>
        Effect.fail(
          new OpenCodeRuntimeError({
            operation: "session.abort",
            detail: `Timed out aborting OpenCode session '${sessionID}'.`,
          }),
        ),
    }),
  );

interface OpenCodeCommandLookup {
  readonly command?: { readonly name: string; readonly arguments: string };
  /** A `/name` that could not be checked against OpenCode's list, and why; it goes out as a prompt. */
  readonly unchecked?: { readonly name: string; readonly detail: string };
}

/**
 * `/name args` as `command` when OpenCode lists `name` in the session's directory. A path such as
 * `/Users/me/x.ts`, an unknown name, or a list that fails or does not answer in time sends the
 * input as an ordinary prompt, so the turn still goes out; the last two are `unchecked`.
 */
const findOpenCodeCommand = (
  context: OpenCodeSessionContext,
  input: string | undefined,
): Effect.Effect<OpenCodeCommandLookup> => {
  const parsed = parseSlashCommandInput(input);
  if (parsed === undefined) return Effect.succeed({});
  return runOpenCodeSdk("command.list", (signal) =>
    context.client.command.list(undefined, { signal }),
  ).pipe(
    Effect.timeoutOption(OPENCODE_COMMAND_LIST_TIMEOUT),
    Effect.map((listed): OpenCodeCommandLookup => {
      if (Option.isNone(listed)) {
        return {
          unchecked: { name: parsed.name, detail: "OpenCode did not list its commands in time." },
        };
      }
      return (listed.value.data ?? []).some((command) => command.name === parsed.name)
        ? { command: parsed }
        : {};
    }),
    Effect.catch((error) =>
      Effect.logDebug("OpenCode command list failed; sending a prompt", error.detail).pipe(
        Effect.as<OpenCodeCommandLookup>({
          unchecked: { name: parsed.name, detail: error.detail },
        }),
      ),
    ),
  );
};

/** The event stream shows OpenCode starting the pending command's turn; admits it if still due. */
const admitPendingOpenCodeCommand = (context: OpenCodeSessionContext) => {
  const pending = context.pendingCommand;
  if (pending === undefined) return Effect.void;
  pending.started = true;
  return Deferred.succeed(pending.admitted, undefined).pipe(Effect.asVoid);
};

/** Interrupting the call aborts its request; the caller still aborts the OpenCode session. */
const interruptPendingOpenCodeCommand = (context: OpenCodeSessionContext, turnId?: TurnId) => {
  const pending = context.pendingCommand;
  if (pending === undefined || (turnId !== undefined && pending.turnId !== turnId)) {
    return Effect.void;
  }
  context.pendingCommand = undefined;
  return pending.fiber === undefined ? Effect.void : Fiber.interrupt(pending.fiber);
};

const buildEventBase = (input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Effect.Effect<
  Pick<
    ProviderRuntimeEvent,
    "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
  >
> =>
  Effect.sync(() => crypto.randomUUID()).pipe(
    Effect.map((uuid) => ({
      eventId: EventId.make(uuid),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: input.createdAt ?? nowIso(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
      ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
      ...(input.raw !== undefined
        ? {
            raw: {
              source: "opencode.sdk.event",
              payload: input.raw,
            },
          }
        : {}),
    })),
  );

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

/**
 * Maps an OpenCode assistant message's token snapshot into the shared usage
 * shape. OpenCode reports no context window here, so `usedTokens` is the full
 * bucket sum (input incl. cache + output + reasoning) — the same estimate
 * other apps derive by summing buckets when the server reports no total.
 * Reads defensively: older servers and partial event payloads may omit fields.
 */
function threadTokenUsageFromOpenCodeTokens(
  tokens: unknown,
  requestId: string,
): ThreadTokenUsageSnapshot | undefined {
  if (typeof tokens !== "object" || tokens === null) {
    return undefined;
  }
  const record = tokens as {
    readonly input?: unknown;
    readonly output?: unknown;
    readonly reasoning?: unknown;
    readonly cache?: { readonly read?: unknown; readonly write?: unknown };
  };
  const nonNegative = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const inputTokens =
    nonNegative(record.input) + nonNegative(record.cache?.read) + nonNegative(record.cache?.write);
  const outputTokens = nonNegative(record.output);
  const reasoningTokens = nonNegative(record.reasoning);
  const usedTokens = inputTokens + outputTokens + reasoningTokens;
  if (usedTokens <= 0) {
    return undefined;
  }
  return {
    processedUsage: {
      scope: "request",
      requestId,
      inputTokens,
      cachedInputTokens: nonNegative(record.cache?.read),
      outputTokens: outputTokens + reasoningTokens,
      reasoningOutputTokens: reasoningTokens,
      totalTokens: usedTokens,
    },
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(nonNegative(record.cache?.read) > 0
      ? { cachedInputTokens: nonNegative(record.cache?.read) }
      : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningOutputTokens: reasoningTokens } : {}),
  };
}

function planStepsFromOpenCodeTodos(
  todos: ReadonlyArray<{ readonly content: string; readonly status: string }>,
): Array<{ readonly step: string; readonly status: "pending" | "inProgress" | "completed" }> {
  const steps: Array<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }> = [];
  for (const todo of todos) {
    if (todo.status === "cancelled") {
      continue;
    }
    const step = typeof todo.content === "string" ? todo.content.trim() : "";
    if (!step) {
      continue;
    }
    steps.push({
      step,
      status:
        todo.status === "completed"
          ? "completed"
          : todo.status === "in_progress"
            ? "inProgress"
            : "pending",
    });
  }
  return steps;
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  // `ensureSessionContext` is a sync gate used from both sync helpers and
  // Effect bodies. `Ref.getUnsafe` is an atomic read of the backing cell —
  // no fiber suspension required, which keeps this callable everywhere.
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function suffixPrefixOverlap(text: string, delta: string): number {
  const maxLength = Math.min(text.length, delta.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(delta.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta));
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit,
  };
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "sessionID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(scopedOpenCodeId(part.sessionID, part.messageID));
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  const pendingPrompt = context.pendingPrompt;
  if (pendingPrompt) {
    context.pendingPrompt = undefined;
    yield* Fiber.interrupt(pendingPrompt.fiber).pipe(Effect.ignore);
  }
  yield* interruptPendingOpenCodeCommand(context).pipe(Effect.ignore);

  // Stop the root first so it cannot launch more work while we cancel the
  // child sessions already observed by the event stream or hydration pass.
  // A root abort does not consistently terminate independently-running
  // children, so every tracked session gets its own best-effort abort; the
  // children are independent, so their aborts (each bounded) run together.
  const abortSession = (sessionID: string) =>
    abortOpenCodeSession(context, sessionID).pipe(Effect.ignore({ log: true }));
  yield* abortSession(context.openCodeSessionId);
  yield* Effect.forEach([...context.childSessionIds], abortSession, {
    concurrency: "unbounded",
    discard: true,
  });

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.bounded<ProviderRuntimeEvent>(2_048);
    const runtimeEventQueueMetrics = yield* makeServerQueueMetrics({
      queue: "provider.adapter.runtimeEvents",
      component: "OpenCodeAdapter",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
    });
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(
        Effect.ensuring(runtimeEventQueueMetrics.reset),
        Effect.ensuring(Queue.shutdown(runtimeEvents)),
      ),
    );

    const emitForContext = (context: OpenCodeSessionContext, event: ProviderRuntimeEvent) => {
      if (context.session.runtimeSessionId === undefined) {
        return Effect.die(
          new Error(
            `OpenCodeAdapter emitted '${event.type}' without a runtime session for thread '${event.threadId}'.`,
          ),
        );
      }
      return Queue.offer(
        runtimeEvents,
        stampRuntimeEvent(event, {
          providerInstanceId: boundInstanceId,
          runtimeSessionId: context.session.runtimeSessionId,
        }),
      ).pipe(Effect.andThen(runtimeEventQueueMetrics.recordEnqueued()), Effect.asVoid);
    };
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const emitOpenCodeSubagentStarted = Effect.fn("emitOpenCodeSubagentStarted")(function* (
      context: OpenCodeSessionContext,
      subagent: SubagentRef,
      raw: unknown,
    ) {
      const key = subagentKey(subagent.subagentId);
      if (context.startedSubagentIds.has(key)) {
        return;
      }
      context.startedSubagentIds.add(key);
      yield* emitForContext(context, {
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          raw,
        })),
        type: "subagent.started",
        payload: {
          subagent,
        },
      });
    });

    const emitOpenCodeSubagentUpdated = Effect.fn("emitOpenCodeSubagentUpdated")(function* (
      context: OpenCodeSessionContext,
      input: {
        readonly subagent: SubagentRef;
        readonly status?: RuntimeSubagentStatus;
        readonly summary?: string | undefined;
        readonly detail?: string | undefined;
        readonly raw: unknown;
      },
    ) {
      if (context.completedSubagentIds.has(subagentKey(input.subagent.subagentId))) return;
      yield* emitOpenCodeSubagentStarted(context, input.subagent, input.raw);
      yield* emitForContext(context, {
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          raw: input.raw,
        })),
        type: "subagent.updated",
        payload: {
          subagent: input.subagent,
          ...(input.status ? { status: input.status } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.detail ? { detail: input.detail } : {}),
        },
      });
    });

    const emitOpenCodeSubagentCompleted = Effect.fn("emitOpenCodeSubagentCompleted")(function* (
      context: OpenCodeSessionContext,
      input: {
        readonly subagent: SubagentRef;
        readonly status: Extract<RuntimeSubagentStatus, "completed" | "failed" | "stopped">;
        readonly summary?: string | undefined;
        readonly raw: unknown;
      },
    ) {
      const key = subagentKey(input.subagent.subagentId);
      if (context.completedSubagentIds.has(key)) {
        return;
      }
      yield* emitOpenCodeSubagentStarted(context, input.subagent, input.raw);
      context.completedSubagentIds.add(key);
      yield* emitForContext(context, {
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          raw: input.raw,
        })),
        type: "subagent.completed",
        payload: {
          subagent: input.subagent,
          status: input.status,
          ...(input.summary ? { summary: input.summary } : {}),
        },
      });
    });

    const emitOpenCodeTaskTransition = Effect.fn("emitOpenCodeTaskTransition")(function* (
      context: OpenCodeSessionContext,
      transition: OpenCodeTaskTransition,
      raw: unknown,
    ) {
      const nativeRef = transition.subagent;
      const existing = nativeRef.providerSessionId
        ? context.subagentBySessionId.get(nativeRef.providerSessionId)
        : undefined;
      const subagent: SubagentRef = {
        ...existing,
        ...nativeRef,
        subagentId: existing?.subagentId ?? nativeRef.subagentId,
        capability: existing?.capability === "transcript" ? "transcript" : nativeRef.capability,
        metadata: {
          ...existing?.metadata,
          ...nativeRef.metadata,
          providerInstanceId: boundInstanceId,
        },
      };
      if (subagent.providerSessionId) {
        context.childSessionIds.add(subagent.providerSessionId);
        context.subagentBySessionId.set(subagent.providerSessionId, subagent);
      }
      const key = subagentKey(subagent.subagentId);
      const base = {
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          raw,
        })),
        eventId: EventId.make(
          createHash("sha256")
            .update(
              JSON.stringify([
                context.session.threadId,
                context.openCodeSessionId,
                transition.eventKey,
              ]),
            )
            .digest("hex"),
        ),
      };
      if (transition.type === "started") {
        if (context.startedSubagentIds.has(key)) {
          // A child-session event can arrive before the Task's metadata.
          yield* emitForContext(context, {
            ...base,
            type: "subagent.updated",
            payload: { subagent, status: transition.status },
          });
        } else {
          context.startedSubagentIds.add(key);
          yield* emitForContext(context, {
            ...base,
            type: "subagent.started",
            payload: { subagent },
          });
        }
        context.completedSubagentIds.delete(key);
      } else if (transition.type === "completed") {
        context.startedSubagentIds.add(key);
        context.completedSubagentIds.add(key);
        yield* emitForContext(context, {
          ...base,
          type: "subagent.completed",
          payload: {
            subagent,
            status: transition.status as "completed" | "failed" | "stopped",
            ...(transition.summary ? { summary: transition.summary } : {}),
          },
        });
      } else {
        if (transition.status === "running" || transition.status === "starting")
          context.completedSubagentIds.delete(key);
        yield* emitForContext(context, {
          ...base,
          type: "subagent.updated",
          payload: {
            subagent,
            status: transition.status,
            ...(transition.summary ? { summary: transition.summary } : {}),
          },
        });
      }
    });

    const projectOpenCodeTask = Effect.fn("projectOpenCodeTask")(function* (
      context: OpenCodeSessionContext,
      part: Part,
    ) {
      for (const transition of context.tasks.project(part)) {
        yield* emitOpenCodeTaskTransition(context, transition, part);
      }
    });

    const loadOpenCodeTasks = Effect.fn("loadOpenCodeTasks")(function* (
      context: OpenCodeSessionContext,
    ) {
      const messages = yield* runOpenCodeSdk("session.messages", () =>
        context.client.session.messages({ sessionID: context.openCodeSessionId }),
      );
      // Reconstruct in native message order, but only publish the latest state
      // of each child. The same projector then deduplicates buffered live events.
      const latest = new Map<string, { transition: OpenCodeTaskTransition; part: Part }>();
      for (const entry of messages.data ?? []) {
        for (const part of entry.parts) {
          if (part.sessionID !== context.openCodeSessionId) continue;
          if (entry.info.role !== "assistant" && !(part.type === "text" && part.synthetic))
            continue;
          for (const transition of context.tasks.project(part)) {
            latest.set(String(transition.subagent.subagentId), { transition, part });
          }
        }
      }
      return [...latest.values()];
    });

    const emitStoppedOpenCodeChildren = Effect.fn("emitStoppedOpenCodeChildren")(function* (
      context: OpenCodeSessionContext,
      raw: unknown,
    ) {
      for (const transition of context.tasks.stop()) {
        yield* emitOpenCodeTaskTransition(context, transition, raw);
      }
      for (const subagent of context.subagentBySessionId.values()) {
        yield* emitOpenCodeSubagentCompleted(context, {
          subagent,
          status: subagentCompletionStatus("stopped"),
          raw,
        });
      }
    });

    const bindOpenCodeSubtaskPart = Effect.fn("bindOpenCodeSubtaskPart")(function* (
      context: OpenCodeSessionContext,
      part: Extract<Part, { type: "subtask" }>,
      raw: unknown,
    ) {
      const partKey = scopedOpenCodeId(part.sessionID, part.id);
      const existing = context.subagentBySubtaskPartId.get(partKey);
      const subagent = existing ?? makeSubtaskSubagentRef(part);
      context.subagentBySubtaskPartId.set(partKey, subagent);
      if (!existing && !context.unboundSubtaskPartIds.includes(partKey)) {
        context.unboundSubtaskPartIds.push(partKey);
      }
      yield* emitOpenCodeSubagentUpdated(context, {
        subagent,
        status: statusFromOpenCodeSubagentState("starting"),
        summary: nonEmptyString(part.description) ?? nonEmptyString(part.prompt),
        detail: nonEmptyString(part.prompt),
        raw,
      });
      return subagent;
    });

    const takeUnboundOpenCodeSubtask = (
      context: OpenCodeSessionContext,
    ): SubagentRef | undefined => {
      const partKey = context.unboundSubtaskPartIds.shift();
      if (!partKey) {
        return undefined;
      }
      return context.subagentBySubtaskPartId.get(partKey);
    };

    const registerOpenCodeChildSession = Effect.fn("registerOpenCodeChildSession")(function* (
      context: OpenCodeSessionContext,
      session: Session,
      raw: unknown,
    ) {
      if (
        session.parentID !== context.openCodeSessionId &&
        (session.parentID === undefined || !context.childSessionIds.has(session.parentID))
      ) {
        return undefined;
      }

      const taskRef = context.tasks.refForSession(session.id);
      const existing =
        context.subagentBySessionId.get(session.id) ??
        taskRef ??
        takeUnboundOpenCodeSubtask(context);
      const subagent = mergeOpenCodeChildSessionRef(
        existing,
        session,
        session.parentID ?? context.openCodeSessionId,
      );
      const known = context.childSessionIds.has(session.id);
      context.childSessionIds.add(session.id);
      context.subagentBySessionId.set(session.id, subagent);

      if (taskRef) return subagent;

      if (known) {
        yield* emitOpenCodeSubagentUpdated(context, {
          subagent,
          status: statusFromOpenCodeSubagentState("running"),
          raw,
        });
        return subagent;
      }

      const wasStartedFromSubtask = context.startedSubagentIds.has(
        subagentKey(subagent.subagentId),
      );
      yield* emitOpenCodeSubagentStarted(context, subagent, raw);
      if (wasStartedFromSubtask) {
        yield* emitOpenCodeSubagentUpdated(context, {
          subagent,
          status: statusFromOpenCodeSubagentState("running"),
          raw,
        });
      }
      return subagent;
    });

    const hydrateOpenCodeChildSessions = Effect.fn("hydrateOpenCodeChildSessions")(function* (
      context: OpenCodeSessionContext,
    ) {
      const children = yield* runOpenCodeSdk("session.children", () =>
        context.client.session.children({ sessionID: context.openCodeSessionId }),
      ).pipe(
        Effect.map((response): Array<Session> => {
          const value = response as unknown;
          if (Array.isArray(value)) {
            return value as Array<Session>;
          }
          const data = (value as { readonly data?: unknown }).data;
          return Array.isArray(data) ? (data as Array<Session>) : [];
        }),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Cause.squash(cause);
            yield* emitForContext(context, {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode child session hydration failed.",
                detail: OpenCodeRuntimeError.is(error)
                  ? error.detail
                  : openCodeRuntimeErrorDetail(error),
              },
            });
            return [] as Array<Session>;
          }),
        ),
      );

      for (const child of children) {
        yield* registerOpenCodeChildSession(context, child, {
          method: "session.children",
          child,
        });
      }
    });

    const isRelatedOpenCodeSession = Effect.fn("isRelatedOpenCodeSession")(function* (
      context: OpenCodeSessionContext,
      candidateSessionId: string,
    ) {
      if (
        candidateSessionId === context.openCodeSessionId ||
        context.childSessionIds.has(candidateSessionId)
      ) {
        return true;
      }

      const seen = new Set<string>();
      let sessionId: string | undefined = candidateSessionId;
      for (let depth = 0; sessionId !== undefined && depth < 32; depth += 1) {
        if (sessionId === context.openCodeSessionId || context.childSessionIds.has(sessionId)) {
          for (const relatedId of seen) {
            context.childSessionIds.add(relatedId);
          }
          return true;
        }
        if (seen.has(sessionId)) {
          return false;
        }
        seen.add(sessionId);
        const currentSessionId: string = sessionId;
        const response: { readonly data: Session | undefined } | undefined = yield* runOpenCodeSdk(
          "session.get",
          () => context.client.session.get({ sessionID: currentSessionId }),
        ).pipe(Effect.catchIf(isOpenCodeNotFound, () => Effect.succeed(undefined)));
        if (!response?.data) {
          return false;
        }
        sessionId = response.data.parentID;
      }
      return false;
    });

    const recoverPendingOpenCodeRequests = Effect.fn("recoverPendingOpenCodeRequests")(function* (
      context: OpenCodeSessionContext,
    ) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (yield* Ref.get(context.stopped)) {
          return;
        }
        const result = yield* Effect.all({
          permissions: runOpenCodeSdk("permission.list", () => context.client.permission.list()),
          questions: runOpenCodeSdk("question.list", () => context.client.question.list()),
        }).pipe(Effect.exit);
        if (Exit.isFailure(result)) {
          if (attempt === 4) {
            yield* emitForContext(context, {
              ...(yield* buildEventBase({ threadId: context.session.threadId })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode pending request recovery failed.",
                detail: openCodeRuntimeErrorDetail(Cause.squash(result.cause)),
              },
            });
            return;
          }
          yield* Effect.sleep(`${250 * 2 ** attempt} millis`);
          continue;
        }

        for (const request of result.value.permissions.data ?? []) {
          if (
            context.resolvedRequestIds.has(request.id) ||
            context.pendingPermissions.has(request.id) ||
            !(yield* isRelatedOpenCodeSession(context, request.sessionID))
          ) {
            continue;
          }
          context.pendingPermissions.set(request.id, request);
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              requestId: request.id,
              raw: { type: "permission.asked", properties: request, recovered: true },
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(request.permission),
              detail:
                request.patterns.length > 0 ? request.patterns.join("\n") : request.permission,
              args: request.metadata,
            },
          });
        }

        for (const request of result.value.questions.data ?? []) {
          if (
            context.resolvedRequestIds.has(request.id) ||
            context.pendingQuestions.has(request.id) ||
            !(yield* isRelatedOpenCodeSession(context, request.sessionID))
          ) {
            continue;
          }
          context.pendingQuestions.set(request.id, request);
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              requestId: request.id,
              raw: { type: "question.asked", properties: request, recovered: true },
            })),
            type: "user-input.requested",
            payload: { questions: normalizeQuestionRequest(request) },
          });
        }
        return;
      }
    });

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      yield* emitStoppedOpenCodeChildren(context, { reason: "transport-exit" });
      const turnId = context.activeTurnId;
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emitForContext(context, {
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emitForContext(context, {
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      sessions.delete(context.session.threadId);
      // Inline the teardown that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* Effect.forEach(
        [context.openCodeSessionId, ...context.childSessionIds],
        (sessionID) =>
          runOpenCodeSdk("session.abort", () => context.client.session.abort({ sessionID })).pipe(
            Effect.ignore({ log: true }),
          ),
        { discard: true },
      );
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /**
     * Emit content.delta and item.completed events for an assistant text part.
     * Runs for every text-part update: untraced, so it adds no span per update.
     */
    const emitAssistantTextDelta = Effect.fnUntraced(function* (
      context: OpenCodeSessionContext,
      part: Part,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) {
        return;
      }
      const partKey = scopedOpenCodeId(part.sessionID, part.id);
      if (context.parts.isTerminal(partKey)) return;
      const previousText = context.parts.emittedText(partKey);
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
      context.parts.setEmittedText(partKey, latestText);
      if (latestText !== text) {
        context.parts.set(
          (part.type === "text" || part.type === "reasoning"
            ? { ...part, text: latestText }
            : part) satisfies Part,
        );
      }
      if (deltaToEmit.length > 0) {
        const subagent = context.subagentBySessionId.get(part.sessionID);
        if (subagent) {
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
              createdAt:
                part.type === "text" || part.type === "reasoning"
                  ? isoFromEpochMs(part.time?.start)
                  : undefined,
              raw,
            })),
            type: "subagent.message.delta",
            payload: {
              subagentId: subagent.subagentId,
              delta: deltaToEmit,
              streamKind: resolveTextStreamKind(part),
              role: "assistant",
              providerSessionId: part.sessionID,
              providerThreadId: part.sessionID,
              providerMessageId: part.messageID,
            },
          });
        } else {
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
              createdAt:
                part.type === "text" || part.type === "reasoning"
                  ? isoFromEpochMs(part.time?.start)
                  : undefined,
              raw,
            })),
            type: "content.delta",
            payload: {
              streamKind: resolveTextStreamKind(part),
              delta: deltaToEmit,
            },
          });
        }
      }

      if (
        part.type === "text" &&
        part.time?.end !== undefined &&
        !context.parts.isTerminal(partKey)
      ) {
        const subagent = context.subagentBySessionId.get(part.sessionID);
        if (!subagent) {
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
              createdAt: isoFromEpochMs(part.time.end),
              raw,
            })),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(latestText.length > 0 ? { detail: latestText } : {}),
            },
          });
        }
      }
      if ((part.type === "text" || part.type === "reasoning") && part.time?.end !== undefined) {
        context.parts.complete(partKey);
      }
    });

    // Runs once per subscribed SSE event (every stream delta included):
    // untraced, so it adds no span to the trace file per event.
    const handleSubscribedEvent = Effect.fnUntraced(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      if (yield* Ref.get(context.stopped)) return;
      const payloadSessionId =
        "properties" in event ? (event.properties as { sessionID?: unknown }).sessionID : undefined;
      const eventSessionId = typeof payloadSessionId === "string" ? payloadSessionId : undefined;
      const isRootSessionEvent = eventSessionId === context.openCodeSessionId;
      const isKnownChildSessionEvent =
        eventSessionId !== undefined && context.childSessionIds.has(eventSessionId);
      const isChildSessionCreatedEvent =
        event.type === "session.created" &&
        (event.properties.info.parentID === context.openCodeSessionId ||
          (event.properties.info.parentID !== undefined &&
            context.childSessionIds.has(event.properties.info.parentID)));
      const isRelatedRequestEvent =
        eventSessionId !== undefined &&
        isOpenCodeRequestEvent(event) &&
        (yield* isRelatedOpenCodeSession(context, eventSessionId).pipe(
          Effect.orElseSucceed(() => false),
        ));
      if (
        !isRootSessionEvent &&
        !isKnownChildSessionEvent &&
        !isChildSessionCreatedEvent &&
        !isRelatedRequestEvent
      ) {
        return;
      }

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: nowIso(),
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: eventSessionId ?? context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          payload: event,
        },
      });

      switch (event.type) {
        case "session.created": {
          // A revert's fork is the next root session, never a subagent child.
          if (context.rewinding) break;
          yield* registerOpenCodeChildSession(context, event.properties.info, event);
          break;
        }

        case "todo.updated": {
          if (event.properties.sessionID !== context.openCodeSessionId) {
            break;
          }
          const plan = planStepsFromOpenCodeTodos(event.properties.todos);
          if (plan.length === 0) {
            break;
          }
          const fingerprint = JSON.stringify(plan);
          if (context.lastPlanFingerprint === fingerprint) {
            break;
          }
          context.lastPlanFingerprint = fingerprint;
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "turn.plan.updated",
            payload: { plan },
          });
          break;
        }

        case "message.updated": {
          const messageKey = scopedOpenCodeId(event.properties.sessionID, event.properties.info.id);
          const firstSeen = !context.messageRoleById.has(messageKey);
          context.messageRoleById.set(messageKey, event.properties.info.role);
          if (event.properties.info.role === "assistant") {
            if (event.properties.sessionID === context.openCodeSessionId) {
              const usage = threadTokenUsageFromOpenCodeTokens(
                event.properties.info.tokens,
                event.properties.info.id,
              );
              if (usage) {
                yield* emitForContext(context, {
                  ...(yield* buildEventBase({
                    threadId: context.session.threadId,
                    turnId,
                    raw: event,
                  })),
                  type: "thread.token-usage.updated",
                  payload: { usage },
                });
              }
            }
            for (const part of context.parts.forMessage(
              event.properties.sessionID,
              event.properties.info.id,
            )) {
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          } else {
            context.parts.releaseMessageBodies(
              event.properties.sessionID,
              event.properties.info.id,
            );
            // A new root user message: OpenCode took the pending command. An earlier turn's user
            // message is updated again later (its summary), so only a first sighting counts.
            if (firstSeen && event.properties.sessionID === context.openCodeSessionId) {
              yield* admitPendingOpenCodeCommand(context);
            }
          }
          break;
        }

        case "message.removed": {
          context.parts.removeMessage(event.properties.sessionID, event.properties.messageID);
          context.messageRoleById.delete(
            scopedOpenCodeId(event.properties.sessionID, event.properties.messageID),
          );
          break;
        }

        case "message.part.removed": {
          const partKey = scopedOpenCodeId(event.properties.sessionID, event.properties.partID);
          context.parts.complete(partKey);
          context.toolUpdates.forget(partKey);
          break;
        }

        case "message.part.delta": {
          const partKey = scopedOpenCodeId(event.properties.sessionID, event.properties.partID);
          const existingPart = context.parts.get(partKey);
          if (!existingPart) {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText =
            context.parts.emittedText(partKey) ?? textFromPart(existingPart) ?? "";
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          context.parts.setEmittedText(partKey, nextText);
          if (existingPart.type === "text" || existingPart.type === "reasoning") {
            context.parts.set({
              ...existingPart,
              text: nextText,
            });
          }
          const subagent = context.subagentBySessionId.get(event.properties.sessionID);
          if (subagent) {
            yield* emitForContext(context, {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.partID,
                raw: event,
              })),
              type: "subagent.message.delta",
              payload: {
                subagentId: subagent.subagentId,
                delta: deltaToEmit,
                streamKind,
                role: "assistant",
                providerSessionId: event.properties.sessionID,
                providerThreadId: event.properties.sessionID,
                providerMessageId: event.properties.messageID,
              },
            });
          } else {
            yield* emitForContext(context, {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.properties.partID,
                raw: event,
              })),
              type: "content.delta",
              payload: {
                streamKind,
                delta: deltaToEmit,
              },
            });
          }
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          const messageRole = messageRoleForPart(context, part);
          if (messageRole !== "user" && !context.parts.set(part)) break;
          if (part.sessionID === context.openCodeSessionId && messageRole !== "user") {
            yield* projectOpenCodeTask(context, part);
          } else if (
            part.sessionID === context.openCodeSessionId &&
            part.type === "text" &&
            part.synthetic
          ) {
            yield* projectOpenCodeTask(context, part);
          }

          if (messageRole === "assistant") {
            yield* emitAssistantTextDelta(context, part, turnId, event);
          }

          if (part.type === "subtask" && part.sessionID === context.openCodeSessionId) {
            yield* bindOpenCodeSubtaskPart(context, part, event);
          }

          if (part.type === "tool") {
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
            const detail = detailFromToolPart(part);
            const childSubagent = context.subagentBySessionId.get(part.sessionID);
            // A running part is re-sent per output chunk (bash), each time with the same
            // persisted payload: emit it only when what clients show changed, or per heartbeat.
            const terminal = part.state.status === "completed" || part.state.status === "error";
            const admitted = context.toolUpdates.admit(
              scopedOpenCodeId(part.sessionID, part.id),
              {
                terminal,
                visibleKey: terminal
                  ? undefined
                  : toolUpdateVisibleKey({
                      status: part.state.status,
                      title,
                      detail,
                      input: part.state.input,
                      agentId: childSubagent ? String(childSubagent.subagentId) : undefined,
                      turnId,
                    }),
              },
              yield* Clock.currentTimeMillis,
            );
            if (admitted && childSubagent && !context.tasks.hasSession(part.sessionID)) {
              yield* emitOpenCodeSubagentUpdated(context, {
                subagent: childSubagent,
                status: statusFromOpenCodeSubagentState("running"),
                summary: title,
                detail,
                raw: event,
              });
            }
            if (!admitted) break;
            const payload = {
              itemType,
              ...(childSubagent ? { agentId: String(childSubagent.subagentId) } : {}),
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload,
            };
            yield* emitForContext(context, runtimeEvent);
          }
          break;
        }

        case "permission.asked": {
          if (
            context.resolvedRequestIds.has(event.properties.id) ||
            context.pendingPermissions.has(event.properties.id)
          ) {
            break;
          }
          context.pendingPermissions.set(event.properties.id, event.properties);
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(event.properties.permission),
              detail:
                event.properties.patterns.length > 0
                  ? event.properties.patterns.join("\n")
                  : event.properties.permission,
              args: event.properties.metadata,
            },
          });
          break;
        }

        case "permission.replied": {
          const permissionRequest = context.pendingPermissions.get(event.properties.requestID);
          context.resolvedRequestIds.add(event.properties.requestID);
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: permissionRequest
                ? mapPermissionToRequestType(permissionRequest.permission)
                : "unknown",
              decision: mapPermissionDecision(event.properties.reply),
            },
          });
          break;
        }

        case "question.asked": {
          if (
            context.resolvedRequestIds.has(event.properties.id) ||
            context.pendingQuestions.has(event.properties.id)
          ) {
            break;
          }
          context.pendingQuestions.set(event.properties.id, event.properties);
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "user-input.requested",
            payload: {
              questions: normalizeQuestionRequest(event.properties),
            },
          });
          break;
        }

        case "question.replied": {
          context.resolvedRequestIds.add(event.properties.requestID);
          const request = context.pendingQuestions.get(event.properties.requestID);
          context.pendingQuestions.delete(event.properties.requestID);
          const answers = Object.fromEntries(
            (request?.questions ?? []).map((question, index) => [
              openCodeQuestionId(index, question),
              event.properties.answers[index]?.join(", ") ?? "",
            ]),
          );
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers },
          });
          break;
        }

        case "question.rejected": {
          context.resolvedRequestIds.add(event.properties.requestID);
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
          break;
        }

        case "session.status": {
          if (context.tasks.hasSession(event.properties.sessionID)) break;
          const childSubagent = context.subagentBySessionId.get(event.properties.sessionID);
          if (childSubagent) {
            if (event.properties.status.type === "idle") {
              yield* emitOpenCodeSubagentCompleted(context, {
                subagent: childSubagent,
                status: subagentCompletionStatus("completed"),
                raw: event,
              });
              break;
            }
            yield* emitOpenCodeSubagentUpdated(context, {
              subagent: childSubagent,
              status: statusFromOpenCodeSubagentState("running"),
              ...(event.properties.status.type === "retry"
                ? { detail: event.properties.status.message }
                : {}),
              raw: event,
            });
            break;
          }

          if (event.properties.status.type === "busy") {
            context.lastRetryKey = undefined;
            updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
            yield* admitPendingOpenCodeCommand(context);
          }

          if (event.properties.status.type === "retry") {
            // OpenCode re-emits the retry status while backing off; only
            // surface a warning when the attempt/message actually changes.
            const retryKey = `${event.properties.status.attempt}:${event.properties.status.message}`;
            if (context.lastRetryKey !== retryKey) {
              context.lastRetryKey = retryKey;
              yield* emitForContext(context, {
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                })),
                type: "runtime.warning",
                payload: {
                  message: event.properties.status.message,
                  detail: event.properties.status,
                },
              });
            }
            break;
          }

          if (event.properties.status.type === "idle" && !turnId) {
            // A generation no turn tracks went busy, for example a command OpenCode started after
            // its turn ended: its idle hands the session back.
            if (context.session.status === "running") {
              updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            }
            break;
          }

          if (event.properties.status.type === "idle" && turnId) {
            context.lastRetryKey = undefined;
            if (context.pendingPrompt?.turnId === turnId) {
              context.pendingPrompt.idleEvent = event;
              break;
            }
            if (context.computerLease && context.activeTurnId)
              yield* context.computerLease.retireTurn(context.activeTurnId);
            context.activeTurnId = undefined;
            context.activeAgent = undefined;
            context.activeVariant = undefined;
            updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emitForContext(context, {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "completed",
              },
            });
          }
          break;
        }

        case "session.idle": {
          if (context.tasks.hasSession(event.properties.sessionID)) break;
          const childSubagent = context.subagentBySessionId.get(event.properties.sessionID);
          if (childSubagent) {
            yield* emitOpenCodeSubagentCompleted(context, {
              subagent: childSubagent,
              status: subagentCompletionStatus("completed"),
              raw: event,
            });
          }
          break;
        }

        case "session.error": {
          if (event.properties.sessionID && context.tasks.hasSession(event.properties.sessionID))
            break;
          const message = sessionErrorMessage(event.properties.error);
          const childSubagent =
            event.properties.sessionID !== undefined
              ? context.subagentBySessionId.get(event.properties.sessionID)
              : undefined;
          if (childSubagent) {
            yield* emitOpenCodeSubagentCompleted(context, {
              subagent: childSubagent,
              status: subagentCompletionStatus("failed"),
              summary: message,
              raw: event,
            });
            break;
          }
          const activeTurnId = context.activeTurnId;
          const pendingPrompt = context.pendingPrompt;
          if (pendingPrompt && pendingPrompt.turnId === activeTurnId) {
            context.pendingPrompt = undefined;
            yield* Fiber.interrupt(pendingPrompt.fiber).pipe(Effect.ignore);
          }
          if (context.computerLease && context.activeTurnId)
            yield* context.computerLease.retireTurn(context.activeTurnId);
          context.activeTurnId = undefined;
          context.activeAgent = undefined;
          context.activeVariant = undefined;
          updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emitForContext(context, {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
          }
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const prepareEventSubscription = Effect.fn("prepareEventSubscription")(function* (
      context: OpenCodeSessionContext,
    ) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      const subscription = yield* runOpenCodeSdk("event.subscribe", () =>
        context.client.event.subscribe(undefined, { signal: eventsAbortController.signal }),
      );
      // The SDK returns a lazy async generator: subscribe() alone does not
      // open HTTP. Prime it before reading history so intervening SSE updates
      // stay buffered on the established connection instead of being lost.
      const iterator = subscription.stream[Symbol.asyncIterator]();
      const first = yield* runOpenCodeSdk("event.subscribe", () => iterator.next()).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: "Timed out opening OpenCode event stream.",
              }),
            ),
        }),
      );
      const stream = (async function* () {
        try {
          if (!first.done) yield first.value;
          if (first.done) return;
          while (true) {
            const next = await iterator.next();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          await iterator.return?.();
        }
      })();
      return { subscription: { stream }, eventsAbortController };
    });

    const startEventPump = Effect.fn("startEventPump")(function* (
      context: OpenCodeSessionContext,
      prepared: Effect.Success<ReturnType<typeof prepareEventSubscription>>,
    ) {
      const { subscription, eventsAbortController } = prepared;
      yield* Stream.fromAsyncIterable(
        subscription.stream,
        (cause) =>
          new OpenCodeRuntimeError({
            operation: "event.subscribe",
            detail: openCodeRuntimeErrorDetail(cause),
            cause,
          }),
      )
        .pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event)))
        .pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              // Expected paths: caller aborted the fetch or the session
              // has already been marked stopped. Treat as a clean exit.
              if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
                return;
              }
              if (Exit.isFailure(exit)) {
                yield* emitUnexpectedExit(
                  context,
                  openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
                );
              }
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
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
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const computerRequested = computerTurnPlan(input.threadId) !== undefined;
        if (computerRequested && serverUrl)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue:
              "Computer Use needs a managed, isolated OpenCode server. External OpenCode servers cannot receive local desktop authority.",
          });
        const directory = input.cwd ?? serverConfig.cwd;
        const resume =
          input.resumePolicy === "fresh" ? undefined : parseOpenCodeResume(input.resumeCursor);
        const resumeSessionId = resume?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          if (existing.session.runtimeSessionId === runtimeSessionId) {
            return existing.session;
          }
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Thread '${input.threadId}' still has runtime '${existing.session.runtimeSessionId ?? "legacy"}'; stop it before starting '${runtimeSessionId}'.`,
          });
        }

        let deviceToolContext: OpenCodeSessionContext | undefined;
        const deviceToolBinding = createProcessDeviceToolBinding({
          threadId: input.threadId,
          isTurnActive: () =>
            deviceToolContext?.activeTurnId !== undefined &&
            deviceToolContext.session.status !== "closed",
        });
        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          if (deviceToolBinding) {
            yield* Scope.addFinalizer(
              sessionScope,
              Effect.sync(() => deviceToolBinding.dispose()),
            );
          }
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const computerLeaseOption = computerRequested
                ? yield* installAgentControlNativeHttp(options?.agentControl, {
                    threadId: input.threadId,
                    providerInstanceId: boundInstanceId,
                    runtimeSessionId,
                    injectionMode: "opencode-http",
                    computerOnly: true,
                  })
                : Option.none();
              const computerLease = Option.getOrUndefined(computerLeaseOption);
              if (computerLease) yield* computerLease.addScopeFinalizer(sessionScope);
              const server =
                options?.serverOwner && !computerLease
                  ? yield* options.serverOwner.acquire.pipe(
                      Effect.map((process) => ({
                        url: process.url,
                        ...(process.serverPassword
                          ? { serverPassword: process.serverPassword }
                          : {}),
                        exitCode: process.exitCode,
                        external: false,
                      })),
                    )
                  : yield* openCodeRuntime.connectToOpenCodeServer({
                      binaryPath,
                      serverUrl,
                      ...(serverPassword ? { serverPassword } : {}),
                      ...(options?.environment ? { environment: options.environment } : {}),
                      ...(options?.processPriority
                        ? { processPriority: options.processPriority }
                        : {}),
                    });
              const client = yield* openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
              });
              yield* verifyOpenCodeServerVersion(client);
              if (computerLease)
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
                    directory,
                    name: "ryco_computer",
                    config: {
                      type: "remote",
                      url: computerLease.mcpServer.url,
                      headers: { ...computerLease.mcpServer.headers },
                      oauth: false,
                      enabled: true,
                    },
                  }),
                );
              if (deviceToolBinding) {
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
                    directory,
                    name: `ryco_device_${runtimeSessionId}`,
                    config: {
                      type: "remote",
                      url: deviceToolBinding.url,
                      headers: { ...deviceToolBinding.headers },
                      oauth: false,
                      enabled: true,
                    },
                  }),
                );
              }
              // A session OpenCode no longer has fails the start in words the orchestrator
              // recognizes (`isMissingConversationError`), so it starts fresh or carries the
              // conversation over by context handoff instead of a silent new session.
              const adoptedSession = resumeSessionId
                ? yield* runOpenCodeSdk("session.get", () =>
                    client.session.get({ sessionID: resumeSessionId }),
                  ).pipe(
                    Effect.map((response) => response.data),
                    Effect.mapError((error) =>
                      isOpenCodeNotFound(error)
                        ? new OpenCodeRuntimeError({
                            operation: "session.get",
                            detail: `Session not found: ${resumeSessionId} (${error.detail})`,
                            cause: error.cause,
                          })
                        : error,
                    ),
                  )
                : undefined;
              if (adoptedSession) {
                yield* runOpenCodeSdk("session.update", () =>
                  client.session.update({
                    sessionID: adoptedSession.id,
                    permission: buildOpenCodePermissionRules(input.runtimeMode),
                  }),
                );
              }
              const openCodeSession = adoptedSession
                ? { data: adoptedSession }
                : yield* runOpenCodeSdk("session.create", () =>
                    client.session.create({
                      title: `Ryco ${input.threadId}`,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
              if (!openCodeSession.data) {
                return yield* new OpenCodeRuntimeError({
                  operation: adoptedSession ? "session.get" : "session.create",
                  detail: adoptedSession
                    ? "OpenCode session.get returned no session payload."
                    : "OpenCode session.create returned no session payload.",
                });
              }
              return {
                sessionScope,
                server,
                client,
                ...(computerLease ? { computerLease } : {}),
                openCodeSession: openCodeSession.data,
                adopted: adoptedSession !== undefined,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        const createdAt = nowIso();
        const tokenMode = input.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE;
        // Only the resumed session carries the forks recorded against it.
        const forgottenTurnIds =
          resume !== undefined && resume.sessionId === started.openCodeSession.id
            ? resume.forgottenTurnIds
            : [];
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          runtimeSessionId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          tokenMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          resumeCursor: openCodeResumeCursor(started.openCodeSession.id, forgottenTurnIds),
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          ...(started.computerLease ? { computerLease: started.computerLease } : {}),
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          forgottenTurnIds,
          rewinding: false,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          resolvedRequestIds: new Set(),
          parts: new OpenCodePartIndex(),
          messageRoleById: new Map(),
          childSessionIds: new Set(),
          subagentBySessionId: new Map(),
          subagentBySubtaskPartId: new Map(),
          unboundSubtaskPartIds: [],
          startedSubagentIds: new Set(),
          completedSubagentIds: new Set(),
          tasks: new OpenCodeTaskLifecycle(),
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          lastPlanFingerprint: undefined,
          lastRetryKey: undefined,
          toolUpdates: new ToolUpdateGate(),
          promptSemaphore: yield* Semaphore.make(1),
          pendingPrompt: undefined,
          pendingCommand: undefined,
          promptGeneration: 0,
          agentControlHostContextDelivered: false,
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        const prepared = yield* Effect.exit(prepareEventSubscription(context));
        if (Exit.isFailure(prepared)) {
          if (!started.adopted) {
            yield* runOpenCodeSdk("session.abort", () =>
              started.client.session.abort({ sessionID: started.openCodeSession.id }),
            ).pipe(Effect.ignore);
          }
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return yield* toProcessError(input.threadId, Cause.squash(prepared.cause));
        }
        const storedTasks = started.adopted
          ? yield* loadOpenCodeTasks(context).pipe(
              Effect.catch((error) =>
                Effect.logWarning("OpenCode Task history reconstruction failed", error).pipe(
                  Effect.as([]),
                ),
              ),
            )
          : [];
        // Recheck after subscription and history awaits; a reused native session
        // belongs to the winner and must never be aborted by a losing startup.
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          if (!started.adopted) {
            yield* runOpenCodeSdk("session.abort", () =>
              started.client.session.abort({ sessionID: started.openCodeSession.id }),
            ).pipe(Effect.ignore);
          }
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }
        deviceToolContext = context;
        sessions.set(input.threadId, context);

        yield* emitForContext(context, {
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emitForContext(context, {
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });
        for (const { transition, part } of storedTasks) {
          yield* emitOpenCodeTaskTransition(context, transition, part);
        }
        yield* startEventPump(context, prepared.value);
        yield* Effect.gen(function* () {
          yield* hydrateOpenCodeChildSessions(context);
          yield* recoverPendingOpenCodeRequests(context);
        }).pipe(Effect.forkIn(context.sessionScope));

        return session;
      },
    );

    /**
     * Ends a turn OpenCode never started: the session is ready again with the error, and the turn
     * is aborted. A no-op once something else settled the turn.
     */
    const abortUnstartedOpenCodeTurn = Effect.fn("abortUnstartedOpenCodeTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      reason: string,
    ) {
      if (context.activeTurnId !== turnId) return;
      if (context.computerLease) yield* context.computerLease.retireTurn(turnId);
      context.activeTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      updateProviderSession(
        context,
        { status: "ready", lastError: reason },
        { clearActiveTurnId: true },
      );
      yield* emitForContext(context, {
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "turn.aborted",
        payload: { reason },
      });
    });

    /**
     * Runs one of OpenCode's commands and returns once OpenCode took it (`PendingOpenCodeCommand`).
     * `session.command` answers only when the generation ends, so the call keeps running in the
     * session scope. Failing before admission fails the send. After it, only an answer from
     * OpenCode counts: a refusal before the turn started aborts the turn, a failure of a started
     * turn is a warning (OpenCode's idle and error events settle it), and a call that ends with no
     * response says nothing about the command, which OpenCode keeps running.
     */
    const submitOpenCodeCommand = Effect.fn("submitOpenCodeCommand")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      request: Parameters<OpencodeClient["session"]["command"]>[0],
    ) {
      const admitted = yield* Deferred.make<void, ProviderAdapterRequestError>();
      const pending: PendingOpenCodeCommand = {
        turnId,
        admitted,
        started: false,
        fiber: undefined,
      };
      context.pendingCommand = pending;
      const fiber = yield* runOpenCodeSdk("session.command", (signal) =>
        context.client.session.command(request, { signal }),
      ).pipe(
        Effect.matchEffect({
          onSuccess: () => Deferred.succeed(admitted, undefined),
          onFailure: (error) =>
            Effect.gen(function* () {
              // `fail` loses to an earlier admission: the command was accepted.
              if (
                (yield* Deferred.fail(admitted, toRequestError(error))) ||
                context.activeTurnId !== turnId
              ) {
                return;
              }
              // Node's fetch gives up on a response after 5 minutes, and `session.command`
              // answers only when the generation ends: a long command outlives its request.
              if (openCodeResponseStatus(error) === undefined) {
                return yield* Effect.logDebug(
                  `OpenCode /${request.command} call ended without a response`,
                  error.detail,
                );
              }
              if (!pending.started) {
                return yield* abortUnstartedOpenCodeTurn(context, turnId, error.detail);
              }
              yield* emitForContext(context, {
                ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
                type: "runtime.warning",
                payload: {
                  message: `OpenCode /${request.command} failed after it was accepted.`,
                  detail: error.detail,
                },
              });
            }),
        }),
        Effect.onInterrupt(() => Deferred.interrupt(admitted)),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.pendingCommand === pending) context.pendingCommand = undefined;
          }),
        ),
        Effect.asVoid,
        Effect.forkIn(context.sessionScope),
      );
      pending.fiber = fiber;
      // Still pending at the bound: OpenCode holds the command, most likely resolving its
      // template. Aborting the request would not stop it, so the turn runs and events settle it.
      yield* Deferred.await(admitted).pipe(
        Effect.timeoutOrElse({
          duration: OPENCODE_COMMAND_ADMISSION_TIMEOUT,
          orElse: () =>
            Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Deferred.await(admitted))),
        }),
      );
    });

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId);
      return yield* context.promptSemaphore.withPermits(1)(
        Effect.gen(function* () {
          // The session can close while this send waits behind an earlier prompt.
          if (sessions.get(input.threadId) !== context || (yield* Ref.get(context.stopped))) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }

          const turnId = TurnId.make(
            `opencode-turn-${yield* Effect.sync(() => crypto.randomUUID())}`,
          );
          const modelSelection =
            input.modelSelection ??
            (context.session.model
              ? { instanceId: boundInstanceId, model: context.session.model }
              : undefined);
          if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
            });
          }
          const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
          if (!parsedModel) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "OpenCode model selection must use the 'provider/model' format.",
            });
          }

          // OpenCode 1.x's `promptAsync` hands `/name` to the model as text: only
          // `session.command` runs one of OpenCode's own commands.
          const commandLookup = yield* findOpenCodeCommand(context, input.input);
          const command = commandLookup.command;
          const formatted = formatSourceControlContextsForAgent(input.sourceControlContexts ?? []);
          // A command's text is its arguments, which OpenCode substitutes into the template; the
          // source-control contexts and attachment paths follow them.
          let text =
            command !== undefined
              ? [command.arguments, formatted].filter((part) => part.length > 0).join("\n\n")
              : formatted
                ? formatted + "\n\n" + (input.input?.trim() ?? "")
                : input.input?.trim();
          const attachmentUrlById = new Map<string, string>();
          const declaredAttachmentBytes = (input.attachments ?? []).reduce(
            (total, attachment) => total + (attachment.sizeBytes ?? 0),
            0,
          );
          if (declaredAttachmentBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.prompt",
              detail: `Attachments total ${declaredAttachmentBytes} bytes; limit is ${PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
            });
          }
          let attachmentTotalBytes = 0;
          for (const attachment of input.attachments ?? []) {
            if (!isOpenCodeNativeAttachment(attachment)) {
              continue;
            }
            const persisted = yield* Effect.promise(() =>
              readPersistedAttachment({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              }),
            );
            if (!persisted.ok) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.prompt",
                detail: persisted.reason,
              });
            }
            attachmentUrlById.set(
              attachment.id,
              `data:${attachment.mimeType};base64,${persisted.bytes.toString("base64")}`,
            );
            attachmentTotalBytes += persisted.sizeBytes;
            if (attachmentTotalBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.prompt",
                detail: `Attachments total ${attachmentTotalBytes} bytes; limit is ${PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
              });
            }
          }
          text = appendAttachmentPathLines(
            text,
            attachmentPathLines({
              attachmentsDir: serverConfig.attachmentsDir,
              attachments: input.attachments,
            }),
          );
          const fileParts = toOpenCodeFileParts({
            attachments: input.attachments,
            resolveAttachmentUrl: (attachment) =>
              attachment.id === undefined ? null : (attachmentUrlById.get(attachment.id) ?? null),
          });
          if (command === undefined && (!text || text.length === 0) && fileParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "OpenCode turns require text input or at least one attachment.",
            });
          }
          // A command reaches OpenCode as itself: the context waits for the next ordinary turn.
          if (command === undefined && !context.agentControlHostContextDelivered) {
            text = `<ryco_host_context>${context.computerLease ? "Computer Use tools are available through the private ryco_computer MCP server for this task. Start with computer_help and computer_inspect." : agentControlHostContext(false)}</ryco_host_context>${text ? `\n\n${text}` : ""}`;
            context.agentControlHostContextDelivered = true;
          }

          const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
          const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

          if (context.computerLease) yield* context.computerLease.bindTurn(turnId);
          context.activeTurnId = turnId;
          // OpenCode has no dedicated ask agent; its "plan" agent is the
          // read-only equivalent, so both plan and ask map onto it.
          context.activeAgent =
            agent ??
            (input.interactionMode === "plan" || input.interactionMode === "ask"
              ? "plan"
              : undefined);
          context.activeVariant = variant;
          updateProviderSession(
            context,
            {
              status: "running",
              activeTurnId: turnId,
              model: modelSelection?.model ?? context.session.model,
            },
            { clearLastError: true },
          );

          yield* emitForContext(context, {
            ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
            type: "turn.started",
            payload: {
              model: modelSelection?.model ?? context.session.model,
              ...(variant ? { effort: variant } : {}),
            },
          });
          if (commandLookup.unchecked !== undefined) {
            yield* emitForContext(context, {
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "runtime.warning",
              payload: {
                message: `Couldn't check whether /${commandLookup.unchecked.name} is an OpenCode command, so it went to the model as a prompt.`,
                detail: commandLookup.unchecked.detail,
              },
            });
          }

          context.promptGeneration += 1;
          const generation = context.promptGeneration;
          const submission: Effect.Effect<unknown, ProviderAdapterRequestError> =
            command !== undefined
              ? submitOpenCodeCommand(context, turnId, {
                  sessionID: context.openCodeSessionId,
                  command: command.name,
                  arguments: text ?? "",
                  model: `${parsedModel.providerID}/${parsedModel.modelID}`,
                  ...(context.activeAgent ? { agent: context.activeAgent } : {}),
                  ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                  ...(fileParts.length > 0 ? { parts: fileParts } : {}),
                })
              : runOpenCodeSdk("session.promptAsync", (signal) =>
                  context.client.session.promptAsync(
                    {
                      sessionID: context.openCodeSessionId,
                      model: parsedModel,
                      ...(context.activeAgent ? { agent: context.activeAgent } : {}),
                      ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                      parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
                    },
                    { signal },
                  ),
                ).pipe(Effect.mapError(toRequestError));
          const promptEffect = submission.pipe(
            Effect.tapError((requestError) =>
              context.promptGeneration === generation
                ? abortUnstartedOpenCodeTurn(context, turnId, requestError.detail)
                : Effect.void,
            ),
          );
          const promptFiber = yield* promptEffect.pipe(Effect.forkIn(context.sessionScope));
          const pendingPrompt: NonNullable<OpenCodeSessionContext["pendingPrompt"]> = {
            turnId,
            fiber: promptFiber,
          };
          context.pendingPrompt = pendingPrompt;
          yield* Fiber.join(promptFiber).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (context.pendingPrompt?.fiber === promptFiber) {
                  context.pendingPrompt = undefined;
                }
              }),
            ),
          );

          const completedDuringAdmission = pendingPrompt.idleEvent !== undefined;
          if (completedDuringAdmission && context.activeTurnId === turnId) {
            if (context.computerLease && context.activeTurnId)
              yield* context.computerLease.retireTurn(context.activeTurnId);
            context.activeTurnId = undefined;
            context.activeAgent = undefined;
            context.activeVariant = undefined;
            updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emitForContext(context, {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: pendingPrompt.idleEvent,
              })),
              type: "turn.completed",
              payload: { state: "completed" },
            });
          }

          if (
            sessions.get(input.threadId) !== context ||
            (yield* Ref.get(context.stopped)) ||
            (!completedDuringAdmission && context.activeTurnId !== turnId) ||
            context.promptGeneration !== generation
          ) {
            return yield* Effect.interrupt;
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: context.session.resumeCursor,
          };
        }),
      );
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId);
        const interruptedTurnId = turnId ?? context.activeTurnId;
        if (
          turnId !== undefined &&
          context.activeTurnId !== undefined &&
          turnId !== context.activeTurnId
        ) {
          return;
        }
        yield* emitStoppedOpenCodeChildren(context, {
          method: "session.abort",
          reason: "turn-interrupted",
        });
        const pendingPrompt = context.pendingPrompt;
        if (pendingPrompt && pendingPrompt.turnId === interruptedTurnId) {
          context.pendingPrompt = undefined;
          yield* Fiber.interrupt(pendingPrompt.fiber).pipe(Effect.ignore);
        }
        yield* interruptPendingOpenCodeCommand(context, interruptedTurnId).pipe(Effect.ignore);

        const rootAbortExit = yield* abortOpenCodeSession(context, context.openCodeSessionId).pipe(
          Effect.mapError(toRequestError),
          Effect.exit,
        );
        yield* Effect.forEach(
          context.childSessionIds,
          (sessionID) =>
            abortOpenCodeSession(context, sessionID).pipe(Effect.ignore({ log: true })),
          { discard: true },
        );
        if (Exit.isFailure(rootAbortExit)) {
          return yield* Effect.failCause(rootAbortExit.cause);
        }
        if (interruptedTurnId) {
          if (context.activeTurnId === interruptedTurnId) {
            if (context.computerLease && context.activeTurnId)
              yield* context.computerLease.retireTurn(context.activeTurnId);
            context.activeTurnId = undefined;
            context.activeAgent = undefined;
            context.activeVariant = undefined;
            updateProviderSession(
              context,
              { status: "ready" },
              { clearActiveTurnId: true, clearLastError: true },
            );
          }
          yield* emitForContext(context, {
            ...(yield* buildEventBase({
              threadId,
              turnId: interruptedTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = ensureSessionContext(sessions, threadId);
      const request = context.pendingPermissions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.respond",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.respond", () =>
        context.client.permission.respond({
          sessionID: request.sessionID,
          permissionID: requestId,
          response: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("question.reply", () =>
        context.client.question.reply({
          requestID: requestId,
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context);
        if (!stopped) {
          return;
        }
        yield* emitStoppedOpenCodeChildren(context, {
          method: "session.abort",
          reason: "session-stopped",
        });
        yield* emitForContext(context, {
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
        sessions.delete(threadId);
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns = (messages.data ?? [])
          .filter((entry) => entry.info.role === "assistant")
          .map((entry) => ({
            id: TurnId.make(entry.info.id),
            items: [entry.info, ...entry.parts],
          }));

        return {
          threadId,
          turns,
        };
      },
    );

    /**
     * Makes OpenCode forget the newest turns by forking the root session just
     * before the first dropped user message and rebinding the thread to the
     * fork. OpenCode's boundary is exclusive, and unlike 1.x `session.revert`
     * a fork never touches files. The old session is kept for audit.
     */
    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, { numTurns, droppedTurnIds }) {
        const context = ensureSessionContext(sessions, threadId);
        const refuse = (detail: string) =>
          new ProviderAdapterRequestError({ provider: PROVIDER, method: "session.fork", detail });
        if (context.activeTurnId !== undefined || context.pendingPrompt !== undefined) {
          return yield* refuse("An OpenCode turn is still running.");
        }
        if (context.rewinding) {
          return yield* refuse("OpenCode is already rewinding this thread.");
        }
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* refuse("numTurns must be an integer >= 1.");
        }
        // A retried revert whose earlier fork landed: OpenCode already lacks
        // those turns, so counting them again would drop kept turns.
        const dropped = new Set<string>(droppedTurnIds);
        const forgotten = new Set(context.forgottenTurnIds);
        const alreadyForgotten = droppedTurnIds.filter((turnId) => forgotten.has(turnId)).length;
        if (
          alreadyForgotten > 0 &&
          (context.forgottenTurnIds.some((turnId) => !dropped.has(turnId)) ||
            alreadyForgotten > numTurns)
        ) {
          return yield* refuse(
            "An earlier revert that did not finish already removed turns this revert would keep. Revert to that checkpoint or an earlier one, or start a new thread.",
          );
        }
        const remainingTurns = numTurns - alreadyForgotten;
        if (remainingTurns === 0) {
          return yield* readThread(threadId);
        }
        const rootSessionId = context.openCodeSessionId;
        const messages =
          (yield* runOpenCodeSdk("session.messages", () =>
            context.client.session.messages({ sessionID: rootSessionId }),
          ).pipe(Effect.mapError(toRequestError))).data ?? [];
        // One root user message per Ryco turn. OpenCode adds user messages of its own made only of
        // synthetic text (a finished background Task's report); Ryco never sends synthetic text.
        const users = messages.filter(
          (entry) =>
            entry.info.role === "user" &&
            !(
              entry.parts.length > 0 &&
              entry.parts.every((part) => part.type === "text" && part.synthetic === true)
            ),
        );
        if (remainingTurns > users.length) {
          return yield* refuse(
            "OpenCode's conversation is shorter than this thread's history; it may already be reverted.",
          );
        }
        const boundary = users[users.length - remainingTurns]!;
        const boundaryIndex = messages.indexOf(boundary);

        context.rewinding = true;
        return yield* Effect.gen(function* () {
          const forked = yield* runOpenCodeSdk("session.fork", () =>
            context.client.session.fork({ sessionID: rootSessionId, messageID: boundary.info.id }),
          ).pipe(Effect.mapError(toRequestError));
          const fork = forked.data;
          if (!fork) return yield* refuse("OpenCode session.fork returned no session.");
          const retained =
            (yield* runOpenCodeSdk("session.messages", () =>
              context.client.session.messages({ sessionID: fork.id }),
            ).pipe(Effect.mapError(toRequestError))).data ?? [];
          if (retained.length !== boundaryIndex) {
            return yield* refuse("OpenCode did not preserve the requested rewind boundary.");
          }
          // Security: the fork must carry this thread's rules, never inherit looser ones.
          yield* runOpenCodeSdk("session.update", () =>
            context.client.session.update({
              sessionID: fork.id,
              permission: buildOpenCodePermissionRules(context.session.runtimeMode),
            }),
          ).pipe(Effect.mapError(toRequestError));

          context.openCodeSessionId = fork.id;
          context.forgottenTurnIds = [...droppedTurnIds];
          context.childSessionIds.clear();
          // The host context rides on the first prompt; a fork before it loses it.
          if (boundaryIndex === 0) context.agentControlHostContextDelivered = false;
          context.session = {
            ...context.session,
            resumeCursor: openCodeResumeCursor(fork.id, context.forgottenTurnIds),
            updatedAt: nowIso(),
          };
          return yield* readThread(threadId);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              context.rewinding = false;
            }),
          ),
        );
      },
    );

    /**
     * OpenCode's commands in `cwd`, read from its server without a session. The first read may
     * start the shared `opencode serve`, as Claude's per-directory probe spawns its CLI; the
     * owner keeps it for a while after the lease. No machine-level list: the provider probe runs
     * in the server's own directory, whose project commands would show in every project.
     */
    const readProjectCommands: NonNullable<OpenCodeAdapterShape["readProjectCommands"]> = (cwd) =>
      openCodeSettings.enabled
        ? Effect.gen(function* () {
            const server = options?.serverOwner
              ? yield* options.serverOwner.acquire
              : yield* openCodeRuntime.connectToOpenCodeServer({
                  binaryPath: openCodeSettings.binaryPath,
                  serverUrl: openCodeSettings.serverUrl,
                  ...(openCodeSettings.serverPassword
                    ? { serverPassword: openCodeSettings.serverPassword }
                    : {}),
                  ...(options?.environment ? { environment: options.environment } : {}),
                });
            const client = yield* openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: cwd,
              ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
            });
            // A 2.x server converts the shared OpenCode database in place: never talk to one.
            yield* verifyOpenCodeServerVersion(client);
            const listed = yield* runOpenCodeSdk("command.list", (signal) =>
              client.command.list({ directory: cwd }, { signal }),
            );
            return {
              skills: [],
              slashCommands: openCodeCommandsToSlashCommands(listed.data ?? []),
            } satisfies ProviderProjectCommands;
          }).pipe(Effect.scoped, Effect.mapError(toRequestError))
        : Effect.succeed(EMPTY_PROJECT_COMMANDS);

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: "native",
        // A steer stops the turn and sends the message next (ProviderService).
        turnSteering: "interrupt-restart",
        // Unverified: OpenCode scopes sessions to a project directory.
        resumeSurvivesCwdChange: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      readProjectCommands,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents).pipe(
          Stream.tap(() => runtimeEventQueueMetrics.recordDequeued()),
        );
      },
    } satisfies OpenCodeAdapterShape;
  });
}
