/**
 * CursorAdapterLive — Cursor CLI (`agent acp`) via ACP: the shared ACP adapter
 * (`makeAcpAdapter`) configured with Cursor's model and mode selection, its
 * extension methods and its permission option ids.
 *
 * @module CursorAdapterLive
 */
import {
  type CursorSettings,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
} from "@ryco/contracts";
import { Effect } from "effect";
import type * as EffectAcpErrors from "effect-acp/errors";

import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { type AcpSessionMode, type AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import { applyCursorAcpModelSelection, makeCursorAcpRuntime } from "../acp/CursorAcpSupport.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../acp/CursorAcpExtension.ts";
import {
  type AcpAdapterExtensionContext,
  type AcpSessionConfiguration,
  type AcpUserInputResolution,
  makeAcpAdapter,
} from "./AcpAdapter.ts";
import { resolveCursorAcpBaseModelId } from "./CursorProvider.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { AgentProcessPriorityShape } from "../agentProcessPriority.ts";
import { type AgentControlProviderBridge } from "../../agentControl/ProviderInjection.ts";

const PROVIDER = ProviderDriverKind.make("cursor");
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export interface CursorAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`cursor`).
   */
  readonly instanceId?: typeof ProviderInstanceId.Type;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `cursorSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<CursorSettings>;
  readonly agentControl?: AgentControlProviderBridge;
  readonly stdioProxy?: { readonly command: string; readonly entryPoint: string };
  /** Lowers each session's agent process; undefined spawns it unchanged. */
  readonly processPriority?: AgentProcessPriorityShape | undefined;
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.interactionMode === "ask") {
    return findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyCursorAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

/** Cursor selects models through `session/set_config_option` and picks a mode for every turn. */
const cursorSessionConfiguration: AcpSessionConfiguration = {
  start: ({ runtime, threadId, runtimeMode, modelSelection }) =>
    applyRequestedSessionConfiguration({
      runtime,
      runtimeMode,
      interactionMode: undefined,
      modelSelection,
      mapError: ({ cause, method }) => mapAcpToAdapterError(PROVIDER, threadId, method, cause),
    }).pipe(Effect.as({ model: modelSelection?.model, currentModelId: undefined })),
  turn: ({ runtime, threadId, session, interactionMode, modelSelection }) => {
    const model = modelSelection?.model ?? session.model;
    return applyRequestedSessionConfiguration({
      runtime,
      runtimeMode: session.runtimeMode,
      interactionMode,
      modelSelection: model === undefined ? undefined : { model, options: modelSelection?.options },
      mapError: ({ cause, method }) => mapAcpToAdapterError(PROVIDER, threadId, method, cause),
    }).pipe(Effect.as({ model: resolveCursorAcpBaseModelId(model), currentModelId: undefined }));
  },
};

/**
 * What Cursor's agent is told when a question is settled. A question cancelled by an interrupt
 * or a stop is answered with no answers, as the Cursor adapter always did. xAI agents get an
 * explicit cancellation instead (`AcpAdapter.ts`); whether Cursor should too is undecided.
 */
export function cursorAskQuestionAnswers(
  resolution: AcpUserInputResolution,
): ProviderUserInputAnswers {
  return resolution._tag === "answered" ? resolution.answers : {};
}

/** Cursor's extension methods: questions, proposed plans and its todo list. */
export function registerCursorExtensions(
  context: AcpAdapterExtensionContext,
): Effect.Effect<void, EffectAcpErrors.AcpError> {
  return Effect.gen(function* () {
    yield* context.runtime.handleExtRequest(
      "cursor/ask_question",
      CursorAskQuestionRequest,
      (params) =>
        Effect.gen(function* () {
          yield* context.logNative("cursor/ask_question", params);
          const resolved = yield* context.requestUserInput({
            questions: extractAskQuestions(params),
            raw: {
              source: "acp.cursor.extension",
              method: "cursor/ask_question",
              payload: params,
            },
            rawOnResolved: false,
          });
          return { answers: cursorAskQuestionAnswers(resolved) };
        }),
    );
    yield* context.runtime.handleExtRequest(
      "cursor/create_plan",
      CursorCreatePlanRequest,
      (params) =>
        Effect.gen(function* () {
          yield* context.logNative("cursor/create_plan", params);
          yield* context.emit({
            type: "turn.proposed.completed",
            ...(yield* context.makeEventStamp()),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId(),
            payload: { planMarkdown: extractPlanMarkdown(params) },
            raw: {
              source: "acp.cursor.extension",
              method: "cursor/create_plan",
              payload: params,
            },
          });
          return { accepted: true } as const;
        }),
    );
    yield* context.runtime.handleExtNotification(
      "cursor/update_todos",
      CursorUpdateTodosRequest,
      (params) =>
        Effect.gen(function* () {
          yield* context.logNative("cursor/update_todos", params);
          yield* context.emitPlanUpdate({
            payload: extractTodosAsPlan(params),
            rawPayload: params,
            source: "acp.cursor.extension",
            method: "cursor/update_todos",
          });
        }),
    );
  });
}

export function makeCursorAdapter(
  cursorSettings: CursorSettings,
  options?: CursorAdapterLiveOptions,
) {
  return makeAcpAdapter({
    provider: PROVIDER,
    ...(options?.environment ? { environment: options.environment } : {}),
    ...(options?.nativeEventLogPath !== undefined
      ? { nativeEventLogPath: options.nativeEventLogPath }
      : {}),
    ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
    instanceId: options?.instanceId ?? ProviderInstanceId.make("cursor"),
    ...(options?.processPriority ? { processPriority: options.processPriority } : {}),
    normalizeModel: resolveCursorAcpBaseModelId,
    // Settings are read per session, so a test's settings change reaches the next spawn.
    makeRuntime: (input) =>
      Effect.gen(function* () {
        const effectiveCursorSettings = options?.resolveSettings
          ? yield* options.resolveSettings
          : cursorSettings;
        return yield* makeCursorAcpRuntime({ ...input, cursorSettings: effectiveCursorSettings });
      }),
    sessionConfiguration: cursorSessionConfiguration,
    registerExtensions: registerCursorExtensions,
    // Cursor's agent uses fixed option ids.
    selectPermissionOptionId: (_request, decision) => acpPermissionOutcome(decision),
    invalidResumeCursor: "start-fresh",
    promptAssembly: "after-turn-start",
    agentControl: {
      bridge: options?.agentControl,
      ...(options?.stdioProxy ? { stdioProxy: options.stdioProxy } : {}),
    },
    // A steer stops the turn (session/cancel) and sends the message next (ProviderService).
    turnSteering: "interrupt-restart",
    labels: {
      readyReason: "Cursor ACP session ready",
      rollbackUnsupportedDetail: "Cursor does not support conversation rollback.",
      userInputMethod: "cursor/ask_question",
    },
  });
}
