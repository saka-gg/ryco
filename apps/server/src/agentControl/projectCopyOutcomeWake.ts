/**
 * Tells the agent that asked for an `importProject` or `copyProjectToNode` how it ended: once the
 * proposal settles (`completed` or `failed`), a short note is queued in the asking chat's own
 * follow-up queue, the same queue `ryco_send_message` and a worktree handoff's continuation use.
 * The queue sends it at the chat's next idle moment, after the person's own follow-ups, and holds
 * it like them; the agent may edit or remove it (`ryco_queue_*`). The note's ids follow from the
 * proposal's operation, so queueing it again (a restart, a repeated settle) changes nothing.
 *
 * Loaded with the project copy runs (`projectCopyRuns.ts`), never on the boot path.
 *
 * @module agentControl/projectCopyOutcomeWake
 */
import type {
  AgentControlCopyProjectToNodePlan,
  AgentControlImportProjectPlan,
  AgentControlOperationId,
  AgentControlProposal,
  CommandId,
  MessageId,
  OrchestrationThreadShell,
  ThreadId,
  ThreadQueueAddCommand,
} from "@ryco/contracts";
import { isRuntimeModeAbove } from "@ryco/shared/runtimeMode";
import { Effect } from "effect";

/** The step the note's command and message ids are minted for. */
export const PROJECT_COPY_OUTCOME_STEP = "project-copy-outcome";

type ProjectCopyPlan = AgentControlImportProjectPlan | AgentControlCopyProjectToNodePlan;
type ProposalWithPlan = AgentControlProposal & { readonly plan: ProjectCopyPlan };

const isProjectCopyProposal = (proposal: AgentControlProposal): proposal is ProposalWithPlan =>
  proposal.plan.kind === "importProject" || proposal.plan.kind === "copyProjectToNode";

/** Whether a proposal event is one this module tells its agent about. */
export const isSettledProjectCopyProposal = (proposal: AgentControlProposal): boolean =>
  isProjectCopyProposal(proposal) &&
  (proposal.status === "completed" || proposal.status === "failed") &&
  proposal.principal.kind === "provider-session";

const quoted = (command: string): string =>
  command.includes("\n") || command.length > 200 ? "the setup command" : `\`${command}\``;

/**
 * What the agent reads: where the project is, how its setup went, the setup thread and any
 * warnings, or why it failed. Null for a proposal that is not a settled copy or import.
 */
export function renderProjectCopyOutcome(proposal: AgentControlProposal): string | null {
  if (!isProjectCopyProposal(proposal) || proposal.result === null) return null;
  const plan = proposal.plan;
  const copy = plan.kind === "copyProjectToNode" ? plan : null;
  const title = copy === null ? (plan as AgentControlImportProjectPlan).title : copy.source.title;
  const where = copy === null ? "this node" : copy.target.label;
  const request =
    copy === null
      ? `Setting up ${title} on this node`
      : `Copying ${title} to ${where} (${copy.target.environmentId})`;
  const result = proposal.result;
  const lines: Array<string> = [];
  if (result.outcome === "failed") {
    lines.push(
      `[Ryco] ${request}, which you asked for (request ${proposal.requestId}), failed: ${result.error.message}`,
      result.error.retryable
        ? "Nothing more happens on its own. If the user still wants it, fix the cause and propose it again with a new requestId."
        : "Nothing more happens on its own.",
    );
    return lines.join("\n");
  }
  const outcome = result.projectCopy;
  lines.push(`[Ryco] ${request}, which you asked for (request ${proposal.requestId}), finished.`);
  const projectId = result.remoteProject?.projectId ?? result.createdProjectIds?.[0] ?? null;
  if (outcome !== undefined) lines.push(`Folder on ${where}: ${outcome.path}`);
  if (projectId !== null) lines.push(`Project: ${projectId} on ${where}`);
  if (plan.setup !== null) {
    const command = quoted(plan.setup.command);
    const setup = outcome?.setup ?? null;
    lines.push(
      setup === null
        ? `Setup: ${command} ran; Ryco did not learn how it ended.`
        : setup.status === "succeeded"
          ? `Setup: ${command} succeeded${setup.detail === null ? "" : ` (${setup.detail})`}.`
          : `Setup: ${command} failed${setup.detail === null ? "" : ` (${setup.detail})`}; the project is there, but its setup may be incomplete.`,
    );
  } else {
    lines.push("Setup: none was asked for.");
  }
  if (plan.followUpThread !== null) {
    const threadId = outcome?.followUpThreadId ?? null;
    lines.push(
      threadId === null
        ? `Setup thread "${plan.followUpThread.title}" did not start.`
        : `Setup thread: "${plan.followUpThread.title}" (${threadId}) on ${where}.`,
    );
  }
  for (const warning of outcome?.warnings ?? []) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

export interface ProjectCopyOutcomeWakeDeps<E> {
  readonly loadThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadShell, E>;
  /** Dispatches the queue add (`applyInternal`: `author` is server-only). */
  readonly queue: (command: ThreadQueueAddCommand) => Effect.Effect<unknown, E>;
  readonly commandIdFor: (operationId: AgentControlOperationId, step: string) => CommandId;
  readonly messageIdFor: (operationId: AgentControlOperationId, step: string) => MessageId;
}

/**
 * Queues the outcome note in the chat whose agent asked. Does nothing for another proposal, one
 * that is not settled, one no chat asked for, or an archived chat. The note never runs with more
 * privilege than the chat had when it asked.
 */
export const wakeProjectCopyOrigin = <E>(
  deps: ProjectCopyOutcomeWakeDeps<E>,
  proposal: AgentControlProposal,
): Effect.Effect<boolean, E> =>
  Effect.gen(function* () {
    if (!isSettledProjectCopyProposal(proposal)) return false;
    const principal = proposal.principal;
    if (principal.kind !== "provider-session") return false;
    const operationId = proposal.result?.execution?.operationId;
    const text = renderProjectCopyOutcome(proposal);
    if (operationId === undefined || text === null) return false;
    const thread = yield* deps.loadThread(principal.threadId);
    if (thread.archivedAt !== null) return false;
    const ceiling = principal.originRuntimeMode;
    const runtimeMode =
      ceiling !== undefined && isRuntimeModeAbove(thread.runtimeMode, ceiling)
        ? ceiling
        : thread.runtimeMode;
    yield* deps.queue({
      type: "thread.queue.add",
      commandId: deps.commandIdFor(operationId, PROJECT_COPY_OUTCOME_STEP),
      threadId: principal.threadId,
      author: "agent",
      // The asking chat's agent may edit or remove it (`ryco_queue_*`).
      queuedBy: principal.threadId,
      entry: {
        messageId: deps.messageIdFor(operationId, PROJECT_COPY_OUTCOME_STEP),
        text,
        attachments: [],
        modelSelection: thread.modelSelection,
        runtimeMode,
        interactionMode: thread.interactionMode,
        ...(thread.tokenMode === undefined ? {} : { tokenMode: thread.tokenMode }),
      },
      createdAt: new Date().toISOString(),
    });
    return true;
  });
