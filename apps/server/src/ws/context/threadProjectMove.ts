/**
 * The node's side of "Move to project" around the decider (`thread.project.move`).
 *
 * The decider owns every rule it can read from the orchestration model (an idle thread, a live
 * target, the stale-client fence). This step adds what lives outside it:
 * - a schedule that continues this chat (an automation's target) keeps it in place: its runs
 *   would fail in another project, so the user points the automation elsewhere first;
 * - a terminal of the thread running a command keeps it in place, and the thread's idle shells
 *   close once it moved (their history is kept; the next one opens in the new directory);
 * - a move to "No project" first creates the new chat and its folder, exactly as a chat's first
 *   send does, and removes that folder again when the move is refused.
 *
 * @module ws/context/threadProjectMove
 */
import {
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
  type ThreadId,
} from "@ryco/contracts";
import { Effect } from "effect";

import type { AgentControlAutomationRepositoryShape } from "../../persistence/Services/AgentControlAutomations.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { isTerminalAlive, isTerminalWorking } from "../../terminal/terminalActivity.ts";
import {
  type ChatBootstrapDependencies,
  type PreparedChatProject,
  prepareChatProject,
  releasePreparedChatFolder,
} from "./chatBootstrap.ts";

export type ThreadProjectMoveCommand = Extract<
  OrchestrationCommand,
  { type: "thread.project.move" }
>;

export interface ThreadProjectMoveDependencies {
  readonly chatBootstrap: ChatBootstrapDependencies;
  readonly terminals: Pick<TerminalManagerShape, "listDiagnostics" | "close">;
  /** Absent where Agent Control persistence is not provided: no automation can target a chat. */
  readonly automations:
    | Pick<AgentControlAutomationRepositoryShape, "listActiveTitlesTargetingThread">
    | undefined;
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

const refuse = (message: string, cause?: unknown) =>
  new OrchestrationDispatchCommandError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/** Why an automation keeps the thread in place, or null. */
export function automationMoveBlockerMessage(titles: ReadonlyArray<string>): string | null {
  const first = titles[0];
  if (first === undefined) return null;
  const others = titles.length - 1;
  const subject =
    others === 0
      ? `The automation "${first}" continues this chat`
      : `The automation "${first}" and ${others} more continue this chat`;
  return `${subject}. Point it at another chat or remove it, then move the chat.`;
}

const threadTerminals = (deps: ThreadProjectMoveDependencies, threadId: ThreadId) =>
  deps.terminals.listDiagnostics.pipe(
    Effect.map((terminals) =>
      terminals.filter((terminal) => terminal.threadId === threadId && isTerminalAlive(terminal)),
    ),
  );

export const dispatchThreadProjectMove = (
  deps: ThreadProjectMoveDependencies,
  command: ThreadProjectMoveCommand,
): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
  Effect.gen(function* () {
    if (deps.automations !== undefined) {
      const titles = yield* deps.automations
        .listActiveTitlesTargetingThread(command.threadId)
        .pipe(
          Effect.mapError((cause) =>
            refuse("Ryco could not check this chat's automations. Try again.", cause),
          ),
        );
      const automationBlocker = automationMoveBlockerMessage(titles);
      if (automationBlocker !== null) return yield* refuse(automationBlocker);
    }
    const terminals = yield* threadTerminals(deps, command.threadId);
    if (terminals.some(isTerminalWorking)) {
      return yield* refuse(
        "A terminal of this thread is running a command. Stop it, then move the thread.",
      );
    }

    let prepared: PreparedChatProject | undefined;
    if (command.createChatProject !== undefined) {
      prepared = yield* prepareChatProject(deps.chatBootstrap, {
        chat: command.createChatProject,
        createThread: { worktreePath: null, createdAt: command.createdAt },
      });
    }
    const result = yield* deps
      .dispatch(command)
      .pipe(
        Effect.onError(() =>
          prepared === undefined
            ? Effect.void
            : releasePreparedChatFolder(deps.chatBootstrap, prepared),
        ),
      );

    // Shells of the thread run in its old directory; history stays, the next one opens here.
    if (terminals.length > 0) {
      yield* deps.terminals
        .close({ threadId: command.threadId })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    return result;
  });
