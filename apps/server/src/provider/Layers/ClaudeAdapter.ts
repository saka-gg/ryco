import { claudeApprovalPresentation } from "../claudeApprovalPresentation.ts";
import { claudeInitAdvertisesNativeCompaction } from "../claudeNativeCompaction.ts";
import { readClaudeResumeState } from "../claudeResumeCursor.ts";
import { prepareClaudeCodeSpawn } from "../claudeCodeSpawn.ts";
import { observeClaudeCache } from "../claudeCacheObservation.ts";
import { claudePostCompactionUsage } from "../claudeContextUsage.ts";
import {
  decideClaudeFastModePublish,
  readClaudeFastModeFrame,
} from "../claudeFastModeObservation.ts";
import {
  CLAUDE_CLI_CAPABILITY_INTERRUPT_CANCEL_QUEUED,
  CLAUDE_CLI_CAPABILITY_INTERRUPT_RECEIPT,
  claudeEchoNamesTurn,
  claudeEchoedPromptUuids,
  claudeResultBelongsToTurn,
  classifyClaudeResultKind,
  decideClaudeStop,
  decideClaudeTurnClose,
  decideClaudeTurnResult,
  isClaudeApiErrorReply,
  isClaudeRootTurnFrame,
  parseClaudeCliCapabilities,
  readClaudeInterruptReceipt,
  rememberDiscardedSteer,
  type ClaudeTurnClose,
} from "../claudeSteering.ts";
import {
  CLAUDE_PROVIDER_TURN_STOP_GRACE_MS,
  CLAUDE_WAKE_TURN_FIRST_OUTPUT_TIMEOUT_MS,
  claudeWakeSignal,
  isClaudeRootTurnOutput,
  shouldOpenClaudeWakeTurn,
} from "../claudeWakeTurn.ts";
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  getSessionMessages,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@ryco/shared/cliArgs";
import { normalizePromptSuggestion } from "@ryco/shared/promptSuggestion";
import {
  parseClaudeAutoCompactWindow,
  resolveClaudeAutoCompactMode,
} from "@ryco/shared/claudeAutoCompact";
import {
  ApprovalRequestId,
  type ClaudeSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  PROMPT_SUGGESTION_MAX_CHARS,
  type RuntimeErrorClass,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimePlanStep,
  DEFAULT_AGENT_TOKEN_MODE,
  RuntimeTaskId,
  type RuntimeSubagentStatus,
  type SubagentRef,
  type TaskRunHandles,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@ryco/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@ryco/shared/model";
import { classifyTaskAgentKind } from "@ryco/shared/taskClassification";
import { timeoutWhileResponsiveOption } from "@ryco/shared/responsiveDeadline";
import { NATIVE_COMPACTION_COMMAND } from "@ryco/shared/threadActivity";
import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Queue,
  Ref,
  Semaphore,
  Stream,
} from "effect";

import { ServerConfig } from "../../config.ts";
import { logOnceEvery } from "../../logOnceEvery.ts";
import { makeServerQueueMetrics } from "../../observability/QueueMetrics.ts";
import {
  concludeContextCompactionRequest,
  disableContextCompaction,
  initialContextCompactionPolicyState,
  markContextCompactionStarted,
  nativeAutoCompactWindowBehindTrigger,
  observeContextCompaction,
  recordContextCompactionRequest,
  settleContextCompaction,
} from "../contextCompactionPolicy.ts";
import { createProcessDeviceToolBinding } from "../../providerTools/deviceToolGateway.ts";
import { makeClaudeEnvironment, resolveClaudeSourceRoot } from "../Drivers/ClaudeHome.ts";
import {
  type ClaudeChainPositionBeforePrompt,
  claudeEntryBeforePrompt,
} from "../claudeTranscriptCutoff.ts";
import {
  ClaudePlanTaskTracker,
  planTasksCursorField,
  readClaudePlanTasksFromCursor,
} from "../claudePlanTasks.ts";
import {
  type ClaudeTranscriptPresence,
  readClaudeTranscriptPresence,
} from "../claudeTranscriptPresence.ts";
import { formatProjectCustomSystemPrompt } from "../ProjectCustomSystemPrompt.ts";
import { ASSISTANT_ATTACHMENT_INSTRUCTIONS } from "../../assistantAttachments.ts";
import { DEVICE_ROUTING_INSTRUCTIONS } from "../../providerTools/deviceToolRouting.ts";
import { isSlashCommandInput } from "../attachmentInstructionDelivery.ts";
import { providerStartupPhaseTimeoutDetail } from "../providerOperationPolicy.ts";
import {
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  parseClaudeSlashCommands,
  probeClaudeCapabilities,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
  resolveClaudeFastMode,
} from "./ClaudeProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderTaskEndedError,
  ProviderTurnNotSteerableError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { TASK_MESSAGE_PENDING_LIMIT_METHOD } from "../Errors.ts";
import {
  CLAUDE_SUBAGENT_MESSAGE_UNDELIVERED,
  CLAUDE_SUBAGENT_PENDING_MESSAGES_MAX,
  claudeSubagentMessageContext,
  isMessageableClaudeTask,
  takeSubagentMessages,
} from "../claudeSubagentMessages.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { requireRuntimeSessionId, stampRuntimeEvent } from "../runtimeSession.ts";
import { withThreadAttribution } from "../../localServers/threadAttributionEnv.ts";
import { providerThreadSnapshotFromTurnIds } from "../providerThreadSnapshot.ts";
import {
  AGENT_CONTROL_INTERNAL_SERVER_NAME,
  agentControlHostContext,
  installAgentControlNativeHttp,
  redactAgentControlSecrets,
} from "../../agentControl/ProviderInjection.ts";
import { makeSharedPayloadSecretRedactor } from "../../agentControl/secretRedaction.ts";
import {
  applyClaudeRateLimitInfo,
  classifyClaudeUsageLimitResult,
  CLAUDE_USAGE_LIMIT_FALLBACK_MESSAGE,
  claudeUsageLimitState,
} from "./claudeUsageLimits.ts";
import {
  adapterFailureDetail,
  claudeAutoModeRefusedMessage,
  claudeTurnCloseErrorMessage,
  interruptionMessageFromClaudeCause,
  isClaudeInterruptedCause,
  messageFromClaudeStreamCause,
  toError,
  toMessage,
  toRequestError,
  toSessionRequestError,
  withClaudeProcessStderr,
} from "./ClaudeAdapter.errors.ts";
import {
  CLAUDE_SETTING_SOURCES,
  buildUserMessage,
  buildUserMessageEffect,
  claudePermissionModeForInteraction,
  getEffectiveClaudeAgentEffort,
  readTokenReductionInstructions,
} from "./ClaudeAdapter.prompt.ts";
import {
  boundedJsonPreview,
  claudeApiRetryNotice,
  claudeInformationalLabel,
  claudeMainChainUuid,
  extractAssistantTextBlocks,
  hasDurableClaudeSessionId,
  nativeProviderRefs,
  sanitizeSessionUrl,
  sdkMessageSubtype,
  sdkNativeItemId,
  sdkNativeMethod,
  streamKindFromDeltaType,
  turnStatusFromResult,
} from "./ClaudeAdapter.sdkMessage.ts";
import {
  CLAUDE_TASK_PATCH_STATUS,
  type ClaudeWorkflowProgress,
  agentIdForParentToolUse,
  claudeSubagentLaunchModel,
  claudeTaskCompletionStatus,
  claudeTaskSubagentStatus,
  isClaudeSubagentTaskMessage,
  makeClaudeTaskSubagentRef,
  mergeWorkflowPhases,
  parseWorkflowProgress,
  rememberClaudeSubagentAttribution,
  rememberClaudeSubagentLaunch,
  taskLinkageFor,
  workflowAgentStatus,
} from "./ClaudeAdapter.tasks.ts";
import {
  EMPTY_STREAMED_JSON_SCAN,
  classifyRequestType,
  classifyToolItemType,
  exitPlanCaptureKey,
  extractContentBlockText,
  extractExitPlanModePlan,
  extractPlanStepsFromTodoInput,
  isTodoTool,
  mayBeCompleteJson,
  readClaudeToolUseResult,
  readClaudeVcsSignal,
  scanStreamedJson,
  summarizeToolRequest,
  toolEventInput,
  toolInputFingerprint,
  toolItemDetail,
  toolItemTitle,
  toolResultBlocksFromUserMessage,
  toolResultStreamKind,
  tryParseJsonRecord,
} from "./ClaudeAdapter.tools.ts";
import {
  type AssistantTextBlockState,
  CLAUDE_DEVICE_TOOL_SERVER,
  CLAUDE_REWIND_PROBE_TIMEOUT,
  CLAUDE_REWIND_QUERY_EXIT_MS,
  CLAUDE_REWIND_TRANSCRIPT_TIMEOUT,
  CLAUDE_STARTUP_INITIALIZE_TIMEOUT_MS,
  CLAUDE_TRANSCRIPT_CHECK_TIMEOUT,
  CLAUDE_TURN_HEADS_CAP,
  type ClaudeAdapterLiveOptions,
  type ClaudeQueryRuntime,
  type ClaudeSessionContext,
  type ClaudeTranscriptEntry,
  type ClaudeTurnOpener,
  type ClaudeTurnState,
  DISCARDED_STEER_TURN_REASON,
  NO_STEER_PROMPT_UUIDS,
  PROVIDER,
  PROVIDER_TURN_STOP_REASON,
  type PendingApproval,
  type PendingUserInput,
  type PromptQueueItem,
  STEER_TURN_COMPACTING_DETAIL,
  STEER_TURN_ENDED_DETAIL,
  type ToolInFlight,
  WAKE_NO_OUTPUT_REASON,
  asCanonicalTurnId,
  asRuntimeItemId,
  asRuntimeRequestId,
  makeClaudeTurnState,
  rememberBounded,
  trimmedClaudeString,
} from "./ClaudeAdapter.types.ts";
import {
  normalizeClaudeTokenUsage,
  normalizeTaskUsage,
  resolveResultUsageSnapshot,
  withAutomaticCompactionCapability,
} from "./ClaudeAdapter.usage.ts";
import { nowIso, transcriptSeenMarker, updateResumeCursor } from "./ClaudeAdapter.session.ts";

export type { ClaudeAdapterLiveOptions, ClaudeTranscriptEntry } from "./ClaudeAdapter.types.ts";

export const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  claudeSettings: ClaudeSettings,
  options?: ClaudeAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("claudeAgent");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, options?.environment).pipe(
    Effect.provideService(Path.Path, path),
  );
  // How this instance compacts. A value this node does not know falls back to the default, so a
  // typo never makes the instance unavailable.
  const autoCompactMode = resolveClaudeAutoCompactMode(claudeSettings.autoCompact);
  const autoCompactWindow = parseClaudeAutoCompactWindow(claudeSettings.autoCompactWindow);
  const ignoredAutoCompactSettings = {
    ...(claudeSettings.autoCompact !== "" && claudeSettings.autoCompact !== autoCompactMode
      ? { autoCompact: claudeSettings.autoCompact }
      : {}),
    ...(claudeSettings.autoCompactWindow !== "" && autoCompactWindow === undefined
      ? { autoCompactWindow: claudeSettings.autoCompactWindow }
      : {}),
  };
  if (Object.keys(ignoredAutoCompactSettings).length > 0) {
    yield* Effect.logWarning("claude.compaction.settingsIgnored", {
      instanceId: boundInstanceId,
      ...ignoredAutoCompactSettings,
    });
  }
  // The auto-compact window Claude Code starts with. Left to Claude Code it is the configured one.
  // Under Ryco's policy Claude Code's own (mid-turn) compaction must not come before Ryco's
  // between-turn 80% mark, so a small window is raised for Claude Code alone.
  const nativeAutoCompactWindow =
    autoCompactWindow === undefined || autoCompactMode === "claudeCode"
      ? autoCompactWindow
      : nativeAutoCompactWindowBehindTrigger(autoCompactWindow);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  // Only a logger built here is closed here; an injected one (the shared
  // `ProviderEventLoggers.native`) belongs to its owner.
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

  const readSessionMessages =
    options?.readSessionMessages ??
    ((
      sessionId: string,
      readOptions: { readonly dir?: string; readonly includeSystemMessages: boolean },
    ) =>
      getSessionMessages(sessionId, {
        ...(readOptions.dir !== undefined ? { dir: readOptions.dir } : {}),
        includeSystemMessages: readOptions.includeSystemMessages,
      }));
  const readTranscriptPresence =
    options?.readTranscriptPresence ??
    (yield* resolveClaudeSourceRoot(claudeSettings, options?.environment).pipe(
      Effect.provideService(Path.Path, path),
      Effect.map(
        (root) => (sessionId: string) => readClaudeTranscriptPresence({ root, sessionId }),
      ),
    ));
  /** `readTranscriptPresence`; a failed or slow read is `unknown`. */
  const checkTranscriptPresence = (sessionId: string) =>
    Effect.tryPromise(() => readTranscriptPresence(sessionId)).pipe(
      Effect.timeoutOption(CLAUDE_TRANSCRIPT_CHECK_TIMEOUT),
      Effect.map(Option.getOrElse((): ClaudeTranscriptPresence => "unknown")),
      Effect.catch(() => Effect.succeed<ClaudeTranscriptPresence>("unknown")),
    );
  /** Threads whose session is being closed and reopened by a checkpoint revert. */
  const rewindingThreads = new Set<ThreadId>();

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) =>
      query({
        prompt: input.prompt,
        options: input.options,
      }) as ClaudeQueryRuntime);

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  let nextSessionGeneration = 0;
  /** Orders `commands_changed` pushes across sessions, so the newest list of a directory wins. */
  let nextSlashCommandsOrder = 0;
  // An SDK message is logged natively and may be previewed: redact it once, share it. Runtime
  // events are redacted centrally (`ProviderService.publishRuntimeEvent`).
  const secretRedactor = makeSharedPayloadSecretRedactor();
  const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
    options?.runtimeEventQueueCapacity ?? 2_048,
  );
  const runtimeEventQueueMetrics = yield* makeServerQueueMetrics({
    queue: "provider.adapter.runtimeEvents",
    component: "ClaudeAdapter",
    provider: PROVIDER,
    providerInstanceId: boundInstanceId,
  });

  const nextEventId = Effect.map(
    Effect.sync(() => crypto.randomUUID()),
    (id) => EventId.make(id),
  );
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEventForContext = (
    context: ClaudeSessionContext,
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> => {
    if (context.session.runtimeSessionId === undefined) {
      return Effect.die(
        new Error(
          `ClaudeAdapter emitted '${event.type}' without a runtime session for thread '${event.threadId}'.`,
        ),
      );
    }
    // Repeat positive background evidence on sparse lifecycle updates, so a
    // retained activity can stand alone. Absence is not foreground evidence.
    if (
      event.type === "task.started" ||
      event.type === "task.progress" ||
      event.type === "task.updated" ||
      event.type === "task.completed"
    ) {
      event = {
        ...event,
        payload: {
          ...event.payload,
          ...(!event.payload.taskType && context.taskAgents.get(event.payload.taskId)?.taskType
            ? { taskType: context.taskAgents.get(event.payload.taskId)!.taskType }
            : {}),
          ...(context.taskAgents.get(event.payload.taskId)?.backgroundAttempt !== undefined
            ? { attempt: context.taskAgents.get(event.payload.taskId)!.backgroundAttempt }
            : {}),
          ...(context.backgroundedTaskIds.has(event.payload.taskId)
            ? { isBackgrounded: true }
            : {}),
          // An emitter can deny stop for synthesized rows, never grant it.
          canStop: event.payload.canStop !== false && context.query.stopTask !== undefined,
          canMessage:
            context.liveTaskIds.has(event.payload.taskId) &&
            isMessageableClaudeTask(context.taskAgents.get(event.payload.taskId)),
        },
      } as ProviderRuntimeEvent;
    }
    // A settled task never reads what still waits for it: say so instead of dropping it.
    const undelivered =
      (event.type === "task.updated" || event.type === "task.completed") &&
      !context.liveTaskIds.has(event.payload.taskId)
        ? takeSubagentMessages(context.pendingSubagentMessages, event.payload.taskId)
        : null;
    // Agent Control tokens are redacted centrally (`ProviderService.publishRuntimeEvent`).
    const offered = Queue.offer(
      runtimeEventQueue,
      stampRuntimeEvent(event, {
        providerInstanceId: boundInstanceId,
        runtimeSessionId: context.session.runtimeSessionId,
      }),
    ).pipe(Effect.andThen(runtimeEventQueueMetrics.recordEnqueued()), Effect.asVoid);
    return undelivered === null
      ? offered
      : // A notice is labelled by its message and shows the undelivered text (truncated).
        offered.pipe(
          Effect.andThen(
            emitRuntimeNotice(context, CLAUDE_SUBAGENT_MESSAGE_UNDELIVERED, undelivered),
          ),
        );
  };

  const emitClaudeSubagentStarted = Effect.fn("emitClaudeSubagentStarted")(function* (
    context: ClaudeSessionContext,
    subagent: SubagentRef,
    raw: SDKMessage,
  ) {
    const key = String(subagent.subagentId);
    if (context.startedSubagentIds.has(key)) {
      return;
    }
    context.startedSubagentIds.add(key);
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "subagent.started",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        subagent,
      },
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message",
        method: sdkNativeMethod(raw),
        messageType: `${raw.type}:${sdkMessageSubtype(raw) ?? ""}`,
        payload: raw,
      },
    });
  });

  const emitClaudeSubagentUpdated = Effect.fn("emitClaudeSubagentUpdated")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly subagent: SubagentRef;
      readonly status?: RuntimeSubagentStatus;
      readonly summary?: string | undefined;
      readonly detail?: string | undefined;
      readonly usage?: unknown;
      readonly raw: SDKMessage;
    },
  ) {
    yield* emitClaudeSubagentStarted(context, input.subagent, input.raw);
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "subagent.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        subagent: input.subagent,
        ...(input.status ? { status: input.status } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message",
        method: sdkNativeMethod(input.raw),
        messageType: `${input.raw.type}:${sdkMessageSubtype(input.raw) ?? ""}`,
        payload: input.raw,
      },
    });
  });

  const emitClaudeSubagentCompleted = Effect.fn("emitClaudeSubagentCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly subagent: SubagentRef;
      readonly status: Extract<RuntimeSubagentStatus, "completed" | "failed" | "stopped">;
      readonly summary?: string | undefined;
      readonly usage?: unknown;
      readonly raw: SDKMessage;
    },
  ) {
    const key = String(input.subagent.subagentId);
    if (context.completedSubagentIds.has(key)) {
      return;
    }
    yield* emitClaudeSubagentStarted(context, input.subagent, input.raw);
    context.completedSubagentIds.add(key);
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "subagent.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        subagent: input.subagent,
        status: input.status,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message",
        method: sdkNativeMethod(input.raw),
        messageType: `${input.raw.type}:${sdkMessageSubtype(input.raw) ?? ""}`,
        payload: input.raw,
      },
    });
  });

  // Runs once per SDK message (every stream delta included): a plain
  // function, not an `Effect.fn`, so it adds no span to the trace file.
  const logNativeSdkMessage = (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ): Effect.Effect<void> => {
    if (!nativeEventLogger) {
      return Effect.void;
    }

    const observedAt = new Date().toISOString();
    const itemId = sdkNativeItemId(message);

    return nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : crypto.randomUUID(),
          kind: "notification",
          provider: PROVIDER,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          ...(itemId ? { itemId: ProviderItemId.make(itemId) } : {}),
          payload: secretRedactor.payload(message),
        },
      },
      context.session.threadId,
    );
  };

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return providerThreadSnapshotFromTurnIds(threadId, context.completedTurnIds);
  });

  /**
   * Checks once per session, after a completed turn wrote its transcript, whether the instance's
   * config root holds it. Only a session seen there may later read as deleted from it: a wrapper
   * binary or a container can keep its transcripts in a store this root is not.
   */
  const noteTranscriptSeen = Effect.fn("noteTranscriptSeen")(function* (
    context: ClaudeSessionContext,
    sessionId: string,
  ) {
    context.transcriptCheckedFor = sessionId;
    const presence = yield* checkTranscriptPresence(sessionId);
    yield* Effect.annotateCurrentSpan({ "claude.transcript": presence });
    if (presence === "present") context.transcriptSeenFor = sessionId;
  });

  const ensureAssistantTextBlock = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex);
    if (existing && !existing.completionEmitted) {
      if (existing.fallbackText.length === 0 && options?.fallbackText) {
        existing.fallbackText = options.fallbackText;
      }
      if (options?.streamClosed) {
        existing.streamClosed = true;
      }
      return { blockIndex, block: existing };
    }

    const block: AssistantTextBlockState = {
      itemId: yield* Effect.sync(() => crypto.randomUUID()),
      blockIndex,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
    return { blockIndex, block };
  });

  const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
    function* (context: ClaudeSessionContext, fallbackText: string) {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    },
  );

  const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || block.completionEmitted) {
      return;
    }

    if (!options?.force && !block.streamClosed) {
      return;
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0) {
      const deltaStamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "content.delta",
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: "assistant_text",
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    }

    block.completionEmitted = true;
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
      turnState.assistantTextBlocks.delete(block.blockIndex);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    });
  });

  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    "backfillAssistantTextBlocksFromSnapshot",
  )(function* (context: ClaudeSessionContext, message: SDKMessage) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    const snapshotTextBlocks = extractAssistantTextBlocks(message);
    if (snapshotTextBlocks.length === 0) {
      return;
    }

    const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
      blockIndex: block.blockIndex,
      block,
    }));

    for (const [position, text] of snapshotTextBlocks.entries()) {
      const existingEntry = orderedBlocks[position];
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) => {
            if (!created) {
              return undefined;
            }
            orderedBlocks.push(created);
            return created;
          }),
        ));
      if (!entry) {
        continue;
      }

      if (entry.block.fallbackText.length === 0) {
        entry.block.fallbackText = text;
      }

      if (entry.block.streamClosed && !entry.block.completionEmitted) {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }
  });

  const ensureThreadId = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (typeof message.session_id !== "string" || message.session_id.length === 0) {
      return;
    }
    if (!hasDurableClaudeSessionId(message)) {
      return;
    }
    const nextThreadId = message.session_id;
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
    options?: { readonly class?: RuntimeErrorClass; readonly resetAt?: string | null },
  ) {
    if (cause !== undefined) {
      void cause;
    }
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: options?.class ?? "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
        ...(options?.resetAt !== undefined ? { resetAt: options.resetAt } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeNotice = Effect.fn("emitRuntimeNotice")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: string,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "runtime.notice",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: { message, ...(detail ? { detail } : {}) },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const emitAutoModeRefusedWarning = Effect.fn("emitAutoModeRefusedWarning")(function* (
    context: ClaudeSessionContext,
    model: string | undefined,
  ) {
    if (context.autoModeRefusedWarningEmitted) return;
    context.autoModeRefusedWarningEmitted = true;
    yield* emitRuntimeWarning(context, claudeAutoModeRefusedMessage(model));
  });

  /**
   * The thread plan from TodoWrite input or the Task tool list. Stamped with the open turn, else
   * the last completed one: a background subagent's update after its turn settled must not go
   * out turnless, or clients would keep preferring that turn's older plan.
   */
  const emitPlanUpdated = Effect.fn("emitPlanUpdated")(function* (
    context: ClaudeSessionContext,
    plan: ReadonlyArray<RuntimePlanStep>,
    raw?: { readonly method: string; readonly payload: unknown },
  ) {
    const turnId = context.turnState?.turnId ?? context.completedTurnIds.at(-1);
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "turn.plan.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnId ? { turnId: asCanonicalTurnId(turnId) } : {}),
      payload: { plan },
      providerRefs: nativeProviderRefs(context),
      ...(raw
        ? { raw: { source: "claude.sdk.message", method: raw.method, payload: raw.payload } }
        : {}),
    });
  });

  const emitCompactionUnavailableWarning = Effect.fn("emitCompactionUnavailableWarning")(function* (
    context: ClaudeSessionContext,
  ) {
    // It reports Ryco's own compaction, which an instance left to Claude Code does not run.
    if (autoCompactMode === "claudeCode" || context.compactionUnavailableWarningEmitted) return;
    context.compactionUnavailableWarningEmitted = true;
    yield* emitRuntimeWarning(
      context,
      "Automatic context compaction is unavailable for this session. Start a new session if the context window fills.",
    );
  });

  /** Applies a compaction request's conclusion; one that ended without compacting warns once. */
  const concludeAutomaticCompaction = Effect.fn("concludeAutomaticCompaction")(function* (
    context: ClaudeSessionContext,
    requestId: string,
    aborted: boolean,
  ) {
    const conclusion = concludeContextCompactionRequest(context.compactionPolicy, {
      generation: context.generation,
      requestId,
      aborted,
    });
    context.compactionPolicy = conclusion.state;
    if (conclusion.unavailable) yield* emitCompactionUnavailableWarning(context);
  });

  /**
   * Compacts at the policy threshold before a completed prompt turn closes: Claude Code's own
   * `/compact` runs as the turn's last segment, and the turn closes at that prompt's result
   * (`closeCompactedTurn`). Claude Code fixes its auto-compact window when it starts: a live
   * `applyFlagSettings({ autoCompactWindow })` leaves the window it compacts at unchanged
   * (claudeCompactionCliProbe.test.ts), so only the explicit command compacts here.
   *
   * Inside the turn, not as a turn of its own: the thread stays busy until compaction ends, so a
   * queued message waits for it instead of racing it, and the turn the user started stays the
   * thread's latest (a delegated task still returns its result). Returns `compacting` when the
   * turn now waits for its compaction, `unavailable` when it crossed the threshold with no way to
   * compact (the caller warns once the turn closed).
   *
   * An instance set to let Claude Code decide (`autoCompact: "claudeCode"`) never compacts here.
   */
  const maybeCompactBeforeClosing = Effect.fn("maybeCompactBeforeClosing")(function* (
    context: ClaudeSessionContext,
    turnState: ClaudeTurnState,
    result: SDKResultMessage,
    usage: ThreadTokenUsageSnapshot | undefined,
  ): Effect.fn.Return<"compacting" | "unavailable" | "none"> {
    if (
      autoCompactMode === "claudeCode" ||
      usage === undefined ||
      context.stopped ||
      sessions.get(context.session.threadId) !== context ||
      context.turnState !== turnState ||
      turnState.completion !== undefined ||
      turnState.interruptRequested ||
      turnState.compactionPromptUuid !== undefined ||
      // A background ("wake") turn has no prompt to correlate; the next prompt turn observes.
      turnState.promptUuid === undefined ||
      // Claude Code runs a queued send next; that turn's completion observes the context again.
      (result.queued_turn_count ?? 0) > 0
    ) {
      return "none";
    }

    const generation = context.generation;
    const decision = observeContextCompaction(context.compactionPolicy, {
      generation,
      usage,
      windowTokens: autoCompactWindow,
    });
    context.compactionPolicy = decision.state;
    if (!decision.trigger) return "none";

    if (!context.supportsAutomaticCompaction) {
      context.compactionPolicy = disableContextCompaction(context.compactionPolicy, generation);
      return "unavailable";
    }

    const requestId = yield* Effect.sync(() => crypto.randomUUID());
    const offered = yield* Queue.offer(context.promptQueue, {
      type: "message",
      message: {
        ...buildUserMessage({
          sdkContent: [{ type: "text", text: NATIVE_COMPACTION_COMMAND }],
        }),
        uuid: requestId,
      },
    });
    if (!offered) {
      // The prompt queue is shut down: the session is ending, and nothing compacts.
      context.compactionPolicy = disableContextCompaction(context.compactionPolicy, generation);
      return "none";
    }
    turnState.compactionPromptUuid = requestId;
    context.compactionPolicy = recordContextCompactionRequest(
      context.compactionPolicy,
      generation,
      requestId,
    );
    // The turn's own work is over: seal it and publish its gauge, as between a steer's segments.
    yield* sealTurnSegment(context, turnState, "completed", result);
    yield* emitTokenUsageSnapshot(context, usage, turnState.turnId);
    turnState.sealedSegmentCount += 1;
    // Exact-turn Agent Control authority ends with the user's work, not with the compaction.
    if (context.agentControl) yield* context.agentControl.retireTurn(turnState.turnId);
    yield* Effect.logInfo("claude.compaction.requested", {
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      usedTokens: usage.usedTokens,
      maxTokens: usage.maxTokens,
      ...(autoCompactWindow !== undefined ? { windowTokens: autoCompactWindow } : {}),
    });
    return "compacting";
  });

  /**
   * Closes a turn at the result of its compaction segment. The turn's own work already completed,
   * so it closes as completed unless Stop was requested; how the compaction ended only decides
   * the policy's request (no boundary before this result: unavailable, unless Stop aborted it).
   */
  const closeCompactedTurn = Effect.fn("closeCompactedTurn")(function* (
    context: ClaudeSessionContext,
    turnState: ClaudeTurnState,
    compactionPromptUuid: string,
    result: SDKResultMessage,
  ) {
    const kind = classifyClaudeResultKind(result);
    if (kind === "failure") {
      yield* Effect.logWarning("claude.compaction.failed", {
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        subtype: result.subtype,
        ...(result.subtype === "success" ? {} : { errors: result.errors }),
      });
    }
    // Claude Code answers a `/compact` that Stop aborted with a successful result.
    const stopped = turnState.interruptRequested;
    yield* concludeAutomaticCompaction(context, compactionPromptUuid, kind === "abort" || stopped);
    yield* completeTurn(
      context,
      stopped ? "interrupted" : "completed",
      stopped ? claudeTurnCloseErrorMessage("stopped", result) : undefined,
      result,
      { expectedTurnState: turnState },
    );
  });

  /** Publishes a context-gauge snapshot, attributed to a turn when one is given. */
  const emitTokenUsageSnapshot = Effect.fn("emitTokenUsageSnapshot")(function* (
    context: ClaudeSessionContext,
    usageSnapshot: ThreadTokenUsageSnapshot | undefined,
    turnId: TurnId | undefined,
  ) {
    if (!usageSnapshot) return;
    const usageStamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "thread.token-usage.updated",
      eventId: usageStamp.eventId,
      provider: PROVIDER,
      createdAt: usageStamp.createdAt,
      threadId: context.session.threadId,
      ...(turnId !== undefined ? { turnId } : {}),
      payload: {
        usage: usageSnapshot,
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  /**
   * Closes everything a CLI segment left open (in-flight tools, assistant text and reasoning
   * blocks) while the turn itself may stay open: between a steer's segments and at completion.
   */
  const sealTurnSegment = Effect.fn("sealTurnSegment")(function* (
    context: ClaudeSessionContext,
    turnState: ClaudeTurnState,
    status: ProviderRuntimeTurnStatus,
    result: SDKResultMessage | undefined,
  ) {
    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: toolEventInput(tool.toolName, tool.input),
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();
    // Suppressed-narration bookkeeping is per-message; anything left after
    // the turn is an interrupted stream's residue.
    context.suppressedSubagentBlocks.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }
    // The next segment's snapshot text maps onto its own blocks, not this segment's.
    turnState.assistantTextBlockOrder.length = 0;

    // A thinking block cut off by an abort never sees content_block_stop.
    for (const reasoningBlock of turnState.reasoningBlocks.values()) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "item.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: asCanonicalTurnId(turnState.turnId),
        itemId: asRuntimeItemId(reasoningBlock.itemId),
        payload: {
          itemType: "reasoning",
          status: status === "failed" ? "failed" : "completed",
          title: "Reasoning",
        },
        providerRefs: nativeProviderRefs(context),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
    }
    turnState.reasoningBlocks.clear();
  });

  /** A result (or local close) with no open turn: keep usage, never publish a lifecycle event. */
  const publishTurnlessResult = Effect.fn("publishTurnlessResult")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage: string | undefined,
    result: SDKResultMessage | undefined,
  ) {
    yield* emitTokenUsageSnapshot(
      context,
      yield* resolveResultUsageSnapshot(context, result),
      undefined,
    );

    // Prompt turns always receive local turnState when sent, and provider
    // turns open at Claude's wake signal (status: requesting/compacting, or
    // init on legacy CLIs) or, failing that, at the first out-of-turn root
    // assistant message. What remains is a resume handshake, an empty
    // notification turn, a late result after Stop finished the turn locally,
    // or a no-turn stream failure. Keep usage, but never publish an
    // untargeted lifecycle completion.
    yield* Effect.logInfo("claude.turn.result-without-active-turn", {
      threadId: context.session.threadId,
      status,
      numTurns: result?.num_turns,
      hasUsage: result?.usage !== undefined,
      ...(errorMessage ? { errorMessage } : {}),
    });
  });

  /** Finishes a turn this fiber claimed in `completeTurn`. Never call it directly. */
  const finishClaimedTurn = Effect.fn("finishClaimedTurn")(function* (
    context: ClaudeSessionContext,
    turnState: ClaudeTurnState,
    completion: Deferred.Deferred<void>,
    status: ProviderRuntimeTurnStatus,
    errorMessage: string | undefined,
    result: SDKResultMessage | undefined,
    options:
      | {
          readonly abortReason?: string;
          readonly resolvedUsage?: { readonly snapshot: ThreadTokenUsageSnapshot | undefined };
        }
      | undefined,
  ) {
    const usageSnapshot =
      options?.resolvedUsage !== undefined
        ? options.resolvedUsage.snapshot
        : yield* resolveResultUsageSnapshot(context, result);

    yield* sealTurnSegment(context, turnState, status, result);

    context.completedTurnIds.push(turnState.turnId);
    context.lastFinishedTurn = {
      turnId: turnState.turnId,
      status: options?.abortReason !== undefined ? "interrupted" : status,
    };
    if (turnState.lastChainUuid !== undefined) {
      context.turnHeads.push({ turnId: turnState.turnId, head: turnState.lastChainUuid });
      if (context.turnHeads.length > CLAUDE_TURN_HEADS_CAP) context.turnHeads.shift();
    }
    // The first completed turn after a rewind makes the rewound branch the newest
    // transcript leaf, so plain resumes are correct again. Refresh the cursor
    // before turn.completed goes out: ProviderService persists the live cursor
    // when it sees that event.
    if (status === "completed") context.pendingRewind = undefined;
    const sessionId = context.resumeSessionId;
    if (
      status === "completed" &&
      sessionId !== undefined &&
      context.transcriptCheckedFor !== sessionId
    ) {
      yield* noteTranscriptSeen(context, sessionId);
    }
    yield* updateResumeCursor(context);

    yield* emitTokenUsageSnapshot(context, usageSnapshot, turnState.turnId);

    const stamp = yield* makeEventStamp();
    if (options?.abortReason !== undefined) {
      // Aborted turns settle through thread.turn.interrupt and capture no checkpoint.
      yield* offerRuntimeEventForContext(context, {
        type: "turn.aborted",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: { reason: options.abortReason },
        providerRefs: nativeProviderRefs(context),
      });
    } else {
      yield* offerRuntimeEventForContext(context, {
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          state: status,
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        providerRefs: nativeProviderRefs(context),
      });
    }

    const updatedAt = yield* nowIso;
    if (context.turnState === turnState) {
      context.turnState = undefined;
      context.session = {
        ...context.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt,
        ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
      };
    }
    // Release waiters before the tail effects: the turn is detached.
    Deferred.doneUnsafe(completion, Effect.void);
    if (context.agentControl) yield* context.agentControl.retireTurn(turnState.turnId);
    // Closed before its compaction's result (Stop, a lost stream): the request settles quietly.
    // After `closeCompactedTurn` it is already concluded, so this is a no-op.
    if (turnState.compactionPromptUuid !== undefined) {
      yield* concludeAutomaticCompaction(context, turnState.compactionPromptUuid, true);
    }
  });

  /**
   * The single owner of turn completion. The open turn is claimed synchronously at entry, so a
   * concurrent close (sendTurn, Stop grace, watchdog, stream exit) waits for the claimer instead
   * of emitting a second lifecycle event.
   */
  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
    options?: {
      readonly abortReason?: string;
      /** Only close this exact turn; a different (or no) open turn is left alone. */
      readonly expectedTurnState?: ClaudeTurnState;
      /** The result's gauge, when the caller already resolved it (resolving consumes state). */
      readonly resolvedUsage?: { readonly snapshot: ThreadTokenUsageSnapshot | undefined };
    },
  ) {
    // Must stay the first statement: the claim is only atomic before any yield.
    const turnState = context.turnState;
    if (options?.expectedTurnState !== undefined && turnState !== options.expectedTurnState) {
      return;
    }
    if (turnState?.completion !== undefined) {
      // Another fiber is finishing this turn; never emit a second lifecycle event. A result that
      // arrives now only loses its usage: a local close already finished the turn.
      if (result !== undefined) {
        yield* Effect.logInfo("claude.turn.result-during-completion", {
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          status,
        });
      }
      yield* Deferred.await(turnState.completion);
      return;
    }
    if (turnState === undefined) {
      return yield* publishTurnlessResult(context, status, errorMessage, result);
    }
    const completion = Deferred.makeUnsafe<void>();
    turnState.completion = completion;
    yield* finishClaimedTurn(
      context,
      turnState,
      completion,
      status,
      errorMessage,
      result,
      options,
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          // Failed or interrupted before the turn was detached: release the claim so a later
          // close can retry.
          if (context.turnState === turnState) turnState.completion = undefined;
          Deferred.doneUnsafe(completion, Effect.void);
        }),
      ),
    );
  });

  const handleStreamEvent = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;

    // Subagent-owned stream traffic (parent_tool_use_id set) must not write
    // into the parent transcript: with forwardSubagentText off the SDK still
    // forwards subagent tool_use/tool_result blocks and their wrapping
    // text/thinking deltas, and emitting them interleaved N subagents'
    // narration into the chat. Their results reach the UI via the task.*
    // lifecycle; their tool blocks are attributed and re-homed by the
    // quiet-timeline filter.
    const streamParentToolUseId = (message as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (streamParentToolUseId !== null && streamParentToolUseId !== undefined) {
      // Drop only the subagent's narration (text/thinking); tool_use blocks
      // and their input_json_delta frames must flow so attributed tool items
      // keep their inputs.
      const dropStart =
        event.type === "content_block_start" &&
        event.content_block.type !== "tool_use" &&
        event.content_block.type !== "server_tool_use" &&
        event.content_block.type !== "mcp_tool_use";
      if (dropStart) {
        let suppressed = context.suppressedSubagentBlocks.get(streamParentToolUseId);
        if (!suppressed) {
          suppressed = new Set();
          context.suppressedSubagentBlocks.set(streamParentToolUseId, suppressed);
        }
        suppressed.add(event.index);
        return;
      }
      const dropDelta =
        event.type === "content_block_delta" &&
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta");
      if (dropDelta) {
        return;
      }
      // The stop frame of a dropped narration block must be dropped too:
      // block indexes are per-message, so it would otherwise complete the
      // parent's assistant block (or in-flight tool) at the same index.
      if (event.type === "content_block_stop") {
        const suppressed = context.suppressedSubagentBlocks.get(streamParentToolUseId);
        if (suppressed?.delete(event.index)) {
          if (suppressed.size === 0) {
            context.suppressedSubagentBlocks.delete(streamParentToolUseId);
          }
          return;
        }
      }
    }

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        // Thinking deltas belong to their own reasoning item, never to a text
        // block that happens to share the stream index.
        const reasoningBlock =
          event.delta.type === "thinking_delta"
            ? context.turnState.reasoningBlocks.get(event.index)
            : undefined;
        const assistantBlockEntry =
          event.delta.type === "text_delta"
            ? yield* ensureAssistantTextBlock(context, event.index)
            : undefined;
        if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
          assistantBlockEntry.block.emittedTextDelta = true;
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEventForContext(context, {
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? {
                itemId: asRuntimeItemId(assistantBlockEntry.block.itemId),
              }
            : reasoningBlock
              ? { itemId: asRuntimeItemId(reasoningBlock.itemId) }
              : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const tool = context.inFlightTools.get(event.index);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json;
        const partialInputScan = scanStreamedJson(tool.partialInputScan, event.delta.partial_json);
        const parsedInput = mayBeCompleteJson(partialInputScan)
          ? tryParseJsonRecord(partialInputJson)
          : undefined;
        const detail = parsedInput ? toolItemDetail(tool.toolName, parsedInput) : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJson,
          partialInputScan,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(event.index, nextTool);
        if (nextTool.itemType === "collab_agent_tool_call" && parsedInput) {
          rememberClaudeSubagentLaunch(context, nextTool.itemId, parsedInput);
        }
        if (parsedInput) {
          context.planTasks.noteToolUse(nextTool.itemId, nextTool.toolName, parsedInput);
        }

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(event.index, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEventForContext(context, {
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: "inProgress",
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            ...(nextTool.agentId ? { agentId: nextTool.agentId } : {}),
            ...(nextTool.parentToolUseId ? { parentToolUseId: nextTool.parentToolUseId } : {}),
            data: {
              toolName: nextTool.toolName,
              input: toolEventInput(nextTool.toolName, nextTool.input),
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: nextTool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });

        // TodoWrite carries its whole list in its input. The CLI keeps one TodoWrite list per
        // agent, so a subagent's list must not replace the root's plan.
        if (parsedInput && isTodoTool(nextTool.toolName) && !nextTool.parentToolUseId) {
          const planSteps = extractPlanStepsFromTodoInput(parsedInput);
          if (planSteps && planSteps.length > 0) {
            yield* emitPlanUpdated(context, planSteps);
          }
        }
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      if (block.type === "text") {
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
        });
        return;
      }
      if (block.type === "thinking" && context.turnState) {
        const turnState = context.turnState;
        turnState.reasoningBlockCount += 1;
        const itemId = `${turnState.turnId}:thinking:${turnState.reasoningBlockCount}`;
        turnState.reasoningBlocks.set(index, { itemId });
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEventForContext(context, {
          type: "item.started",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: asCanonicalTurnId(turnState.turnId),
          itemId: asRuntimeItemId(itemId),
          payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_start",
            payload: message,
          },
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }

      const toolName = block.name;
      const itemType = classifyToolItemType(toolName);
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemId = block.id;
      const detail = toolItemDetail(toolName, toolInput);
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

      // Attribute tools that ran inside a subagent to their owning agent so
      // clients can re-home them out of the main timeline (quiet-timeline
      // guarantee): the SDK forwards subagent tool_use blocks tagged with the
      // spawning Task tool's id as parent_tool_use_id.
      const parentToolUseId =
        (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
      const owningAgentId = agentIdForParentToolUse(context.taskAgents, parentToolUseId);

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        title: toolItemTitle(toolName, itemType),
        ...(detail ? { detail } : {}),
        input: toolInput,
        partialInputJson: "",
        partialInputScan: EMPTY_STREAMED_JSON_SCAN,
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
        ...(owningAgentId ? { agentId: owningAgentId } : {}),
        ...(parentToolUseId ? { parentToolUseId } : {}),
      };
      context.inFlightTools.set(index, tool);
      if (itemType === "collab_agent_tool_call") {
        rememberClaudeSubagentLaunch(context, itemId, toolInput);
      }
      context.planTasks.noteToolUse(itemId, toolName, toolInput);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: {
            toolName: tool.toolName,
            input: toolEventInput(tool.toolName, toolInput),
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: message,
        },
      });
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const reasoningBlock = context.turnState?.reasoningBlocks.get(index);
      if (reasoningBlock && context.turnState) {
        context.turnState.reasoningBlocks.delete(index);
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEventForContext(context, {
          type: "item.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: asCanonicalTurnId(context.turnState.turnId),
          itemId: asRuntimeItemId(reasoningBlock.itemId),
          payload: { itemType: "reasoning", status: "completed", title: "Reasoning" },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_stop",
            payload: message,
          },
        });
        return;
      }
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
      if (!tool) {
        return;
      }
    }
  });

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    const toolResults = toolResultBlocksFromUserMessage(message);
    for (const toolResult of toolResults) {
      // Before the in-flight lookup: subagent calls seen only in snapshots are never in flight.
      // A subagent's result updates the session's shared list too. Known gap: a discarded steer
      // segment's frames never get here (routeSteerFrame), so its task changes show up only at the
      // next TaskList.
      const plan = context.planTasks.applyResult({
        toolUseId: toolResult.toolUseId,
        text: toolResult.text,
        isError: toolResult.isError,
        structured: toolResults.length === 1 ? readClaudeToolUseResult(message) : undefined,
      });
      if (plan) {
        yield* emitPlanUpdated(context, plan, { method: "claude/user", payload: message });
        // The live cursor is what a stop persists; a background result may be the last frame.
        yield* updateResumeCursor(context);
      }

      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const toolData = {
        toolName: tool.toolName,
        input: toolEventInput(tool.toolName, tool.input),
        result: toolResult.block,
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEventForContext(context, {
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: tool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      // The Workflow tool's result carries the run handles (runId, scriptPath,
      // transcriptDir, sessionUrl). Attach them to the workflow's task agent so
      // the next task.* payload advertises them to clients.
      const toolUseResult = readClaudeToolUseResult(message);
      if (!toolResult.isError && tool.toolName.toLowerCase() === "workflow" && toolUseResult) {
        const workflowTaskId = trimmedClaudeString(toolUseResult.taskId);
        if (workflowTaskId) {
          const runHandles: TaskRunHandles = {
            ...(trimmedClaudeString(toolUseResult.runId)
              ? { runId: trimmedClaudeString(toolUseResult.runId) }
              : {}),
            ...(trimmedClaudeString(toolUseResult.scriptPath)
              ? { scriptPath: trimmedClaudeString(toolUseResult.scriptPath) }
              : {}),
            ...(trimmedClaudeString(toolUseResult.transcriptDir)
              ? { transcriptDir: trimmedClaudeString(toolUseResult.transcriptDir) }
              : {}),
            ...(sanitizeSessionUrl(toolUseResult.sessionUrl)
              ? { sessionUrl: sanitizeSessionUrl(toolUseResult.sessionUrl) }
              : {}),
          };
          const existing = context.taskAgents.get(workflowTaskId);
          context.taskAgents.set(workflowTaskId, {
            taskId: workflowTaskId,
            toolUseId: existing?.toolUseId ?? tool.itemId,
            description: existing?.description,
            subagentType: existing?.subagentType,
            taskType: existing?.taskType ?? "local_workflow",
            workflowName: existing?.workflowName,
            skipTranscript: existing?.skipTranscript ?? false,
            runHandles,
            owningAgentId: existing?.owningAgentId,
            model: existing?.model,
            effort: existing?.effort,
          });
        }
      }

      context.inFlightTools.delete(index);
    }
  });

  /**
   * Opens a provider turn: one Claude started without a prompt, either at its turn-start signal
   * ("wake-signal") or, when no signal opened one, at its first root assistant output. It binds
   * Agent Control authority as a provider turn: the same turn-bound tools as a prompt turn (they
   * end with it), but never the user's staged Computer Use request.
   */
  const startProviderTurn = Effect.fn("startProviderTurn")(function* (
    context: ClaudeSessionContext,
    openedBy: Exclude<ClaudeTurnOpener, "prompt">,
  ) {
    const turnId = TurnId.make(yield* Effect.sync(() => crypto.randomUUID()));
    const startedAt = yield* nowIso;
    // Synchronous from here to the install: re-check after the yields above.
    if (context.turnState !== undefined || context.stopped) return;
    if (openedBy === "wake-signal" && (context.turnInstallsInFlight > 0 || !context.promptSent)) {
      return;
    }
    const turnState = makeClaudeTurnState({ turnId, startedAt, openedBy });
    context.turnState = turnState;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: startedAt,
    };
    // Bound with the install: `completeTurn` retires it whichever way the turn ends.
    if (context.agentControl) {
      yield* context.agentControl.bindTurn(turnId, "provider").pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to bind Agent Control provider-turn authority", {
            threadId: context.session.threadId,
            turnId,
            cause,
          }),
        ),
      );
      // Ended while binding: its retire already ran, so retire the late binding too.
      if (context.turnState !== turnState) yield* context.agentControl.retireTurn(turnId);
    }
    const turnStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: {},
      providerRefs: {
        ...nativeProviderRefs(context),
        providerTurnId: turnId,
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/synthetic-turn-start",
        payload: { openedBy },
      },
    });
    if (openedBy === "wake-signal") {
      // First-output watchdog: a wake that never produces root output must not hold the
      // thread running. turn.aborted settles it without a checkpoint capture.
      yield* Effect.sleep(Duration.millis(CLAUDE_WAKE_TURN_FIRST_OUTPUT_TIMEOUT_MS)).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            context.turnState === turnState && !turnState.rootOutputObserved && !context.stopped
              ? completeTurn(context, "interrupted", WAKE_NO_OUTPUT_REASON, undefined, {
                  abortReason: WAKE_NO_OUTPUT_REASON,
                })
              : Effect.void,
          ),
        ),
        Effect.ignoreCause({ log: true }),
        Effect.forkDetach,
      );
    }
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }

    // Subagent-owned assistant snapshots (parent_tool_use_id set) are the
    // subagent's own conversation, not the parent's. Emitting them created
    // interleaved leak messages and spawned synthetic turns per subagent
    // completion (which also reset the Working timer).
    const assistantParentToolUseId = (message as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (assistantParentToolUseId !== null && assistantParentToolUseId !== undefined) {
      // The snapshot's message.model is the authoritative API model the
      // subagent actually ran on — refine the seeded launch-time value.
      const owningTaskId = agentIdForParentToolUse(context.taskAgents, assistantParentToolUseId);
      const snapshotModel = trimmedClaudeString(message.message.model);
      const owningAgent = owningTaskId ? context.taskAgents.get(owningTaskId) : undefined;
      if (owningAgent && snapshotModel && owningAgent.model !== snapshotModel) {
        owningAgent.model = snapshotModel;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEventForContext(context, {
          ...stamp,
          type: "task.updated",
          provider: PROVIDER,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: nativeProviderRefs(context),
          payload: {
            taskId: RuntimeTaskId.make(owningAgent.taskId),
            ...taskLinkageFor(context.taskAgents, owningAgent.taskId),
          },
        });
        const existingSubagent = context.subagentByTaskId.get(owningAgent.taskId);
        if (existingSubagent) {
          const subagent = { ...existingSubagent, model: snapshotModel };
          context.subagentByTaskId.set(owningAgent.taskId, subagent);
          yield* emitClaudeSubagentUpdated(context, { subagent, raw: message });
        }
      } else if (!owningAgent && snapshotModel) {
        rememberClaudeSubagentAttribution(
          context.subagentModelByToolUseId,
          assistantParentToolUseId,
          snapshotModel,
        );
      }
      // The SDK may deliver subagent tool calls only in full snapshots.
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        rememberClaudeSubagentAttribution(
          context.subagentParentByToolUseId,
          block.id,
          assistantParentToolUseId,
        );
        if (block.input === null || typeof block.input !== "object" || Array.isArray(block.input)) {
          continue;
        }
        const blockInput = block.input as Record<string, unknown>;
        if (classifyToolItemType(block.name) === "collab_agent_tool_call") {
          rememberClaudeSubagentLaunch(context, block.id, blockInput);
        }
        // Subagents write to the session's task list, so their Task calls feed the plan too.
        context.planTasks.noteToolUse(block.id, block.name, blockInput);
      }
      context.lastAssistantUuid = message.uuid;
      yield* updateResumeCursor(context);
      return;
    }

    const cacheStamp = yield* makeEventStamp();
    const previousCache = context.cacheObservation;
    context.cacheObservation = observeClaudeCache({
      usage: message.message.usage,
      messageId: message.message.id,
      model: message.message.model,
      ...(context.cacheModelSelection ? { modelSelection: context.cacheModelSelection } : {}),
      ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      runtimeSessionId: context.session.runtimeSessionId!,
      providerInstanceId: context.session.providerInstanceId!,
      observedAt: cacheStamp.createdAt,
      ...(previousCache ? { previous: previousCache } : {}),
    });
    if (context.cacheObservation) context.mainLoopUsageObserved = true;
    if (context.cacheObservation && context.cacheObservation !== previousCache) {
      const observation = context.cacheObservation;
      const usedTokens =
        observation.directInputTokens +
        observation.cacheReadInputTokens +
        observation.cacheWriteInputTokens;
      const usage: ThreadTokenUsageSnapshot = {
        usedTokens,
        inputTokens: usedTokens,
        cachedInputTokens: observation.cacheReadInputTokens,
        ...(context.lastKnownContextWindow ? { maxTokens: context.lastKnownContextWindow } : {}),
        claudeCache: observation,
      };
      context.lastKnownTokenUsage = usage;
      yield* offerRuntimeEventForContext(context, {
        type: "thread.token-usage.updated",
        provider: PROVIDER,
        eventId: cacheStamp.eventId,
        createdAt: cacheStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        payload: { usage },
        providerRefs: {},
      });
    }

    // Fallback opener for root assistant output that arrives while no turn is
    // open and no wake signal opened one (e.g., a background reply on a CLI
    // that emits neither status frames nor init). Ungated on purpose: output
    // must never land outside a turn.
    if (!context.turnState) {
      yield* startProviderTurn(context, "assistant-output");
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (toolUse.type !== "tool_use") {
          continue;
        }
        // The snapshot's input is final; it overrides what streaming noted.
        if (
          typeof toolUse.id === "string" &&
          typeof toolUse.name === "string" &&
          toolUse.input !== null &&
          typeof toolUse.input === "object" &&
          !Array.isArray(toolUse.input)
        ) {
          context.planTasks.noteToolUse(
            toolUse.id,
            toolUse.name,
            toolUse.input as Record<string, unknown>,
          );
        }
        if (toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      yield* backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* updateResumeCursor(context);
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
    options?: {
      /** The result ends a discarded steer's CLI turn the CLI folded the open turn into. */
      readonly foldedIntoDiscardedCliTurn?: boolean;
    },
  ) {
    if (message.type !== "result") {
      return;
    }
    // A reopen probe owns turnless error results (for example a refused resume).
    if (context.probing && context.turnState === undefined) {
      if (message.subtype !== "success" || message.is_error) {
        const detail =
          (message.subtype !== "success" ? message.errors[0] : undefined) ??
          `Claude reported ${message.subtype} while reopening the conversation.`;
        if (context.probeFailure) yield* Deferred.succeed(context.probeFailure, detail);
      }
      return;
    }

    const turnState = context.turnState;
    const echoedPromptUuids = claudeEchoedPromptUuids(message);
    // A turn waiting for its compaction segment closes only at that prompt's result.
    const compactionPromptUuid = turnState?.compactionPromptUuid;
    if (turnState !== undefined && compactionPromptUuid !== undefined) {
      if (
        claudeResultBelongsToTurn({
          echoed: echoedPromptUuids,
          origin: message.origin,
          promptUuid: compactionPromptUuid,
          steerPromptUuids: NO_STEER_PROMPT_UUIDS,
        })
      ) {
        return yield* closeCompactedTurn(context, turnState, compactionPromptUuid, message);
      }
      yield* Effect.logInfo("claude.turn.result-during-compaction", {
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        origin: message.origin?.kind,
      });
      return;
    }
    // Resuming can produce a result for a background notification before the
    // queued user prompt runs. Prefer explicit correlation; older CLIs omit it.
    // A steered turn's later segments echo only their steer uuids.
    if (
      turnState?.promptUuid !== undefined &&
      !claudeResultBelongsToTurn({
        echoed: echoedPromptUuids,
        origin: message.origin,
        promptUuid: turnState.promptUuid,
        steerPromptUuids: turnState.steerPromptUuids,
      })
    ) {
      yield* Effect.logInfo("claude.turn.result-for-other-prompt", {
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        origin: message.origin?.kind,
      });
      return;
    }

    const resultStatus = turnStatusFromResult(message);
    let close: ClaudeTurnClose = { status: resultStatus, cause: "result" };
    let unsettledSteerCount = 0;
    if (turnState) {
      const decision = decideClaudeTurnResult({
        kind: classifyClaudeResultKind(message),
        echoedPromptUuids,
        queuedTurnCount: message.queued_turn_count,
        steerPromptUuids: turnState.steerPromptUuids,
        settledSteerPromptUuids: turnState.settledSteerPromptUuids,
        interruptRequested: turnState.interruptRequested,
      });
      for (const uuid of decision.newlySettled) {
        turnState.settledSteerPromptUuids.add(uuid);
        context.discardedSteerPromptUuids.delete(uuid);
      }
      unsettledSteerCount = decision.unsettled.length;
      if (decision.decision === "await-steer") {
        // The CLI promised another result: this segment ended (a "now" steer aborted it, or the
        // prompt finished first) and the steer runs next. Keep the Ryco turn open for it.
        yield* sealTurnSegment(context, turnState, resultStatus, message);
        yield* emitTokenUsageSnapshot(
          context,
          yield* resolveResultUsageSnapshot(context, message),
          turnState.turnId,
        );
        turnState.sealedSegmentCount += 1;
        turnState.awaitingSteerContinuation = {
          since: yield* nowIso,
          segmentStatus: resultStatus,
        };
        yield* Effect.logInfo("claude.turn.awaiting-steer-continuation", {
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          queuedTurnCount: message.queued_turn_count,
          unsettled: decision.unsettled.length,
          terminalReason: message.terminal_reason,
        });
        return;
      }
      // Stop or a failed segment: the pending steers never reply. Recorded here, before the turn
      // closes, so a steer's CLI turn is dropped even when the result beats Stop's receipt.
      if (decision.discardUnsettled) {
        for (const uuid of decision.unsettled) {
          rememberDiscardedSteer(context.discardedSteerPromptUuids, uuid);
        }
      }
      // The result's status unless it misstates the turn: a steer's abort or Ryco's own discard
      // re-interrupt is never a Stop, a Stop always ends as one, and a failure that dropped a
      // steer is always reported as a failure.
      close = decideClaudeTurnClose({
        resultStatus,
        decision,
        interruptRequested: turnState.interruptRequested,
        echoedPromptUuids,
        promptUuid: turnState.promptUuid,
        steerPromptUuids: turnState.steerPromptUuids,
        foldedIntoDiscardedCliTurn: options?.foldedIntoDiscardedCliTurn === true,
      });
      if (close.cause !== "result") {
        // Seal the segment on its own outcome (a tool the abort cut off fails, a finished one
        // completes), unless the turn reports a failure, which fails whatever is still open.
        if (close.status !== "failed") {
          yield* sealTurnSegment(context, turnState, resultStatus, message);
        }
        yield* Effect.logInfo("claude.turn.closed-as", {
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          cause: close.cause,
          resultStatus,
          status: close.status,
          queuedTurnCount: message.queued_turn_count,
          unsettled: decision.unsettled.length,
          terminalReason: message.terminal_reason,
        });
      }
    }

    // A usage-limit stop can arrive as `subtype: "success", is_error: true`, which would
    // otherwise complete the turn with no error. Only an open turn can record a limit, so
    // a stale or late result never marks the thread Limited. It takes precedence over a
    // failed-segment close; pending steers were already discarded above. Both the result's own
    // status and the close must rule out an interrupt: a steer's abort closes as completed, and
    // an older CLI reports that abort only in its error text, with no terminal reason.
    const notInterrupted = (status: ProviderRuntimeTurnStatus) =>
      status !== "interrupted" && status !== "cancelled";
    const usageLimit =
      context.turnState && notInterrupted(resultStatus) && notInterrupted(close.status)
        ? classifyClaudeUsageLimitResult({
            result: message,
            windows: context.rejectedRateLimitWindows,
            nowMs: yield* Clock.currentTimeMillis,
          })
        : null;
    if (usageLimit) {
      yield* emitRuntimeError(context, usageLimit.message, undefined, {
        class: "usage_limit",
        resetAt: usageLimit.resetAt,
      });
      yield* completeTurn(context, "failed", usageLimit.message, message);
      return;
    }

    const errorMessage = claudeTurnCloseErrorMessage(close.cause, message);
    if (close.status === "failed") {
      yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
    }

    // A turn whose own work completed may compact before it closes.
    if (
      turnState !== undefined &&
      close.status === "completed" &&
      close.cause === "result" &&
      unsettledSteerCount === 0
    ) {
      const usageSnapshot = yield* resolveResultUsageSnapshot(context, message);
      const compaction = yield* maybeCompactBeforeClosing(
        context,
        turnState,
        message,
        usageSnapshot,
      );
      if (compaction === "compacting") return;
      yield* completeTurn(context, close.status, errorMessage, message, {
        resolvedUsage: { snapshot: usageSnapshot },
      });
      if (compaction === "unavailable") yield* emitCompactionUnavailableWarning(context);
      return;
    }
    yield* completeTurn(context, close.status, errorMessage, message);
  });

  /**
   * Synthesizes per-member task.progress rows from the coordinator's
   * workflow_progress array. Member identity is the stable slot
   * `<coordinatorTaskId>:wf:<index>` (never the per-attempt agent id, which
   * changes on retry and would split one member into duplicate rows).
   * timelineBypass keeps these out of the parent chat; the Agents surface and
   * workflow card consume them.
   */
  const emitWorkflowMemberProgress = Effect.fn("emitWorkflowMemberProgress")(function* (
    context: ClaudeSessionContext,
    message: Extract<SDKMessage, { type: "system"; subtype: "task_progress" }>,
    progress: ClaudeWorkflowProgress | undefined,
  ) {
    if (!progress) {
      return;
    }
    const coordinatorId = message.task_id;
    for (const entry of progress.agents) {
      const memberTaskId = `${coordinatorId}:wf:${entry.index}`;
      const status = workflowAgentStatus(entry);
      // Material-transition filter: the wire repeats every member each tick.
      // Emit only when something the client renders actually changed, so a
      // 100-agent fleet costs ~1 event per changed member instead of 100
      // per tick.
      const fingerprint = [
        status,
        entry.label ?? "",
        entry.model ?? "",
        entry.lastToolName ?? "",
        entry.error ?? "",
        entry.tokens ?? "",
        entry.toolCalls ?? "",
        entry.phaseIndex ?? "",
        entry.phaseTitle ?? "",
        entry.attempt ?? "",
      ].join("");
      if (context.workflowMemberFingerprints.get(memberTaskId) === fingerprint) {
        continue;
      }
      context.workflowMemberFingerprints.set(memberTaskId, fingerprint);
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        providerRefs: nativeProviderRefs(context),
        raw: {
          source: "claude.sdk.message" as const,
          method: sdkNativeMethod(message),
          messageType: `${message.type}:${message.subtype}`,
          payload: message,
        },
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(memberTaskId),
          description: entry.label ?? `agent ${entry.index}`,
          status,
          ...(entry.error ? { error: entry.error } : {}),
          ...(entry.label ? { title: entry.label } : {}),
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.lastToolName ? { lastToolName: entry.lastToolName } : {}),
          ...(entry.tokens !== undefined
            ? {
                typedUsage: {
                  totalTokens: entry.tokens,
                  ...(entry.toolCalls !== undefined ? { toolUses: entry.toolCalls } : {}),
                },
              }
            : {}),
          parentAgentId: coordinatorId,
          agentIndex: entry.index,
          ...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
          ...(entry.phaseTitle ? { phaseTitle: entry.phaseTitle } : {}),
          ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
          // A member slot is never a live SDK task, so stopTask on it is a no-op.
          canStop: false,
          timelineBypass: true,
        },
      });
    }
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    // Open a provider ("wake") turn at Claude's own turn-start signal, before
    // the triggering frame's events are built, so they carry the new turn id.
    if (message.subtype === "status" && message.status === "requesting") {
      context.requestingStatusObserved = true;
    }
    // A reported mode is never adopted (it may predate a switch this adapter made); a
    // disagreement only makes the tracked mode unknown, so the next turn sets it.
    const reportedPermissionMode =
      message.subtype === "init" || message.subtype === "status"
        ? message.permissionMode
        : undefined;
    // Defensive: a session launched in Auto whose first init reports the default mode was
    // refused Auto by the CLI, so the turns stop asking for it. A plan or ask turn reports
    // `plan`, which never counts.
    if (
      message.subtype === "init" &&
      context.cliCapabilities === undefined &&
      context.basePermissionMode === "auto" &&
      context.currentPermissionMode === "auto" &&
      reportedPermissionMode === "default"
    ) {
      context.basePermissionMode = undefined;
      yield* Effect.logWarning("claude.auto-mode.refused-by-cli", {
        threadId: context.session.threadId,
        model: message.model,
      });
      yield* emitAutoModeRefusedWarning(context, context.session.model ?? message.model);
    }
    if (
      reportedPermissionMode !== undefined &&
      reportedPermissionMode !== context.currentPermissionMode
    ) {
      context.currentPermissionMode = undefined;
    }
    const wakeSignal = claudeWakeSignal(message);
    if (
      wakeSignal !== undefined &&
      shouldOpenClaudeWakeTurn({
        signal: wakeSignal,
        hasOpenTurn: context.turnState !== undefined,
        sessionStopped: context.stopped,
        promptSent: context.promptSent,
        turnInstallsInFlight: context.turnInstallsInFlight,
        requestingStatusObserved: context.requestingStatusObserved,
      })
    ) {
      if (context.discardedSteerPromptUuids.size > 0) {
        // This may be the CLI turn of a steer Stop cancelled; its first frame tells.
        context.wakeSignalDeferred = true;
      } else {
        yield* startProviderTurn(context, "wake-signal");
      }
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };
    /**
     * A low-key status line (a retry, a banner): never a "Runtime warning" row. `text` is the
     * row's label, so it must stay short; anything longer belongs in `detail`, the row's body.
     * Both read SDK fields, so a frame missing one emits nothing rather than failing the stream.
     */
    const emitNotice = (text: unknown, detail?: unknown) => {
      const notice = typeof text === "string" ? text.trim() : "";
      const body = typeof detail === "string" ? detail.trim() : "";
      return notice.length === 0
        ? Effect.void
        : offerRuntimeEventForContext(context, {
            ...base,
            type: "runtime.notice",
            payload: { message: notice, ...(body.length > 0 ? { detail: body } : {}) },
          });
    };
    /** Provider prose of any length (a hook's reason, a refusal): a fixed label, the text as body. */
    const emitBanner = (label: string, content: unknown) =>
      typeof content === "string" && content.trim().length > 0
        ? emitNotice(label, content)
        : Effect.void;

    // Background-set reconciliation (CC ≥ 2.1.203; the pinned SDK typings
    // don't carry the subtype yet, hence the runtime check before the typed
    // switch). The set carries BACKGROUND tasks only — the CLI's own schema
    // note says a foreground agent joins it when backgrounded, and warns
    // against correlating it with the edge stream. So absence only settles
    // ids we positively observed as backgrounded (earlier set membership or
    // an is_backgrounded patch); a live foreground subagent is simply not a
    // member and must never be settled by this message. Unknown ids in the
    // set get a synthesized start so a partial stream still yields a roster
    // entry, and every member is flagged backgrounded for later settling —
    // that is how a background task whose task_notification drops still
    // stops reading as Working forever.
    if ((message.subtype as string) === "background_tasks_changed") {
      const wire = message as unknown as { background_tasks?: unknown; tasks?: unknown };
      const rawEntries = Array.isArray(wire.background_tasks)
        ? wire.background_tasks
        : Array.isArray(wire.tasks)
          ? wire.tasks
          : [];
      const liveSet = new Map<string, { taskType?: string; description?: string }>();
      for (const entry of rawEntries) {
        if (entry === null || typeof entry !== "object") {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const id =
          typeof record.id === "string" && record.id.trim().length > 0
            ? record.id
            : typeof record.task_id === "string" && record.task_id.trim().length > 0
              ? record.task_id
              : undefined;
        if (id === undefined) {
          continue;
        }
        const taskType =
          typeof record.type === "string" && record.type.length > 0
            ? record.type
            : typeof record.task_type === "string" && record.task_type.length > 0
              ? record.task_type
              : undefined;
        const description =
          typeof record.description === "string" && record.description.trim().length > 0
            ? record.description.trim()
            : undefined;
        liveSet.set(id, {
          ...(taskType !== undefined ? { taskType } : {}),
          ...(description !== undefined ? { description } : {}),
        });
      }

      for (const [taskId, info] of liveSet) {
        // Reuse the existing linkage owner. A membership-only shell must keep
        // its type on sparse progress/completion instead of becoming an agent.
        const previous = context.taskAgents.get(taskId);
        const descriptionChanged =
          info.description !== undefined && info.description !== previous?.description;
        const typeChanged = info.taskType !== undefined && info.taskType !== previous?.taskType;
        context.taskAgents.set(taskId, {
          taskId,
          backgroundAttempt:
            classifyTaskAgentKind({
              taskType: info.taskType ?? previous?.taskType,
              agentId: previous?.owningAgentId,
            }) === "background"
              ? previous?.backgroundAttempt === undefined
                ? 0
                : previous.backgroundAttempt + (context.liveTaskIds.has(taskId) ? 0 : 1)
              : previous?.backgroundAttempt,
          toolUseId: previous?.toolUseId,
          description: info.description ?? previous?.description,
          subagentType: previous?.subagentType,
          taskType: info.taskType ?? previous?.taskType,
          workflowName: previous?.workflowName,
          skipTranscript: previous?.skipTranscript ?? false,
          runHandles: previous?.runHandles,
          owningAgentId: previous?.owningAgentId,
          model: previous?.model,
          effort: previous?.effort,
        });
        const newlyBackgrounded = !context.backgroundedTaskIds.has(taskId);
        context.backgroundedTaskIds.add(taskId);
        if (
          (newlyBackgrounded || descriptionChanged || typeChanged) &&
          context.liveTaskIds.has(taskId)
        ) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEventForContext(context, {
            ...base,
            ...stamp,
            type: "task.updated",
            payload: {
              taskId: RuntimeTaskId.make(taskId),
              isBackgrounded: true,
              ...taskLinkageFor(context.taskAgents, taskId),
            },
          });
        }
      }

      for (const taskId of context.liveTaskIds) {
        if (liveSet.has(taskId) || !context.backgroundedTaskIds.has(taskId)) {
          continue;
        }
        context.liveTaskIds.delete(taskId);
        context.backgroundedTaskIds.delete(taskId);
        const settleStamp = yield* makeEventStamp();
        yield* offerRuntimeEventForContext(context, {
          ...base,
          eventId: settleStamp.eventId,
          createdAt: settleStamp.createdAt,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(taskId),
            status: "stopped",
            ...taskLinkageFor(context.taskAgents, taskId),
          },
        });
        const subagent = context.subagentByTaskId.get(taskId);
        if (subagent) {
          yield* emitClaudeSubagentCompleted(context, {
            subagent,
            status: "stopped",
            raw: message,
          });
        }
      }

      for (const [taskId, info] of liveSet) {
        if (context.liveTaskIds.has(taskId)) {
          continue;
        }
        context.liveTaskIds.add(taskId);
        const startStamp = yield* makeEventStamp();
        yield* offerRuntimeEventForContext(context, {
          ...base,
          eventId: startStamp.eventId,
          createdAt: startStamp.createdAt,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(taskId),
            description: info.description ?? "Background task",
            ...(info.taskType !== undefined ? { taskType: info.taskType } : {}),
            ...(info.description !== undefined ? { title: info.description } : {}),
            ...taskLinkageFor(context.taskAgents, taskId),
          },
        });
      }
      return;
    }

    // Claude's git and pull request signals (untyped, like the background set above): the
    // node's thread git sync refreshes the checkout's status on them, mid-turn.
    const vcsSignal = readClaudeVcsSignal(message);
    if (vcsSignal !== undefined) {
      if (vcsSignal !== null) {
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "vcs.state.changed",
          payload: vcsSignal,
        });
      }
      return;
    }

    switch (message.subtype) {
      case "init":
        context.cliCapabilities = parseClaudeCliCapabilities(message);
        context.supportsAutomaticCompaction = claudeInitAdvertisesNativeCompaction(message);
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });
        return;
      case "status":
        if (message.status === "compacting") {
          context.compactionPolicy = markContextCompactionStarted(
            context.compactionPolicy,
            context.generation,
          );
        } else if (message.compact_result === "failed") {
          // The policy's own `/compact` concludes at its result, which knows whether Stop aborted
          // it: Claude Code reports a stopped compaction as failed.
          if (context.compactionPolicy.requestId === undefined) {
            context.compactionPolicy = disableContextCompaction(
              context.compactionPolicy,
              context.generation,
            );
            yield* emitCompactionUnavailableWarning(context);
          }
        } else if (message.compact_result === "success") {
          context.compactionPolicy = settleContextCompaction(
            context.compactionPolicy,
            context.generation,
          );
        }
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        return;
      case "compact_boundary": {
        context.compactionPolicy = settleContextCompaction(
          context.compactionPolicy,
          context.generation,
        );
        const postCompactionUsage = claudePostCompactionUsage(
          message.compact_metadata,
          context.lastKnownContextWindow,
        );
        // The pre-compaction gauge is gone either way; post_tokens is its only honest
        // replacement until the next main-loop request reports real usage.
        context.lastKnownTokenUsage = postCompactionUsage;
        context.cacheObservation = undefined;
        context.cumulativeUsageSpansCompaction = true;
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });
        if (postCompactionUsage) {
          const usageStamp = yield* makeEventStamp();
          yield* offerRuntimeEventForContext(context, {
            ...base,
            eventId: usageStamp.eventId,
            createdAt: usageStamp.createdAt,
            type: "thread.token-usage.updated",
            payload: {
              usage: withAutomaticCompactionCapability(
                postCompactionUsage,
                context.supportsAutomaticCompaction,
              ),
            },
          });
        }
        return;
      }
      case "hook_started":
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "task_started": {
        // A task launched by a tool that itself ran inside a subagent (the
        // in-flight tool carries agentId from parent_tool_use_id) is
        // agent-internal: a subagent's background shell, not parent work.
        const launchingTool = message.tool_use_id
          ? Array.from(context.inFlightTools.values()).find(
              (tool) => tool.itemId === message.tool_use_id,
            )
          : undefined;
        const parentToolUseId = message.tool_use_id
          ? context.subagentParentByToolUseId.get(message.tool_use_id)
          : undefined;
        const owningAgentId =
          launchingTool?.agentId ?? agentIdForParentToolUse(context.taskAgents, parentToolUseId);
        if (message.tool_use_id) context.subagentParentByToolUseId.delete(message.tool_use_id);
        // Model/effort: the Agent tool's input carries explicit overrides.
        // The subagent's own assistant snapshot is authoritative for its API
        // model and may arrive before or after task_started. Never fill a
        // missing model from context.session.model: that mutable value can
        // already belong to a later parent turn when background task events
        // arrive. AgentInput.effort may be a named level or an integer.
        const launchInput =
          launchingTool?.input ??
          (message.tool_use_id
            ? context.subagentLaunchInputByToolUseId.get(message.tool_use_id)
            : undefined);
        const backgroundFlag = (message as unknown as { is_backgrounded?: boolean })
          .is_backgrounded;
        if (
          backgroundFlag === true ||
          (backgroundFlag === undefined && launchInput?.run_in_background === true)
        ) {
          context.backgroundedTaskIds.add(message.task_id);
        } else if (backgroundFlag === false) {
          context.backgroundedTaskIds.delete(message.task_id);
        }
        const launchTurnId = message.tool_use_id
          ? context.subagentLaunchTurnByToolUseId.get(message.tool_use_id)
          : undefined;
        if (message.tool_use_id) {
          context.subagentLaunchInputByToolUseId.delete(message.tool_use_id);
          context.subagentLaunchTurnByToolUseId.delete(message.tool_use_id);
        }
        const model =
          (message.tool_use_id
            ? context.subagentModelByToolUseId.get(message.tool_use_id)
            : undefined) ?? claudeSubagentLaunchModel(launchInput);
        if (message.tool_use_id) {
          context.subagentModelByToolUseId.delete(message.tool_use_id);
        }
        const rawLaunchEffort = launchInput?.effort;
        const effort =
          trimmedClaudeString(rawLaunchEffort) ??
          (typeof rawLaunchEffort === "number" && Number.isFinite(rawLaunchEffort)
            ? String(rawLaunchEffort)
            : context.currentEffort);
        // Remember the agent identity so every later task.* payload for this
        // taskId is self-describing (identity must survive activity retention).
        const previousTask = context.taskAgents.get(message.task_id);
        context.taskAgents.set(message.task_id, {
          taskId: message.task_id,
          ...(classifyTaskAgentKind({
            taskType: message.task_type ?? previousTask?.taskType,
            agentId: owningAgentId,
          }) === "background"
            ? {
                backgroundAttempt:
                  previousTask?.backgroundAttempt === undefined
                    ? 0
                    : previousTask.backgroundAttempt +
                      (context.liveTaskIds.has(message.task_id) ? 0 : 1),
              }
            : {}),
          toolUseId: message.tool_use_id,
          description: message.description,
          subagentType: message.subagent_type,
          taskType: message.task_type ?? previousTask?.taskType,
          workflowName: message.workflow_name,
          skipTranscript: message.skip_transcript === true,
          runHandles: context.taskAgents.get(message.task_id)?.runHandles,
          owningAgentId,
          model,
          effort,
        });
        context.liveTaskIds.add(message.task_id);
        yield* offerRuntimeEventForContext(context, {
          ...base,
          ...(launchTurnId ? { turnId: asCanonicalTurnId(launchTurnId) } : {}),
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            ...(typeof backgroundFlag === "boolean" ? { isBackgrounded: backgroundFlag } : {}),
            description: message.description,
            ...(message.task_type ? { taskType: message.task_type } : {}),
            ...(owningAgentId ? { agentId: owningAgentId } : {}),
            ...(message.description ? { title: message.description } : {}),
            ...(message.subagent_type ? { role: message.subagent_type } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
          },
        });
        if (
          isClaudeSubagentTaskMessage(message) ||
          (message.task_type !== undefined &&
            classifyTaskAgentKind({ taskType: message.task_type, agentId: owningAgentId }) ===
              "agent")
        ) {
          const subagent = makeClaudeTaskSubagentRef(
            context.subagentByTaskId.get(message.task_id),
            message,
            context.taskAgents.get(message.task_id),
          );
          context.subagentByTaskId.set(message.task_id, subagent);
          yield* emitClaudeSubagentStarted(context, subagent, message);
        }
        return;
      }
      case "task_progress": {
        if (
          message.usage &&
          !context.mainLoopUsageObserved &&
          !isClaudeSubagentTaskMessage(message) &&
          !context.taskAgents.get(message.task_id)?.toolUseId
        ) {
          const normalizedUsage = normalizeClaudeTokenUsage(
            message.usage,
            context.lastKnownContextWindow,
          );
          if (normalizedUsage) {
            context.lastKnownTokenUsage = normalizedUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEventForContext(context, {
              ...base,
              eventId: usageStamp.eventId,
              createdAt: usageStamp.createdAt,
              type: "thread.token-usage.updated",
              payload: {
                usage: withAutomaticCompactionCapability(
                  {
                    ...normalizedUsage,
                    ...(context.cacheObservation ? { claudeCache: context.cacheObservation } : {}),
                  },
                  context.supportsAutomaticCompaction,
                ),
              },
            });
          }
        }
        const progressLinkage = taskLinkageFor(context.taskAgents, message.task_id);
        const progressTypedUsage = normalizeTaskUsage(message.usage);
        // Phases ride on the coordinator's ONE progress row per tick. A
        // separate phases-only row would share the stable ingestion activity
        // id with this full row, and the thinner upsert would overwrite
        // usage and progress text.
        const workflowProgress = parseWorkflowProgress(
          (message as unknown as Record<string, unknown>).workflow_progress,
        );
        const workflowPhases = mergeWorkflowPhases(
          context.workflowPhasesByTaskId.get(message.task_id),
          workflowProgress?.phases,
        );
        if (workflowPhases.length > 0) {
          context.workflowPhasesByTaskId.set(message.task_id, workflowPhases);
        }
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(progressTypedUsage ? { typedUsage: progressTypedUsage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            ...(workflowPhases.length > 0 ? { phases: workflowPhases } : {}),
            ...progressLinkage,
            ...(message.subagent_type ? { role: message.subagent_type } : {}),
          },
        });
        yield* emitWorkflowMemberProgress(context, message, workflowProgress);
        // A workflow coordinator ticks several times a second for its whole
        // run, and each subagent update is its own persisted row: hundreds of
        // members' ticks pushed every member row out of the thread's activity
        // window. Its latest-state progress row above and the member rows
        // already carry everything those updates said.
        const isWorkflowCoordinator =
          context.taskAgents.get(message.task_id)?.taskType === "local_workflow";
        if (
          !isWorkflowCoordinator &&
          (isClaudeSubagentTaskMessage(message) || context.subagentByTaskId.has(message.task_id))
        ) {
          const subagent = makeClaudeTaskSubagentRef(
            context.subagentByTaskId.get(message.task_id),
            message,
            context.taskAgents.get(message.task_id),
          );
          context.subagentByTaskId.set(message.task_id, subagent);
          yield* emitClaudeSubagentUpdated(context, {
            subagent,
            status: claudeTaskSubagentStatus("running"),
            ...(message.summary ? { summary: message.summary } : {}),
            detail: message.description,
            ...(message.usage ? { usage: message.usage } : {}),
            raw: message,
          });
        }
        return;
      }
      case "task_updated": {
        // Status patch (killed/paused/backgrounded/end_time/error) —
        // previously dropped on the floor as an unknown subtype, losing all
        // transitions.
        const patch = message.patch;
        const status =
          patch.status !== undefined ? CLAUDE_TASK_PATCH_STATUS[patch.status] : undefined;
        // Every terminal RuntimeTaskStatus clears local liveness, so a
        // patch-terminated task can never draw a redundant stop request.
        // ("interrupted" has no patch mapping today; covering it costs
        // nothing and survives a future mapping.)
        if (
          status === "completed" ||
          status === "failed" ||
          status === "cancelled" ||
          status === "interrupted"
        ) {
          context.liveTaskIds.delete(message.task_id);
          context.backgroundedTaskIds.delete(message.task_id);
        }
        if (patch.is_backgrounded !== undefined) {
          if (patch.is_backgrounded) {
            context.backgroundedTaskIds.add(message.task_id);
          } else {
            context.backgroundedTaskIds.delete(message.task_id);
          }
        }
        const endedAt =
          typeof patch.end_time === "number" && Number.isFinite(patch.end_time)
            ? DateTime.formatIso(DateTime.makeUnsafe(patch.end_time))
            : undefined;
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            ...(status ? { status } : {}),
            ...(patch.description ? { description: patch.description } : {}),
            ...(patch.error ? { error: patch.error } : {}),
            ...(endedAt ? { endedAt } : {}),
            ...(patch.is_backgrounded !== undefined
              ? { isBackgrounded: patch.is_backgrounded }
              : {}),
            ...taskLinkageFor(context.taskAgents, message.task_id),
          },
        });
        return;
      }
      case "task_notification": {
        context.liveTaskIds.delete(message.task_id);
        context.backgroundedTaskIds.delete(message.task_id);
        if (
          message.usage &&
          !context.mainLoopUsageObserved &&
          !isClaudeSubagentTaskMessage(message) &&
          !context.taskAgents.get(message.task_id)?.toolUseId
        ) {
          const normalizedUsage = normalizeClaudeTokenUsage(
            message.usage,
            context.lastKnownContextWindow,
          );
          if (normalizedUsage) {
            context.lastKnownTokenUsage = normalizedUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEventForContext(context, {
              ...base,
              eventId: usageStamp.eventId,
              createdAt: usageStamp.createdAt,
              type: "thread.token-usage.updated",
              payload: {
                usage: withAutomaticCompactionCapability(
                  {
                    ...normalizedUsage,
                    ...(context.cacheObservation ? { claudeCache: context.cacheObservation } : {}),
                  },
                  context.supportsAutomaticCompaction,
                ),
              },
            });
          }
        }
        const completionTypedUsage = normalizeTaskUsage(message.usage);
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(completionTypedUsage ? { typedUsage: completionTypedUsage } : {}),
            ...(message.output_file ? { outputFile: message.output_file } : {}),
            ...taskLinkageFor(context.taskAgents, message.task_id),
          },
        });
        if (isClaudeSubagentTaskMessage(message) || context.subagentByTaskId.has(message.task_id)) {
          const subagent = makeClaudeTaskSubagentRef(
            context.subagentByTaskId.get(message.task_id),
            message,
            context.taskAgents.get(message.task_id),
          );
          context.subagentByTaskId.set(message.task_id, subagent);
          yield* emitClaudeSubagentCompleted(context, {
            subagent,
            status: claudeTaskCompletionStatus(message.status),
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            raw: message,
          });
        }
        return;
      }
      case "files_persisted":
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      case "thinking_tokens":
        return;
      case "permission_denied":
        yield* offerRuntimeEventForContext(context, {
          ...base,
          type: "tool.denied",
          payload: {
            toolName: message.tool_name,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.decision_reason ? { reason: message.decision_reason } : {}),
            ...(message.agent_id ? { agentId: message.agent_id } : {}),
          },
        });
        return;
      case "mirror_error":
        yield* emitRuntimeError(
          context,
          `Claude workspace mirror error: ${message.error}`,
          message,
        );
        return;
      case "api_retry": {
        const retry = claudeApiRetryNotice(message);
        yield* emitNotice(retry.message, retry.detail);
        return;
      }
      case "commands_changed":
        // The full list after a change (skills found as the agent works, MCP prompts): it
        // replaces what the session reported before and is served for its directory while it
        // runs (`readLiveProjectCommands`). Menu bookkeeping, not transcript content.
        context.slashCommands = {
          commands: parseClaudeSlashCommands(message.commands),
          order: ++nextSlashCommandsOrder,
        };
        return;
      case "informational":
        // `info` lines show only in Claude Code's transcript mode. A tool-scoped line is that
        // tool's live progress, which the CLI dedupes per tool use; the tool's own row already
        // tracks it, so it is dropped. The rest are banners: hook feedback, a block reason.
        if (message.level !== "info" && message.tool_use_id === undefined) {
          yield* emitBanner(claudeInformationalLabel(message), message.content);
        }
        return;
      case "notification":
        // The REPL's transient toast queue; only what it would interrupt for earns a row.
        if (message.priority === "high" || message.priority === "immediate") {
          yield* emitBanner("Claude notification", message.text);
        }
        return;
      case "local_command_output":
        // A slash command's own output (/usage, /context): the answer the user asked for.
        yield* emitBanner("Command output", message.content);
        return;
      case "memory_recall": {
        const count = Array.isArray(message.memories) ? message.memories.length : 0;
        if (count > 0) {
          yield* emitNotice(`Recalled ${count} ${count === 1 ? "memory" : "memories"}`);
        }
        return;
      }
      case "model_refusal_fallback":
        yield* emitBanner("Model switched after a refusal", message.content);
        return;
      case "model_refusal_no_fallback":
        yield* emitBanner("Claude declined the request", message.content);
        return;
      case "plugin_install":
        // Headless install progress; only a failure is actionable.
        if (message.status === "failed") {
          yield* emitNotice(
            message.name
              ? `Claude plugin install failed: ${message.name}`
              : "Claude plugin install failed",
            message.error,
          );
        }
        return;
      case "session_state_changed":
        // Turn boundaries come from results and wake signals; a second idle/running source
        // would race them over the session's status.
        return;
      case "control_request_progress":
        // Progress of a control request this adapter already bounds with its own deadline.
        return;
      case "elicitation_complete":
        // Confirms a URL-mode MCP elicitation, which this adapter never opens.
        return;
      case "worker_shutting_down":
        // Remote Control bridge teardown; a local CLI's exit ends the stream itself.
        return;
      default: {
        // A subtype newer than the pinned SDK: the conversation gets nothing it cannot explain,
        // and the server log (kept at its default level, unlike the provider event log's
        // lifecycle mode) gets the subtype with a redacted preview, once per subtype a window.
        const rawSubtype = (message as { readonly subtype?: unknown }).subtype;
        const subtype = typeof rawSubtype === "string" ? rawSubtype : String(rawSubtype);
        yield* logOnceEvery({
          key: `claude.system-message.unhandled:${subtype}`,
          message: "claude.system-message.unhandled",
          level: "Info",
          fields: {
            threadId: context.session.threadId,
            subtype,
            preview: boundedJsonPreview(secretRedactor.payload(message)),
          },
        });
        return;
      }
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEventForContext(context, {
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { taskId: RuntimeTaskId.make(message.task_id) } : {}),
          ...(message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined
            ? { parentToolUseId: message.parent_tool_use_id }
            : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEventForContext(context, {
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? {
                precedingToolUseIds: message.preceding_tool_use_ids,
              }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEventForContext(context, {
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      const transition = message.rate_limit_info
        ? applyClaudeRateLimitInfo(context.rejectedRateLimitWindows, message.rate_limit_info)
        : undefined;
      yield* offerRuntimeEventForContext(context, {
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
          usageLimitState: claudeUsageLimitState(
            context.rejectedRateLimitWindows,
            yield* Clock.currentTimeMillis,
          ),
        },
      });
      const turnState = context.turnState;
      if (transition?.blocked && turnState) {
        const announced = (turnState.announcedUsageLimitKeys ??= new Set());
        if (!announced.has(transition.key)) {
          announced.add(transition.key);
          yield* emitRuntimeWarning(context, CLAUDE_USAGE_LIMIT_FALLBACK_MESSAGE, {
            usageLimit: { limitType: transition.limitType, resetAt: transition.resetAt },
          });
        }
      }
      return;
    }
  });

  /** Plain interrupt for a CLI segment Stop already ended; bounded, failures only logged. */
  const forkReinterrupt = (context: ClaudeSessionContext, reason: string) =>
    Effect.tryPromise({
      // Invoke through the query object: SDK methods rely on `this`.
      try: () => context.query.interrupt(),
      catch: (cause) =>
        toSessionRequestError(context, context.session.threadId, "turn/interrupt", cause),
    }).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.tap(() =>
        Effect.logInfo("claude.turn.reinterrupted", {
          threadId: context.session.threadId,
          reason,
        }),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkDetach,
      Effect.asVoid,
    );

  /**
   * A discarded steer's CLI turn turned out to be the one a provider turn was opened for (by its
   * `status: requesting`, legacy `init`, `api_retry` or compaction frame, before its echo). That
   * turn has routed no content: retract it.
   */
  const retractDiscardedSteerWakeTurn = Effect.fn("retractDiscardedSteerWakeTurn")(function* (
    context: ClaudeSessionContext,
  ) {
    const turnState = context.turnState;
    if (
      turnState === undefined ||
      turnState.openedBy !== "wake-signal" ||
      turnState.rootContentObserved ||
      turnState.steerPromptUuids.size > 0
    ) {
      return;
    }
    yield* completeTurn(context, "interrupted", DISCARDED_STEER_TURN_REASON, undefined, {
      abortReason: DISCARDED_STEER_TURN_REASON,
      expectedTurnState: turnState,
    });
  });

  /**
   * The discarded CLI turn's result: forget its uuids, then drop it (keeping its usage). Returns
   * whether it was consumed. Only this result can end the open turn when:
   * - it echoes the open turn's prompt or steer, which the CLI folded into the discarded CLI turn
   *   (a fold shows only on the result). That turn's reply went with the dropped frames, and the
   *   discard's re-interrupt usually aborted it, so the result closes it here as failed (never as
   *   a Stop the user did not press);
   * - the CLI turn's output already reached an open provider turn (its frames carried no echo,
   *   or beat Stop's bookkeeping). The result is routed on and completes that turn.
   */
  const endDiscardedSteerCliTurn = Effect.fn("endDiscardedSteerCliTurn")(function* (
    context: ClaudeSessionContext,
    message: SDKResultMessage,
    uuids: Iterable<string>,
  ) {
    let count = 0;
    for (const uuid of uuids) {
      context.discardedSteerPromptUuids.delete(uuid);
      count += 1;
    }
    context.discardingCliTurn = undefined;
    context.wakeSignalDeferred = false;
    const open = context.turnState;
    if (open !== undefined) {
      const logContext = {
        threadId: context.session.threadId,
        turnId: open.turnId,
        openedBy: open.openedBy,
        uuids: count,
      };
      const folded = claudeEchoNamesTurn({
        echoed: claudeEchoedPromptUuids(message),
        promptUuid: open.promptUuid,
        steerPromptUuids: open.steerPromptUuids,
      });
      if (folded) {
        yield* Effect.logInfo("claude.turn.discarded-steer-folded-open-turn", logContext);
        yield* handleResultMessage(context, message, { foldedIntoDiscardedCliTurn: true });
        return true;
      }
      if (open.promptUuid === undefined && open.rootContentObserved) {
        yield* Effect.logInfo("claude.turn.discarded-steer-output-leaked", logContext);
        return false;
      }
    }
    yield* emitTokenUsageSnapshot(
      context,
      yield* resolveResultUsageSnapshot(context, message),
      undefined,
    );
    yield* retractDiscardedSteerWakeTurn(context);
    yield* Effect.logInfo("claude.turn.discarded-cancelled-steer", {
      threadId: context.session.threadId,
      uuids: count,
    });
    return true;
  });

  /**
   * Routes frames of CLI segments started by steers. Returns true when the frame was consumed
   * (dropped, or a result that already closed the open turn). The echo is read on a CLI turn's
   * first reply frame (its first stream event, or its first root assistant message when it
   * streamed nothing) and on its result. A CLI turn whose echo holds only steers Stop (or a failed
   * segment) discarded is interrupted again (unless its reply is an API error, which ends it
   * anyway) and dropped up to and including its result; a result with such an echo and no reply
   * before it is dropped alone. Either result still ends the open turn when only it can (see
   * `endDiscardedSteerCliTurn`). The open turn owns its own steers' segments; after Stop, one that
   * starts is interrupted again too, with the same API-error exception.
   */
  const routeSteerFrame = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const discarding = context.discardingCliTurn;
    if (discarding !== undefined) {
      switch (message.type) {
        case "result":
          return yield* endDiscardedSteerCliTurn(context, message, [
            ...discarding.uuids,
            ...claudeEchoedPromptUuids(message),
          ]);
        case "stream_event":
        case "assistant":
        case "user":
        case "tool_progress":
        case "tool_use_summary":
          return true;
        default:
          // Task lifecycle (system) and rate-limit frames stay session truth.
          return false;
      }
    }

    if (
      message.type !== "stream_event" &&
      message.type !== "assistant" &&
      message.type !== "result"
    )
      return false;
    const echoed = claudeEchoedPromptUuids(message);
    if (echoed.length === 0) return false;

    const discarded = context.discardedSteerPromptUuids;
    const turnState = context.turnState;
    const owned =
      turnState !== undefined &&
      claudeEchoNamesTurn({
        echoed,
        promptUuid: turnState.promptUuid,
        steerPromptUuids: turnState.steerPromptUuids,
      });
    // An API-error reply ends its CLI turn: an interrupt now would reach the CLI's next turn.
    const reinterruptable = !isClaudeApiErrorReply(message);
    if (owned || !echoed.every((uuid) => discarded.has(uuid))) {
      if (owned && message.type !== "result") {
        // Its output now streams into this turn, so Stop must wait for its result even when a
        // receipt written before it started still lists it as queued.
        for (const uuid of echoed) {
          if (turnState.steerPromptUuids.has(uuid)) turnState.startedSteerPromptUuids.add(uuid);
        }
        // S5: a steer that was in transit at Stop started its own segment. End it too.
        const echoKey = [...echoed].toSorted().join(" ");
        if (
          reinterruptable &&
          turnState.interruptRequested &&
          echoed.some(
            (uuid) =>
              turnState.steerPromptUuids.has(uuid) && !turnState.settledSteerPromptUuids.has(uuid),
          ) &&
          !turnState.reinterruptedEchoKeys.has(echoKey)
        ) {
          turnState.reinterruptedEchoKeys.add(echoKey);
          yield* forkReinterrupt(context, "steer-segment-after-stop");
        }
      }
      // The CLI consumed these uuids in a CLI turn that is not dropped (the open turn's, or one
      // batched with another prompt), so they never start a CLI turn of their own.
      for (const uuid of echoed) discarded.delete(uuid);
      return false;
    }

    if (message.type === "result") {
      // The discarded CLI turn ended with no echo before its result: it failed or the re-run
      // aborted before replying, or its reply carried no echo.
      return yield* endDiscardedSteerCliTurn(context, message, echoed);
    }

    // The CLI turn's first reply frame: drop it and the rest of the CLI turn. A deferred wake turn
    // never opens (only content opens it, after this check).
    context.discardingCliTurn = { uuids: new Set(echoed) };
    context.wakeSignalDeferred = false;
    if (reinterruptable) yield* forkReinterrupt(context, "discarded-steer-segment");
    yield* Effect.logInfo("claude.turn.discarding-cancelled-steer", {
      threadId: context.session.threadId,
      uuids: echoed.length,
    });
    yield* retractDiscardedSteerWakeTurn(context);
    return true;
  });

  /**
   * Publishes Claude Code's Fast mode serving state as a turn-less `session.configured` whose
   * camelCase `fastModeState` key never matches the raw init forwarded with snake_case fields.
   */
  const observeClaudeFastModeState = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const report = readClaudeFastModeFrame(message);
    if (report === undefined) return;
    const decision = decideClaudeFastModePublish({
      previousSignature: context.lastFastModeSignature,
      report,
      isResult: message.type === "result",
      fastRequested: context.fastModeRequested,
    });
    context.lastFastModeSignature = decision.signature;
    if (!decision.publish) return;
    const model = context.session.model;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "session.configured",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      payload: {
        config: {
          fastModeState: {
            state: report.state,
            ...(report.disabledReason !== undefined
              ? { disabledReason: report.disabledReason }
              : {}),
            ...(model !== undefined ? { model } : {}),
            // Lets a client tell Fast mode it no longer requests from Fast mode set elsewhere.
            requested: context.fastModeRequested,
          },
        },
      },
      providerRefs: {},
    });
  });

  // Untraced, like the other helpers that run once per SDK message (every stream delta
  // included): a span each made them a large share of the server trace.
  const handleSdkMessage = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);
    // Before steer routing: a dropped steer turn's result still reports the session's Fast mode.
    if (
      !context.probing &&
      (message.type === "result" || (message.type === "system" && message.subtype === "init"))
    ) {
      yield* observeClaudeFastModeState(context, message);
    }
    if (yield* routeSteerFrame(context, message)) return;
    // After steer routing (dropped steer frames never move it), before dispatch: completing the turn records this as the turn's transcript head.
    const chainUuid = claudeMainChainUuid(message);
    if (chainUuid !== undefined && context.turnState) context.turnState.lastChainUuid = chainUuid;
    const rootContent = isClaudeRootTurnFrame(message);
    if (context.wakeSignalDeferred) {
      // Only content can open the deferred turn: its first frame carries the echo, which
      // routeSteerFrame already checked. A result ends the signalling CLI turn either way.
      if (rootContent) {
        context.wakeSignalDeferred = false;
        if (context.turnState === undefined) yield* startProviderTurn(context, "wake-signal");
      } else if (message.type === "result") {
        context.wakeSignalDeferred = false;
      }
    }
    const waiting = context.turnState;
    if (waiting?.awaitingSteerContinuation !== undefined && rootContent) {
      waiting.awaitingSteerContinuation = undefined;
    }
    yield* routeSdkMessage(context, message);
    // After routing, so a turn opened by `status: compacting` is marked by its own trigger.
    const open = context.turnState;
    if (open && !open.rootOutputObserved && isClaudeRootTurnOutput(message)) {
      open.rootOutputObserved = true;
    }
    if (open && rootContent) open.rootContentObserved = true;
  });

  /**
   * Claude Code's predicted next prompt, sent after a turn's result. Offered only for a turn that
   * completed and while no newer turn is open: a suggestion that arrives once the next turn
   * started (a wake turn, a quick send) predicts a reply the user has not seen yet.
   */
  const handlePromptSuggestion = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    text: string,
  ) {
    const finished = context.lastFinishedTurn;
    const suggestion = normalizePromptSuggestion(text, PROMPT_SUGGESTION_MAX_CHARS);
    if (
      context.probing ||
      context.turnState !== undefined ||
      finished === undefined ||
      finished.status !== "completed" ||
      suggestion === undefined
    ) {
      return;
    }
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "turn.prompt-suggestion",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: finished.turnId,
      payload: { suggestion },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const routeSdkMessage = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* handleResultMessage(context, message);
        return;
      case "system":
        yield* handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);
        return;
      case "prompt_suggestion":
        yield* handlePromptSuggestion(context, message.suggestion);
        return;
      default:
        yield* emitRuntimeWarning(
          context,
          `Unhandled Claude SDK message type '${message.type}'.`,
          message,
        );
        return;
    }
  });

  const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
    Stream.fromAsyncIterable(context.query, (cause) =>
      toError(withClaudeProcessStderr(context, cause), "Claude runtime stream failed."),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) =>
        context.turnLock.withPermits(1)(handleSdkMessage(context, message)),
      ),
    );

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, Error>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      if (isClaudeInterruptedCause(exit.cause)) {
        if (context.turnState) {
          yield* completeTurn(
            context,
            "interrupted",
            interruptionMessageFromClaudeCause(exit.cause),
          );
        }
      } else {
        const message = messageFromClaudeStreamCause(exit.cause, "Claude runtime stream failed.");
        yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
        yield* completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: {
      readonly emitExitEvent?: boolean;
      /**
       * Close the query first and wait up to this long for the CLI to exit (its
       * output closing ends the stream) before interrupting the stream fiber. A
       * rewind must not reopen the transcript while the old CLI still writes it.
       */
      readonly awaitQueryExitMs?: number;
    },
  ) {
    if (context.stopped) return;

    context.stopped = true;
    context.discardedSteerPromptUuids.clear();
    context.discardingCliTurn = undefined;
    context.wakeSignalDeferred = false;
    context.deviceToolBinding?.dispose();
    if (context.agentControl) yield* context.agentControl.revoke("runtime-teardown");

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "request.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision: "cancel",
        },
        providerRefs: nativeProviderRefs(context),
      });
    }
    context.pendingApprovals.clear();

    // Same reason as the approvals above: a request nobody can answer any more
    // must not stay open, or the thread can never be settled.
    for (const pending of context.pendingUserInputs.values()) {
      yield* pending.cancel;
    }

    if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Session stopped.");
    }

    yield* Queue.shutdown(context.promptQueue);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;
    const closeQuery = Effect.gen(function* () {
      // @effect-diagnostics-next-line tryCatchInEffectGen:off
      try {
        context.query.close();
      } catch (cause) {
        yield* emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
      }
    });
    if (options?.awaitQueryExitMs !== undefined) {
      yield* closeQuery;
      if (streamFiber && streamFiber.pollUnsafe() === undefined) {
        const exited = yield* Fiber.await(streamFiber).pipe(
          Effect.timeoutOption(Duration.millis(options.awaitQueryExitMs)),
        );
        if (Option.isNone(exited)) yield* Fiber.interrupt(streamFiber);
      }
    } else {
      if (streamFiber && streamFiber.pollUnsafe() === undefined) {
        yield* Fiber.interrupt(streamFiber);
      }
      yield* closeQuery;
    }

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: "Session stopped",
          exitKind: "graceful",
        },
        providerRefs: {},
      });
    }

    sessions.delete(context.session.threadId);
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      if (input.providerInstanceId !== undefined && input.providerInstanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider instance '${boundInstanceId}' but received '${input.providerInstanceId}'.`,
        });
      }
      const runtimeSessionId = yield* requireRuntimeSessionId(PROVIDER, input);
      if (rewindingThreads.has(input.threadId)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Claude is rewinding this thread; try again in a moment.",
        });
      }

      const existingContext = sessions.get(input.threadId);
      if (existingContext) {
        if (existingContext.session.runtimeSessionId === runtimeSessionId) {
          return existingContext.session;
        }
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Thread '${input.threadId}' still has runtime '${existingContext.session.runtimeSessionId ?? "legacy"}'; stop it before starting '${runtimeSessionId}'.`,
        });
      }
      yield* failIfTranscriptMissing(input);
      const context = yield* openSessionContext(input, {});
      return { ...context.session };
    },
  );

  /**
   * Claude starts a resume of a session whose transcript it deleted (its default cleanup, a
   * moved config) and only fails it on the first prompt, with "No conversation found". The start
   * fails with that error instead, before any turn reaches Claude, so the orchestrator can start
   * fresh or carry the conversation over by context handoff. Only a session whose transcript this
   * config root was seen to hold (`transcriptSeen`) and whose `projects` directory now lacks it
   * counts. Any other cursor (a wrapper binary or a container whose store is elsewhere, a cursor
   * from before the marker), an unreadable store, or a config root without `projects/` resumes as
   * before and fails on the first prompt.
   */
  const failIfTranscriptMissing = Effect.fn("failIfTranscriptMissing")(function* (
    input: ProviderSessionStartInput,
  ) {
    if (input.resumePolicy === "fresh") return;
    const resumeState = readClaudeResumeState(input.resumeCursor);
    const sessionId = resumeState?.resume;
    if (sessionId === undefined || resumeState?.transcriptSeen !== true) return;
    const presence = yield* checkTranscriptPresence(sessionId);
    yield* Effect.annotateCurrentSpan({ "claude.resume.transcript": presence });
    if (presence !== "missing") return;
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session/resume",
      detail: `No conversation found with session ID ${sessionId}: Claude no longer keeps its transcript.`,
    });
  });

  /**
   * Opens a query for `input` and registers its context. With `probe`, the
   * reopened CLI must accept a control request before this succeeds; a failed
   * probe stops the context silently (no runtime.error or session.exited).
   */
  const openSessionContext = Effect.fn("openSessionContext")(function* (
    input: ProviderSessionStartInput,
    openOptions: {
      readonly probe?: boolean;
      /** Validates the truncation at boot; only for an immediate rewind reopen. */
      readonly resumeDropsTurn?: string;
      readonly turnHeads?: ReadonlyArray<{ readonly turnId: TurnId; readonly head: string }>;
    },
  ) {
    const runtimeSessionId = yield* requireRuntimeSessionId(PROVIDER, input);
    const startedAt = yield* nowIso;
    const effectiveResumeCursor = input.resumePolicy === "fresh" ? undefined : input.resumeCursor;
    const resumeState = readClaudeResumeState(effectiveResumeCursor);
    const threadId = input.threadId;
    const existingResumeSessionId = resumeState?.resume;
    const newSessionId =
      existingResumeSessionId === undefined
        ? yield* Effect.sync(() => crypto.randomUUID())
        : undefined;
    const sessionId = existingResumeSessionId ?? newSessionId;

    const runtimeContext = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(runtimeContext);
    const runPromise = Effect.runPromiseWith(runtimeContext);

    const promptQueue = yield* Queue.bounded<PromptQueueItem>(64);
    const prompt = Stream.fromQueue(promptQueue).pipe(
      Stream.filter((item) => item.type === "message"),
      Stream.map((item) => item.message),
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
      ),
      Stream.toAsyncIterable,
    );

    const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
    const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
    const inFlightTools = new Map<number, ToolInFlight>();

    const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);
    let deviceToolContext: ClaudeSessionContext | undefined;
    // Which subagent made each device tool call, as its PreToolUse hook saw it: the gateway
    // gives every agent the driving guide once and screen diffs of its own.
    const deviceToolCallers = new Map<string, string>();
    const deviceToolBinding = createProcessDeviceToolBinding({
      threadId,
      isTurnActive: () => deviceToolContext?.turnState !== undefined && !deviceToolContext.stopped,
      agentKeyFor: (toolUseId) =>
        toolUseId === undefined ? undefined : deviceToolCallers.get(toolUseId),
    });

    /**
     * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
     * runtime event and waiting for the user to respond via `respondToUserInput`.
     */
    const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
      context: ClaudeSessionContext,
      toolInput: Record<string, unknown>,
      callbackOptions: {
        readonly signal: AbortSignal;
        readonly requestId: string;
        readonly toolUseID?: string;
      },
    ) {
      if (callbackOptions.signal.aborted || context.stopped) {
        return {
          behavior: "deny",
          message: "User cancelled tool execution.",
        } satisfies PermissionResult;
      }
      const requestId = ApprovalRequestId.make(callbackOptions.requestId);

      // Parse questions from the SDK's AskUserQuestion input.
      // `id` MUST equal the full question text — Claude SDK >= 2.1.121 looks
      // up answers by question text in `mapToolResultToToolResultBlockParam`,
      // so the key the UI uses to keep its draft answer must match the SDK's
      // expected lookup key. See https://github.com/sak0a/ryco/issues/2388
      const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const questions: Array<UserInputQuestion> = rawQuestions.map(
        (q: Record<string, unknown>, idx: number) => ({
          id: typeof q.question === "string" && q.question.length > 0 ? q.question : `q-${idx}`,
          header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
          question: typeof q.question === "string" ? q.question : "",
          options: Array.isArray(q.options)
            ? q.options.map((opt: Record<string, unknown>) => ({
                label: typeof opt.label === "string" ? opt.label : "",
                description: typeof opt.description === "string" ? opt.description : "",
              }))
            : [],
          multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
        }),
      );

      const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
      let aborted = false;
      const settleAsAborted = Effect.suspend(() => {
        if (pendingUserInputs.get(requestId) !== pendingInput) {
          return Effect.void;
        }
        aborted = true;
        pendingUserInputs.delete(requestId);
        return Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers).pipe(
          Effect.ignore,
        );
      });
      const pendingInput: PendingUserInput = {
        questions,
        answers: answersDeferred,
        cancel: settleAsAborted,
      };

      const requestedStamp = yield* makeEventStamp();
      // Own the callback before publication can yield to a response or shutdown.
      if (pendingUserInputs.has(requestId)) {
        return {
          behavior: "deny",
          message: "A question with this request ID is already pending.",
        } satisfies PermissionResult;
      }
      pendingUserInputs.set(requestId, pendingInput);
      yield* offerRuntimeEventForContext(context, {
        type: "user-input.requested",
        eventId: requestedStamp.eventId,
        provider: PROVIDER,
        createdAt: requestedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState
          ? {
              turnId: asCanonicalTurnId(context.turnState.turnId),
            }
          : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: { questions },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/AskUserQuestion",
          payload: {
            toolName: "AskUserQuestion",
            input: toolInput,
          },
        },
      });

      // Handle abort (e.g. turn interrupted while waiting for user input).
      const onAbort = () => {
        runFork(settleAsAborted);
      };
      callbackOptions.signal.addEventListener("abort", onAbort, {
        once: true,
      });

      // Abort can happen while the request is being published, before the listener exists.
      if (callbackOptions.signal.aborted || context.stopped) yield* settleAsAborted;

      // Release the listener on answers, cancellation, and interrupted waits alike.
      const answers = yield* Deferred.await(answersDeferred).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            callbackOptions.signal.removeEventListener("abort", onAbort);
            if (pendingUserInputs.get(requestId) === pendingInput)
              pendingUserInputs.delete(requestId);
          }),
        ),
      );

      // Emit user-input.resolved so the UI knows the interaction completed.
      const resolvedStamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "user-input.resolved",
        eventId: resolvedStamp.eventId,
        provider: PROVIDER,
        createdAt: resolvedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState
          ? {
              turnId: asCanonicalTurnId(context.turnState.turnId),
            }
          : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          answers,
          cancelled: aborted,
          userInputIdentity: {
            requestEventId: requestedStamp.eventId,
            ...(context.session.runtimeSessionId
              ? { runtimeSessionId: context.session.runtimeSessionId }
              : {}),
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/AskUserQuestion/resolved",
          payload: { answers },
        },
      });

      if (aborted) {
        return {
          behavior: "deny",
          message: "User cancelled tool execution.",
        } satisfies PermissionResult;
      }

      // Return the answers to the SDK in the expected format:
      // { questions: [...], answers: { questionText: selectedLabel } }
      return {
        behavior: "allow",
        updatedInput: {
          questions: toolInput.questions,
          answers,
        },
      } satisfies PermissionResult;
    });

    const canUseToolEffect = Effect.fn("canUseTool")(function* (
      toolName: Parameters<CanUseTool>[0],
      toolInput: Parameters<CanUseTool>[1],
      callbackOptions: Parameters<CanUseTool>[2],
    ) {
      const context = yield* Ref.get(contextRef);
      if (!context) {
        return {
          behavior: "deny",
          message: "Claude session context is unavailable.",
        } satisfies PermissionResult;
      }

      // Handle AskUserQuestion: surface clarifying questions to the
      // user via the user-input runtime event channel, regardless of
      // runtime mode (plan mode relies on this heavily).
      if (toolName === "AskUserQuestion") {
        return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
      }

      if (toolName === "ExitPlanMode") {
        const planMarkdown = extractExitPlanModePlan(toolInput);
        if (planMarkdown) {
          yield* emitProposedPlanCompleted(context, {
            planMarkdown,
            toolUseId: callbackOptions.toolUseID,
            rawSource: "claude.sdk.permission",
            rawMethod: "canUseTool/ExitPlanMode",
            rawPayload: {
              toolName,
              input: toolInput,
            },
          });
        }

        return {
          behavior: "deny",
          message:
            "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
        } satisfies PermissionResult;
      }

      const runtimeMode = input.runtimeMode ?? "full-access";
      if (runtimeMode === "full-access") {
        return {
          behavior: "allow",
          updatedInput: toolInput,
        } satisfies PermissionResult;
      }

      const requestId = ApprovalRequestId.make(callbackOptions.requestId);
      const requestType = classifyRequestType(toolName);
      const detail = summarizeToolRequest(toolName, toolInput);
      const presentation = claudeApprovalPresentation({ detail, options: callbackOptions });
      const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
      const pendingApproval: PendingApproval = {
        requestType,
        detail,
        decision: decisionDeferred,
        ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
        ...(presentation.acceptForSessionOffered === false
          ? { acceptForSessionOffered: false }
          : {}),
      };

      const requestedStamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "request.opened",
        eventId: requestedStamp.eventId,
        provider: PROVIDER,
        createdAt: requestedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType,
          detail,
          ...presentation,
          args: {
            toolName,
            input: toolInput,
            ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/request",
          payload: {
            toolName,
            input: toolInput,
          },
        },
      });

      pendingApprovals.set(requestId, pendingApproval);

      const onAbort = () => {
        if (!pendingApprovals.has(requestId)) {
          return;
        }
        pendingApprovals.delete(requestId);
        runFork(Deferred.succeed(decisionDeferred, "cancel"));
      };

      callbackOptions.signal.addEventListener("abort", onAbort, {
        once: true,
      });

      const requestedDecision = yield* Deferred.await(decisionDeferred);
      pendingApprovals.delete(requestId);
      // A request that refused a session-wide grant (a client that predates the flag can still
      // offer it) is answered, and reported, as one approval.
      const decision: ProviderApprovalDecision =
        requestedDecision === "acceptForSession" &&
        pendingApproval.acceptForSessionOffered === false
          ? "accept"
          : requestedDecision;

      const resolvedStamp = yield* makeEventStamp();
      yield* offerRuntimeEventForContext(context, {
        type: "request.resolved",
        eventId: resolvedStamp.eventId,
        provider: PROVIDER,
        createdAt: resolvedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType,
          decision,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/decision",
          payload: {
            decision,
          },
        },
      });

      if (decision === "accept" || decision === "acceptForSession") {
        if (
          decision === "acceptForSession" &&
          pendingApproval.suggestions?.some((suggestion) => suggestion.type === "setMode")
        ) {
          // The CLI applies the suggested mode itself; the next turn sets its own.
          context.currentPermissionMode = undefined;
        }
        return {
          behavior: "allow",
          updatedInput: toolInput,
          ...(decision === "acceptForSession" && pendingApproval.suggestions
            ? {
                updatedPermissions: [...pendingApproval.suggestions],
              }
            : {}),
        } satisfies PermissionResult;
      }

      return {
        behavior: "deny",
        message:
          decision === "cancel"
            ? "User cancelled tool execution."
            : "User declined tool execution.",
      } satisfies PermissionResult;
    });

    const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
      runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

    const pendingSubagentMessages = new Map<string, Array<string>>();
    // The only SDK channel into a running subagent: a PreToolUse hook's input carries the
    // calling agent's `agent_id` (its task id), and its additionalContext reaches that agent.
    // It runs on every tool call, so the path without a waiting message stays trivial.
    const subagentMessageHook: HookCallback = async (hookInput) => {
      const agentId = "agent_id" in hookInput ? hookInput.agent_id : undefined;
      if (pendingSubagentMessages.size === 0 || typeof agentId !== "string") return {};
      const message = takeSubagentMessages(pendingSubagentMessages, agentId);
      if (message === null) return {};
      await runPromise(
        Effect.gen(function* () {
          const context = yield* Ref.get(contextRef);
          if (!context) return;
          const agent = context.taskAgents.get(agentId);
          yield* emitRuntimeNotice(
            context,
            `${agent?.description ?? "The agent"} read your message.`,
            message,
          );
        }),
      ).catch(() => undefined);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: claudeSubagentMessageContext(message),
        },
      } satisfies HookJSONOutput;
    };

    const deviceToolCallerHook: HookCallback = async (hookInput) => {
      if (!("tool_name" in hookInput) || !("tool_use_id" in hookInput)) return {};
      const agentId = "agent_id" in hookInput ? hookInput.agent_id : undefined;
      if (
        typeof agentId === "string" &&
        typeof hookInput.tool_use_id === "string" &&
        hookInput.tool_name.startsWith(`mcp__${CLAUDE_DEVICE_TOOL_SERVER}__`)
      ) {
        rememberBounded(deviceToolCallers, hookInput.tool_use_id, agentId, 256);
      }
      return {};
    };
    // Native subagents start with their own system prompt: the device routing rules go with them.
    const deviceRoutingSubagentHook: HookCallback = async () => ({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: DEVICE_ROUTING_INSTRUCTIONS,
      },
    });

    const claudeBinaryPath = claudeSettings.binaryPath;
    // Claude Code forces thinking display to "omitted" in SDK sessions unless
    // the display is set explicitly on the command line. Ryco renders the
    // thinking in the transcript, so ask for summaries — unless the user's
    // own launch args already choose a display.
    const extraArgs = {
      "thinking-display": "summarized",
      ...parseCliArgs(claudeSettings.launchArgs).flags,
    };
    const modelSelection =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
    const caps = getClaudeModelCapabilities(modelSelection?.model);
    const descriptors = getProviderOptionDescriptors({ caps });
    const apiModelId = modelSelection ? resolveClaudeApiModelId(modelSelection) : undefined;
    const rawEffort = getModelSelectionStringOptionValue(modelSelection, "effort");
    const effort = resolveClaudeEffort(caps, rawEffort) ?? null;
    const thinkingSupported = descriptors.some(
      (descriptor) => descriptor.type === "boolean" && descriptor.id === "thinking",
    );
    const fastMode = resolveClaudeFastMode(modelSelection);
    const thinking = thinkingSupported
      ? getModelSelectionBooleanOptionValue(modelSelection, "thinking")
      : undefined;
    const ultracode = isClaudeUltracodeEffort(effort);
    const effectiveEffort = getEffectiveClaudeAgentEffort(effort, modelSelection?.model);
    const runtimeModeToPermission: Record<string, PermissionMode> = {
      "auto-accept-edits": "acceptEdits",
      auto: "auto",
      "full-access": "bypassPermissions",
    };
    // Fail closed when this instance's Claude Code says the model cannot run Auto: the session
    // starts in the CLI's default mode and says so. Its runtime mode stays "auto", so the
    // orchestrator never sees a mode change and restarts it. Unknown support keeps Auto.
    const autoModeRefused =
      input.runtimeMode === "auto" &&
      modelSelection !== undefined &&
      options?.resolveAutoModeSupport !== undefined &&
      (yield* options.resolveAutoModeSupport(modelSelection.model)) === false;
    const permissionMode = autoModeRefused ? undefined : runtimeModeToPermission[input.runtimeMode];
    const settings = {
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
      ...(ultracode ? { ultracode: true } : {}),
      // Claude Code reads its auto-compact window only at start-up. A configured window applies
      // in both modes, so its own mid-turn compaction is bounded by it too; without one, the
      // user's own `/autocompact` choice stands. `autoCompactEnabled` is left to the user's
      // Claude config: the window applies without it (claudeCompactionCliProbe.test.ts).
      ...(nativeAutoCompactWindow !== undefined
        ? { autoCompactWindow: nativeAutoCompactWindow }
        : {}),
    };
    const tokenMode = input.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE;
    const tokenReductionInstructions = yield* readTokenReductionInstructions(tokenMode);
    const customSystemPrompt = formatProjectCustomSystemPrompt(input.customSystemPrompt);
    const appendSystemPrompt = [
      ASSISTANT_ATTACHMENT_INSTRUCTIONS,
      deviceToolBinding ? DEVICE_ROUTING_INSTRUCTIONS : undefined,
      tokenReductionInstructions,
      customSystemPrompt,
    ]
      .map((part) => part?.trim())
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n\n");
    let agentControl = Option.getOrUndefined(
      yield* installAgentControlNativeHttp(options?.agentControl, {
        threadId,
        providerInstanceId: boundInstanceId,
        runtimeSessionId,
        injectionMode: "claude-http",
      }),
    );
    const mcpServers = {
      ...(deviceToolBinding
        ? {
            // Deferred behind tool search where Claude Code offers it: a session that never
            // touches a device pays only for the routing rules, not the catalogue.
            [CLAUDE_DEVICE_TOOL_SERVER]: {
              type: "http" as const,
              url: deviceToolBinding.url,
              headers: { ...deviceToolBinding.headers },
            },
          }
        : {}),
      ...(agentControl
        ? {
            [AGENT_CONTROL_INTERNAL_SERVER_NAME]: {
              ...agentControl.mcpServer,
              alwaysLoad: true,
            },
          }
        : {}),
    };
    // Claude Code and every job it starts carry the thread's id, so the servers it leaves running
    // stay listed under this thread (`localServers/threadAttributionEnv.ts`).
    const sessionEnvironment = withThreadAttribution(claudeEnvironment, threadId);
    // Only when agent priority changes the argv; otherwise the SDK spawns Claude Code itself.
    // Read per session: open sessions follow a change once they restart.
    const promptSuggestions =
      options?.promptSuggestionsEnabled === undefined
        ? false
        : yield* options.promptSuggestionsEnabled;
    const claudeCodeSpawn = yield* prepareClaudeCodeSpawn(options?.processPriority, {
      binaryPath: claudeBinaryPath,
      env: sessionEnvironment,
      cwd: input.cwd,
    });
    const queryOptions: ClaudeQueryOptions = {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(apiModelId ? { model: apiModelId } : {}),
      pathToClaudeCodeExecutable: claudeBinaryPath,
      ...(claudeCodeSpawn
        ? { spawnClaudeCodeProcess: claudeCodeSpawn.spawnClaudeCodeProcess }
        : {}),
      // The SDK only reads appended text from `systemPrompt.append`; a top-level
      // `appendSystemPrompt` query option is silently dropped.
      systemPrompt: appendSystemPrompt
        ? { type: "preset", preset: "claude_code", append: appendSystemPrompt }
        : { type: "preset", preset: "claude_code" },
      settingSources: [...CLAUDE_SETTING_SOURCES],
      ...(effectiveEffort
        ? {
            effort: effectiveEffort as unknown as NonNullable<ClaudeQueryOptions["effort"]>,
          }
        : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
      // Only a rewind pins the resume point: a plain resume follows the newest leaf.
      ...(existingResumeSessionId && resumeState?.rewindAt
        ? { resumeSessionAt: resumeState.rewindAt }
        : {}),
      ...(existingResumeSessionId && resumeState?.rewindAt && openOptions.resumeDropsTurn
        ? { resumeDropsTurn: openOptions.resumeDropsTurn }
        : {}),
      ...(newSessionId ? { sessionId: newSessionId } : {}),
      includePartialMessages: true,
      ...(promptSuggestions ? { promptSuggestions: true } : {}),
      canUseTool,
      hooks: {
        PreToolUse: [
          { hooks: [subagentMessageHook] },
          ...(deviceToolBinding ? [{ hooks: [deviceToolCallerHook] }] : []),
        ],
        ...(deviceToolBinding ? { SubagentStart: [{ hooks: [deviceRoutingSubagentHook] }] } : {}),
      },
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      env: sessionEnvironment,
      ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
      ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
    };

    yield* Effect.annotateCurrentSpan({
      "provider.kind": PROVIDER,
      "provider.thread_id": threadId,
      "provider.runtime_mode": input.runtimeMode,
      "claude.resume.source":
        existingResumeSessionId !== undefined ? "resume-session" : "generated-session",
      "claude.resume.thread_id": resumeState?.threadId ?? "",
      "claude.resume.session_id": existingResumeSessionId ?? "",
      "claude.resume.session_at": resumeState?.resumeSessionAt ?? "",
      "claude.resume.turn_count": resumeState?.turnCount ?? -1,
      "claude.query.cwd": input.cwd ?? "",
      "claude.query.model": apiModelId ?? "",
      "claude.query.effort": effectiveEffort ?? "",
      "claude.query.permission_mode": permissionMode ?? "",
      "claude.query.auto_mode_refused": autoModeRefused,
      "claude.query.system_prompt_append_bytes": Buffer.byteLength(appendSystemPrompt, "utf8"),
      "claude.query.allow_dangerously_skip_permissions": permissionMode === "bypassPermissions",
      "claude.query.resume": existingResumeSessionId ?? "",
      "claude.query.session_id": newSessionId ?? "",
      "claude.query.include_partial_messages": true,
      "claude.query.additional_directories": input.cwd ? [input.cwd] : [],
      "claude.query.setting_sources": [...CLAUDE_SETTING_SOURCES],
      "claude.query.settings_json": JSON.stringify(settings),
      "claude.query.extra_args_json": JSON.stringify(extraArgs),
      "claude.query.path_to_executable": claudeBinaryPath,
      "claude.query.process_priority": claudeCodeSpawn ? "exec-nice" : "sdk-default",
    });

    const queryRuntime = yield* Effect.try({
      try: () =>
        createQuery({
          prompt,
          options: queryOptions,
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail: redactAgentControlSecrets(
            toMessage(cause, "Failed to start Claude runtime session."),
          ) as string,
          cause: redactAgentControlSecrets(cause),
        }),
    }).pipe(
      Effect.tapError(() => Effect.sync(() => deviceToolBinding?.dispose())),
      Effect.onError(() => (agentControl ? agentControl.revoke("runtime-teardown") : Effect.void)),
    );

    if (agentControl) {
      const status = queryRuntime.mcpServerStatus
        ? yield* Effect.tryPromise({
            try: () => queryRuntime.mcpServerStatus!(),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: "Agent Control MCP status check failed.",
                cause: redactAgentControlSecrets(cause),
              }),
          }).pipe(
            Effect.timeoutOption("8 seconds"),
            Effect.onInterrupt(() => agentControl!.revoke("runtime-teardown")),
            Effect.catch(() => Effect.succeed(Option.none())),
          )
        : Option.none<ReadonlyArray<{ readonly name: string; readonly status: string }>>();
      const installed = Option.exists(status, (servers) =>
        servers.some(
          (server) =>
            server.name === AGENT_CONTROL_INTERNAL_SERVER_NAME && server.status === "connected",
        ),
      );
      if (!installed) {
        yield* agentControl.revoke("runtime-teardown");
        agentControl = undefined;
      }
    }

    // A resumed session continues its task list; any other start (a fresh policy, a handoff, a
    // native fork's new session id) begins empty. No plan event: the thread already shows the
    // list's last plan, or, after a revert, gets it with the next task result. A fresh start
    // replaces a session whose list the thread may still show, so its list starts unshown and its
    // first task result is sent even when it finds no tasks.
    const planTasks = new ClaudePlanTaskTracker(
      input.resumePolicy === "fresh"
        ? { tasks: [], shown: false }
        : readClaudePlanTasksFromCursor(effectiveResumeCursor, existingResumeSessionId),
    );
    const session: ProviderSession = {
      threadId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      runtimeSessionId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      tokenMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      ...(threadId ? { threadId } : {}),
      resumeCursor: {
        ...(threadId ? { threadId } : {}),
        ...(sessionId ? { resume: sessionId } : {}),
        ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
        ...(existingResumeSessionId && resumeState?.rewindAt
          ? { rewind: { at: resumeState.rewindAt } }
          : {}),
        turnCount: resumeState?.turnCount ?? 0,
        ...(resumeState?.transcriptSeen ? { transcriptSeen: true } : {}),
        ...planTasksCursorField(planTasks, sessionId),
      },
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    const generation = ++nextSessionGeneration;
    const { resumeCursor: _resumeCursor, resumePolicy: _resumePolicy, ...startInput } = input;
    const context: ClaudeSessionContext = {
      generation,
      session,
      startInput,
      turnHeads: [...(openOptions.turnHeads ?? [])],
      pendingRewind:
        existingResumeSessionId && resumeState?.rewindAt ? { at: resumeState.rewindAt } : undefined,
      ...(claudeCodeSpawn ? { processStderrTail: claudeCodeSpawn.stderrTail } : {}),
      probing: openOptions.probe === true,
      probeFailure: openOptions.probe === true ? Deferred.makeUnsafe<string>() : undefined,
      promptQueue,
      query: queryRuntime,
      cliCommand: claudeBinaryPath,
      cliInitialized: false,
      deviceToolBinding,
      ...(agentControl ? { agentControl } : {}),
      agentControlHostContext:
        agentControl?.hostContext ?? (options?.agentControl ? agentControlHostContext(false) : ""),
      agentControlHostContextDelivered: false,
      streamFiber: undefined,
      startedAt,
      basePermissionMode: permissionMode,
      autoModeRefusedWarningEmitted: false,
      currentPermissionMode: permissionMode,
      currentApiModelId: apiModelId,
      currentEffort: effectiveEffort ?? undefined,
      resumeSessionId: sessionId,
      transcriptSeenFor: resumeState?.transcriptSeen ? existingResumeSessionId : undefined,
      transcriptCheckedFor: resumeState?.transcriptSeen ? existingResumeSessionId : undefined,
      pendingApprovals,
      pendingUserInputs,
      completedTurnIds: [],
      inFlightTools,
      planTasks,
      suppressedSubagentBlocks: new Map(),
      taskAgents: new Map(),
      subagentLaunchInputByToolUseId: new Map(),
      subagentLaunchTurnByToolUseId: new Map(),
      subagentModelByToolUseId: new Map(),
      subagentParentByToolUseId: new Map(),
      workflowMemberFingerprints: new Map(),
      rejectedRateLimitWindows: new Map(),
      workflowPhasesByTaskId: new Map(),
      liveTaskIds: new Set(),
      pendingSubagentMessages,
      backgroundedTaskIds: new Set(),
      turnState: undefined,
      lastKnownContextWindow: undefined,
      lastKnownTokenUsage: undefined,
      cacheObservation: undefined,
      mainLoopUsageObserved: false,
      cumulativeUsageSpansCompaction: false,
      cacheModelSelection: modelSelection,
      compactionPolicy: initialContextCompactionPolicyState(generation),
      supportsAutomaticCompaction: false,
      fastModeRequested: fastMode,
      lastFastModeSignature: undefined,
      compactionUnavailableWarningEmitted: false,
      lastAssistantUuid: resumeState?.resumeSessionAt,
      lastThreadStartedId: undefined,
      subagentByTaskId: new Map(),
      startedSubagentIds: new Set(),
      completedSubagentIds: new Set(),
      stopped: false,
      promptSent: false,
      turnInstallsInFlight: 0,
      requestingStatusObserved: false,
      cliCapabilities: undefined,
      slashCommands: undefined,
      discardedSteerPromptUuids: new Set(),
      discardingCliTurn: undefined,
      wakeSignalDeferred: false,
      turnLock: yield* Semaphore.make(1),
    };
    deviceToolContext = context;
    yield* Ref.set(contextRef, context);
    sessions.set(threadId, context);

    const sessionStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "session.started",
      eventId: sessionStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: sessionStartedStamp.createdAt,
      threadId,
      payload: effectiveResumeCursor !== undefined ? { resume: effectiveResumeCursor } : {},
      providerRefs: {},
    });

    const configuredStamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "session.configured",
      eventId: configuredStamp.eventId,
      provider: PROVIDER,
      createdAt: configuredStamp.createdAt,
      threadId,
      payload: {
        config: {
          ...(apiModelId ? { model: apiModelId } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(effectiveEffort ? { effort: effectiveEffort } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(fastMode ? { fastMode: true } : {}),
        },
      },
      providerRefs: {},
    });
    if (autoModeRefused) yield* emitAutoModeRefusedWarning(context, modelSelection?.model);

    const readyStamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "session.state.changed",
      eventId: readyStamp.eventId,
      provider: PROVIDER,
      createdAt: readyStamp.createdAt,
      threadId,
      payload: {
        state: "ready",
      },
      providerRefs: {},
    });

    let streamFiber: Fiber.Fiber<void, never>;
    streamFiber = runFork(
      Effect.exit(runSdkStream(context)).pipe(
        Effect.flatMap((exit) => {
          if (context.stopped) {
            return Effect.void;
          }
          if (context.streamFiber === streamFiber) {
            context.streamFiber = undefined;
          }
          // While probing, an exit is the reopen failing, not a session ending.
          if (context.probing && context.probeFailure) {
            return Deferred.succeed(
              context.probeFailure,
              Exit.isFailure(exit)
                ? messageFromClaudeStreamCause(exit.cause, "Claude runtime stream failed.")
                : "Claude exited while reopening the conversation.",
            ).pipe(Effect.asVoid);
          }
          return handleStreamExit(context, exit);
        }),
      ),
    );
    context.streamFiber = streamFiber;
    streamFiber.addObserver(() => {
      if (context.streamFiber === streamFiber) {
        context.streamFiber = undefined;
      }
    });

    if (context.probing && context.probeFailure) {
      const probeFailure = context.probeFailure;
      const controlRequest = Effect.tryPromise({
        try: () =>
          queryRuntime.initializationResult?.() ??
          queryRuntime.mcpServerStatus?.() ??
          Promise.resolve(),
        catch: (cause) =>
          toMessage(
            withClaudeProcessStderr(context, cause),
            "Claude rejected the reopened conversation.",
          ),
      });
      const probe = yield* Effect.raceFirst(
        controlRequest.pipe(Effect.asVoid),
        Deferred.await(probeFailure).pipe(Effect.flatMap((detail) => Effect.fail(detail))),
      ).pipe(Effect.timeoutOption(CLAUDE_REWIND_PROBE_TIMEOUT), Effect.result);
      context.probing = false;
      if (probe._tag === "Success" && Option.isSome(probe.success)) context.cliInitialized = true;
      const failure =
        probe._tag === "Failure"
          ? probe.failure
          : Option.isNone(probe.success)
            ? "Claude did not respond while reopening the conversation."
            : Deferred.isDoneUnsafe(probeFailure)
              ? "Claude exited while reopening the conversation."
              : undefined;
      if (failure !== undefined) {
        yield* stopSessionInternal(context, { emitExitEvent: false });
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail: failure,
        });
      }
    }

    return context;
  });

  /**
   * Bounds the CLI's startup on a runtime's first turn. The control requests sendTurn makes
   * (setModel, setPermissionMode) are answered only after it, so a CLI that hangs while loading
   * would hold the send until the turn-acceptance deadline. One that misses the deadline is
   * stopped, so the next send starts a fresh CLI.
   */
  const awaitCliInitialized = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    threadId: ThreadId,
  ) {
    if (context.cliInitialized || context.query.initializationResult === undefined) return;
    const initialized = yield* Effect.tryPromise({
      // Invoke through the query object: SDK methods rely on `this`.
      try: () => context.query.initializationResult!(),
      catch: (cause) => toSessionRequestError(context, threadId, "initialize", cause),
    }).pipe(timeoutWhileResponsiveOption(CLAUDE_STARTUP_INITIALIZE_TIMEOUT_MS));
    if (Option.isSome(initialized)) {
      context.cliInitialized = true;
      return;
    }
    yield* stopSessionInternal(context);
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "initialize",
      detail: providerStartupPhaseTimeoutDetail({
        command: context.cliCommand,
        request: "Claude Code `initialize`",
        timeoutMs: CLAUDE_STARTUP_INITIALIZE_TIMEOUT_MS,
        hint: `Run \`${context.cliCommand}\` in a terminal to check that it is signed in and that its plugins and MCP servers load, then send the message again.`,
      }),
    });
  });

  const sendTurnOnContext = Effect.fn("sendTurnOnContext")(function* (
    context: ClaudeSessionContext,
    input: ProviderSendTurnInput,
  ) {
    yield* awaitCliInitialized(context, input.threadId);
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;

    if (modelSelection?.model) {
      const apiModelId = resolveClaudeApiModelId(modelSelection);
      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toSessionRequestError(context, input.threadId, "turn/setModel", cause),
        });
        context.currentApiModelId = apiModelId;
        context.lastKnownContextWindow = undefined;
        context.lastKnownTokenUsage = undefined;
      }
      context.cacheModelSelection = modelSelection;
      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
      const turnEffort = resolveClaudeEffort(
        getClaudeModelCapabilities(modelSelection.model),
        getModelSelectionStringOptionValue(modelSelection, "effort"),
      );
      context.currentEffort =
        getEffectiveClaudeAgentEffort(turnEffort ?? null, modelSelection.model) ?? undefined;
      // Fast mode changes in-session (`modelSelectionChangeRestartsSession`), so background work
      // the runtime still runs keeps running. `null` clears the flag-layer key, as Claude Code's
      // own toggle does, which leaves the speed to Claude Code's settings as a start without
      // Fast mode does.
      const fastMode = resolveClaudeFastMode(modelSelection);
      if (fastMode !== context.fastModeRequested) {
        yield* Effect.tryPromise({
          try: () => context.query.applyFlagSettings({ fastMode: fastMode ? true : null }),
          catch: (cause) =>
            toSessionRequestError(context, input.threadId, "turn/applyFlagSettings", cause),
        });
        context.fastModeRequested = fastMode;
        // The next report republishes with the new request, even if the state holds.
        context.lastFastModeSignature = undefined;
      }
    }

    // Apply interaction mode by switching the SDK's permission mode.
    // "plan" maps directly to the SDK's "plan" permission mode;
    // "ask" also maps to "plan" — the SDK's only read-only permission
    // mode — so the turn cannot perform file edits or run commands;
    // "default" restores the session's original permission mode.
    // When interactionMode is absent we leave the current mode unchanged.
    // A mode the process is known to be in already costs no control round trip.
    const targetPermissionMode = claudePermissionModeForInteraction(
      input.interactionMode,
      context.basePermissionMode,
    );
    if (
      targetPermissionMode !== undefined &&
      targetPermissionMode !== context.currentPermissionMode
    ) {
      // Unknown until the CLI acknowledged the switch.
      context.currentPermissionMode = undefined;
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode(targetPermissionMode),
        catch: (cause) =>
          toSessionRequestError(context, input.threadId, "turn/setPermissionMode", cause),
      });
      context.currentPermissionMode = targetPermissionMode;
    }

    const promptUuid = yield* Effect.sync(() => crypto.randomUUID());
    const turnId = TurnId.make(promptUuid);
    const startedAt = yield* nowIso;

    // Closes a stale provider turn, one opened while the awaits above yielded,
    // or waits for an in-flight completion. Re-checks until no turn is open.
    while (context.turnState !== undefined) {
      yield* completeTurn(context, "completed");
    }
    // No yield between the last check and the install.
    const turnState = makeClaudeTurnState({ turnId, promptUuid, startedAt, openedBy: "prompt" });
    context.turnState = turnState;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: startedAt,
    };
    context.promptSent = true;

    const turnStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: modelSelection?.model ? { model: modelSelection.model } : {},
      providerRefs: {},
    });

    // A slash command must lead the prompt; the context waits for the next turn.
    const hostContextPrefix =
      isSlashCommandInput(input.input) ||
      context.agentControlHostContextDelivered ||
      context.agentControlHostContext.length === 0
        ? undefined
        : `<ryco_host_context>${context.agentControlHostContext}</ryco_host_context>`;
    if (hostContextPrefix) context.agentControlHostContextDelivered = true;
    const message = yield* buildUserMessageEffect(
      hostContextPrefix
        ? {
            ...input,
            input: [hostContextPrefix, input.input].filter(Boolean).join("\n\n"),
          }
        : input,
      {
        fileSystem,
        attachmentsDir: serverConfig.attachmentsDir,
        boundInstanceId,
      },
    );

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message: { ...message, uuid: promptUuid },
    }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

    if (context.agentControl) {
      yield* context.agentControl.bindTurn(turnId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to bind Agent Control turn authority", {
            threadId: input.threadId,
            turnId,
            cause,
          }),
        ),
      );
    }

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    // Counted from entry to install, so no provider turn opens under a send in flight; the
    // release also runs when the send fails or is interrupted.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        context.turnInstallsInFlight += 1;
      }),
      () => sendTurnOnContext(context, input),
      () =>
        Effect.sync(() => {
          context.turnInstallsInFlight -= 1;
        }),
    );
  });

  /**
   * Adds a user message to the exact running turn: an SDK user message with `priority: "now"`
   * and its own uuid. The Ryco turn keeps its id and absorbs the CLI segments the steer starts.
   * Refusals are `ProviderTurnNotSteerableError`, so the message stays queued as the next turn.
   */
  const steerTurn: NonNullable<ClaudeAdapterShape["steerTurn"]> = Effect.fn("steerTurn")(
    function* (input) {
      const context = yield* requireSession(input.threadId);
      const refuse = (reason: "turn-ended" | "busy" | "unsupported", detail: string) =>
        new ProviderTurnNotSteerableError({
          provider: PROVIDER,
          threadId: input.threadId,
          turnId: input.expectedTurnId,
          reason,
          detail,
        });
      const turnState = context.turnState;
      if (
        !turnState ||
        turnState.turnId !== input.expectedTurnId ||
        context.session.activeTurnId !== input.expectedTurnId ||
        turnState.interruptRequested
      ) {
        return yield* refuse("turn-ended", STEER_TURN_ENDED_DETAIL);
      }
      if (context.pendingApprovals.size > 0 || context.pendingUserInputs.size > 0) {
        return yield* refuse(
          "busy",
          "Claude is waiting for an approval or answer. The message stays queued.",
        );
      }
      // A steer would stop the compaction the policy sent; the message runs after it instead.
      if (turnState.compactionPromptUuid !== undefined) {
        return yield* refuse("busy", STEER_TURN_COMPACTING_DETAIL);
      }
      if (!context.cliCapabilities?.has(CLAUDE_CLI_CAPABILITY_INTERRUPT_RECEIPT)) {
        return yield* refuse(
          "unsupported",
          "This Claude Code version can't steer a running turn. The message stays queued.",
        );
      }
      if (input.input?.trimStart().startsWith("/")) {
        return yield* refuse(
          "unsupported",
          "Slash commands can't be steered into a running turn. The message stays queued.",
        );
      }
      // No host-context prefix: that is delivered only with sendTurn. The effort prefix follows
      // the running turn's model selection.
      const message = yield* buildUserMessageEffect(
        {
          threadId: input.threadId,
          ...(input.input ? { input: input.input } : {}),
          attachments: input.attachments ?? [],
          ...(context.cacheModelSelection ? { modelSelection: context.cacheModelSelection } : {}),
        },
        { fileSystem, attachmentsDir: serverConfig.attachmentsDir, boundInstanceId },
      );
      const steerUuid = yield* Effect.sync(() => crypto.randomUUID());
      // Re-check identity after the attachment reads: the turn or the context may have changed,
      // and the turn's result may have started its compaction.
      const registered = yield* context.turnLock.withPermits(1)(
        Effect.gen(function* () {
          if (
            sessions.get(input.threadId) !== context ||
            context.stopped ||
            context.turnState !== turnState ||
            turnState.interruptRequested ||
            turnState.completion !== undefined
          ) {
            return "turn-ended" as const;
          }
          if (turnState.compactionPromptUuid !== undefined) return "compacting" as const;
          turnState.steerPromptUuids.add(steerUuid);
          const offered = yield* Queue.offer(context.promptQueue, {
            type: "message",
            message: { ...message, uuid: steerUuid, priority: "now" },
          });
          if (!offered) turnState.steerPromptUuids.delete(steerUuid);
          return offered ? ("registered" as const) : ("turn-ended" as const);
        }),
      );
      if (registered === "compacting") {
        return yield* refuse("busy", STEER_TURN_COMPACTING_DETAIL);
      }
      if (registered === "turn-ended") {
        return yield* refuse("turn-ended", STEER_TURN_ENDED_DETAIL);
      }
      yield* Effect.logInfo("claude.turn.steered", {
        threadId: input.threadId,
        turnId: turnState.turnId,
        awaiting: turnState.awaitingSteerContinuation !== undefined,
      });
      return { threadId: context.session.threadId, turnId: turnState.turnId };
    },
  );

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, turnId) {
      const context = yield* requireSession(threadId);
      const target = context.turnState;
      // Stop is thread-scoped: the open turn never waits for a steer again.
      if (target) target.interruptRequested = true;
      if (context.agentControl) yield* context.agentControl.retireTurn(turnId);
      // Stop-everything semantics: users reach for Stop precisely when a
      // fleet ran away. interrupt() alone only ends the parent turn —
      // background subagents/shells keep running and keep burning tokens.
      // Stop every live task first (best-effort per task: one refusal must
      // not strand the rest or block the turn interrupt), then interrupt.
      if (context.query.stopTask && context.liveTaskIds.size > 0) {
        const liveIds = Array.from(context.liveTaskIds);
        // Bounded: a wedged child's stopTask promise may never settle
        // (Effect.ignore handles rejection, not non-resolution), and the
        // parent interrupt below MUST still run — Stop matters most during
        // runaway fleets. Per-task timeout keeps one hung child from
        // consuming the whole budget.
        yield* Effect.forEach(
          liveIds,
          (taskId) =>
            Effect.gen(function* () {
              const stopAcknowledged = yield* Effect.tryPromise({
                // Invoke through the query object: SDK methods rely on `this`.
                try: () => context.query.stopTask!(taskId),
                catch: () => undefined,
              }).pipe(
                Effect.timeoutOption("3 seconds"),
                Effect.orElseSucceed(() => Option.none()),
              );
              if (Option.isNone(stopAcknowledged) || !context.liveTaskIds.delete(taskId)) {
                return;
              }

              // The separate task notification can lose its race with the
              // parent interrupt. Treat an acknowledged stop as authoritative
              // durable state for the Agents surface.
              const stamp = yield* makeEventStamp();
              yield* offerRuntimeEventForContext(context, {
                type: "task.completed",
                eventId: stamp.eventId,
                provider: PROVIDER,
                createdAt: stamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                payload: {
                  taskId: RuntimeTaskId.make(taskId),
                  status: "stopped",
                  ...taskLinkageFor(context.taskAgents, taskId),
                },
                providerRefs: nativeProviderRefs(context),
              });
            }).pipe(Effect.ignore),
          { concurrency: 8, discard: true },
        ).pipe(Effect.timeoutOption("10 seconds"), Effect.ignore);
      }
      const unsettledAtStop = target
        ? [...target.steerPromptUuids].filter((uuid) => !target.settledSteerPromptUuids.has(uuid))
        : [];
      // Only with steers pending: cancel_queued also drops queued task notifications. Without
      // steers, Stop stays exactly the plain interrupt it always was.
      const cancelQueued =
        unsettledAtStop.length > 0 &&
        context.cliCapabilities?.has(CLAUDE_CLI_CAPABILITY_INTERRUPT_CANCEL_QUEUED) === true;
      const rawReceipt = yield* Effect.tryPromise({
        // Invoke through the query object: SDK methods rely on `this`.
        try: () =>
          cancelQueued
            ? context.query.interrupt({ cancelQueued: true })
            : context.query.interrupt(),
        catch: (cause) => toSessionRequestError(context, threadId, "turn/interrupt", cause),
      });
      if (target !== undefined && target.steerPromptUuids.size > 0) {
        const receipt = readClaudeInterruptReceipt(rawReceipt);
        yield* Effect.logInfo("claude.turn.interrupt-receipt", {
          threadId: context.session.threadId,
          turnId: target.turnId,
          cancelQueued,
          hasReceipt: receipt !== undefined,
          stillQueued: receipt?.stillQueued.length ?? 0,
          cancelled: receipt?.cancelled?.length ?? 0,
        });
        yield* context.turnLock.withPermits(1)(
          Effect.gen(function* () {
            if (context.stopped) return;
            const stop = decideClaudeStop({
              unsettledSteers: [...target.steerPromptUuids].filter(
                (uuid) => !target.settledSteerPromptUuids.has(uuid),
              ),
              startedSteers: target.startedSteerPromptUuids,
              promptUuid: target.promptUuid,
              sealedSegmentCount: target.sealedSegmentCount,
              awaitingSteerContinuation: target.awaitingSteerContinuation !== undefined,
              receipt,
            });
            // The stream fiber can take the lock first and close the turn on its result. That
            // result saw `interruptRequested` and already discarded every unsettled steer, so
            // only the cancelled ones (which never run) are left to release.
            if (context.turnState === target) {
              for (const uuid of stop.discard) {
                rememberDiscardedSteer(context.discardedSteerPromptUuids, uuid);
              }
            }
            // Settled too: a stopped turn's closing result discards its unsettled steers, and a
            // cancelled one would then never leave the discard set.
            for (const uuid of stop.release) {
              context.discardedSteerPromptUuids.delete(uuid);
              target.settledSteerPromptUuids.add(uuid);
            }
            if (stop.forceClose && context.turnState === target) {
              // No CLI segment of this turn is running, so no result will close it.
              yield* completeTurn(context, "interrupted", "Interrupted by user.", undefined, {
                expectedTurnState: target,
              });
            }
          }),
        );
      }
      // The CLI may never report a result for a provider turn it was not asked to run, or for a
      // compaction segment it stopped. Give it a grace period, then finish the turn locally.
      // Forked: Stop must never block the reactor.
      const compacting = target?.compactionPromptUuid !== undefined;
      if (
        target !== undefined &&
        (target.openedBy !== "prompt" || compacting) &&
        (turnId === undefined || target.turnId === turnId)
      ) {
        yield* Effect.sleep(Duration.millis(CLAUDE_PROVIDER_TURN_STOP_GRACE_MS)).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              // A result (or another close) already ended or is ending the turn.
              if (
                context.turnState !== target ||
                target.completion !== undefined ||
                context.stopped
              ) {
                return Effect.void;
              }
              return Effect.logInfo("claude.turn.provider-turn-finalized-after-stop", {
                threadId: context.session.threadId,
                turnId: target.turnId,
                openedBy: target.openedBy,
                compacting,
              }).pipe(
                Effect.andThen(
                  completeTurn(
                    context,
                    "interrupted",
                    compacting ? "Interrupted by user." : PROVIDER_TURN_STOP_REASON,
                  ),
                ),
              );
            }),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkDetach,
        );
      }
    },
  );

  const stopBackgroundTask: NonNullable<ClaudeAdapterShape["stopBackgroundTask"]> = Effect.fn(
    "stopBackgroundTask",
  )(function* (threadId, taskId, expected) {
    const context = yield* requireSession(threadId);
    const staleIdentity = () =>
      expected !== undefined &&
      (sessions.get(threadId) !== context ||
        context.stopped ||
        expected.runtimeSessionId !== context.session.runtimeSessionId ||
        expected.attempt !== (context.taskAgents.get(taskId)?.backgroundAttempt ?? 0));
    const staleError = () =>
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "task/stop",
        issue: "The displayed background task activation is no longer current.",
      });
    if (staleIdentity()) return yield* staleError();
    if (!context.query.stopTask) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "task/stop",
        detail: "This Claude session does not support stopping individual tasks.",
      });
    }
    // Idempotent: a task that already settled (or was never tracked) is a
    // successful no-op — the caller races task completion by design.
    if (!context.liveTaskIds.has(taskId)) {
      return;
    }
    // Bounded like the interrupt sweep: a wedged child's stopTask promise
    // may never settle, and a user-facing button must not hang forever.
    const outcome = yield* Effect.tryPromise({
      // Invoke through the query object: SDK methods rely on `this`.
      try: () => {
        if (staleIdentity()) throw staleError();
        if (!context.liveTaskIds.has(taskId)) return Promise.resolve();
        return context.query.stopTask!(taskId);
      },
      catch: (cause) => toSessionRequestError(context, threadId, "task/stop", cause),
    }).pipe(Effect.timeoutOption("5 seconds"));
    if (Option.isNone(outcome)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "task/stop",
        detail: `Timed out stopping task ${taskId}.`,
      });
    }
  });

  // Queues a person's message for one running subagent; the PreToolUse hook hands it over at
  // the agent's next tool call, and a task that settles first reports it undelivered.
  const messageBackgroundTask: NonNullable<ClaudeAdapterShape["messageBackgroundTask"]> = Effect.fn(
    "messageBackgroundTask",
  )(function* (threadId, taskId, text, expected) {
    const context = yield* requireSession(threadId);
    const agent = context.taskAgents.get(taskId);
    if (
      context.stopped ||
      expected.runtimeSessionId !== context.session.runtimeSessionId ||
      expected.attempt !== (agent?.backgroundAttempt ?? 0) ||
      !context.liveTaskIds.has(taskId)
    ) {
      return yield* new ProviderTaskEndedError({ provider: PROVIDER, threadId, taskId });
    }
    if (!isMessageableClaudeTask(agent)) {
      return yield* new ProviderUnsupportedError({ provider: PROVIDER });
    }
    const pending = context.pendingSubagentMessages.get(taskId) ?? [];
    if (pending.length >= CLAUDE_SUBAGENT_PENDING_MESSAGES_MAX) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: TASK_MESSAGE_PENDING_LIMIT_METHOD,
        detail: "Several messages already wait for this agent's next step.",
      });
    }
    context.pendingSubagentMessages.set(taskId, [...pending, text]);
  });

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  /** The session's main transcript chain, oldest first. Errors and timeouts read as empty. */
  const readMainTranscriptChain = Effect.fn("readMainTranscriptChain")(function* (
    sessionId: string,
    cwd: string | undefined,
  ) {
    const read = (dir: string | undefined) =>
      Effect.tryPromise(() =>
        readSessionMessages(sessionId, {
          ...(dir !== undefined ? { dir } : {}),
          includeSystemMessages: true,
        }),
      ).pipe(
        Effect.timeoutOption(CLAUDE_REWIND_TRANSCRIPT_TIMEOUT),
        Effect.map((entries) => Option.getOrElse(entries, () => [])),
        Effect.catch(() => Effect.succeed<ReadonlyArray<ClaudeTranscriptEntry>>([])),
        Effect.map((entries) =>
          entries.filter(
            (entry) =>
              typeof entry.uuid === "string" &&
              (entry.parent_tool_use_id === null || entry.parent_tool_use_id === undefined),
          ),
        ),
      );
    const inCwd = yield* read(cwd);
    return inCwd.length > 0 || cwd === undefined ? inCwd : yield* read(undefined);
  });

  /**
   * Makes Claude forget the newest turns: close the live query, wait for the
   * CLI to exit, and reopen the transcript truncated just before the first
   * dropped prompt (or a fresh session for checkpoint 0). A reopen the CLI
   * refuses restores the previous conversation and reports the refusal.
   */
  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, input) {
      const context = yield* requireSession(threadId);
      const refuse = (detail: string) =>
        new ProviderAdapterRequestError({ provider: PROVIDER, method: "thread/rollback", detail });
      if (context.turnState) return yield* refuse("A Claude turn is still running.");
      if (context.liveTaskIds.size > 0) {
        return yield* refuse(
          "Claude still has background tasks running. Stop them, then revert again.",
        );
      }
      if (context.pendingApprovals.size > 0 || context.pendingUserInputs.size > 0) {
        return yield* refuse("Claude is waiting for your answer. Answer it, then revert again.");
      }
      if (rewindingThreads.has(threadId)) {
        return yield* refuse("Claude is already rewinding this thread.");
      }

      type RewindPlan =
        | { readonly kind: "fresh" }
        | { readonly kind: "rewind"; readonly at: string; readonly dropsTurn?: string };
      let plan: RewindPlan | undefined;
      if (input.targetTurnId === null) {
        plan = { kind: "fresh" };
      } else {
        // The transcript is durable: prefer it over in-memory heads.
        const firstDropped = input.droppedTurnIds[0];
        const chain =
          context.resumeSessionId !== undefined && firstDropped !== undefined
            ? yield* readMainTranscriptChain(context.resumeSessionId, context.session.cwd)
            : [];
        const before: ClaudeChainPositionBeforePrompt =
          firstDropped === undefined
            ? { kind: "missing" }
            : claudeEntryBeforePrompt(
                chain.map((entry) => entry.uuid),
                firstDropped,
              );
        if (before.kind === "entry") {
          plan = {
            kind: "rewind",
            at: before.uuid,
            ...(input.droppedTurnIds.length === 1 && firstDropped !== undefined
              ? { dropsTurn: firstDropped }
              : {}),
          };
        } else if (before.kind === "chain-start") {
          plan = { kind: "fresh" };
        } else {
          const head = context.turnHeads.find((entry) => entry.turnId === input.targetTurnId)?.head;
          if (head !== undefined) plan = { kind: "rewind", at: head };
        }
      }
      if (plan === undefined) {
        return yield* refuse(
          "Claude has no recorded transcript position for this checkpoint. Revert to an earlier checkpoint or start a new thread.",
        );
      }
      const rewindPlan = plan;

      rewindingThreads.add(threadId);
      return yield* Effect.gen(function* () {
        const previousCursor = context.session.resumeCursor;
        const dropped = new Set<string>(input.droppedTurnIds);
        const keptTurnHeads = context.turnHeads.filter((entry) => !dropped.has(entry.turnId));
        yield* stopSessionInternal(context, {
          emitExitEvent: false,
          awaitQueryExitMs: CLAUDE_REWIND_QUERY_EXIT_MS,
        });

        const previousTurnCount =
          readClaudeResumeState(previousCursor)?.turnCount ?? context.completedTurnIds.length;
        // A revert does not rewind Claude's task store, so the rewound session keeps its list;
        // the fresh branch is a new session whose list starts empty. The revert does drop the
        // reverted turns' plans, so the thread may show an older list: marked unshown, the list
        // goes out with the next task result even when that result changes nothing.
        const nextCursor =
          rewindPlan.kind === "fresh" || context.resumeSessionId === undefined
            ? { threadId }
            : {
                threadId,
                resume: context.resumeSessionId,
                rewind: { at: rewindPlan.at },
                turnCount: Math.max(0, previousTurnCount - input.numTurns),
                ...transcriptSeenMarker(context),
                ...planTasksCursorField(context.planTasks, context.resumeSessionId, {
                  shown: false,
                }),
              };
        const reopenInput: ProviderSessionStartInput = {
          ...context.startInput,
          runtimeMode: context.session.runtimeMode,
          ...(context.session.tokenMode !== undefined
            ? { tokenMode: context.session.tokenMode }
            : {}),
          ...((context.cacheModelSelection ?? context.startInput.modelSelection)
            ? { modelSelection: context.cacheModelSelection ?? context.startInput.modelSelection }
            : {}),
          ...(context.session.runtimeSessionId !== undefined
            ? { runtimeSessionId: context.session.runtimeSessionId }
            : {}),
        };
        // `resumeDropsTurn` stays off until a manual check proves the CLI refuses
        // a mismatched truncation at boot rather than on the first prompt.
        const reopened = yield* Effect.result(
          openSessionContext(
            { ...reopenInput, resumeCursor: nextCursor },
            { probe: true, turnHeads: keptTurnHeads },
          ),
        );
        if (reopened._tag === "Success") {
          return yield* snapshotThread(reopened.success);
        }

        // The error's own detail, not its message: that wraps the detail in the
        // adapter's internal prefix and the thread id.
        const refusal = adapterFailureDetail(reopened.failure);
        const restored = yield* Effect.result(
          openSessionContext(
            { ...reopenInput, resumeCursor: previousCursor },
            { probe: true, turnHeads: context.turnHeads },
          ),
        );
        if (restored._tag === "Failure") {
          // Orchestration must see the session end; recovery reuses the untouched binding.
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEventForContext(context, {
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId,
            payload: {
              reason: "Claude could not restart after a failed rewind",
              exitKind: "error",
            },
            providerRefs: {},
          });
        }
        return yield* refuse(
          `Claude refused to rewind this conversation, so nothing was changed. ${refusal}`,
        );
      }).pipe(Effect.ensuring(Effect.sync(() => rewindingThreads.delete(threadId))));
    },
  );

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }

      context.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending.decision, decision);
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: true,
        }),
      { concurrency: "unbounded", discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: false,
        }),
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.tap(() => runtimeEventQueueMetrics.reset),
      Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      conversationRollback: "native",
      turnSteering: "native",
      // Transcripts live under a per-cwd project key, so a moved resume finds nothing.
      resumeSurvivesCwdChange: false,
      // Carried in systemPrompt.append, so slash commands such as /compact stay commands.
      attachmentInstructions: "session",
      // Anthropic's prompt cache expires between turns; a cold resume re-sends the context.
      resumeCacheReview: true,
    },
    startSession,
    sendTurn,
    steerTurn,
    interruptTurn,
    stopBackgroundTask,
    messageBackgroundTask,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    // The capabilities probe run in the directory: no prompt, nothing persisted, no MCP.
    // A failed or timed-out probe fails the read, so it never stands in for an empty list.
    readProjectCommands: (cwd) =>
      probeClaudeCapabilities(claudeSettings, options?.environment, cwd).pipe(
        Effect.flatMap((probe) =>
          probe === undefined
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "initialize",
                  detail: "Claude Code did not report its commands for this directory.",
                }),
              )
            : Effect.succeed({ skills: [], slashCommands: probe.slashCommands }),
        ),
        Effect.provideService(Path.Path, path),
      ),
    // The newest `commands_changed` list of a running session in the directory.
    readLiveProjectCommands: (cwd) =>
      Effect.sync(() => {
        let latest: ClaudeSessionContext["slashCommands"];
        for (const context of sessions.values()) {
          const pushed = context.slashCommands;
          if (
            pushed !== undefined &&
            !context.stopped &&
            context.session.cwd === cwd &&
            (latest === undefined || pushed.order > latest.order)
          ) {
            latest = pushed;
          }
        }
        return latest === undefined ? undefined : { skills: [], slashCommands: latest.commands };
      }),
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue).pipe(
        Stream.tap(() => runtimeEventQueueMetrics.recordDequeued()),
      );
    },
  } satisfies ClaudeAdapterShape;
});
