import { isCopilotChildEvent } from "./CopilotAdapter.eventScope.ts";
import { randomUUID } from "node:crypto";

import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type RuntimeSessionId,
  type UserInputQuestion,
} from "@ryco/contracts";
import type { PermissionRequestResult, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { Effect, Queue, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { makeServerQueueMetrics } from "../../observability/QueueMetrics.ts";
import { getProviderOptionStringSelectionValue } from "@ryco/shared/model";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { stampRuntimeEvent } from "../runtimeSession.ts";
import type { CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import {
  COPILOT_DRIVER_KIND,
  USER_INPUT_QUESTION_ID,
  type ActiveCopilotSession,
  type CopilotAdapterLiveOptions,
  type PendingApprovalRequest,
  type PendingUserInputRequest,
  approvalDecisionToPermissionResult,
  eventBase,
  requestDetailFromPermissionRequest,
  requestTypeFromPermissionRequest,
  selectionTargetsCopilotInstance,
} from "./CopilotAdapter.types.ts";
import { mapEvent, type MapEventDeps } from "./CopilotAdapter.mapEvent.ts";
import {
  type SessionOpsDeps,
  makeHasSession,
  makeInterruptTurn,
  makeListSessions,
  makeReadThread,
  makeRollbackThread,
  makeSendTurn,
  makeStartSession,
  makeStopAll,
  makeStopSession,
} from "./CopilotAdapter.session.ts";
import {
  AGENT_CONTROL_INTERNAL_SERVER_NAME,
  agentControlHostContext,
  redactAgentControlSecrets,
  type AgentControlNativeHttpInjection,
} from "../../agentControl/ProviderInjection.ts";

export { makeCopilotClientOptions, resolveCopilotCliPath } from "./CopilotAdapter.types.ts";
export type { CopilotAdapterLiveOptions } from "./CopilotAdapter.types.ts";

const FULL_ACCESS_AUTO_APPROVE_AFTER_MS = 600;

export const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  copilotSettings: { readonly binaryPath: string },
  options?: CopilotAdapterLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const instanceId = options?.instanceId ?? ProviderInstanceId.make("copilot");
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const sessions = new Map<ThreadId, ActiveCopilotSession>();
  const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(2_048);
  const runtimeEventQueueMetrics = yield* makeServerQueueMetrics({
    queue: "provider.adapter.runtimeEvents",
    component: "CopilotAdapter",
    provider: COPILOT_DRIVER_KIND,
    providerInstanceId: instanceId,
  });

  const nextEventId = Effect.map(
    Effect.sync(() => crypto.randomUUID()),
    (id) => EventId.make(id),
  );
  const makeEventStamp = () =>
    Effect.all({
      eventId: nextEventId,
      createdAt: Effect.sync(() => new Date().toISOString()),
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ActiveCopilotSession, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: COPILOT_DRIVER_KIND, threadId }),
        );
  };

  const emit = (events: ReadonlyArray<ProviderRuntimeEvent>) => {
    for (const event of events) {
      if (event.runtimeSessionId === undefined) {
        throw new Error(
          `CopilotAdapter emitted '${event.type}' without a runtime session for thread '${event.threadId}'.`,
        );
      }
    }
    const safeEvents = events.map(
      (event) => redactAgentControlSecrets(event) as ProviderRuntimeEvent,
    );
    return Queue.offerAll(runtimeEventQueue, safeEvents).pipe(
      Effect.andThen(runtimeEventQueueMetrics.recordEnqueued(events.length)),
      Effect.asVoid,
    );
  };

  const logNativeEvent = Effect.fn("logCopilotNativeEvent")(function* (
    threadId: ThreadId,
    event: SessionEvent,
  ) {
    if (!nativeEventLogger) return;
    yield* nativeEventLogger
      .write(
        {
          observedAt: new Date().toISOString(),
          event: redactAgentControlSecrets(event),
        },
        threadId,
      )
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const makeSyntheticEvent = <TType extends ProviderRuntimeEvent["type"]>(
    threadId: ThreadId,
    runtimeSessionId: RuntimeSessionId,
    type: TType,
    payload: Extract<ProviderRuntimeEvent, { type: TType }>["payload"],
    extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
  ): Effect.Effect<Extract<ProviderRuntimeEvent, { type: TType }>> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      return stampRuntimeEvent(
        {
          ...eventBase({
            eventId: stamp.eventId,
            createdAt: stamp.createdAt,
            threadId,
            providerInstanceId: instanceId,
            ...(extra?.turnId ? { turnId: extra.turnId } : {}),
            ...(extra?.itemId ? { itemId: extra.itemId } : {}),
            ...(extra?.requestId ? { requestId: extra.requestId } : {}),
            raw: {
              source: "copilot.sdk.synthetic",
              payload,
            },
          }),
          type,
          payload,
        } as Extract<ProviderRuntimeEvent, { type: TType }>,
        {
          providerInstanceId: instanceId,
          runtimeSessionId,
        },
      ) as Extract<ProviderRuntimeEvent, { type: TType }>;
    });

  const mapEventDeps: MapEventDeps = { makeEventStamp, nextEventId };

  const handleEvent = Effect.fn("handleCopilotEvent")(function* (
    session: ActiveCopilotSession,
    event: SessionEvent,
  ) {
    if (isCopilotChildEvent(event)) {
      yield* logNativeEvent(session.threadId, event);
      const mapped = (yield* mapEvent(mapEventDeps, session, event)).map((runtimeEvent) =>
        stampRuntimeEvent(runtimeEvent, {
          providerInstanceId: instanceId,
          runtimeSessionId: session.runtimeSessionId,
        }),
      );
      if (mapped.length > 0) yield* emit(mapped);
      return;
    }
    session.updatedAt = event.timestamp;
    const clearsActiveTurn = event.type === "session.idle" || event.type === "abort";

    if (event.type === "assistant.turn_start") {
      const turnId = TurnId.make(event.data.turnId);
      session.activeTurnId = turnId;
      session.turns.push({ id: turnId, items: [event] });
    } else if (event.type === "assistant.message") {
      session.activeMessageId = event.data.messageId;
      session.turns.at(-1)?.items.push(event);
    } else if (
      event.type === "assistant.message_delta" ||
      event.type === "assistant.reasoning" ||
      event.type === "assistant.reasoning_delta" ||
      event.type === "assistant.usage" ||
      event.type === "tool.execution_start" ||
      event.type === "tool.execution_complete" ||
      event.type === "user_input.requested" ||
      event.type === "user_input.completed"
    ) {
      session.turns.at(-1)?.items.push(event);
    } else if (
      event.type === "session.idle" ||
      event.type === "abort" ||
      event.type === "assistant.turn_end" ||
      event.type === "session.error"
    ) {
      session.turns.at(-1)?.items.push(event);
    }

    if (event.type === "session.error") {
      session.lastError = event.data.message;
      if (session.agentControl) yield* session.agentControl.revoke("runtime-teardown");
    }

    yield* logNativeEvent(session.threadId, event);
    const mapped = (yield* mapEvent(mapEventDeps, session, event)).map((runtimeEvent) =>
      stampRuntimeEvent(runtimeEvent, {
        providerInstanceId: instanceId,
        runtimeSessionId: session.runtimeSessionId,
      }),
    );
    if (mapped.length > 0) {
      yield* emit(mapped);
    }

    if (clearsActiveTurn) {
      if (session.agentControl && session.activeTurnId) {
        yield* session.agentControl.retireTurn(session.activeTurnId);
      }
      session.activeTurnId = undefined;
      session.activeMessageId = undefined;
    }
    if (event.type === "assistant.turn_end" && session.agentControl && session.activeTurnId) {
      yield* session.agentControl.retireTurn(session.activeTurnId);
    }
  });

  const buildSessionConfig = (
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
  ): SessionConfig => ({
    ...(selectionTargetsCopilotInstance(input.modelSelection, instanceId)
      ? {
          model: input.modelSelection.model,
          ...(getProviderOptionStringSelectionValue(input.modelSelection.options, "reasoningEffort")
            ? {
                reasoningEffort: getProviderOptionStringSelectionValue(
                  input.modelSelection.options,
                  "reasoningEffort",
                ) as "low" | "medium" | "high" | "xhigh",
              }
            : {}),
        }
      : {}),
    ...(input.cwd ? { workingDirectory: input.cwd } : {}),
    streaming: true,
    systemMessage: {
      mode: "append",
      content:
        "You have access to a Chromium browser in this environment. " +
        "Use it when the task requires live web interaction, navigation, UI verification, login flows, repros, scraping, or screenshots. " +
        "Prefer codebase inspection first when the task is local-only. " +
        "Summarize what was verified, including URL and important observations. " +
        "Avoid unnecessary browser use when terminal or file tools are sufficient." +
        (input.agentControl
          ? `\n\n${input.agentControl.hostContext}`
          : options?.agentControl
            ? `\n\n${agentControlHostContext(false)}`
            : ""),
    },
    ...(input.agentControl
      ? {
          mcpOAuthTokenStorage: "in-memory",
          mcpServers: {
            [AGENT_CONTROL_INTERNAL_SERVER_NAME]: input.agentControl.mcpServer,
          },
        }
      : {}),
    onPermissionRequest: (request) =>
      new Promise<PermissionRequestResult>((resolve) => {
        const requestId = randomUUID();
        const currentTurnId = activeTurnId();
        const requestType = requestTypeFromPermissionRequest(request);
        const requestDetail = requestDetailFromPermissionRequest(request);
        pendingApprovals.set(requestId, {
          request,
          requestType,
          turnId: currentTurnId,
          resolve,
        });

        void makeSyntheticEvent(
          input.threadId,
          input.runtimeSessionId,
          "request.opened",
          {
            requestType,
            ...(requestDetail ? { detail: requestDetail } : {}),
            args: request,
          },
          {
            ...(currentTurnId ? { turnId: currentTurnId } : {}),
            requestId,
          },
        )
          .pipe(
            Effect.flatMap((event) => emit([event])),
            Effect.runPromise,
          )
          .catch(() => undefined);

        if (input.runtimeMode === "full-access") {
          void Effect.gen(function* () {
            yield* Effect.sleep(FULL_ACCESS_AUTO_APPROVE_AFTER_MS);
            if (stoppedRef.stopped) return;
            const pending = pendingApprovals.get(requestId);
            if (!pending) return;
            pendingApprovals.delete(requestId);
            pending.resolve({ kind: "approve-once" });
            const event = yield* makeSyntheticEvent(
              input.threadId,
              input.runtimeSessionId,
              "request.resolved",
              {
                requestType,
                decision: "accept",
              },
              {
                ...(currentTurnId ? { turnId: currentTurnId } : {}),
                requestId,
              },
            );
            yield* emit([event]);
          })
            .pipe(Effect.runPromise)
            .catch(() => undefined);
        }
      }),
    onUserInputRequest: (request) =>
      new Promise((resolve) => {
        const requestId = randomUUID();
        const currentTurnId = activeTurnId();
        pendingUserInputs.set(requestId, {
          turnId: currentTurnId,
          choices: request.choices ?? [],
          resolve,
        });

        const question: UserInputQuestion = {
          id: USER_INPUT_QUESTION_ID,
          header: "Question",
          question: request.question,
          options: (request.choices ?? []).map((choice: string) => ({
            label: choice,
            description: choice,
          })),
        };

        void makeSyntheticEvent(
          input.threadId,
          input.runtimeSessionId,
          "user-input.requested",
          { questions: [question] },
          {
            ...(currentTurnId ? { turnId: currentTurnId } : {}),
            requestId,
          },
        )
          .pipe(
            Effect.flatMap((event) => emit([event])),
            Effect.runPromise,
          )
          .catch(() => undefined);
      }),
  });

  const sessionDeps: SessionOpsDeps = {
    sessions,
    serverConfig: { attachmentsDir: serverConfig.attachmentsDir },
    copilotSettings,
    ...(options?.environment ? { environment: options.environment } : {}),
    options,
    instanceId,
    emit,
    makeSyntheticEvent: makeSyntheticEvent as SessionOpsDeps["makeSyntheticEvent"],
    buildSessionConfig,
    handleEvent,
    requireSession,
  };

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      const pending = record.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: COPILOT_DRIVER_KIND,
          method: "session.permission.respond",
          detail: `Unknown pending GitHub Copilot approval request '${requestId}'.`,
        });
      }

      record.pendingApprovals.delete(requestId);
      pending.resolve(approvalDecisionToPermissionResult(decision, pending.request));
      const event = yield* makeSyntheticEvent(
        threadId,
        record.runtimeSessionId,
        "request.resolved",
        {
          requestType: pending.requestType,
          decision,
        },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId,
        },
      );
      yield* emit([event]);
    });

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      const pending = record.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: COPILOT_DRIVER_KIND,
          method: "session.userInput.respond",
          detail: `Unknown pending GitHub Copilot user-input request '${requestId}'.`,
        });
      }

      record.pendingUserInputs.delete(requestId);
      const candidate =
        typeof answers[USER_INPUT_QUESTION_ID] === "string"
          ? answers[USER_INPUT_QUESTION_ID]
          : (Object.values(answers).find((value): value is string => typeof value === "string") ??
            "");
      pending.resolve({
        answer: candidate,
        wasFreeform: !pending.choices.includes(candidate),
      });

      const event = yield* makeSyntheticEvent(
        threadId,
        record.runtimeSessionId,
        "user-input.resolved",
        { answers },
        {
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          requestId,
        },
      );
      yield* emit([event]);
    });

  const stopAll = makeStopAll(sessionDeps);

  return {
    provider: COPILOT_DRIVER_KIND,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession: makeStartSession(sessionDeps),
    sendTurn: makeSendTurn(sessionDeps),
    interruptTurn: makeInterruptTurn(sessionDeps),
    respondToRequest,
    respondToUserInput,
    stopSession: makeStopSession(sessionDeps),
    listSessions: makeListSessions(sessionDeps),
    hasSession: makeHasSession(sessionDeps),
    readThread: makeReadThread(sessionDeps),
    rollbackThread: makeRollbackThread(),
    stopAll: () => stopAll().pipe(Effect.tap(() => runtimeEventQueueMetrics.reset)),
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue).pipe(
        Stream.tap(() => runtimeEventQueueMetrics.recordDequeued()),
      );
    },
  } satisfies CopilotAdapterShape;
});
