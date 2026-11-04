/**
 * Agent Control's cross-node project copy runs: an approved `importProject` this node executes
 * through its import job (and settles from the job's outcome, following it across restarts), and
 * a `copyProjectToNode` the approving app executes against the other node, reporting back here
 * (`beginClientExecution`, `reportClientExecution`, and failing a run whose report deadline
 * passed).
 *
 * Once either settles, the agent that asked is told how it ended (`projectCopyOutcomeWake.ts`:
 * a note queued in its chat, which wakes it at the chat's next idle moment).
 *
 * Loaded by the executor with `import()` on the first copy request, its recovery, a missed
 * deadline or a settled copy, so the server's boot path carries none of it. The executor passes
 * its stores and its own result helpers in.
 *
 * @module agentControl/projectCopyRuns
 */
import {
  type AgentControlClientExecutionResult,
  type AgentControlClientExecutionState,
  type AgentControlClientExecutorId,
  type AgentControlCopyProjectToNodePlan,
  type AgentControlErrorCode,
  type AgentControlImportProjectPlan,
  type AgentControlOperation,
  type AgentControlOperationState,
  type AgentControlProposal,
  type AgentControlProposalId,
  type AgentControlResultEnvelope,
  type AgentControlExecutionReceipt,
  type AgentControlProjectCopyOutcome,
  type AgentControlProjectSetupOutcome,
  type OrchestrationDispatchCommandError,
  type ThreadId,
} from "@ryco/contracts";
import {
  PROJECT_IMPORT_TERMINAL_STATUSES,
  type ProjectImportId,
  type ProjectImportSnapshot,
} from "@ryco/contracts/project-copy";
import { projectImportSetupOutcome } from "@ryco/shared/projectImportOutcome";
import { Cause, Duration, Effect, Option, type Scope, Stream } from "effect";

import type { ProjectImportsShape } from "../projectCopy/Services/ProjectImports.ts";
import { AgentControlClientExecutionError, AgentControlProposalNotFoundError } from "./Errors.ts";
import { computeAgentControlPlanDigest } from "./planDigest.ts";
import {
  isSettledProjectCopyProposal,
  wakeProjectCopyOrigin,
  type ProjectCopyOutcomeWakeDeps,
} from "./projectCopyOutcomeWake.ts";
import {
  AGENT_CONTROL_CLIENT_EXECUTION_DEADLINE_MS,
  AGENT_CONTROL_CLIENT_EXECUTION_STARTED_DEADLINE_MS,
  agentControlClientExecutionMissedDeadlineMessage,
  agentControlClientExecutorIdHash,
  agentControlClientExecutorMatches,
  agentControlProjectImportId,
  agentControlProjectImportInput,
  boundedProjectCopyText,
  isAgentControlClientExecutedKind,
  isPastAgentControlClientExecutionDeadline,
} from "./projectCopyControl.ts";
import type { AgentControlActionValidatorShape } from "./Services/AgentControlActionValidator.ts";
import type { AgentControlExecutionShape } from "./Services/AgentControlExecution.ts";
import type {
  AgentControlOperationStoreError,
  AgentControlOperationStoreShape,
} from "./Services/AgentControlOperationStore.ts";
import type {
  AgentControlProposalStoreError,
  AgentControlProposalStoreShape,
} from "./Services/AgentControlProposalStore.ts";

/** An import follower polls the job when its change stream ends early. */
const PROJECT_IMPORT_POLL_INTERVAL = Duration.seconds(5);
/** Consecutive failed reads (5 minutes of them) after which a follower gives up. */
const PROJECT_IMPORT_POLL_MAX_FAILURES = 60;

const isProjectImportTerminal = (snapshot: ProjectImportSnapshot): boolean =>
  PROJECT_IMPORT_TERMINAL_STATUSES.includes(snapshot.status);

type ProposalWithPlan<P> = AgentControlProposal & { readonly plan: P };

const unique = <T>(items: ReadonlyArray<T>): Array<T> => [...new Set(items)];

/** Warnings as a result keeps them: credentials redacted, bounded, blank ones dropped. */
const boundedWarnings = (warnings: ReadonlyArray<string>): Array<string> =>
  warnings
    .map((warning) => boundedProjectCopyText(warning, ""))
    .filter((warning) => warning.length > 0)
    .slice(0, 20);

/** The folder, setup outcome (its detail redacted like any result text) and setup thread. */
const projectCopyOutcome = (input: {
  readonly path: string;
  readonly setup: AgentControlProjectSetupOutcome | null;
  readonly followUpThreadId: ThreadId | null;
  readonly warnings: ReadonlyArray<string>;
}): AgentControlProjectCopyOutcome => {
  const detail = input.setup?.detail == null ? "" : boundedProjectCopyText(input.setup.detail, "");
  return {
    path: input.path,
    setup:
      input.setup === null
        ? null
        : { status: input.setup.status, detail: detail.length > 0 ? detail : null },
    followUpThreadId: input.followUpThreadId,
    warnings: boundedWarnings(input.warnings),
  };
};

/** What an import's terminal snapshot says about the project it set up. */
const importOutcome = (job: ProjectImportSnapshot): AgentControlProjectCopyOutcome =>
  projectCopyOutcome({
    path: job.destinationPath,
    setup: projectImportSetupOutcome(job),
    followUpThreadId: job.followUpThreadId,
    warnings: job.warnings,
  });

/** What the approving app reported about the project the copy set up on its target. */
const reportedOutcome = (
  reported: AgentControlClientExecutionResult,
): AgentControlProjectCopyOutcome =>
  projectCopyOutcome({
    path: reported.workspaceRoot,
    setup: reported.setup ?? null,
    followUpThreadId: reported.followUpThreadId ?? null,
    warnings: reported.warnings,
  });

/** A completed result with the project's outcome; a failed one stays as it is. */
const withProjectCopy = (
  result: AgentControlResultEnvelope,
  projectCopy: AgentControlProjectCopyOutcome,
): AgentControlResultEnvelope =>
  result.outcome === "completed" ? { ...result, projectCopy } : result;

export interface ProjectCopyRunDeps {
  readonly proposals: AgentControlProposalStoreShape;
  readonly operations: AgentControlOperationStoreShape;
  readonly validator: Pick<AgentControlActionValidatorShape, "revalidateExecution">;
  readonly projectImports: Option.Option<ProjectImportsShape>;
  /** Import followers outlive the execution that started them, never the executor's layer. */
  readonly followerScope: Scope.Scope;
  /** The executor's own result helpers, so every action settles alike. */
  readonly appendStep: (
    state: AgentControlOperationState,
    step: string,
  ) => AgentControlOperationState;
  readonly completedResult: (
    operation: AgentControlOperation,
    detail?: string,
  ) => AgentControlResultEnvelope;
  readonly failedResult: (
    operation: AgentControlOperation,
    input: {
      readonly revalidation: boolean;
      readonly message: string;
      readonly retryable: boolean;
      readonly code?: AgentControlErrorCode;
    },
  ) => AgentControlResultEnvelope;
  readonly executionReceipt: (operation: AgentControlOperation) => AgentControlExecutionReceipt;
  readonly boundedCauseMessage: (cause: Cause.Cause<unknown>, fallback: string) => string;
  readonly settleProposalFailure: (
    proposal: AgentControlProposal,
    operation: AgentControlOperation,
    input: {
      readonly revalidation: boolean;
      readonly message: string;
      readonly retryable: boolean;
      readonly code?: AgentControlErrorCode;
    },
  ) => Effect.Effect<unknown, AgentControlOperationStoreError | AgentControlProposalStoreError>;
  /** Reads the asking chat and queues the outcome note there. */
  readonly wake: ProjectCopyOutcomeWakeDeps<Error | OrchestrationDispatchCommandError>;
}

export const makeProjectCopyRuns = (deps: ProjectCopyRunDeps) => {
  const {
    proposals,
    operations,
    validator,
    projectImports,
    followerScope,
    appendStep,
    completedResult,
    failedResult,
    executionReceipt,
    boundedCauseMessage,
    settleProposalFailure,
    wake,
  } = deps;
  const isPastDeadline = isPastAgentControlClientExecutionDeadline;

  // ── importProject: executed here, settled from its import job ──────────

  /**
   * Settles an `importProject` from its import job's terminal snapshot (or its absence). Never
   * compensates: the job alone owns, and cleans up, what it created.
   */
  const settleProjectImport = (
    proposalId: AgentControlProposalId,
    snapshot: Option.Option<ProjectImportSnapshot>,
    unavailable?: string,
  ) =>
    Effect.gen(function* () {
      const proposal = yield* proposals.getById(proposalId);
      const operation = yield* operations.getByProposalId(proposalId);
      if (
        Option.isNone(proposal) ||
        proposal.value.status !== "executing" ||
        Option.isNone(operation) ||
        operation.value.status !== "running"
      )
        return;
      const current = operation.value;
      if (Option.isSome(snapshot) && snapshot.value.status === "completed") {
        const job = snapshot.value;
        const state = appendStep(
          {
            ...current.state,
            resources: {
              ...current.state.resources,
              projectIds: unique([...(current.state.resources.projectIds ?? []), job.projectId]),
              threadIds: unique([
                ...current.state.resources.threadIds,
                ...(job.followUpThreadId === null ? [] : [job.followUpThreadId]),
              ]),
            },
          },
          "project-import-completed",
        );
        const detail = boundedProjectCopyText(
          [`Set up ${job.title} on this node.`, ...job.warnings].join(" "),
          "Set up the project on this node.",
        );
        const projectCopy = importOutcome(job);
        const completed = yield* operations.transition({
          operationId: current.operationId,
          expectedStatus: "running",
          nextStatus: "completed",
          actor: "executor",
          attempt: current.attempt,
          state,
          result: withProjectCopy(completedResult({ ...current, state }, detail), projectCopy),
          updatedAt: new Date().toISOString(),
        });
        yield* proposals.settleExecution({
          proposalId,
          result: withProjectCopy(completedResult(completed, detail), projectCopy),
          now: new Date().toISOString(),
        });
        return;
      }
      const message = Option.match(snapshot, {
        onNone: () => unavailable ?? "The import did not start; nothing was changed on this node.",
        onSome: (job) =>
          [
            job.error?.message ?? `The import was ${job.status}.`,
            ...(job.leftoverPath === null
              ? []
              : [`A partial copy is left at ${job.leftoverPath}; discard it from Projects.`]),
          ].join(" "),
      });
      yield* settleProposalFailure(proposal.value, current, {
        revalidation: false,
        message: boundedProjectCopyText(message, "The import failed."),
        retryable: true,
      });
    }).pipe(
      // A concurrent settle won; its state stands.
      Effect.catchTag("AgentControlInvalidTransitionError", () => Effect.void),
    );

  /** The job's terminal snapshot; none when the node does not know the job. */
  const awaitProjectImport = (
    importId: ProjectImportId,
  ): Effect.Effect<
    | { readonly _tag: "settled"; readonly snapshot: Option.Option<ProjectImportSnapshot> }
    | { readonly _tag: "unavailable" }
  > => {
    if (Option.isNone(projectImports)) return Effect.succeed({ _tag: "unavailable" });
    const imports = projectImports.value;
    const poll = Effect.gen(function* () {
      let failures = 0;
      while (failures < PROJECT_IMPORT_POLL_MAX_FAILURES) {
        const read = yield* Effect.exit(imports.get(importId));
        if (read._tag === "Failure") {
          failures += 1;
        } else {
          failures = 0;
          if (Option.isNone(read.value) || isProjectImportTerminal(read.value.value))
            return { _tag: "settled" as const, snapshot: read.value };
        }
        yield* Effect.sleep(PROJECT_IMPORT_POLL_INTERVAL);
      }
      return { _tag: "unavailable" as const };
    });
    // The change stream ends at the terminal snapshot; one that ends or fails early (an
    // unknown job, a restarted import service) is followed by polling.
    return imports.subscribe({ importId }).pipe(
      Stream.filter(isProjectImportTerminal),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => poll,
          onSome: (snapshot) =>
            Effect.succeed({ _tag: "settled" as const, snapshot: Option.some(snapshot) }),
        }),
      ),
      Effect.catch(() => poll),
    );
  };

  /** Follows the job in the background until it settles the proposal. */
  const followProjectImport = (proposalId: AgentControlProposalId, importId: ProjectImportId) =>
    awaitProjectImport(importId).pipe(
      Effect.flatMap((outcome) =>
        outcome._tag === "settled"
          ? settleProjectImport(proposalId, outcome.snapshot)
          : settleProjectImport(
              proposalId,
              Option.none(),
              "The import's progress could not be read on this node; check Projects for the project.",
            ),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Agent Control project import follower failed", {
          proposalId,
          cause: Cause.hasInterruptsOnly(cause) ? "interrupted" : "failure",
        }),
      ),
      Effect.forkIn(followerScope),
      Effect.asVoid,
    );

  /**
   * Starts the job (`importId` derived from the operation, so a retry finds the same job) and
   * leaves its follower to settle the proposal: a clone and setup can take an hour, and the
   * executor must not wait for them.
   */
  const startProjectImport = (
    proposal: ProposalWithPlan<AgentControlImportProjectPlan>,
    initial: AgentControlOperation,
  ) =>
    Effect.gen(function* () {
      const plan = proposal.plan;
      const importId = agentControlProjectImportId(initial.operationId);
      let operation = initial;
      const started = yield* Effect.exit(
        Effect.gen(function* () {
          if (Option.isNone(projectImports))
            return yield* Effect.fail(new Error("Project import is unavailable on this node."));
          operation = yield* operations.checkpoint({
            operationId: operation.operationId,
            expectedStatus: "running",
            attempt: operation.attempt,
            state: appendStep(
              {
                ...operation.state,
                resources: {
                  ...operation.state.resources,
                  projectIds: unique([
                    ...(operation.state.resources.projectIds ?? []),
                    plan.projectId,
                  ]),
                },
              },
              "project-import-planned",
            ),
            updatedAt: new Date().toISOString(),
          });
          const job = yield* projectImports.value
            .start(
              agentControlProjectImportInput(plan, { importId, proposalId: proposal.proposalId }),
            )
            .pipe(
              // A start that failed after the job was recorded is followed, not failed.
              Effect.catch((error) =>
                projectImports.value.get(importId).pipe(
                  Effect.catch(() => Effect.succeed(Option.none<ProjectImportSnapshot>())),
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        Effect.fail(
                          new Error(
                            boundedProjectCopyText(error.message, "The import could not start."),
                          ),
                        ),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
            );
          operation = yield* operations.checkpoint({
            operationId: operation.operationId,
            expectedStatus: "running",
            attempt: operation.attempt,
            state: appendStep(operation.state, "project-import-started"),
            updatedAt: new Date().toISOString(),
          });
          return job;
        }),
      );
      if (started._tag === "Failure") {
        yield* settleProposalFailure(proposal, operation, {
          revalidation: false,
          message: boundedCauseMessage(started.cause, "The import could not start."),
          retryable: true,
        });
        return;
      }
      if (isProjectImportTerminal(started.value)) {
        yield* settleProjectImport(proposal.proposalId, Option.some(started.value));
        return;
      }
      yield* followProjectImport(proposal.proposalId, importId);
    });

  // ── copyProjectToNode: executed by the approving client ───────────────

  const isCopyProposal = (
    proposal: AgentControlProposal,
  ): proposal is ProposalWithPlan<AgentControlCopyProjectToNodePlan> =>
    proposal.plan.kind === "copyProjectToNode";

  const requireProposal = (proposalId: AgentControlProposalId) =>
    proposals.getById(proposalId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AgentControlProposalNotFoundError({ proposalId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const requireClientExecuted = (proposal: AgentControlProposal) =>
    isCopyProposal(proposal) && isAgentControlClientExecutedKind(proposal.plan.kind)
      ? Effect.succeed(proposal)
      : Effect.fail(
          new AgentControlClientExecutionError({
            reason: "not-client-executed",
            detail: "This request is not executed by the app that approves it.",
          }),
        );

  const notExecuting = (proposal: AgentControlProposal) =>
    new AgentControlClientExecutionError({
      reason: "not-executing",
      detail: `This request is ${proposal.status}.`,
      status: proposal.status,
    });

  const executorMismatch = () =>
    new AgentControlClientExecutionError({
      reason: "executor-mismatch",
      detail: "Another app is running this request.",
    });

  /** The executor binding of a proposal's operation; the presented executor must match it. */
  const requireBinding = (
    proposal: AgentControlProposal,
    executorId: AgentControlClientExecutorId,
  ) =>
    Effect.gen(function* () {
      const operation = yield* operations.getByProposalId(proposal.proposalId);
      const binding = Option.isSome(operation) ? operation.value.state.clientExecution : undefined;
      if (Option.isNone(operation) || binding === undefined)
        return yield* Effect.fail(notExecuting(proposal));
      if (!agentControlClientExecutorMatches(binding.executorIdHash, executorId))
        return yield* Effect.fail(executorMismatch());
      return { operation: operation.value, binding };
    });

  const beginClientExecution: AgentControlExecutionShape["beginClientExecution"] = (input) =>
    Effect.gen(function* () {
      const proposal = yield* requireClientExecuted(yield* requireProposal(input.proposalId));
      if (proposal.status === "approved") {
        // Re-checked as the executor before anything runs, exactly like a server-run plan.
        const invalid =
          computeAgentControlPlanDigest(proposal.plan) !== proposal.planDigest
            ? "The approved plan digest no longer matches its immutable payload."
            : yield* validator.revalidateExecution(proposal).pipe(
                Effect.as(null),
                Effect.catch((error) =>
                  Effect.succeed(
                    error.detail.trim().length > 0
                      ? error.detail.slice(0, 2_000)
                      : "The approved plan no longer passes current server validation.",
                  ),
                ),
              );
        const now = Date.now();
        const binding: AgentControlClientExecutionState = {
          executorIdHash: agentControlClientExecutorIdHash(input.executorId),
          deadlineAt: new Date(now + AGENT_CONTROL_CLIENT_EXECUTION_DEADLINE_MS).toISOString(),
          importId: null,
          targetEnvironmentId: proposal.plan.target.environmentId,
        };
        const begun = yield* proposals
          .beginExecution({
            proposalId: proposal.proposalId,
            actor: "executor",
            now: new Date(now).toISOString(),
            // The operation (with the binding) lands in the same transaction: the proposal is
            // never executing without it.
            withinTransaction: (executing) =>
              operations
                .createForProposal({
                  proposal: executing,
                  now: new Date(now).toISOString(),
                  state: {
                    completedSteps: [],
                    resources: {
                      projectIds: [],
                      automationIds: [],
                      threadIds: [],
                      ownedThreadIds: [],
                      worktreeIds: [],
                      ownedWorktrees: [],
                    },
                    commandReceipts: [],
                    clientExecution: binding,
                  },
                })
                .pipe(
                  Effect.flatMap(({ operation, replayed }) =>
                    replayed
                      ? Effect.void
                      : operations
                          .transition({
                            operationId: operation.operationId,
                            expectedStatus: "pending",
                            nextStatus: "running",
                            actor: "executor",
                            attempt: operation.attempt + 1,
                            state: operation.state,
                            result: null,
                            updatedAt: new Date(now).toISOString(),
                          })
                          .pipe(Effect.asVoid),
                  ),
                ),
          })
          .pipe(
            Effect.map(Option.some),
            // Another accept won the begin: the binding check below decides.
            Effect.catchTag("AgentControlInvalidTransitionError", () =>
              Effect.succeed(Option.none<AgentControlProposal>()),
            ),
          );
        if (Option.isSome(begun) && invalid !== null) {
          const { operation } = yield* requireBinding(begun.value, input.executorId);
          yield* settleProposalFailure(begun.value, operation, {
            revalidation: true,
            message: invalid,
            retryable: true,
          });
          return yield* requireProposal(proposal.proposalId);
        }
        if (Option.isSome(begun)) return begun.value;
      }
      // Executing or settled: only the executor that holds it gets its state back.
      const latest = yield* requireProposal(proposal.proposalId);
      if (latest.status === "approved") return yield* Effect.fail(notExecuting(latest));
      yield* requireBinding(latest, input.executorId);
      return latest;
    });

  const reportClientExecution: AgentControlExecutionShape["reportClientExecution"] = (input) =>
    Effect.gen(function* () {
      let proposal = yield* requireClientExecuted(yield* requireProposal(input.proposalId));
      const plan = proposal.plan;
      const { operation, binding } = yield* requireBinding(proposal, input.executorId);
      // An operation that settled before its proposal (a crash in between) settles it now.
      if (
        proposal.status === "executing" &&
        operation.status !== "running" &&
        operation.result !== null
      ) {
        const settled = yield* proposals.settleExecution({
          proposalId: proposal.proposalId,
          result: operation.result,
          now: new Date().toISOString(),
        });
        if (!isCopyProposal(settled)) return settled;
        proposal = settled;
      }
      if (proposal.status !== "executing" || operation.status !== "running") {
        // Repeating the outcome that settled it answers with the receipt.
        const settledAs =
          proposal.status === "completed"
            ? "completed"
            : proposal.status === "failed"
              ? "failed"
              : null;
        if (settledAs !== null && settledAs === input.outcome) return proposal;
        return yield* Effect.fail(notExecuting(proposal));
      }
      const now = new Date();
      const importId = input.importId ?? binding.importId;
      if (input.outcome === "started") {
        yield* operations.checkpoint({
          operationId: operation.operationId,
          expectedStatus: "running",
          attempt: operation.attempt,
          state: appendStep(
            {
              ...operation.state,
              clientExecution: {
                ...binding,
                importId,
                deadlineAt: new Date(
                  now.getTime() + AGENT_CONTROL_CLIENT_EXECUTION_STARTED_DEADLINE_MS,
                ).toISOString(),
              },
            },
            "client-import-started",
          ),
          updatedAt: now.toISOString(),
        });
        return proposal;
      }
      const settle = (result: AgentControlResultEnvelope, state: AgentControlOperationState) =>
        operations
          .transition({
            operationId: operation.operationId,
            expectedStatus: "running",
            nextStatus: result.outcome === "completed" ? "completed" : "failed",
            actor: "executor",
            attempt: operation.attempt,
            state,
            result,
            updatedAt: now.toISOString(),
          })
          .pipe(
            Effect.andThen(
              proposals.settleExecution({
                proposalId: proposal.proposalId,
                result,
                now: now.toISOString(),
              }),
            ),
            // A concurrent report or the deadline sweep settled it first.
            Effect.catchTag("AgentControlInvalidTransitionError", () =>
              requireProposal(proposal.proposalId).pipe(
                Effect.flatMap((latest) =>
                  latest.status === input.outcome
                    ? Effect.succeed(latest)
                    : Effect.fail(notExecuting(latest)),
                ),
              ),
            ),
          );
      if (input.outcome === "completed") {
        const reported = input.result ?? null;
        if (reported === null || reported.targetEnvironmentId !== plan.target.environmentId) {
          return yield* Effect.fail(
            new AgentControlClientExecutionError({
              reason: "result-mismatch",
              detail:
                reported === null
                  ? "A completed report carries the project it created."
                  : "The reported node is not this request's target.",
            }),
          );
        }
        const state = appendStep(
          { ...operation.state, clientExecution: { ...binding, importId } },
          "client-execution-completed",
        );
        return yield* settle(
          {
            outcome: "completed",
            remoteProject: {
              environmentId: reported.targetEnvironmentId,
              projectId: reported.projectId,
            },
            projectCopy: reportedOutcome(reported),
            execution: executionReceipt({ ...operation, state }),
            detail: boundedProjectCopyText(
              [`Copied to ${plan.target.label}.`, ...reported.warnings].join(" "),
              `Copied to ${plan.target.label}.`,
            ),
            completedAt: now.toISOString(),
          },
          state,
        );
      }
      const state = appendStep(
        { ...operation.state, clientExecution: { ...binding, importId } },
        "client-execution-failed",
      );
      return yield* settle(
        failedResult(
          { ...operation, state },
          {
            revalidation: false,
            message: boundedProjectCopyText(
              input.error,
              `The copy to ${plan.target.label} failed in the app that approved it.`,
            ),
            retryable: true,
          },
        ),
        state,
      );
    });

  /** Fails one client execution whose report deadline passed; a report that won stands. */
  const failMissedClientExecution = (listed: AgentControlOperation) =>
    Effect.gen(function* () {
      // Re-read: a `started` report since the listing moved the deadline (the operation's
      // compare-and-set checks only its status).
      const operation = yield* operations.getByProposalId(listed.proposalId);
      if (
        Option.isNone(operation) ||
        operation.value.status !== "running" ||
        !isPastDeadline(operation.value, new Date().toISOString())
      )
        return;
      const proposal = yield* proposals.getById(listed.proposalId);
      if (Option.isNone(proposal) || !isCopyProposal(proposal.value)) return;
      yield* settleProposalFailure(proposal.value, operation.value, {
        revalidation: false,
        message: agentControlClientExecutionMissedDeadlineMessage(proposal.value.plan.target.label),
        retryable: true,
      });
    }).pipe(Effect.catchTag("AgentControlInvalidTransitionError", () => Effect.void));

  /**
   * Tells the agent that asked for a settled copy or import how it ended. Safe to repeat: the
   * note's ids follow from the operation, and the queue takes an id it already has as done.
   */
  const wakeOrigin = (proposal: AgentControlProposal) =>
    isSettledProjectCopyProposal(proposal)
      ? wakeProjectCopyOrigin(wake, proposal).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("Agent Control could not tell the agent how its copy ended", {
              proposalId: proposal.proposalId,
              cause: Cause.hasInterruptsOnly(cause) ? "interrupted" : Cause.pretty(cause),
            }),
          ),
        )
      : Effect.void;

  return {
    wakeOrigin,
    startProjectImport,
    followProjectImport,
    beginClientExecution,
    reportClientExecution,
    failMissedClientExecution,
  };
};

export type ProjectCopyRuns = ReturnType<typeof makeProjectCopyRuns>;
