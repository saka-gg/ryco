import { DateTime, Effect, Option } from "effect";
import { CommandId, type WorktreeId } from "@ryco/contracts";

import { resolvePullRequestTerminalAt } from "../orchestration/pullRequestTerminalAt.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionWorktreeRepository } from "../persistence/Services/ProjectionWorktrees.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";

export interface RefreshWorktreeSourceControlStateInput {
  readonly worktreeId: WorktreeId;
}

export const refreshWorktreeSourceControlState = Effect.fn("refreshWorktreeSourceControlState")(
  function* (input: RefreshWorktreeSourceControlStateInput) {
    const repo = yield* ProjectionWorktreeRepository;
    const row = yield* repo.getById({ worktreeId: input.worktreeId });
    if (Option.isNone(row)) return;
    const existing = row.value;
    if (existing.prNumber === null && existing.issueNumber === null) return;
    if (existing.worktreePath === null) return;

    const registry = yield* SourceControlProviderRegistry;
    const cwd = existing.worktreePath;
    const provider = yield* registry.resolve({ cwd });

    // One timestamp for both the event time and the first-observation fallback.
    const observedAt = new Date().toISOString();
    let nextPrState = existing.prState ?? null;
    let nextPrIsDraft = existing.prIsDraft ?? null;
    let reportedTerminalAt: string | null = null;
    if (existing.prNumber !== null) {
      const pr = yield* provider
        .getPullRequestState({ number: existing.prNumber, cwd })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to refresh PR state", { cause }).pipe(Effect.as(null)),
          ),
        );
      if (pr !== null) {
        nextPrState = pr.state;
        nextPrIsDraft = pr.isDraft;
        reportedTerminalAt = pr.terminalAt ? DateTime.formatIso(pr.terminalAt) : null;
      }
    }

    let nextIssueState = existing.issueState ?? null;
    if (existing.issueNumber !== null) {
      const issue = yield* provider
        .getIssueState({ number: existing.issueNumber, cwd })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to refresh issue state", { cause }).pipe(Effect.as(null)),
          ),
        );
      if (issue !== null) {
        nextIssueState = issue.state;
      }
    }

    const nextPrTerminalAt = resolvePullRequestTerminalAt({
      previousState: existing.prState ?? null,
      previousTerminalAt: existing.prTerminalAt ?? null,
      nextState: nextPrState,
      reportedTerminalAt,
      observedAt,
    });

    const changed =
      nextPrState !== (existing.prState ?? null) ||
      nextPrIsDraft !== (existing.prIsDraft ?? null) ||
      nextPrTerminalAt !== (existing.prTerminalAt ?? null) ||
      nextIssueState !== (existing.issueState ?? null);
    if (!changed) return;

    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "worktree.source-control-state.update",
      commandId: CommandId.make(`server:refresh-sc-state:${crypto.randomUUID()}`),
      worktreeId: input.worktreeId,
      prState: nextPrState,
      prIsDraft: nextPrIsDraft,
      prTerminalAt: nextPrTerminalAt,
      issueState: nextIssueState,
      updatedAt: observedAt,
    });
  },
);
