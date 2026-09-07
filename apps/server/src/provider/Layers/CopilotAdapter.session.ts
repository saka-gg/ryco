import { isCopilotChildEvent } from "./CopilotAdapter.eventScope.ts";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeSessionId,
} from "@ryco/contracts";
import {
  CopilotClient,
  type CopilotClientOptions,
  type MessageOptions,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { Effect, Option } from "effect";
import {
  appendAttachmentPathLines,
  formatAttachmentPathLines,
  type AttachmentPathLineEntry,
} from "@ryco/shared/attachmentPrompt";
import { getModelSelectionStringOptionValue } from "@ryco/shared/model";

import { isPersistableChatAttachment, readPersistedAttachment } from "../../attachmentStore.ts";
import { createProcessDeviceToolBinding } from "../../providerTools/deviceToolGateway.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { requireRuntimeSessionId } from "../runtimeSession.ts";
import {
  COPILOT_DRIVER_KIND,
  type ActiveCopilotSession,
  type CopilotAdapterLiveOptions,
  type PendingApprovalRequest,
  type PendingTurnStartRequest,
  type PendingUserInputRequest,
  buildThreadSnapshot,
  isSessionNotFoundError,
  makeCopilotClientOptions,
  selectionTargetsCopilotInstance,
  toMessage,
} from "./CopilotAdapter.types.ts";
import {
  installAgentControlNativeHttp,
  type AgentControlNativeHttpInjection,
  redactAgentControlSecrets,
} from "../../agentControl/ProviderInjection.ts";

type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";

const TURN_START_TIMEOUT_MS = 30_000;

export interface SessionOpsDeps {
  readonly sessions: Map<ThreadId, ActiveCopilotSession>;
  readonly serverConfig: { readonly attachmentsDir: string };
  readonly copilotSettings: { readonly binaryPath: string };
  readonly environment?: NodeJS.ProcessEnv;
  readonly options: CopilotAdapterLiveOptions | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly emit: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
  readonly makeSyntheticEvent: (
    threadId: ThreadId,
    runtimeSessionId: RuntimeSessionId,
    type: string,
    payload: unknown,
    extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
  ) => Effect.Effect<ProviderRuntimeEvent>;
  readonly buildSessionConfig: (
    input: {
      threadId: ThreadId;
      runtimeMode: ProviderSession["runtimeMode"];
      runtimeSessionId: RuntimeSessionId;
      cwd?: string;
      modelSelection?: ProviderSendTurnInput["modelSelection"] | ProviderSession["resumeCursor"];
      agentControl?: AgentControlNativeHttpInjection;
    },
    pendingApprovals: Map<string, PendingApprovalRequest>,
    pendingUserInputs: Map<string, PendingUserInputRequest>,
    activeTurnId: () => TurnId | undefined,
    stoppedRef: { stopped: boolean },
  ) => SessionConfig;
  readonly handleEvent: (session: ActiveCopilotSession, event: SessionEvent) => Effect.Effect<void>;
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ActiveCopilotSession, ProviderAdapterSessionNotFoundError>;
}

function parseResumeCursor(resumeCursor: unknown): string | undefined {
  return typeof resumeCursor === "object" &&
    resumeCursor !== null &&
    "sessionId" in resumeCursor &&
    typeof resumeCursor.sessionId === "string" &&
    resumeCursor.sessionId.trim().length > 0
    ? resumeCursor.sessionId.trim()
    : undefined;
}

function attachmentMimeType(attachment: ChatAttachment): string {
  return attachment.mimeType ?? "application/octet-stream";
}

function createTurnStartWaiter(record: ActiveCopilotSession) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let pending: PendingTurnStartRequest | undefined;
  let settled = false;

  const clear = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    if (pending) record.pendingTurnStarts.delete(pending);
  };

  const promise = new Promise<TurnId>((resolve, reject) => {
    pending = {
      resolve: (turnId) => {
        if (settled) return;
        settled = true;
        clear();
        resolve(turnId);
      },
      reject: (cause) => {
        if (settled) return;
        settled = true;
        clear();
        reject(cause);
      },
    };
    record.pendingTurnStarts.add(pending);
    timeout = setTimeout(() => {
      pending?.reject(new Error("Timed out waiting for GitHub Copilot turn start."));
    }, TURN_START_TIMEOUT_MS);
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      clear();
    },
  };
}

export const makeStartSession =
  (deps: SessionOpsDeps): CopilotAdapterShape["startSession"] =>
  (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== COPILOT_DRIVER_KIND) {
        return yield* new ProviderAdapterValidationError({
          provider: COPILOT_DRIVER_KIND,
          operation: "startSession",
          issue: `Expected provider '${COPILOT_DRIVER_KIND}' but received '${input.provider}'.`,
        });
      }
      if (input.providerInstanceId !== undefined && input.providerInstanceId !== deps.instanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: COPILOT_DRIVER_KIND,
          operation: "startSession",
          issue: `Expected provider instance '${deps.instanceId}' but received '${input.providerInstanceId}'.`,
        });
      }
      const runtimeSessionId = yield* requireRuntimeSessionId(COPILOT_DRIVER_KIND, input);

      const existing = deps.sessions.get(input.threadId);
      if (existing) {
        if (existing.runtimeSessionId !== runtimeSessionId) {
          return yield* new ProviderAdapterValidationError({
            provider: COPILOT_DRIVER_KIND,
            operation: "startSession",
            issue: `Thread '${input.threadId}' still has runtime '${existing.runtimeSessionId}'; stop it before starting '${runtimeSessionId}'.`,
          });
        }
        return {
          provider: COPILOT_DRIVER_KIND,
          providerInstanceId: deps.instanceId,
          runtimeSessionId,
          status: existing.activeTurnId ? "running" : "ready",
          runtimeMode: existing.runtimeMode,
          tokenMode: existing.tokenMode,
          threadId: input.threadId,
          ...(existing.cwd ? { cwd: existing.cwd } : {}),
          ...(existing.model ? { model: existing.model } : {}),
          resumeCursor: { sessionId: existing.session.sessionId },
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        } satisfies ProviderSession;
      }

      const clientOptions: CopilotClientOptions = makeCopilotClientOptions(
        deps.copilotSettings,
        deps.environment,
        input.cwd,
      );
      const client =
        deps.options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);
      const pendingApprovals = new Map<string, PendingApprovalRequest>();
      const pendingUserInputs = new Map<string, PendingUserInputRequest>();
      let activeTurn: TurnId | undefined;
      const stoppedRef = { stopped: false };
      const deviceToolBinding = createProcessDeviceToolBinding({
        threadId: input.threadId,
        isTurnActive: () => activeTurn !== undefined && !stoppedRef.stopped,
      });
      let agentControl = Option.getOrUndefined(
        yield* installAgentControlNativeHttp(deps.options?.agentControl, {
          threadId: input.threadId,
          providerInstanceId: deps.instanceId,
          runtimeSessionId,
          injectionMode: "copilot-http",
        }),
      );
      const buildConfig = (): SessionConfig => {
        const baseSessionConfig = deps.buildSessionConfig(
          {
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            runtimeSessionId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
            ...(agentControl ? { agentControl } : {}),
          },
          pendingApprovals,
          pendingUserInputs,
          () => activeTurn,
          stoppedRef,
        );
        return {
          ...baseSessionConfig,
          ...(deviceToolBinding
            ? {
                mcpServers: {
                  ...baseSessionConfig.mcpServers,
                  ryco_device: {
                    type: "http",
                    url: deviceToolBinding.url,
                    headers: { ...deviceToolBinding.headers },
                  },
                },
              }
            : {}),
        };
      };
      let sessionConfig = buildConfig();

      const effectiveResumeCursor = input.resumePolicy === "fresh" ? undefined : input.resumeCursor;
      const createSession = (config: SessionConfig) =>
        Effect.tryPromise({
          try: () => {
            const sessionId = parseResumeCursor(effectiveResumeCursor);
            return sessionId
              ? client.resumeSession(sessionId, config)
              : client.createSession(config);
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: COPILOT_DRIVER_KIND,
              threadId: input.threadId,
              detail: redactAgentControlSecrets(
                toMessage(cause, "Failed to start GitHub Copilot session."),
              ) as string,
              cause: redactAgentControlSecrets(cause),
            }),
        });
      let attempt = yield* Effect.exit(
        createSession(sessionConfig).pipe(
          Effect.onInterrupt(() =>
            agentControl ? agentControl.revoke("runtime-teardown") : Effect.void,
          ),
        ),
      );
      if (attempt._tag === "Failure" && agentControl) {
        yield* agentControl.revoke("runtime-teardown");
        agentControl = undefined;
        sessionConfig = buildConfig();
        attempt = yield* Effect.exit(createSession(sessionConfig));
      }
      if (attempt._tag === "Failure") {
        deviceToolBinding?.dispose();
        return yield* Effect.failCause(attempt.cause);
      }
      const session = attempt.value;

      const createdAt = new Date().toISOString();
      const tokenMode = input.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE;
      const record: ActiveCopilotSession = {
        client,
        session,
        threadId: input.threadId,
        providerInstanceId: deps.instanceId,
        runtimeSessionId,
        ...(agentControl ? { agentControl } : {}),
        createdAt,
        runtimeMode: input.runtimeMode,
        tokenMode,
        pendingApprovals,
        pendingUserInputs,
        pendingTurnStarts: new Set(),
        deviceToolBinding,
        turns: [],
        renewSession: () => client.createSession(sessionConfig),
        attachSession: (nextSession) => {
          record.unsubscribe();
          record.session = nextSession;
          delete record.contextUsage;
          record.lastUsage = undefined;
          record.unsubscribe = nextSession.on((event) => {
            if (event.type === "assistant.turn_start" && !isCopilotChildEvent(event)) {
              activeTurn = TurnId.make(event.data.turnId);
              record.activeTurnId = activeTurn;
              for (const pending of Array.from(record.pendingTurnStarts)) {
                pending.resolve(activeTurn);
              }
              record.pendingTurnStarts.clear();
            }
            void deps
              .handleEvent(record, event)
              .pipe(Effect.runPromise)
              .catch(() => undefined);
            activeTurn = record.activeTurnId;
          });
        },
        unsubscribe: () => {},
        cwd: input.cwd,
        model: selectionTargetsCopilotInstance(input.modelSelection, deps.instanceId)
          ? input.modelSelection.model
          : undefined,
        updatedAt: createdAt,
        lastError: undefined,
        activeTurnId: undefined,
        activeMessageId: undefined,
        lastUsage: undefined,
        get stopped() {
          return stoppedRef.stopped;
        },
        set stopped(value: boolean) {
          stoppedRef.stopped = value;
        },
      };

      record.attachSession(session);

      deps.sessions.set(input.threadId, record);

      yield* deps.emit([
        yield* deps.makeSyntheticEvent(
          input.threadId,
          runtimeSessionId,
          "session.started",
          effectiveResumeCursor !== undefined ? { resume: effectiveResumeCursor } : {},
        ),
        yield* deps.makeSyntheticEvent(input.threadId, runtimeSessionId, "thread.started", {
          providerThreadId: session.sessionId,
        }),
        yield* deps.makeSyntheticEvent(input.threadId, runtimeSessionId, "session.state.changed", {
          state: "ready",
          reason: "session.started",
        }),
      ]);

      return {
        provider: COPILOT_DRIVER_KIND,
        providerInstanceId: deps.instanceId,
        runtimeSessionId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        tokenMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(record.model ? { model: record.model } : {}),
        resumeCursor: { sessionId: session.sessionId },
        createdAt,
        updatedAt: createdAt,
      } satisfies ProviderSession;
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => deps.sessions.get(input.threadId)?.agentControl).pipe(
          Effect.flatMap((connection) =>
            connection ? connection.revoke("runtime-teardown") : Effect.void,
          ),
        ),
      ),
    );

export const makeSendTurn =
  (deps: SessionOpsDeps): CopilotAdapterShape["sendTurn"] =>
  (input) =>
    Effect.gen(function* () {
      const record = yield* deps.requireSession(input.threadId);
      const declaredAttachmentBytes = (input.attachments ?? []).reduce(
        (total, attachment) => total + (attachment.sizeBytes ?? 0),
        0,
      );
      if (declaredAttachmentBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
        return yield* new ProviderAdapterRequestError({
          provider: COPILOT_DRIVER_KIND,
          method: "session.send",
          detail: `Attachments total ${declaredAttachmentBytes} bytes; limit is ${PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
        });
      }
      let attachmentTotalBytes = 0;
      const pathLineEntries: AttachmentPathLineEntry[] = [];
      const attachments: MessageOptions["attachments"] = (yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) =>
          Effect.gen(function* () {
            if (!isPersistableChatAttachment(attachment)) {
              pathLineEntries.push({ attachment });
              return null;
            }
            const persisted = readPersistedAttachment({
              attachmentsDir: deps.serverConfig.attachmentsDir,
              attachment,
            });
            if (!persisted.ok) {
              return yield* new ProviderAdapterRequestError({
                provider: COPILOT_DRIVER_KIND,
                method: "session.send",
                detail: persisted.reason,
              });
            }
            attachmentTotalBytes += persisted.sizeBytes;
            if (attachmentTotalBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
              return yield* new ProviderAdapterRequestError({
                provider: COPILOT_DRIVER_KIND,
                method: "session.send",
                detail: `Attachments total ${attachmentTotalBytes} bytes; limit is ${PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
              });
            }
            return {
              type: "blob" as const,
              data: persisted.bytes.toString("base64"),
              mimeType: attachmentMimeType(attachment),
              displayName: attachment.name,
            } satisfies NonNullable<MessageOptions["attachments"]>[number];
          }),
      )).filter((attachment) => attachment !== null);
      const copilotModelSelection = selectionTargetsCopilotInstance(
        input.modelSelection,
        deps.instanceId,
      )
        ? input.modelSelection
        : undefined;

      if (copilotModelSelection) {
        record.model = copilotModelSelection.model;
        const reasoningEffort = getModelSelectionStringOptionValue(
          copilotModelSelection,
          "reasoningEffort",
        );
        const setModelOptions = reasoningEffort
          ? { reasoningEffort: reasoningEffort as CopilotReasoningEffort }
          : undefined;

        yield* Effect.tryPromise({
          try: async () => {
            try {
              await record.session.setModel(copilotModelSelection.model, setModelOptions);
            } catch (firstError) {
              if (!isSessionNotFoundError(firstError)) throw firstError;
              const freshSession = await record.renewSession();
              record.attachSession(freshSession);
              await record.session.setModel(copilotModelSelection.model, setModelOptions);
            }
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: COPILOT_DRIVER_KIND,
              method: "session.setModel",
              detail: toMessage(cause, "Failed to apply GitHub Copilot model selection."),
              cause,
            }),
        });
      }

      record.updatedAt = new Date().toISOString();

      const sendPayload: Parameters<typeof record.session.send>[0] = {
        prompt:
          appendAttachmentPathLines(
            input.input ?? "",
            formatAttachmentPathLines(pathLineEntries),
          ) ?? "",
        ...(attachments.length > 0 ? { attachments } : {}),
        mode: "immediate",
      };

      const sendAndWaitForTurnStart = async (): Promise<TurnId> => {
        const turnStart = createTurnStartWaiter(record);
        try {
          const [, startedTurnId] = await Promise.all([
            record.session.send(sendPayload),
            turnStart.promise,
          ]);
          return startedTurnId;
        } catch (error) {
          turnStart.cancel();
          throw error;
        }
      };

      let turnId: TurnId;
      yield* Effect.tryPromise({
        try: async () => {
          try {
            turnId = await sendAndWaitForTurnStart();
          } catch (firstError) {
            if (!isSessionNotFoundError(firstError)) throw firstError;
            const freshSession = await record.renewSession();
            record.attachSession(freshSession);
            if (copilotModelSelection) {
              const reasoningEffort = getModelSelectionStringOptionValue(
                copilotModelSelection,
                "reasoningEffort",
              );
              await record.session.setModel(
                copilotModelSelection.model,
                reasoningEffort
                  ? { reasoningEffort: reasoningEffort as CopilotReasoningEffort }
                  : undefined,
              );
            }
            turnId = await sendAndWaitForTurnStart();
          }
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: COPILOT_DRIVER_KIND,
            method: "session.send",
            detail: toMessage(cause, "Failed to send GitHub Copilot turn."),
            cause,
          }),
      });

      if (record.agentControl) yield* record.agentControl.bindTurn(turnId!);

      return {
        threadId: input.threadId,
        turnId: turnId!,
        resumeCursor: { sessionId: record.session.sessionId },
      } satisfies ProviderTurnStartResult;
    });

export const makeInterruptTurn =
  (deps: SessionOpsDeps): CopilotAdapterShape["interruptTurn"] =>
  (threadId) =>
    Effect.gen(function* () {
      const record = yield* deps.requireSession(threadId);
      if (record.agentControl) yield* record.agentControl.retireTurn(record.activeTurnId);
      yield* Effect.tryPromise({
        try: () => record.session.abort(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: COPILOT_DRIVER_KIND,
            method: "session.abort",
            detail: toMessage(cause, "Failed to interrupt GitHub Copilot turn."),
            cause,
          }),
      });
    });

export const stopSessionRecord = (
  record: ActiveCopilotSession,
): Effect.Effect<void, ProviderAdapterRequestError> =>
  Effect.sync(() => record.deviceToolBinding?.dispose()).pipe(
    Effect.andThen(
      record.agentControl ? record.agentControl.revoke("runtime-teardown") : Effect.void,
    ),
    Effect.andThen(
      Effect.tryPromise({
        try: async () => {
          record.stopped = true;
          record.unsubscribe();
          for (const pending of record.pendingApprovals.values()) {
            pending.resolve({ kind: "reject" });
          }
          for (const pending of record.pendingUserInputs.values()) {
            pending.resolve({ answer: "", wasFreeform: true });
          }
          for (const pending of record.pendingTurnStarts.values()) {
            pending.reject(new Error("GitHub Copilot session stopped before turn start."));
          }
          record.pendingApprovals.clear();
          record.pendingUserInputs.clear();
          record.pendingTurnStarts.clear();
          try {
            await record.session.disconnect();
          } finally {
            await record.client.stop();
          }
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: COPILOT_DRIVER_KIND,
            method: "session.stop",
            detail: toMessage(cause, "Failed to stop GitHub Copilot session."),
            cause,
          }),
      }),
    ),
  );

export const makeStopSession =
  (deps: SessionOpsDeps): CopilotAdapterShape["stopSession"] =>
  (threadId) =>
    Effect.gen(function* () {
      const record = yield* deps.requireSession(threadId);
      deps.sessions.delete(threadId);
      yield* stopSessionRecord(record);
    });

export const makeStopAll =
  (deps: SessionOpsDeps): CopilotAdapterShape["stopAll"] =>
  () =>
    Effect.gen(function* () {
      const records = Array.from(deps.sessions.values());
      deps.sessions.clear();
      yield* Effect.forEach(records, stopSessionRecord, {
        concurrency: "unbounded",
        discard: true,
      });
    });

export const makeListSessions =
  (deps: SessionOpsDeps): CopilotAdapterShape["listSessions"] =>
  () =>
    Effect.sync(() =>
      Array.from(deps.sessions.values()).map((record): ProviderSession => {
        const session: { -readonly [K in keyof ProviderSession]: ProviderSession[K] } = {
          provider: COPILOT_DRIVER_KIND,
          providerInstanceId: deps.instanceId,
          runtimeSessionId: record.runtimeSessionId,
          status: record.activeTurnId ? "running" : "ready",
          runtimeMode: record.runtimeMode,
          tokenMode: record.tokenMode,
          threadId: record.threadId,
          resumeCursor: { sessionId: record.session.sessionId },
          activeTurnId: record.activeTurnId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
        if (record.cwd) session.cwd = record.cwd;
        if (record.model) session.model = record.model;
        if (record.lastError) session.lastError = record.lastError;
        return session;
      }),
    );

export const makeHasSession =
  (deps: SessionOpsDeps): CopilotAdapterShape["hasSession"] =>
  (threadId) =>
    Effect.sync(() => deps.sessions.has(threadId));

export const makeReadThread =
  (deps: SessionOpsDeps): CopilotAdapterShape["readThread"] =>
  (threadId) =>
    Effect.gen(function* () {
      const record = yield* deps.requireSession(threadId);
      return buildThreadSnapshot(threadId, record.turns);
    });

export const makeRollbackThread = (): CopilotAdapterShape["rollbackThread"] => (threadId) =>
  Effect.succeed({
    threadId,
    turns: [],
  });
