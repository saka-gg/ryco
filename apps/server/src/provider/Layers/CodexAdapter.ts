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
  type AgentTokenMode,
  type CodexSettings,
  type ChatAttachment,
  type ProviderEvent,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type RuntimeSessionId,
  type ServerProviderSlashCommand,
  ThreadId,
  TurnId,
  MessageId,
  EventId,
  ProviderItemId,
  ProviderSendTurnInput,
  ProviderSteerTurnInput,
  DEFAULT_AGENT_TOKEN_MODE,
  PROMPT_SUGGESTION_MAX_CHARS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ryco/contracts";
import {
  Cause,
  Clock,
  type Duration,
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
import { ChildProcessSpawner } from "effect/process";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { getModelSelectionStringOptionValue } from "@ryco/shared/model";
import { appendAttachmentPathLines } from "@ryco/shared/attachmentPrompt";
import { formatSourceControlContextsForAgent } from "@ryco/shared/sourceControlContextFormatter";
import { isNativeCompactionCommand, NATIVE_COMPACTION_COMMAND } from "@ryco/shared/threadActivity";
import { normalizePromptSuggestion } from "@ryco/shared/promptSuggestion";

import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderTurnNotSteerableError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import type { AgentProcessPriorityShape } from "../agentProcessPriority.ts";
import { codexServiceTierForSelection } from "../CodexServiceTier.ts";
import { attachmentPathLines, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { makeServerQueueMetrics } from "../../observability/QueueMetrics.ts";
import { buildTokenReductionInstructions, checkRtkAvailability } from "../../tokenReduction.ts";
import {
  CODEX_AGENT_CONTROL_SERVER_NAME,
  CodexResumeCursorSchema,
  CodexSessionRuntimeThreadIdMissingError,
  CodexSessionRuntimeInvalidUserInputAnswersError,
  CodexSessionRuntimePendingUserInputNotFoundError,
  isCodexStartupPhaseTimeout,
  makeCodexSessionRuntime,
  requestStoredCodexThread,
  type CodexAgentControlInjection,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
} from "./CodexSessionRuntime.ts";
import { parseCodexSkillsListResponse } from "./CodexProvider.ts";
import {
  makeCodexStoredThreadReader,
  type CodexStoredThreadReader,
} from "./CodexStoredThreadReader.ts";
import {
  agentControlHostContext,
  installAgentControlNativeHttp,
  type AgentControlProviderBridge,
  type AgentControlRuntimeLease,
} from "../../agentControl/ProviderInjection.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { requireRuntimeSessionId, stampRuntimeEvent } from "../runtimeSession.ts";
import type { ProviderThreadHistory } from "../Services/ProviderAdapter.ts";
import { makeCodexUsageLimitTracker } from "./codexUsageLimits.ts";
import {
  PROVIDER,
  mapItemLifecycle,
  mapToRuntimeEvents,
  normalizeCodexThreadGoal,
} from "./CodexAdapter.mapEvent.ts";

const PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES =
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS * PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;

/** Codex's compaction, offered as a command: `sendTurn` runs it as `thread/compact/start`. */
const CODEX_COMPACT_SLASH_COMMAND = {
  name: NATIVE_COMPACTION_COMMAND.slice(1),
  description: "Summarize the conversation to free context",
} satisfies ServerProviderSlashCommand;

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
 * every request is rejected as unauthorized. Built on the shared host
 * context so Codex hears the same guidance as every other provider.
 */
export const CODEX_AGENT_CONTROL_INSTRUCTIONS =
  `${agentControlHostContext(true)} The server is '${CODEX_AGENT_CONTROL_SERVER_NAME}' on a ` +
  "private local connection; if it becomes unreachable, Ryco has revoked this session's access.";

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
  /**
   * The instance's shared stored-thread reader, when its driver also reads the provider status
   * through it. Without one the adapter starts its own.
   */
  readonly storedThreadReader?: CodexStoredThreadReader;
  /** How long the adapter's own stored-thread reader stays up unused. */
  readonly storedThreadReaderIdleTimeout?: Duration.Input;
  /** Lowers each session's `codex app-server`; undefined spawns it unchanged. */
  readonly processPriority?: AgentProcessPriorityShape | undefined;
  /**
   * The node's `promptSuggestions` setting, read after each completed turn: Codex then samples the
   * next prompt on a hidden fork of the thread. Undefined keeps it off.
   */
  readonly promptSuggestionsEnabled?: Effect.Effect<boolean> | undefined;
}

/** The `thread/sample` prompt that predicts the user's next message. */
export const CODEX_PROMPT_SUGGESTION_PROMPT =
  "Predict the next message the user will send in this conversation. Reply with only that message, written as the user would type it, in under 20 words. Do not use tools. If there is no clear next step, reply with nothing.";

interface CodexAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly runtimeSessionId: RuntimeSessionId;
  readonly scope: Scope.Closeable;
  readonly runtime: CodexSessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  /** Unique Agent Control lease id for this exact runtime, when issued. */
  readonly agentControl?: AgentControlRuntimeLease;
  /** Turns `/compact` started; nothing predicts a next prompt after them. */
  readonly compactionTurnIds: Set<string>;
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
    detail: Schema.is(CodexSessionRuntimePendingUserInputNotFoundError)(error)
      ? `Unknown pending user-input request: ${error.requestId}`
      : formatCodexRuntimeErrorDetail(error),
    ...(Schema.is(CodexSessionRuntimeInvalidUserInputAnswersError)(error)
      ? { userInputResponseNotSent: true }
      : {}),
    cause: error,
  });
}

function normalizeFileSizeBytes(size: number | bigint | undefined): number {
  if (typeof size === "bigint") {
    return size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size);
  }
  return typeof size === "number" && Number.isFinite(size) ? size : 0;
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
  // History reads of threads without a live runtime share one read-only app-server.
  const storedThreadReader =
    options?.storedThreadReader ??
    (yield* makeCodexStoredThreadReader({
      binaryPath: codexConfig.binaryPath,
      cwd: process.cwd(),
      ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
      ...(options?.environment ? { environment: options.environment } : {}),
      ...(options?.storedThreadReaderIdleTimeout !== undefined
        ? { idleTimeout: options.storedThreadReaderIdleTimeout }
        : {}),
    }));

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

        const startServiceTier =
          input.modelSelection?.instanceId === boundInstanceId
            ? codexServiceTierForSelection(input.modelSelection)
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
          ...(startServiceTier ? { serviceTier: startServiceTier } : {}),
          ...(options?.processPriority ? { processPriority: options.processPriority } : {}),
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
        // Best effort, after the turn's own events: Codex before 0.165 has no `thread/sample`, and
        // a sample fails once the user sends again. Forked into the session scope, so a closed
        // session never publishes a late suggestion.
        const promptSuggestionsEnabled = options?.promptSuggestionsEnabled;
        const compactionTurnIds = new Set<string>();
        const samplePromptSuggestion = (turnId: TurnId) =>
          Effect.gen(function* () {
            if (compactionTurnIds.delete(turnId)) return;
            if (promptSuggestionsEnabled === undefined || !(yield* promptSuggestionsEnabled)) {
              return;
            }
            const suggestion = normalizePromptSuggestion(
              yield* runtime.sampleThread({ turnId, prompt: CODEX_PROMPT_SUGGESTION_PROMPT }),
              PROMPT_SUGGESTION_MAX_CHARS,
            );
            if (suggestion === undefined) return;
            yield* Queue.offer(runtimeEventQueue, {
              eventId: EventId.make(crypto.randomUUID()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              runtimeSessionId,
              threadId: input.threadId,
              turnId,
              createdAt: new Date().toISOString(),
              type: "turn.prompt-suggestion",
              payload: { suggestion },
            });
            yield* runtimeEventQueueMetrics.recordEnqueued(1);
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logDebug("Codex prompt suggestion failed", {
                    threadId: input.threadId,
                    turnId,
                    cause,
                  }),
            ),
          );
        // Per-session: the rate-limit snapshot and limited turns belong to this runtime.
        const usageLimits = makeCodexUsageLimitTracker();
        const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event);
            const runtimeEvents = usageLimits
              .annotate(
                event,
                mapToRuntimeEvents(event, event.threadId),
                yield* Clock.currentTimeMillis,
              )
              .map((runtimeEvent) =>
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
            for (const runtimeEvent of runtimeEvents) {
              if (
                runtimeEvent.type === "turn.completed" &&
                runtimeEvent.payload.state === "completed" &&
                runtimeEvent.turnId !== undefined
              ) {
                yield* samplePromptSuggestion(runtimeEvent.turnId).pipe(
                  Effect.forkIn(sessionScope),
                );
              }
            }
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
          Effect.mapError((cause) =>
            // A startup phase that never answered names its request and the next step.
            isCodexStartupPhaseTimeout(cause)
              ? new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: cause.cause.phase,
                  detail: cause.detail,
                  cause,
                })
              : new ProviderAdapterProcessError({
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
          compactionTurnIds,
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
      pathLines: attachmentPathLines({ attachmentsDir: serverConfig.attachmentsDir, attachments }),
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

  const bindAgentControlTurn = (session: CodexAdapterSessionContext, turnId: TurnId) =>
    session.agentControl
      ? session.agentControl.bindTurn(turnId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to bind Agent Control turn authority", {
              threadId: session.threadId,
              turnId,
              cause,
            }),
          ),
        )
      : Effect.void;

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    // Codex compacts through its own request: sent as a prompt, `/compact` reaches the model.
    if (isNativeCompactionCommand(input)) {
      const session = yield* requireSession(input.threadId);
      const result = yield* session.runtime
        .compactThread()
        .pipe(
          Effect.mapError((cause) =>
            mapCodexRuntimeError(input.threadId, "thread/compact/start", cause),
          ),
        );
      session.compactionTurnIds.add(result.turnId);
      yield* bindAgentControlTurn(session, result.turnId);
      return result;
    }
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
    const serviceTier =
      input.modelSelection?.instanceId === boundInstanceId
        ? codexServiceTierForSelection(input.modelSelection)
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
        ...(serviceTier ? { serviceTier } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(input.customSystemPrompt !== undefined
          ? { customSystemPrompt: input.customSystemPrompt }
          : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
      })
      .pipe(Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/start", cause)));
    yield* bindAgentControlTurn(session, result.turnId);
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
          // A late steer races the turn's end. Decide by state, not by the error text: if the
          // runtime no longer runs the expected turn, the message is sent as the next turn.
          Effect.catchTag("ProviderAdapterRequestError", (error) =>
            Effect.gen(function* () {
              const current = yield* session.runtime.getSession;
              if (current.activeTurnId === input.expectedTurnId) return yield* error;
              return yield* new ProviderTurnNotSteerableError({
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: input.expectedTurnId,
                reason: "turn-ended",
                detail:
                  "The turn finished before this message could be steered. It stays queued and is sent next.",
                cause: error,
              });
            }),
          ),
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

  const stopAfterFailedInterrupt = (session: CodexAdapterSessionContext) =>
    stopSessionInternal(session).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          // Closing the runtime also closes its event consumer. Publish settlement
          // here so cancellation cannot lose the final exit notification in teardown.
          yield* Queue.offer(runtimeEventQueue, {
            eventId: EventId.make(crypto.randomUUID()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            runtimeSessionId: session.runtimeSessionId,
            threadId: session.threadId,
            createdAt: new Date().toISOString(),
            type: "session.exited",
            payload: {
              reason: "Stopped Codex after background cancellation failed.",
              exitKind: "graceful",
            },
          });
          yield* runtimeEventQueueMetrics.recordEnqueued(1);
        }),
      ),
    );

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        (session.agentControl ? session.agentControl.retireTurn(turnId) : Effect.void).pipe(
          Effect.andThen(
            session.runtime
              .interruptTurn(turnId)
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning(
                    "Codex interrupt failed; stopping the provider session and its background work.",
                    { threadId },
                  ).pipe(Effect.andThen(stopAfterFailedInterrupt(session))),
                ),
              ),
          ),
          Effect.timeoutOption("15 seconds"),
          Effect.flatMap(
            Option.match({
              onSome: () => Effect.void,
              onNone: () =>
                Effect.logWarning(
                  "Codex turn interrupt timed out; recycling the wedged provider session.",
                  { threadId },
                ).pipe(Effect.andThen(stopAfterFailedInterrupt(session))),
            }),
          ),
        ),
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

  // Project skills come from the same shared read-only app-server: skills/list starts no
  // thread and no MCP server.
  const readProjectCommands: NonNullable<CodexAdapterShape["readProjectCommands"]> = (cwd) =>
    storedThreadReader
      .withClient((client) => client.request("skills/list", { cwds: [cwd] }))
      .pipe(
        Effect.map((response) => ({
          skills: parseCodexSkillsListResponse(response, cwd),
          slashCommands: [CODEX_COMPACT_SLASH_COMMAND],
        })),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "skills/list",
              detail: formatCodexRuntimeErrorDetail(cause),
              cause,
            }),
        ),
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
      const providerThreadId = input.resumeCursor.threadId;
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
        : yield* storedThreadReader
            .withClient((client) => requestStoredCodexThread(client, providerThreadId))
            .pipe(
              Effect.mapError((cause) =>
                mapCodexRuntimeError(input.threadId, "thread/read", cause),
              ),
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

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, input) => {
    const numTurns = input.numTurns;
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
      Effect.flatMap((session) =>
        session.runtime.rollbackThread({
          numTurns,
          beforeTurnId: input.droppedTurnIds[0],
        }),
      ),
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

  // Per-event logging helper: a plain function so it adds no trace span.
  const writeNativeEvent = (event: ProviderEvent): Effect.Effect<void> =>
    nativeEventLogger ? nativeEventLogger.write(event, event.threadId) : Effect.void;

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

  // Sessions own independent app-server processes; stop them all at once.
  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: "unbounded",
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
      conversationRollback: "native",
      // thread/resume addresses the rollout by thread id and takes the new cwd.
      resumeSurvivesCwdChange: true,
      // Carried in the turn's collaboration-mode developer instructions.
      attachmentInstructions: "session",
    },
    startSession,
    sendTurn,
    steerTurn,
    interruptTurn,
    readThread,
    readThreadHistory,
    readProjectCommands,
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
