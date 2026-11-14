import { makeAcpSubagentRuntimeEvents } from "../acp/AcpSubagentRuntimeEvents.ts";
import {
  ApprovalRequestId,
  DEFAULT_AGENT_TOKEN_MODE,
  EventId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeEventRaw,
  type RuntimeMode,
  type RuntimeSessionId,
  type ThreadId,
  TurnId,
} from "@ryco/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { appendAttachmentPathLines } from "@ryco/shared/attachmentPrompt";
import { makeKeyedSerialExecutor } from "@ryco/shared/KeyedSerialExecutor";

import {
  attachmentPathLines,
  isPersistableChatAttachment,
  resolveAttachmentPath,
} from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { createProcessDeviceToolBinding } from "../../providerTools/deviceToolGateway.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { failStartedTurnOnError, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSessionRuntimeStartResult,
} from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpThoughtDeltaEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import { providerThreadSnapshotFromTurnIds } from "../providerThreadSnapshot.ts";
import {
  acpAvailableCommandsToSlashCommands,
  makeRecentProjectCommands,
  parseSlashCommandInput,
} from "../providerSlashCommands.ts";
import { isSlashCommandInput } from "../attachmentInstructionDelivery.ts";
import { requireRuntimeSessionId, stampRuntimeEvent } from "../runtimeSession.ts";
import {
  applyAcpModelSelection,
  currentAcpModelIdFromSessionSetup,
} from "../acp/AcpModelSelection.ts";
import {
  extractXAiAskUserQuestions,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  XAiAskUserQuestionRequest,
} from "../acp/XAiAcpExtension.ts";
import type {
  ProviderAdapterShape,
  ProviderTurnSteeringMode,
} from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
type AcpAdapterShape = ProviderAdapterShape<ProviderAdapterError>;
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { AgentProcessPriorityShape } from "../agentProcessPriority.ts";
import {
  agentControlHostContext,
  installAgentControlAcp,
  type AgentControlAcpInjection,
  type AgentControlProviderBridge,
} from "../../agentControl/ProviderInjection.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const ACP_RESUME_VERSION = 1 as const;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

/** A session's or turn's model as Ryco reports it, and the agent's model id to start from next. */
export interface AcpModelState {
  /** Reported on the session and on `turn.started`; nothing is reported when undefined. */
  readonly model: string | undefined;
  /** The agent's current model id, passed to the next turn's configuration. */
  readonly currentModelId: string | undefined;
}

/**
 * How a session's model (and anything else, like its mode) is configured, at start and before
 * every turn. The default selects the model through the ACP model API
 * (`applyAcpModelSelection`) and reports it through `normalizeModel`.
 */
export interface AcpSessionConfiguration {
  readonly start: (input: {
    readonly runtime: AcpSessionRuntimeShape;
    readonly threadId: ThreadId;
    readonly runtimeMode: RuntimeMode;
    /** The requested selection when it names this instance. */
    readonly modelSelection: ModelSelection | undefined;
    readonly started: AcpSessionRuntimeStartResult;
  }) => Effect.Effect<AcpModelState, ProviderAdapterError>;
  readonly turn: (input: {
    readonly runtime: AcpSessionRuntimeShape;
    readonly threadId: ThreadId;
    readonly session: ProviderSession;
    readonly interactionMode: ProviderInteractionMode | undefined;
    /** The turn's selection when it names this instance. */
    readonly modelSelection: ModelSelection | undefined;
    readonly currentModelId: string | undefined;
  }) => Effect.Effect<AcpModelState, ProviderAdapterError>;
}

type UserInputQuestions = Extract<
  ProviderRuntimeEvent,
  { readonly type: "user-input.requested" }
>["payload"]["questions"];

/** How a question the agent asked was settled. */
export type AcpUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  /** The turn was interrupted or the session stopped before anyone answered. */
  | { readonly _tag: "cancelled" };

/** What an agent's extension handlers get from the adapter for one session. */
export interface AcpAdapterExtensionContext {
  readonly runtime: AcpSessionRuntimeShape;
  readonly threadId: ThreadId;
  readonly runtimeSessionId: RuntimeSessionId;
  /** Writes the native request to the native event log; never fails. */
  readonly logNative: (method: string, payload: unknown) => Effect.Effect<void>;
  readonly emit: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<{
    readonly eventId: EventId;
    readonly createdAt: string;
  }>;
  readonly activeTurnId: () => TurnId | undefined;
  /** Emits a plan update, once per distinct plan per turn; dropped before the session is ready. */
  readonly emitPlanUpdate: (input: {
    readonly payload: AcpPlanPayload;
    readonly rawPayload: unknown;
    readonly source: AcpRawSource;
    readonly method: string;
  }) => Effect.Effect<void>;
  /**
   * Asks the person and waits for the answer. Emits `user-input.requested` with `raw`, then
   * `user-input.resolved` (with `raw` too when `rawOnResolved`), whose answers are empty when the
   * question was cancelled.
   */
  readonly requestUserInput: (input: {
    readonly questions: UserInputQuestions;
    readonly raw: RuntimeEventRaw;
    readonly rawOnResolved: boolean;
  }) => Effect.Effect<AcpUserInputResolution>;
}

type AcpRawSource = Extract<RuntimeEventRaw["source"], "acp.jsonrpc" | `acp.${string}.extension`>;

interface AcpPlanPayload {
  readonly explanation?: string | null;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

export interface AcpAdapterLiveOptions {
  readonly provider: ProviderDriverKind;
  readonly makeRuntime: (
    input: Omit<AcpSessionRuntimeOptions, "spawn" | "authMethodId"> & {
      readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    },
  ) => Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope>;
  readonly normalizeModel: (model: string) => string;
  readonly xaiExtensions?: boolean;
  readonly respectPromptCapabilities?: boolean;
  readonly getSessionModelSwitch?: () => "in-session" | "unsupported";
  readonly onCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
  /** Lower-case command names the composer menu must not offer. */
  readonly hiddenCommands?: ReadonlySet<string>;
  /** Lower-case command name -> why Ryco refuses to send it; the turn fails before it starts. */
  readonly refusedCommands?: ReadonlyMap<string, string>;
  readonly onUsage?: () => Effect.Effect<void>;
  readonly onStarted?: (
    result: import("../acp/AcpSessionRuntime.ts").AcpSessionRuntimeStartResult,
  ) => Effect.Effect<void>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Lowers each session's agent process; undefined spawns it unchanged. */
  readonly processPriority?: AgentProcessPriorityShape | undefined;
  /** Model (and mode) configuration; defaults to the ACP model API. */
  readonly sessionConfiguration?: AcpSessionConfiguration;
  /** Registers the agent's own extension requests and notifications before the session starts. */
  readonly registerExtensions?: (
    context: AcpAdapterExtensionContext,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /**
   * The permission option a person's decision selects. Defaults to the option the agent offers
   * with the matching kind (`allow_always`, `allow_once`, `reject_once`); none cancels the request.
   */
  readonly selectPermissionOptionId?: (
    request: EffectAcpSchema.RequestPermissionRequest,
    decision: Exclude<ProviderApprovalDecision, "cancel">,
  ) => string | undefined;
  /**
   * A resume cursor this adapter cannot read: `"reject"` (default) fails `startSession`,
   * `"start-fresh"` starts a new agent session instead.
   */
  readonly invalidResumeCursor?: "reject" | "start-fresh";
  /**
   * When a turn's prompt is built from its text and attachments. `"before-turn-start"` (default):
   * an empty turn or an unreadable attachment fails `sendTurn` before any turn event.
   * `"after-turn-start"`: `turn.started` goes out first, and such a failure closes the turn as
   * failed.
   */
  readonly promptAssembly?: "before-turn-start" | "after-turn-start";
  /**
   * Agent Control for each session: its MCP server is offered to the agent, each turn binds the
   * turn's authority, and the first prompt (unless it is a slash command) carries the host
   * context. Without a bridge the session runs without Agent Control and no host context.
   */
  readonly agentControl?: {
    readonly bridge: AgentControlProviderBridge | undefined;
    readonly stdioProxy?: { readonly command: string; readonly entryPoint: string };
  };
  /** `capabilities.turnSteering`; unset leaves steering unsupported. */
  readonly turnSteering?: ProviderTurnSteeringMode;
  /** Wording that names the agent in events and errors. */
  readonly labels?: {
    /** `session.state.changed` reason once the session is ready. */
    readonly readyReason?: string;
    readonly rollbackUnsupportedDetail?: string;
    /** The method named when a person answers a question nobody asked. */
    readonly userInputMethod?: string;
  };
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<AcpUserInputResolution>;
}

interface AcpSessionContext {
  readonly subagentEvents: ReturnType<typeof makeAcpSubagentRuntimeEvents>;
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly agentControl: AgentControlAcpInjection | undefined;
  /** Sent once, ahead of the first prompt that is not a slash command; empty sends nothing. */
  readonly agentControlHostContext: string;
  agentControlHostContextDelivered: boolean;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /** Completed turn ids only; never prompts (base64 images) or results. */
  readonly turnIds: Array<TurnId>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  currentModelId: string | undefined;
  promptImages: boolean;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAcpResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ACP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

const XAI_ASK_USER_QUESTION_METHODS = [
  "x.ai/ask_user_question",
  "_x.ai/ask_user_question",
] as const;

/** xAI's `ask_user_question` extension (Grok): a cancelled question gets an explicit cancellation. */
function registerXAiExtensions(context: AcpAdapterExtensionContext) {
  return Effect.forEach(
    XAI_ASK_USER_QUESTION_METHODS,
    (method) =>
      context.runtime.handleExtRequest(method, XAiAskUserQuestionRequest, (params) =>
        Effect.gen(function* () {
          yield* context.logNative(method, params);
          const resolved = yield* context.requestUserInput({
            questions: extractXAiAskUserQuestions(params),
            raw: { source: "acp.grok.extension", method, payload: params },
            rawOnResolved: true,
          });
          switch (resolved._tag) {
            case "answered":
              return makeXAiAskUserQuestionResponse(params, resolved.answers);
            case "cancelled":
              return makeXAiAskUserQuestionCancelledResponse();
          }
        }),
      ),
    { discard: true },
  );
}

function makeDefaultSessionConfiguration(
  provider: ProviderDriverKind,
  normalizeModel: (model: string) => string,
): AcpSessionConfiguration {
  const select = (input: {
    readonly runtime: AcpSessionRuntimeShape;
    readonly threadId: ThreadId;
    readonly currentModelId: string | undefined;
    readonly modelSelection: ModelSelection | undefined;
  }) =>
    applyAcpModelSelection({
      runtime: input.runtime,
      currentModelId: input.currentModelId,
      requestedModelId:
        (input.modelSelection?.model ? normalizeModel(input.modelSelection.model) : undefined) ||
        undefined,
      mapError: (cause) =>
        mapAcpToAdapterError(provider, input.threadId, "session/set_model", cause),
    }).pipe(
      Effect.map((currentModelId): AcpModelState => ({
        model: currentModelId ? normalizeModel(currentModelId) : undefined,
        currentModelId,
      })),
    );
  return {
    start: (input) =>
      select({
        ...input,
        currentModelId: currentAcpModelIdFromSessionSetup(input.started.sessionSetupResult),
      }),
    turn: select,
  };
}

export function makeAcpAdapter(options: AcpAdapterLiveOptions) {
  const PROVIDER = options.provider;
  const normalizeModel = options.normalizeModel;
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(PROVIDER);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const sessions = new Map<ThreadId, AcpSessionContext>();
    const threadLocks = yield* makeKeyedSerialExecutor<string>();
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(2_048);
    // The agent's own commands per directory (`readLiveProjectCommands`): ACP lists them only
    // inside a session, so a stopped session's list keeps serving its directory.
    const recentCommands = makeRecentProjectCommands();
    const commandOptions = { hidden: options.hiddenCommands };
    const sessionConfiguration =
      options.sessionConfiguration ?? makeDefaultSessionConfiguration(PROVIDER, normalizeModel);
    const selectDecisionOptionId = options.selectPermissionOptionId ?? selectPermissionOptionId;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = Effect.sync(() => crypto.randomUUID());
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEventForRuntime = (
      runtimeSessionId: RuntimeSessionId,
      event: ProviderRuntimeEvent,
    ) => {
      return PubSub.publish(
        runtimeEventPubSub,
        stampRuntimeEvent(event, { providerInstanceId: boundInstanceId, runtimeSessionId }),
      ).pipe(Effect.asVoid);
    };

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      threadLocks.withLock(threadId, effect);

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native ACP notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: AcpSessionContext,
      payload: AcpPlanPayload,
      rawPayload: unknown,
      source: AcpRawSource,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEventForRuntime(
          ctx.session.runtimeSessionId!,
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.agentControl) yield* ctx.agentControl.revoke("runtime-teardown");
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEventForRuntime(ctx.session.runtimeSessionId!, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: AcpAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
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
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const effectiveResumeCursor =
            input.resumePolicy === "fresh" ? undefined : input.resumeCursor;
          const acpResume =
            effectiveResumeCursor === undefined ? undefined : parseAcpResume(effectiveResumeCursor);
          if (
            effectiveResumeCursor !== undefined &&
            acpResume === undefined &&
            options.invalidResumeCursor !== "start-fresh"
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "resumeCursor must use schema version 1 and contain a non-empty sessionId.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const acpModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            if (existing.session.runtimeSessionId === runtimeSessionId) {
              return existing.session;
            }
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Thread '${input.threadId}' still has runtime '${existing.session.runtimeSessionId ?? "legacy"}'; stop it before starting '${runtimeSessionId}'.`,
            });
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: AcpSessionContext;
          const deviceToolBinding = createProcessDeviceToolBinding({
            threadId: input.threadId,
            isTurnActive: () => ctx !== undefined && ctx.activeTurnId !== undefined && !ctx.stopped,
          });
          if (deviceToolBinding) {
            yield* Scope.addFinalizer(
              sessionScope,
              Effect.sync(() => deviceToolBinding.dispose()),
            );
          }
          // `ctx` exists once the session is ready; callbacks before that see no turn.
          const currentTurnId = (): TurnId | undefined =>
            (ctx as AcpSessionContext | undefined)?.activeTurnId;
          let agentControl: AgentControlAcpInjection | undefined;
          const agentControlOptions = options.agentControl;
          const agentControlRuntimeHooks = agentControlOptions
            ? {
                resolveMcpServers: (initializeResult: EffectAcpSchema.InitializeResponse) =>
                  installAgentControlAcp(agentControlOptions.bridge, {
                    threadId: input.threadId,
                    providerInstanceId: boundInstanceId,
                    runtimeSessionId,
                    initializeResult,
                    proxyCommand: agentControlOptions.stdioProxy?.command ?? process.execPath,
                    proxyEntryPoint:
                      agentControlOptions.stdioProxy?.entryPoint ?? process.argv[1] ?? "",
                  }).pipe(
                    Effect.tap(
                      Option.match({
                        onNone: () => Effect.void,
                        onSome: (installed) =>
                          installed
                            .addScopeFinalizer(sessionScope)
                            .pipe(Effect.tap(() => Effect.sync(() => (agentControl = installed)))),
                      }),
                    ),
                    Effect.map(
                      Option.match({
                        onNone: () => [],
                        onSome: (installed) => [installed.mcpServer],
                      }),
                    ),
                  ),
                onProcessExit: () =>
                  agentControl ? agentControl.revoke("runtime-teardown") : Effect.void,
                onMcpSetupFailure: () =>
                  agentControl
                    ? agentControl
                        .revoke("runtime-teardown")
                        .pipe(Effect.tap(() => Effect.sync(() => (agentControl = undefined))))
                    : Effect.void,
              }
            : {};

          const resumeSessionId = acpResume?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const acp = yield* options
            .makeRuntime({
              threadId: input.threadId,
              ...(options?.environment ? { environment: options.environment } : {}),
              ...(options.processPriority ? { processPriority: options.processPriority } : {}),
              childProcessSpawner,
              cwd,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              clientInfo: { name: "ryco", version: "0.0.0" },
              ...(deviceToolBinding
                ? {
                    mcpServers: [
                      {
                        type: "http" as const,
                        name: "ryco-device",
                        url: deviceToolBinding.url,
                        headers: Object.entries(deviceToolBinding.headers).map(([name, value]) => ({
                          name,
                          value,
                        })),
                      },
                    ],
                  }
                : {}),
              ...agentControlRuntimeHooks,
              ...acpNativeLoggers,
            })
            .pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          const extensionContext: AcpAdapterExtensionContext = {
            runtime: acp,
            threadId: input.threadId,
            runtimeSessionId,
            logNative: (method, payload) => logNative(input.threadId, method, payload),
            emit: (event) => offerRuntimeEventForRuntime(runtimeSessionId, event),
            makeEventStamp,
            activeTurnId: currentTurnId,
            emitPlanUpdate: ({ payload, rawPayload, source, method }) =>
              ctx === undefined
                ? Effect.void
                : emitPlanUpdate(ctx, payload, rawPayload, source, method),
            requestUserInput: ({ questions, raw, rawOnResolved }) =>
              Effect.gen(function* () {
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const resolution = yield* Deferred.make<AcpUserInputResolution>();
                pendingUserInputs.set(requestId, { resolution });
                yield* offerRuntimeEventForRuntime(runtimeSessionId, {
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: currentTurnId(),
                  requestId: runtimeRequestId,
                  payload: { questions },
                  raw,
                });
                const resolved = yield* Deferred.await(resolution);
                pendingUserInputs.delete(requestId);
                yield* offerRuntimeEventForRuntime(runtimeSessionId, {
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: currentTurnId(),
                  requestId: runtimeRequestId,
                  payload: { answers: resolved._tag === "answered" ? resolved.answers : {} },
                  ...(rawOnResolved ? { raw } : {}),
                });
                return resolved;
              }),
          };
          const started = yield* Effect.gen(function* () {
            if (options.xaiExtensions) {
              yield* registerXAiExtensions(extensionContext);
            }
            if (options.registerExtensions) {
              yield* options.registerExtensions(extensionContext);
            }
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEventForRuntime(
                    runtimeSessionId,
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: currentTurnId(),
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEventForRuntime(
                    runtimeSessionId,
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: currentTurnId(),
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectDecisionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          if (options.onStarted) yield* options.onStarted(started);

          const startModel = yield* sessionConfiguration.start({
            runtime: acp,
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            modelSelection: acpModelSelection,
            started,
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            runtimeSessionId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            tokenMode: input.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
            cwd,
            ...(startModel.model ? { model: startModel.model } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: ACP_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            subagentEvents: makeAcpSubagentRuntimeEvents(),
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            agentControl,
            agentControlHostContext:
              agentControl?.hostContext ??
              (agentControlOptions?.bridge ? agentControlHostContext(false) : ""),
            agentControlHostContextDelivered: false,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turnIds: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            currentModelId: startModel.currentModelId,
            promptImages:
              started.initializeResult.agentCapabilities?.promptCapabilities?.image === true,
            stopped: false,
          };

          // Fork into the session scope, not the calling fiber: ProviderService runs
          // `startSession` in its own detached fiber that ends once the session has
          // started, and Effect interrupts a fiber's `forkChild` children when it
          // ends, which dropped every `session/update` (text, tools, plans).
          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "CommandsUpdated":
                    // A late update after a close is dropped. Only the mapped copy is kept,
                    // never the raw payload.
                    if (ctx.stopped) return;
                    recentCommands.record(
                      cwd,
                      acpAvailableCommandsToSlashCommands(event.commands, commandOptions),
                    );
                    if (options.onCommands) yield* options.onCommands(event.commands);
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEventForRuntime(
                      runtimeSessionId,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEventForRuntime(
                      runtimeSessionId,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEventForRuntime(
                      runtimeSessionId,
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    for (const subagentEvent of yield* ctx.subagentEvents({
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: ctx.activeTurnId,
                      state: event.toolCall.subagent,
                      rawPayload: event.rawPayload,
                      makeStamp: makeEventStamp,
                    })) {
                      yield* offerRuntimeEventForRuntime(runtimeSessionId, subagentEvent);
                    }
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEventForRuntime(
                      runtimeSessionId,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ThoughtDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEventForRuntime(
                      runtimeSessionId,
                      makeAcpThoughtDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated":
                    if (options.onUsage) yield* options.onUsage();
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEventForRuntime(
                      runtimeSessionId,
                      makeAcpTokenUsageEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        usage: event.usage,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEventForRuntime(runtimeSessionId, {
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEventForRuntime(runtimeSessionId, {
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: options.labels?.readyReason ?? "ACP session ready" },
          });
          yield* offerRuntimeEventForRuntime(runtimeSessionId, {
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    /** The prompt of a turn: the host context once, then its text, then its images. */
    const buildPromptParts = (ctx: AcpSessionContext, input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const imagePromptParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
          Effect.gen(function* () {
            if (
              !isPersistableChatAttachment(attachment) ||
              attachment.type !== "image" ||
              (options.respectPromptCapabilities && !ctx.promptImages)
            ) {
              return null;
            }
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            return {
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            } satisfies EffectAcpSchema.ContentBlock;
          }),
        );
        const promptText = appendAttachmentPathLines(
          input.input?.trim(),
          attachmentPathLines({
            attachmentsDir: serverConfig.attachmentsDir,
            attachments: input.attachments,
          }),
        );
        const userParts: Array<EffectAcpSchema.ContentBlock> = [
          ...(promptText && promptText.trim().length > 0
            ? [{ type: "text" as const, text: promptText }]
            : []),
          ...imagePromptParts.filter((part) => part !== null),
        ];

        if (userParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        // A slash command must lead the prompt; the host context waits for the next turn.
        if (
          ctx.agentControlHostContextDelivered ||
          ctx.agentControlHostContext.length === 0 ||
          isSlashCommandInput(input.input)
        ) {
          return userParts;
        }
        ctx.agentControlHostContextDelivered = true;
        return [
          {
            type: "text" as const,
            text: `<ryco_host_context>${ctx.agentControlHostContext}</ryco_host_context>`,
          },
          ...userParts,
        ];
      });

    const sendTurn: AcpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const command = parseSlashCommandInput(input.input);
            const refusal =
              command === undefined
                ? undefined
                : options.refusedCommands?.get(command.name.toLowerCase());
            if (refusal !== undefined) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: refusal,
              });
            }
            const turnId = TurnId.make(yield* randomUUIDv4);
            const turnModel = yield* sessionConfiguration.turn({
              runtime: ctx.acp,
              threadId: input.threadId,
              session: ctx.session,
              interactionMode: input.interactionMode,
              modelSelection:
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined,
              currentModelId: ctx.currentModelId,
            });
            const promptParts =
              options.promptAssembly === "after-turn-start"
                ? undefined
                : yield* buildPromptParts(ctx, input);

            ctx.currentModelId = turnModel.currentModelId;
            const displayModel = turnModel.model;
            ctx.activeTurnId = turnId;
            ctx.lastPlanFingerprint = undefined;
            ctx.session = {
              ...ctx.session,
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              ...(displayModel ? { model: displayModel } : {}),
            };

            const runtimeSessionId = ctx.session.runtimeSessionId!;
            yield* offerRuntimeEventForRuntime(runtimeSessionId, {
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: displayModel ? { model: displayModel } : {},
            });

            return {
              ctx,
              acpSessionId: ctx.acpSessionId,
              runtimeSessionId,
              displayModel,
              promptParts,
              turnId,
            };
          }),
        );

        // Once turn.started is out, every failure must also close the turn on the
        // runtime stream; otherwise ingestion keeps it running forever.
        let terminalEmitted = false;
        return yield* Effect.gen(function* () {
          const ctx = prepared.ctx;
          const promptParts = prepared.promptParts ?? (yield* buildPromptParts(ctx, input));
          if (ctx.agentControl) yield* ctx.agentControl.bindTurn(prepared.turnId);
          const result = yield* ctx.acp
            .prompt({
              prompt: promptParts,
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
              Effect.ensuring(
                ctx.agentControl ? ctx.agentControl.retireTurn(prepared.turnId) : Effect.void,
              ),
            );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "ACP session changed before the turn completed.",
                });
              }

              ctx.turnIds.push(prepared.turnId);
              ctx.session = {
                ...ctx.session,
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };

              yield* offerRuntimeEventForRuntime(ctx.session.runtimeSessionId!, {
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: prepared.turnId,
                payload: {
                  state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: result.stopReason ?? null,
                },
              });
              terminalEmitted = true;

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          failStartedTurnOnError({
            isTerminalEmitted: () => terminalEmitted,
            // Stamped with the turn's own runtime: if the ACP session was replaced,
            // ingestion drops it as stale and the rebind's session-replaced release
            // labels the turn instead.
            emitFailed: (errorMessage) =>
              Effect.gen(function* () {
                yield* offerRuntimeEventForRuntime(prepared.runtimeSessionId, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: { state: "failed", errorMessage },
                });
              }),
          }),
        );
      });

    const interruptTurn: AcpAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (ctx.agentControl) yield* ctx.agentControl.retireTurn(ctx.activeTurnId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: AcpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: AcpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: options.labels?.userInputMethod ?? "_x.ai/ask_user_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const readThread: AcpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return providerThreadSnapshotFromTurnIds(threadId, ctx.turnIds);
      });

    // ACP sessions cannot forget turns; ProviderService refuses before reaching this.
    const rollbackThread: AcpAdapterShape["rollbackThread"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail:
            options.labels?.rollbackUnsupportedDetail ??
            "This ACP agent does not support conversation rollback.",
        });
      });

    const stopSession: AcpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: AcpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: AcpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: AcpAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
        concurrency: "unbounded",
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        get sessionModelSwitch() {
          // sendTurn applies the model through applyAcpModelSelection. Drivers
          // override this only when the agent advertises no model API.
          return options.getSessionModelSwitch?.() ?? "in-session";
        },
        ...(options.turnSteering ? { turnSteering: options.turnSteering } : {}),
        // sendTurn awaits the whole ACP prompt after emitting turn.started.
        turnSubmission: "completion",
        // Agent-specific: ACP does not say whether session/load accepts a new cwd.
        resumeSurvivesCwdChange: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      readLiveProjectCommands: (cwd) => Effect.sync(() => recentCommands.read(path.resolve(cwd))),
      streamEvents,
    } satisfies AcpAdapterShape;
  });
}
