// What a proposed plan's buttons send: Implement (a turn in this chat that carries out the plan)
// and Implement in a new chat (a fresh thread in the same place, whose first turn does). The
// prompt, title and file name are web's (`@ryco/client-runtime/state/composer` plan helpers), and
// both turns name the plan they implement, so the node marks it implemented.
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
  buildProposedPlanMarkdownFilename,
  buildTurnStartCommand,
  composeOutgoingPrompt,
  normalizePlanMarkdownForExport,
} from "@ryco/client-runtime/state/composer";
import type {
  AgentTokenMode,
  ClientOrchestrationCommand,
  CommandId,
  EnvironmentApi,
  MessageId,
  ModelSelection,
  OrchestrationProposedPlanId,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@ryco/contracts";
import { truncate } from "@ryco/shared/String";

export interface PlanSource {
  readonly threadId: ThreadId;
  readonly planId: OrchestrationProposedPlanId;
  readonly planMarkdown: string;
}

export interface PlanTurnSettings {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly tokenMode: AgentTokenMode;
}

type TurnStart = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
type ThreadCreate = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;

/** The turn that implements `plan` in the thread `threadId` (its own, or a new one). */
export function buildImplementPlanTurn(input: {
  readonly plan: PlanSource;
  readonly threadId: ThreadId;
  readonly titleSeed: string;
  readonly settings: PlanTurnSettings;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly createdAt: string;
}): TurnStart {
  return buildTurnStartCommand({
    commandId: input.commandId,
    threadId: input.threadId,
    messageId: input.messageId,
    text: composeOutgoingPrompt({ prompt: buildPlanImplementationPrompt(input.plan.planMarkdown) }),
    attachments: [],
    modelSelection: input.settings.modelSelection,
    titleSeed: input.titleSeed,
    runtimeMode: input.settings.runtimeMode,
    // Implementing leaves plan mode: the agent carries the plan out.
    interactionMode: "default",
    tokenMode: input.settings.tokenMode,
    sourceProposedPlan: { threadId: input.plan.threadId, planId: input.plan.planId },
    createdAt: input.createdAt,
  }) as TurnStart;
}

/** The new chat a plan is implemented in: same project, same checkout, titled after the plan. */
export function buildImplementationThreadCreate(input: {
  readonly plan: PlanSource;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly settings: PlanTurnSettings;
  readonly commandId: CommandId;
  readonly createdAt: string;
}): ThreadCreate {
  return {
    type: "thread.create",
    commandId: input.commandId,
    threadId: input.threadId,
    projectId: input.projectId,
    // Cut like web's, so both clients title the chat the same.
    title: truncate(buildPlanImplementationThreadTitle(input.plan.planMarkdown)),
    modelSelection: input.settings.modelSelection,
    runtimeMode: input.settings.runtimeMode,
    interactionMode: "default",
    tokenMode: input.settings.tokenMode,
    branch: input.branch,
    worktreePath: input.worktreePath,
    createdAt: input.createdAt,
  };
}

export interface PlanIds {
  readonly newCommandId: () => CommandId;
  readonly newMessageId: () => MessageId;
}

/**
 * Implement: a turn in this chat. The node runs a turn in the thread's own mode, not the one the
 * turn start names, so a chat still in plan mode is switched to build mode first (as web's send
 * does), or the agent would only plan again.
 */
export async function implementPlanHere(input: {
  readonly api: EnvironmentApi;
  readonly plan: PlanSource;
  readonly titleSeed: string;
  /** The thread's interaction mode now. */
  readonly interactionMode: ProviderInteractionMode;
  /** Sets the thread's interaction mode (`setThreadInteractionMode`). */
  readonly setInteractionMode: (mode: ProviderInteractionMode) => Promise<void>;
  readonly settings: PlanTurnSettings;
  readonly ids: PlanIds;
}): Promise<void> {
  if (input.interactionMode !== "default") {
    await input.setInteractionMode("default");
  }
  await input.api.orchestration.dispatchCommand(
    buildImplementPlanTurn({
      plan: input.plan,
      threadId: input.plan.threadId,
      titleSeed: input.titleSeed,
      settings: input.settings,
      commandId: input.ids.newCommandId(),
      messageId: input.ids.newMessageId(),
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * Implement in a new chat: creates the thread, then starts its turn. A thread whose turn never
 * started is removed again (archived when it cannot be deleted), as web does, so a failure
 * leaves no empty chat behind.
 */
export async function implementPlanInNewThread(input: {
  readonly api: EnvironmentApi;
  readonly plan: PlanSource;
  readonly newThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly settings: PlanTurnSettings;
  readonly ids: PlanIds;
}): Promise<void> {
  const createdAt = new Date().toISOString();
  const create = buildImplementationThreadCreate({
    plan: input.plan,
    threadId: input.newThreadId,
    projectId: input.projectId,
    branch: input.branch,
    worktreePath: input.worktreePath,
    settings: input.settings,
    commandId: input.ids.newCommandId(),
    createdAt,
  });
  const dispatch = input.api.orchestration.dispatchCommand;
  await dispatch(create);
  await dispatch(
    buildImplementPlanTurn({
      plan: input.plan,
      threadId: input.newThreadId,
      titleSeed: create.title,
      settings: input.settings,
      commandId: input.ids.newCommandId(),
      messageId: input.ids.newMessageId(),
      createdAt,
    }),
  ).catch(async (error: unknown) => {
    await dispatch({
      type: "thread.delete",
      commandId: input.ids.newCommandId(),
      threadId: input.newThreadId,
    })
      .catch(() =>
        dispatch({
          type: "thread.archive",
          commandId: input.ids.newCommandId(),
          threadId: input.newThreadId,
        }),
      )
      .catch(() => undefined);
    throw error;
  });
}

/** The plan as a Markdown file: its name after the plan's heading, and its contents. */
export function planMarkdownExport(planMarkdown: string): {
  readonly filename: string;
  readonly contents: string;
} {
  return {
    filename: buildProposedPlanMarkdownFilename(planMarkdown),
    contents: normalizePlanMarkdownForExport(planMarkdown),
  };
}

/**
 * Where "Save to workspace" writes: a path relative to the checkout, never outside it. Null when
 * the typed path is empty, absolute or climbs out with `..`.
 */
export function resolvePlanSavePath(typed: string | undefined): string | null {
  const path = typed?.trim().replace(/\\/g, "/") ?? "";
  if (path.length === 0 || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null;
  if (path.split("/").some((segment) => segment === "..")) return null;
  return path.replace(/^\.\//, "");
}
