import { ServerConfig } from "../config.ts";
import { makeManagedWorktreeMigration } from "./managedWorktreeMigration.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { Context, Effect, Layer, Option, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  type DiagnosticsTerminalProcess,
  type LifecycleSuggestions,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type OrchestrationWorktreeShell,
  type ProjectId,
  ThreadId,
  type TrashListResult,
  type WorkspaceActionAvailability,
  type WorkspaceCheckoutState,
  type WorkspaceLifecycleAction,
  type WorkspaceLifecycleApplyInput,
  WorkspaceLifecycleError,
  type WorkspaceLifecycleEffects,
  type WorkspaceLifecyclePreview,
  type WorkspaceLifecycleRequest,
  type WorkspaceLifecycleResult,
  type WorkspaceLifecycleStep,
  type WorkspaceLifecycleSummary,
  type WorktreeId,
} from "@ryco/contracts";
import {
  planLifecycleSuggestions,
  resolveLifecycleSuggestionPolicy,
  summarizeWorkspaceLifecycleEffects,
  threadBelongsToWorktree,
  threadPendingWork,
} from "@ryco/shared/workspaceLifecycle";

import { GitWorkflowService, type GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
import { applyOrchestrationNormalizedCommand } from "../orchestration/Layers/OrchestrationCommandApplication.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../persistence/Services/ProjectionThreads.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import { TerminalManager, type TerminalManagerShape } from "../terminal/Services/Manager.ts";
import { GitVcsDriver, type GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import { type CheckoutFence, makeSqlCheckoutFence } from "./checkoutFence.ts";
import {
  type CheckoutFacts,
  containsPath,
  inspectCheckout,
  samePath,
} from "./checkoutInspection.ts";
import {
  WorkspaceAccessPolicy,
  type WorkspaceAccessPolicyShape,
} from "./Services/WorkspaceAccessPolicy.ts";

const ACTIONS: ReadonlyArray<WorkspaceLifecycleAction> = [
  "archive",
  "restore",
  "remove-checkout",
  "remove-stale-record",
  "recreate-checkout",
];
const MAIN_PROTECTED = "The project root/main checkout is never a disposable workspace.";
const SAMPLE = 20;

export interface WorkspaceLifecycleShape {
  readonly list: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<WorkspaceLifecycleSummary>, WorkspaceLifecycleError>;
  readonly preview: (
    request: WorkspaceLifecycleRequest,
  ) => Effect.Effect<WorkspaceLifecyclePreview, WorkspaceLifecycleError>;
  /** Applies only if the workspace still matches the reviewed preview fingerprint. */
  readonly apply: (
    input: WorkspaceLifecycleApplyInput,
  ) => Effect.Effect<WorkspaceLifecycleResult, WorkspaceLifecycleError>;
  /**
   * Preview and apply against the current state in one step. For callers that already
   * own an approval of their own (legacy worktree RPCs, approved Agent Control plans).
   */
  readonly applyCurrent: (
    request: WorkspaceLifecycleRequest & { readonly operationKey?: string },
  ) => Effect.Effect<WorkspaceLifecycleResult, WorkspaceLifecycleError>;
  readonly suggestions: () => Effect.Effect<LifecycleSuggestions, WorkspaceLifecycleError>;
  readonly recoverManagedWorktrees?:
    | (() => Effect.Effect<void, WorkspaceLifecycleError>)
    | undefined;
  readonly migrateManagedWorktrees?:
    | (() => Effect.Effect<void, WorkspaceLifecycleError>)
    | undefined;
  readonly listTrash: () => Effect.Effect<TrashListResult, WorkspaceLifecycleError>;
}

export class WorkspaceLifecycle extends Context.Service<
  WorkspaceLifecycle,
  WorkspaceLifecycleShape
>()("ryco/workspace/WorkspaceLifecycle") {}

export interface WorkspaceLifecycleDeps {
  readonly snapshots: Pick<ProjectionSnapshotQueryShape, "getShellSnapshot" | "getThreadShellById">;
  readonly threads: Pick<ProjectionThreadRepositoryShape, "listTrashed">;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly providers: Pick<ProviderServiceShape, "stopSession"> | null;
  readonly sessionDirectory: Pick<ProviderSessionDirectoryShape, "listBindings"> | null;
  readonly terminals: Pick<TerminalManagerShape, "listDiagnostics" | "close">;
  readonly policy: WorkspaceAccessPolicyShape;
  readonly gitDriver: GitVcsDriverShape;
  readonly git: Pick<
    GitWorkflowServiceShape,
    "removeWorktree" | "createWorktree" | "listWorktreePaths" | "invalidateStatus"
  >;
  readonly settings: Pick<ServerSettingsShape, "getSettings">;
  readonly fence: CheckoutFence;
  readonly now?: () => number;
  readonly migration?: { readonly sql: SqlClient.SqlClient; readonly stateDir: string } | undefined;
}

interface LoadedContext {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly trashed: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreeId: WorktreeId | null;
    readonly worktreePath: string | null;
  }>;
  readonly terminals: ReadonlyArray<DiagnosticsTerminalProcess>;
  readonly nowMs: number;
}

interface WorkspaceState {
  readonly worktree: OrchestrationWorktreeShell;
  readonly project: OrchestrationProjectShell;
  readonly main: boolean;
  readonly facts: CheckoutFacts | null;
  readonly inspectionError: string | null;
  readonly checkout: WorkspaceCheckoutState;
  readonly conversations: ReadonlyArray<OrchestrationThreadShell>;
  readonly trashedCount: number;
  readonly activeWork: ReadonlyArray<string>;
  /** Associated threads whose idle terminal shells are closed (history kept) on removal. */
  readonly idleTerminalThreadIds: ReadonlyArray<ThreadId>;
  readonly inspectedAt: string;
}

const lifecycleError = (detail: string) => new WorkspaceLifecycleError({ detail });
/** Everything a removal discards, compared right before it runs. */
const statusKey = (status: CheckoutFacts["status"] | undefined) =>
  JSON.stringify(
    status && {
      modified: status.modified,
      untracked: status.untracked,
      protectedIgnored: status.protectedIgnored,
      regenerableIgnored: status.regenerableIgnored,
      truncated: status.truncated,
    },
  );
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const terminalAlive = (terminal: DiagnosticsTerminalProcess) =>
  terminal.pid !== null || terminal.status === "running" || terminal.status === "starting";

const normalizeRequest = (request: WorkspaceLifecycleRequest): WorkspaceLifecycleRequest => {
  const removal = request.action === "remove-checkout" || request.action === "remove-stale-record";
  const discard = request.action === "remove-checkout" && request.discard === true;
  return {
    worktreeId: request.worktreeId,
    action: request.action,
    // Discarding moves conversations to Trash instead.
    archiveConversations: removal && !discard ? request.archiveConversations !== false : false,
    deleteBranch: request.action === "remove-checkout" ? request.deleteBranch === true : false,
    discard,
  };
};

type BlockerState = Pick<
  WorkspaceState,
  "worktree" | "main" | "facts" | "inspectionError" | "activeWork" | "conversations"
>;

const activeWorkBlocker = (state: BlockerState) =>
  state.activeWork.length > 0
    ? `Associated work is still active: ${state.activeWork.join("; ")}.`
    : null;

/**
 * "Delete workspace": the work it throws away is reviewed, not blocking. Only
 * what cannot be done safely blocks: an uninspectable or foreign directory,
 * a stale Git registration, active work, or nothing left to delete.
 */
function discardBlockers(state: BlockerState, request: WorkspaceLifecycleRequest): string[] {
  const { worktree, facts } = state;
  const blockers: string[] = [];
  const checkoutRemoved = worktree.checkoutRemovedAt != null;
  if (!facts) blockers.push(state.inspectionError ?? "The checkout could not be inspected.");
  else if (!checkoutRemoved) {
    if (facts.checkout === "missing") {
      if (facts.gitRegistered)
        blockers.push(
          "The checkout directory is missing but Git still registers it. Run `git worktree prune` in the project, then retry.",
        );
    } else {
      if (!facts.gitRegistered)
        blockers.push("Git does not register this directory as a worktree of the project.");
      if (!facts.status) blockers.push("The checkout status could not be read.");
    }
  } else if (
    state.conversations.length === 0 &&
    !(request.deleteBranch && facts.branchHead !== null)
  )
    blockers.push(
      "Nothing is left to delete: the checkout is removed and no conversations remain.",
    );
  const activeWork = activeWorkBlocker(state);
  if (activeWork) blockers.push(activeWork);
  return blockers;
}

/** Pure: which actions the inspected state allows, and why not. */
export function workspaceActionBlockers(
  state: BlockerState,
  request: WorkspaceLifecycleRequest,
): string[] {
  const { worktree, facts } = state;
  if (state.main) return [MAIN_PROTECTED];
  if (request.action === "remove-checkout" && request.discard === true)
    return discardBlockers(state, request);
  const blockers: string[] = [];
  const activeWork = activeWorkBlocker(state);
  const checkoutRemoved = worktree.checkoutRemovedAt != null;
  switch (request.action) {
    case "archive":
      if (worktree.archivedAt !== null) blockers.push("The workspace is already archived.");
      if (activeWork) blockers.push(activeWork);
      break;
    case "restore":
      if (worktree.archivedAt === null) blockers.push("The workspace is not archived.");
      break;
    case "remove-checkout": {
      if (checkoutRemoved) {
        blockers.push("The checkout was already removed.");
        break;
      }
      if (!facts) {
        blockers.push(state.inspectionError ?? "The checkout could not be inspected.");
        break;
      }
      if (facts.checkout === "missing") {
        if (facts.gitRegistered)
          blockers.push(
            "The checkout directory is missing but Git still registers it. Run `git worktree prune` in the project, then retry.",
          );
      } else {
        if (!facts.gitRegistered)
          blockers.push("Git does not register this directory as a worktree of the project.");
        const status = facts.status;
        if (!status) blockers.push("The checkout status could not be read.");
        else {
          if (status.truncated)
            blockers.push("The checkout has too many changes to verify safely.");
          if (status.modified > 0)
            blockers.push(`${plural(status.modified, "tracked file")} has uncommitted changes.`);
          if (status.untracked > 0)
            blockers.push(`${plural(status.untracked, "untracked file")} would be lost.`);
          if (status.protectedIgnored.length > 0)
            blockers.push(
              `${plural(status.protectedIgnored.length, "ignored file")} that ${status.protectedIgnored.length === 1 ? "is" : "are"} not a known cache would be lost (${status.protectedIgnored.slice(0, 3).join(", ")}).`,
            );
        }
        if (facts.unmerged !== false)
          blockers.push(
            facts.unmerged === true
              ? "The branch has commits that the project HEAD does not contain."
              : "The branch could not be verified as merged.",
          );
      }
      if (request.deleteBranch && (facts.branchHead === null || facts.unmerged !== false))
        blockers.push("Only a verified merged branch can be deleted.");
      if (activeWork) blockers.push(activeWork);
      break;
    }
    case "remove-stale-record":
      if (checkoutRemoved) {
        blockers.push("The checkout is already recorded as removed.");
        break;
      }
      if (!facts) blockers.push(state.inspectionError ?? "The checkout could not be inspected.");
      else if (facts.checkout === "present")
        blockers.push("The checkout still exists. Use Remove checkout instead.");
      if (activeWork) blockers.push(activeWork);
      break;
    case "recreate-checkout":
      if (!facts) {
        blockers.push(state.inspectionError ?? "The checkout could not be inspected.");
        break;
      }
      if (facts.checkout === "present") blockers.push("The checkout already exists.");
      else if (facts.gitRegistered)
        blockers.push(
          "Git still registers this missing path. Run `git worktree prune` in the project, then retry.",
        );
      if (facts.branchHead === null)
        blockers.push(
          `Branch ${worktree.branch} no longer exists; the checkout cannot be recreated.`,
        );
      break;
  }
  return blockers;
}

export function makeWorkspaceLifecycle(deps: WorkspaceLifecycleDeps): WorkspaceLifecycleShape {
  const now = deps.now ?? Date.now;
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (worktreeId: string) => {
    let lock = locks.get(worktreeId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(worktreeId, lock);
    }
    return lock;
  };

  const loadContext = Effect.gen(function* () {
    const snapshot = yield* deps.snapshots.getShellSnapshot();
    const trashed = yield* deps.threads.listTrashed({ limit: 10_000 });
    const terminals = yield* deps.terminals.listDiagnostics;
    return { snapshot, trashed, terminals, nowMs: now() } satisfies LoadedContext;
  }).pipe(Effect.mapError(() => lifecycleError("Workspace state is unavailable.")));

  const inspectWorkspace = (context: LoadedContext, worktree: OrchestrationWorktreeShell) =>
    Effect.gen(function* () {
      const project = context.snapshot.projects.find((p) => p.id === worktree.projectId);
      if (!project)
        return yield* Effect.fail(lifecycleError("The workspace's project is unavailable."));
      const main =
        worktree.origin === "main" ||
        worktree.worktreePath === null ||
        samePath(worktree.worktreePath, project.workspaceRoot);
      const conversations = context.snapshot.threads.filter((thread) =>
        threadBelongsToWorktree(thread, worktree, samePath),
      );
      const conversationIds = new Set<string>(conversations.map((thread) => thread.id));
      const trashedCount = context.trashed.filter((thread) =>
        threadBelongsToWorktree(thread, worktree, samePath),
      ).length;
      const activeWork: string[] = [];
      if (deps.migration) {
        const pending = yield* deps.migration.sql<{ state: string; last_error: string | null }>`
          SELECT state, last_error FROM managed_worktree_relocations WHERE worktree_id = ${worktree.worktreeId}
            AND state IN ('moving', 'moved', 'attention')`.pipe(
          Effect.mapError(() => lifecycleError("Checkout relocation state is unavailable.")),
        );
        if (pending[0])
          activeWork.push(
            pending[0].state === "attention"
              ? `checkout relocation needs manual recovery: ${pending[0].last_error ?? "inspect both recorded paths"}`
              : "a checkout relocation is in progress",
          );
      }
      for (const thread of conversations) {
        const reasons = threadPendingWork(thread, context.nowMs);
        if (reasons.length > 0) activeWork.push(`"${thread.title}": ${reasons.join(", ")}`);
      }
      const idleTerminalThreadIds = new Set<ThreadId>();
      for (const terminal of context.terminals) {
        if (!terminalAlive(terminal)) continue;
        const inCheckout =
          worktree.worktreePath !== null &&
          (containsPath(worktree.worktreePath, terminal.cwd) ||
            (terminal.worktreePath !== null &&
              containsPath(worktree.worktreePath, terminal.worktreePath)));
        const owned = conversationIds.has(terminal.threadId);
        if (!owned && !inCheckout) continue;
        if (terminal.hasRunningSubprocess || terminal.status === "starting")
          activeWork.push("a terminal is running a command in this checkout");
        else if (!owned) activeWork.push("a terminal of another conversation uses this checkout");
        else idleTerminalThreadIds.add(ThreadId.make(terminal.threadId));
      }
      const inspected =
        main || worktree.worktreePath === null
          ? { facts: null, inspectionError: null }
          : yield* inspectCheckout(
              { policy: deps.policy, git: deps.gitDriver },
              {
                snapshot: context.snapshot,
                project,
                directory: worktree.worktreePath,
                rowWorktreeId: worktree.worktreeId,
                branch: worktree.branch,
                operation: "workspace lifecycle inspection",
              },
            ).pipe(
              Effect.match({
                onSuccess: (value) => ({
                  facts: value as CheckoutFacts | null,
                  inspectionError: null,
                }),
                onFailure: (error) => ({
                  facts: null,
                  inspectionError: error.detail as string | null,
                }),
              }),
              Effect.catchCause(() =>
                Effect.succeed({
                  facts: null,
                  inspectionError:
                    "Filesystem/Git inspection could not safely verify this workspace." as
                      | string
                      | null,
                }),
              ),
            );
      const { facts, inspectionError } = inspected;
      const checkout: WorkspaceCheckoutState = main
        ? "present"
        : worktree.checkoutRemovedAt != null
          ? "removed"
          : (facts?.checkout ?? "unavailable");
      return {
        worktree,
        project,
        main,
        facts,
        inspectionError,
        checkout,
        conversations,
        trashedCount,
        activeWork: [...new Set(activeWork)],
        idleTerminalThreadIds: [...idleTerminalThreadIds],
        inspectedAt: new Date(context.nowMs).toISOString(),
      } satisfies WorkspaceState;
    });

  const summarize = (state: WorkspaceState): WorkspaceLifecycleSummary => {
    const status = state.facts?.status ?? null;
    const actions: WorkspaceActionAvailability[] = ACTIONS.map((action) => {
      const blockers = workspaceActionBlockers(
        state,
        normalizeRequest({ worktreeId: state.worktree.worktreeId, action }),
      );
      return { action, available: blockers.length === 0, blockers };
    });
    return {
      worktreeId: state.worktree.worktreeId,
      projectId: state.worktree.projectId,
      title: state.worktree.title ?? state.worktree.branch,
      branch: state.worktree.branch,
      path: state.worktree.worktreePath,
      origin: state.worktree.origin,
      main: state.main,
      archivedAt: state.worktree.archivedAt,
      checkoutRemovedAt: state.worktree.checkoutRemovedAt ?? null,
      checkout: state.checkout,
      gitRegistered: state.facts?.gitRegistered ?? null,
      branchExists: state.facts ? state.facts.branchHead !== null : null,
      unmerged: state.facts?.unmerged ?? null,
      changes: status
        ? {
            modified: status.modified,
            untracked: status.untracked,
            protectedIgnored: status.protectedIgnored.length,
            protectedIgnoredSample: status.protectedIgnored.slice(0, SAMPLE),
            regenerableIgnored: status.regenerableIgnored.length,
            regenerableIgnoredSample: status.regenerableIgnored.slice(0, SAMPLE),
            truncated: status.truncated,
          }
        : null,
      conversations: {
        active: state.conversations.filter((thread) => thread.archivedAt === null).length,
        archived: state.conversations.filter((thread) => thread.archivedAt !== null).length,
        trashed: state.trashedCount,
      },
      activeWork: state.activeWork,
      actions,
      discardBlockers: workspaceActionBlockers(
        state,
        normalizeRequest({
          worktreeId: state.worktree.worktreeId,
          action: "remove-checkout",
          discard: true,
          deleteBranch: true,
        }),
      ),
      inspectedAt: state.inspectedAt,
    };
  };

  const computeEffects = (
    state: WorkspaceState,
    request: WorkspaceLifecycleRequest,
  ): WorkspaceLifecycleEffects => {
    const removal =
      request.action === "remove-checkout" || request.action === "remove-stale-record";
    const discard = request.action === "remove-checkout" && request.discard === true;
    const checkoutRemoved = state.worktree.checkoutRemovedAt != null;
    // Never-used conversations cannot be archived; they stay where they are.
    const archiveConversationIds =
      removal && request.archiveConversations
        ? state.conversations
            .filter((thread) => thread.archivedAt === null && thread.latestUserMessageAt !== null)
            .map((thread) => thread.id)
        : [];
    const trashConversationIds = discard ? state.conversations.map((thread) => thread.id) : [];
    const removeCheckout =
      request.action === "remove-checkout" &&
      !checkoutRemoved &&
      state.facts?.checkout === "present";
    const deleteBranch =
      request.action === "remove-checkout" &&
      request.deleteBranch === true &&
      (!discard || state.facts?.branchHead != null);
    const status = state.facts?.status ?? null;
    const discardsFiles =
      removeCheckout &&
      status !== null &&
      (status.modified > 0 ||
        status.untracked > 0 ||
        status.protectedIgnored.length > 0 ||
        status.truncated);
    return {
      archiveWorkspace: request.action === "archive",
      restoreWorkspace:
        request.action === "restore" ||
        (request.action === "recreate-checkout" && state.worktree.archivedAt !== null),
      removeCheckout,
      recreateCheckout: request.action === "recreate-checkout",
      recordCheckoutRemoval: removal && !checkoutRemoved,
      stopSessionThreadIds: removeCheckout
        ? state.conversations
            .filter((thread) => thread.session !== null && thread.session.status !== "stopped")
            .map((thread) => thread.id)
        : [],
      archiveConversationIds,
      unchangedConversations:
        state.conversations.length - archiveConversationIds.length - trashConversationIds.length,
      discardedRegenerableIgnored: removeCheckout
        ? (state.facts?.status?.regenerableIgnored.length ?? 0)
        : 0,
      deleteBranch,
      branch: state.worktree.branch,
      discard,
      trashConversationIds,
      discardsWork: discard && (discardsFiles || (deleteBranch && state.facts?.unmerged !== false)),
    };
  };

  const describeDetails = (
    state: WorkspaceState,
    request: WorkspaceLifecycleRequest,
    effects: WorkspaceLifecycleEffects,
  ): string[] => {
    if (effects.discard) return describeDiscard(state, effects);
    const details: string[] = [];
    if (effects.removeCheckout && state.worktree.worktreePath)
      details.push(
        `Removes the checkout at ${state.worktree.worktreePath} with \`git worktree remove\` (never forced).`,
      );
    if (effects.discardedRegenerableIgnored > 0)
      details.push(
        `Discards ${plural(effects.discardedRegenerableIgnored, "ignored cache/build directory")} that can be regenerated (${(state.facts?.status?.regenerableIgnored ?? []).slice(0, 3).join(", ")}).`,
      );
    if (effects.stopSessionThreadIds.length > 0)
      details.push(
        `Stops ${plural(effects.stopSessionThreadIds.length, "provider session")} first; removal is cancelled if any fails to stop.`,
      );
    if (state.idleTerminalThreadIds.length > 0 && effects.removeCheckout)
      details.push("Closes idle terminals of these conversations; terminal history is kept.");
    if (request.action === "remove-checkout" || request.action === "remove-stale-record") {
      details.push(
        "Conversation history, attachments and terminal history stay readable. Resuming a conversation requires recreating the checkout.",
      );
      if (effects.unchangedConversations > 0)
        details.push(`${plural(effects.unchangedConversations, "conversation")} stay as they are.`);
      if (state.trashedCount > 0)
        details.push(`${plural(state.trashedCount, "conversation")} in Trash stay in Trash.`);
      details.push(
        effects.deleteBranch
          ? `Deletes the merged branch ${state.worktree.branch} only if it still points at the reviewed commit.`
          : `Keeps the branch ${state.worktree.branch}.`,
      );
      if (request.action === "remove-stale-record" && state.facts?.gitRegistered)
        details.push("Git still lists this missing path; `git worktree prune` clears it.");
    }
    if (request.action === "archive")
      details.push("Hides the workspace. Its directory, branch and conversations are untouched.");
    if (request.action === "recreate-checkout")
      details.push(
        `Checks out the existing branch ${state.worktree.branch} at ${state.worktree.worktreePath ?? "its recorded path"}.`,
      );
    return details;
  };

  /** What "Delete workspace" throws away, then what it keeps. */
  const describeDiscard = (state: WorkspaceState, effects: WorkspaceLifecycleEffects): string[] => {
    const details: string[] = [];
    const status = state.facts?.status ?? null;
    if (state.worktree.checkoutRemovedAt != null)
      details.push("The checkout is already removed; this finishes deleting the workspace.");
    if (effects.removeCheckout && state.worktree.worktreePath)
      details.push(
        `Removes the checkout at ${state.worktree.worktreePath} with \`git worktree remove --force\`.`,
      );
    if (effects.removeCheckout && status) {
      if (status.modified > 0)
        details.push(`Discards uncommitted changes to ${plural(status.modified, "tracked file")}.`);
      if (status.untracked > 0)
        details.push(`Deletes ${plural(status.untracked, "untracked file")}.`);
      if (status.protectedIgnored.length > 0)
        details.push(
          `Deletes ${plural(status.protectedIgnored.length, "ignored file")} that ${status.protectedIgnored.length === 1 ? "is" : "are"} not a known cache (${status.protectedIgnored.slice(0, 3).join(", ")}).`,
        );
      if (status.truncated)
        details.push("There are more changes than could be counted; all of them are discarded.");
    }
    if (effects.discardedRegenerableIgnored > 0)
      details.push(
        `Discards ${plural(effects.discardedRegenerableIgnored, "ignored cache/build directory")} that can be regenerated.`,
      );
    if (effects.stopSessionThreadIds.length > 0)
      details.push(
        `Stops ${plural(effects.stopSessionThreadIds.length, "provider session")} first; nothing is removed if any fails to stop.`,
      );
    const trashed = effects.trashConversationIds?.length ?? 0;
    if (trashed > 0)
      details.push(
        `Moves ${plural(trashed, "conversation")} to Trash. Restore ${trashed === 1 ? "it" : "them"} from Trash; history is kept until you delete it permanently.`,
      );
    if (state.trashedCount > 0)
      details.push(`${plural(state.trashedCount, "conversation")} already in Trash stay there.`);
    const unmerged = state.facts?.unmerged !== false;
    details.push(
      effects.deleteBranch
        ? unmerged
          ? `Deletes branch ${state.worktree.branch}, including commits the project HEAD does not contain, only if it still points at the reviewed commit.`
          : `Deletes the merged branch ${state.worktree.branch} only if it still points at the reviewed commit.`
        : state.facts?.branchHead === null
          ? `Branch ${state.worktree.branch} no longer exists.`
          : `Keeps the branch ${state.worktree.branch}${unmerged ? " with its unmerged commits" : ""}.`,
    );
    return details;
  };

  const fingerprintOf = (
    state: WorkspaceState,
    request: WorkspaceLifecycleRequest,
    effects: WorkspaceLifecycleEffects,
  ) => {
    const facts = state.facts;
    const status = facts?.status ?? null;
    return createHash("sha256")
      .update(
        JSON.stringify({
          request,
          worktree: {
            id: state.worktree.worktreeId,
            path: state.worktree.worktreePath,
            branch: state.worktree.branch,
            archivedAt: state.worktree.archivedAt,
            checkoutRemovedAt: state.worktree.checkoutRemovedAt ?? null,
          },
          facts: facts && {
            checkout: facts.checkout,
            checkoutIdentity: facts.checkoutIdentity,
            gitRegistered: facts.gitRegistered,
            head: facts.head,
            branchHead: facts.branchHead,
            baseHead: facts.baseHead,
            unmerged: facts.unmerged,
            status: status && {
              modified: status.modified,
              untracked: status.untracked,
              protectedIgnored: status.protectedIgnored,
              regenerableIgnored: status.regenerableIgnored,
              truncated: status.truncated,
            },
          },
          conversations: state.conversations
            .map((thread) => [thread.id, thread.archivedAt])
            .toSorted(),
          trashed: state.trashedCount,
          activeWork: state.activeWork,
          archive: effects.archiveConversationIds.toSorted(),
          trash: (effects.trashConversationIds ?? []).toSorted(),
          deleteBranch: effects.deleteBranch,
        }),
      )
      .digest("hex");
  };

  const buildPreview = (state: WorkspaceState, rawRequest: WorkspaceLifecycleRequest) => {
    const request = normalizeRequest(rawRequest);
    const effects = computeEffects(state, request);
    return {
      request,
      workspace: summarize(state),
      effects,
      summary: summarizeWorkspaceLifecycleEffects(request.action, effects),
      details: describeDetails(state, request, effects),
      blockers: workspaceActionBlockers(state, request),
      fingerprint: fingerprintOf(state, request, effects),
    } satisfies WorkspaceLifecyclePreview;
  };

  const loadState = (worktreeId: WorktreeId) =>
    Effect.gen(function* () {
      const context = yield* loadContext;
      const worktree = (context.snapshot.worktrees ?? []).find(
        (candidate) => candidate.worktreeId === worktreeId,
      );
      if (!worktree)
        return yield* Effect.fail(
          lifecycleError(
            "This workspace has no record. Groups derived from conversations cannot be changed.",
          ),
        );
      return yield* inspectWorkspace(context, worktree);
    });

  const dispatch = (command: OrchestrationCommand) =>
    deps.engine.dispatch(command).pipe(Effect.asVoid);

  // Same follow-ups as a user archive (stop session, close terminals keeping history).
  const archiveThread = (threadId: ThreadId, commandId: CommandId) =>
    applyOrchestrationNormalizedCommand({
      command: { type: "thread.archive", commandId, threadId },
      dispatch: (command) =>
        deps.engine
          .dispatch(command)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
            ),
          ),
      projections: deps.snapshots,
      terminals: deps.terminals,
    }).pipe(Effect.asVoid);

  const execute = (
    rawRequest: WorkspaceLifecycleRequest,
    expectedFingerprint: string | null,
    operationKey: string | null,
  ): Effect.Effect<WorkspaceLifecycleResult, WorkspaceLifecycleError> =>
    lockFor(rawRequest.worktreeId).withPermit(
      Effect.gen(function* () {
        const steps: WorkspaceLifecycleStep[] = [];
        const step = (
          id: WorkspaceLifecycleStep["id"],
          status: WorkspaceLifecycleStep["status"],
          detail: string,
        ) => steps.push({ id, status, detail });
        const result = (
          outcome: WorkspaceLifecycleResult["outcome"],
          message: string,
        ): WorkspaceLifecycleResult => ({ outcome, message, steps: [...steps] });

        const state = yield* loadState(rawRequest.worktreeId);
        const preview = buildPreview(state, rawRequest);
        const { request, effects } = preview;
        if (expectedFingerprint !== null && preview.fingerprint !== expectedFingerprint) {
          step("preflight", "failed", "The workspace changed after it was reviewed.");
          return result(
            "blocked",
            "This workspace changed since you reviewed it. Nothing was changed; review the action again.",
          );
        }
        if (preview.blockers.length > 0) {
          step("preflight", "failed", preview.blockers.join(" "));
          return result("blocked", `Nothing was changed. ${preview.blockers.join(" ")}`);
        }
        step("preflight", "done", preview.summary);
        const key = operationKey ?? preview.fingerprint.slice(0, 24);
        const commandId = (suffix: string) =>
          CommandId.make(`workspace-lifecycle:${key}:${suffix}`);
        const stamp = () => new Date(now()).toISOString();
        const worktreeId = state.worktree.worktreeId;
        const projectRoot = state.project.workspaceRoot;

        switch (request.action) {
          case "archive":
            yield* dispatch({
              type: "worktree.archive",
              commandId: commandId("archive"),
              worktreeId,
              archivedAt: stamp(),
              deletedBranch: false,
            }).pipe(
              Effect.mapError((cause) => lifecycleError(`Archiving failed: ${cause.message}`)),
            );
            step("update-record", "done", "Workspace archived; checkout and branch untouched.");
            return result("completed", preview.summary);

          case "restore":
            yield* dispatch({
              type: "worktree.restore",
              commandId: commandId("restore"),
              worktreeId,
              restoredAt: stamp(),
            }).pipe(
              Effect.mapError((cause) => lifecycleError(`Restoring failed: ${cause.message}`)),
            );
            step("update-record", "done", "Workspace restored.");
            return result("completed", preview.summary);

          case "recreate-checkout": {
            const path = state.worktree.worktreePath!;
            const created = yield* Effect.exit(
              deps.git.createWorktree({
                projectId: state.worktree.projectId,
                cwd: projectRoot,
                refName: state.worktree.branch,
                path,
              }),
            );
            if (created._tag === "Failure") {
              step("recreate-checkout", "failed", "Git could not recreate the checkout.");
              return result("failed", "The checkout could not be recreated. Nothing was changed.");
            }
            step(
              "recreate-checkout",
              "done",
              `Checked out ${state.worktree.branch} at ${created.value.worktree.path}.`,
            );
            const recordUpdate = Effect.gen(function* () {
              if (state.worktree.checkoutRemovedAt != null)
                yield* dispatch({
                  type: "worktree.checkout.restore",
                  commandId: commandId("checkout-restore"),
                  worktreeId,
                  worktreePath: created.value.worktree.path,
                  restoredAt: stamp(),
                });
              if (state.worktree.archivedAt !== null)
                yield* dispatch({
                  type: "worktree.restore",
                  commandId: commandId("restore"),
                  worktreeId,
                  restoredAt: stamp(),
                });
            });
            const recorded = yield* Effect.exit(recordUpdate);
            yield* deps.git.invalidateStatus(projectRoot);
            if (recorded._tag === "Failure") {
              step("update-record", "failed", "The workspace record could not be updated.");
              return result(
                "partial",
                "The checkout was recreated, but its record was not updated. Retry to finish.",
              );
            }
            step("update-record", "done", "Workspace record restored.");
            return result("completed", preview.summary);
          }

          case "remove-checkout":
          case "remove-stale-record": {
            const path = state.worktree.worktreePath!;
            if (effects.removeCheckout) {
              // 1. Sessions must be verifiably stopped before any filesystem change.
              if (effects.stopSessionThreadIds.length > 0) {
                if (deps.providers === null) {
                  step(
                    "stop-sessions",
                    "failed",
                    "Provider sessions cannot be stopped on this node.",
                  );
                  return result(
                    "failed",
                    "Nothing was removed: provider sessions could not be stopped.",
                  );
                }
                const providers = deps.providers;
                const stopped = yield* Effect.exit(
                  Effect.forEach(
                    effects.stopSessionThreadIds,
                    (threadId) => providers.stopSession({ threadId }),
                    { discard: true },
                  ),
                );
                const stillRunning =
                  stopped._tag === "Success" && deps.sessionDirectory
                    ? yield* deps.sessionDirectory
                        .listBindings()
                        .pipe(Effect.orElseSucceed(() => null))
                    : null;
                if (
                  stopped._tag === "Failure" ||
                  (deps.sessionDirectory !== null &&
                    (stillRunning === null ||
                      stillRunning.some(
                        (binding) =>
                          effects.stopSessionThreadIds.includes(binding.threadId) &&
                          binding.status !== "stopped",
                      )))
                ) {
                  step("stop-sessions", "failed", "A provider session did not stop.");
                  return result(
                    "failed",
                    "Nothing was removed: a provider session did not stop. Conversations and the checkout are unchanged.",
                  );
                }
                for (const threadId of effects.stopSessionThreadIds)
                  yield* dispatch({
                    type: "thread.session.stop",
                    commandId: commandId(`session-stop:${threadId}`),
                    threadId,
                    createdAt: stamp(),
                  }).pipe(Effect.ignore({ log: true }));
                step(
                  "stop-sessions",
                  "done",
                  `Stopped ${plural(effects.stopSessionThreadIds.length, "session")}.`,
                );
              }
              for (const threadId of state.idleTerminalThreadIds)
                yield* deps.terminals.close({ threadId }).pipe(Effect.ignore({ log: true }));

              // 2. Fence the path so no turn, recovery or terminal can start there.
              const claim = yield* Effect.exit(
                deps.fence.claim({
                  path,
                  repository: state.facts!.repository,
                  projectId: state.worktree.projectId,
                }),
              );
              if (claim._tag === "Failure") {
                step("fence-checkout", "failed", "The checkout could not be fenced.");
                return result(
                  "failed",
                  "Nothing was removed: the checkout could not be fenced for removal.",
                );
              }
              step("fence-checkout", "done", "New work in this checkout is refused.");

              // 3. Revalidate immediately before removal.
              const fresh = yield* Effect.exit(loadState(worktreeId));
              const freshBlockers =
                fresh._tag === "Success"
                  ? workspaceActionBlockers(fresh.value, request)
                  : ["The workspace could not be revalidated."];
              // A discard throws away exactly what was reviewed: any new or
              // changed file since the review cancels it.
              const unchanged =
                fresh._tag === "Success" &&
                fresh.value.facts?.head === state.facts?.head &&
                fresh.value.facts?.checkoutIdentity === state.facts?.checkoutIdentity &&
                statusKey(fresh.value.facts?.status) === statusKey(state.facts?.status);
              if (freshBlockers.length > 0 || !unchanged) {
                yield* deps.fence.release(claim.value);
                step("revalidate", "failed", freshBlockers.join(" ") || "The checkout changed.");
                return result(
                  "blocked",
                  `Nothing was removed: the checkout changed right before removal. ${freshBlockers.join(" ")}`.trim(),
                );
              }
              step("revalidate", "done", "Checkout unchanged since review.");

              // 4. Remove without force: Git itself refuses modified or untracked
              // content. Only a reviewed discard forces it.
              const removed = yield* Effect.exit(
                deps.git.removeWorktree({
                  cwd: projectRoot,
                  path,
                  force: effects.discard === true,
                }),
              );
              const registered = yield* deps.git
                .listWorktreePaths(projectRoot)
                .pipe(Effect.orElseSucceed(() => null));
              const gone =
                removed._tag === "Success" &&
                !existsSync(path) &&
                registered !== null &&
                !registered.some((entry) => samePath(entry, path));
              if (!gone) {
                const directoryGone = !existsSync(path);
                // Directory still present: nothing was removed, so admission is restored.
                // Directory gone (only Git's registration is left): nothing is in flight
                // any more, so the path stays refused like any removed checkout.
                yield* directoryGone
                  ? deps.fence.complete(claim.value)
                  : deps.fence.release(claim.value);
                step(
                  "remove-checkout",
                  "failed",
                  directoryGone
                    ? "The directory is gone but Git still registers it."
                    : removed._tag === "Failure"
                      ? "Git refused to remove the checkout."
                      : "The checkout could not be verified as removed.",
                );
                return result(
                  directoryGone ? "partial" : "failed",
                  directoryGone
                    ? "The checkout directory was removed, but Git still registers it. Run `git worktree prune` in the project, then retry to record the removal; history and the branch are unchanged."
                    : "The checkout was not removed. Conversations, history and the branch are unchanged.",
                );
              }
              yield* deps.fence.complete(claim.value);
              step("remove-checkout", "done", `Removed ${path}.`);
              yield* deps.git.invalidateStatus(projectRoot);
            }

            // 5. Record the removal; the record, path and branch stay as provenance.
            if (effects.recordCheckoutRemoval) {
              const recorded = yield* Effect.exit(
                dispatch({
                  type: "worktree.checkout.remove",
                  commandId: commandId("checkout-remove"),
                  worktreeId,
                  reason: effects.removeCheckout ? "removed" : "missing",
                  removedAt: stamp(),
                }),
              );
              if (recorded._tag === "Failure") {
                step("update-record", "failed", "The workspace record was not updated.");
                return result(
                  effects.removeCheckout ? "partial" : "failed",
                  effects.removeCheckout
                    ? "The checkout was removed, but its record was not updated. Retry to finish; history is unchanged."
                    : "The workspace record was not updated. Nothing was changed.",
                );
              }
              step("update-record", "done", "Workspace record kept with its branch and path.");
            }

            // 6. Archive conversations (never delete them).
            const failedArchives: ThreadId[] = [];
            for (const threadId of effects.archiveConversationIds) {
              const archived = yield* Effect.exit(
                archiveThread(threadId, commandId(`archive-thread:${threadId}`)),
              );
              if (archived._tag === "Failure") failedArchives.push(threadId);
            }
            if (effects.archiveConversationIds.length > 0)
              step(
                "archive-conversations",
                failedArchives.length === 0 ? "done" : "failed",
                failedArchives.length === 0
                  ? `Archived ${plural(effects.archiveConversationIds.length, "conversation")}.`
                  : `${plural(failedArchives.length, "conversation")} could not be archived.`,
              );
            // A discard moves them to Trash instead, where they stay restorable.
            const trashIds = effects.trashConversationIds ?? [];
            for (const threadId of trashIds) {
              const trashed = yield* Effect.exit(
                dispatch({
                  type: "thread.trash",
                  commandId: commandId(`trash-thread:${threadId}`),
                  threadId,
                }),
              );
              if (trashed._tag === "Failure") failedArchives.push(threadId);
            }
            if (trashIds.length > 0)
              step(
                "archive-conversations",
                failedArchives.length === 0 ? "done" : "failed",
                failedArchives.length === 0
                  ? `Moved ${plural(trashIds.length, "conversation")} to Trash.`
                  : `${plural(failedArchives.length, "conversation")} could not be moved to Trash.`,
              );

            // 7. Branch deletion is explicit, pinned to the reviewed commit, and
            // merged-only unless the reviewed discard said otherwise.
            let branchFailed = false;
            if (effects.deleteBranch && state.facts?.branchHead) {
              const deleted = yield* Effect.exit(
                deps.gitDriver.execute({
                  operation: "workspace lifecycle branch deletion",
                  cwd: projectRoot,
                  args: [
                    "update-ref",
                    "-d",
                    `refs/heads/${state.worktree.branch}`,
                    state.facts.branchHead,
                  ],
                  timeoutMs: 10_000,
                  maxOutputBytes: 8192,
                }),
              );
              branchFailed = deleted._tag === "Failure";
              step(
                "delete-branch",
                branchFailed ? "failed" : "done",
                branchFailed
                  ? `Branch ${state.worktree.branch} was kept (it moved or could not be deleted).`
                  : `Deleted ${state.facts.unmerged === false ? "merged " : ""}branch ${state.worktree.branch}.`,
              );
            }
            if (failedArchives.length > 0 || branchFailed)
              return result(
                "partial",
                `${preview.summary} Some follow-up steps failed; retry to finish. History is unchanged.`,
              );
            return result("completed", preview.summary);
          }
        }
      }),
    );

  const preview: WorkspaceLifecycleShape["preview"] = (request) =>
    loadState(request.worktreeId).pipe(Effect.map((state) => buildPreview(state, request)));

  const migration = deps.migration
    ? makeManagedWorktreeMigration(deps, deps.migration.sql, deps.migration.stateDir, lockFor)
    : null;
  return {
    ...(migration
      ? { migrateManagedWorktrees: migration.migrate, recoverManagedWorktrees: migration.recover }
      : {}),
    list: (projectId) =>
      Effect.gen(function* () {
        const context = yield* loadContext;
        const worktrees = (context.snapshot.worktrees ?? []).filter(
          (worktree) => worktree.projectId === projectId,
        );
        const states = yield* Effect.forEach(
          worktrees,
          (worktree) => inspectWorkspace(context, worktree),
          { concurrency: 4 },
        );
        return states.map(summarize);
      }),
    preview,
    apply: (input) => {
      const { expectedFingerprint, ...request } = input;
      return execute(request, expectedFingerprint, null);
    },
    applyCurrent: ({ operationKey, ...request }) => execute(request, null, operationKey ?? null),
    suggestions: () =>
      Effect.gen(function* () {
        const settings = yield* deps.settings.getSettings.pipe(
          Effect.mapError(() => lifecycleError("Settings are unavailable.")),
        );
        const context = yield* loadContext;
        const excluded = new Set(
          context.terminals.filter(terminalAlive).map((terminal) => terminal.threadId),
        );
        const plan = planLifecycleSuggestions({
          threads: context.snapshot.threads,
          worktrees: context.snapshot.worktrees ?? [],
          projectRoots: new Map(
            context.snapshot.projects.map((project) => [project.id, project.workspaceRoot]),
          ),
          policyFor: (projectId) => resolveLifecycleSuggestionPolicy(settings, projectId),
          excludedThreadIds: excluded,
          samePath,
          nowMs: context.nowMs,
        });
        // Only checkouts whose removal would pass preflight right now are suggested.
        const verified = yield* Effect.forEach(
          plan.checkouts.slice(0, 20),
          (candidate) =>
            Effect.gen(function* () {
              const worktree = (context.snapshot.worktrees ?? []).find(
                (row) => row.worktreeId === candidate.worktreeId,
              );
              if (!worktree) return null;
              const state = yield* inspectWorkspace(context, worktree).pipe(
                Effect.orElseSucceed(() => null),
              );
              if (!state) return null;
              return workspaceActionBlockers(
                state,
                normalizeRequest({ worktreeId: worktree.worktreeId, action: "remove-checkout" }),
              ).length === 0
                ? candidate
                : null;
            }),
          { concurrency: 2 },
        );
        return {
          generatedAt: new Date(context.nowMs).toISOString(),
          threads: plan.threads.map((thread) => ({
            threadId: thread.threadId as ThreadId,
            projectId: thread.projectId as ProjectId,
            title: thread.title,
            lastActivityAt: thread.lastActivityAt,
          })),
          checkouts: verified.flatMap((candidate) =>
            candidate === null
              ? []
              : [
                  {
                    worktreeId: candidate.worktreeId as WorktreeId,
                    projectId: candidate.projectId as ProjectId,
                    title: candidate.title,
                    branch: candidate.branch,
                    archivedSince: candidate.archivedSince,
                    conversations: candidate.conversations,
                  },
                ],
          ),
        };
      }),
    listTrash: () =>
      deps.threads.listTrashed({ limit: 501 }).pipe(
        Effect.map((rows) => ({
          truncated: rows.length > 500,
          threads: rows.slice(0, 500).map((row) => ({
            threadId: row.threadId,
            projectId: row.projectId,
            projectTitle: row.projectTitle,
            projectAvailable: row.projectTitle !== null && row.projectDeletedAt === null,
            title: row.title,
            branch: row.branch,
            worktreePath: row.worktreePath,
            worktreeId: row.worktreeId,
            archivedAt: row.archivedAt,
            trashedAt: row.trashedAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
        })),
        Effect.mapError(() => lifecycleError("Trash is unavailable.")),
      ),
  };
}

export const WorkspaceLifecycleLive = Layer.effect(
  WorkspaceLifecycle,
  Effect.gen(function* () {
    const providers = yield* Effect.serviceOption(ProviderService);
    const sessionDirectory = yield* Effect.serviceOption(ProviderSessionDirectory);
    return makeWorkspaceLifecycle({
      snapshots: yield* ProjectionSnapshotQuery,
      threads: yield* ProjectionThreadRepository,
      engine: yield* OrchestrationEngineService,
      providers: Option.getOrNull(providers),
      sessionDirectory: Option.getOrNull(sessionDirectory),
      terminals: yield* TerminalManager,
      policy: yield* WorkspaceAccessPolicy,
      gitDriver: yield* GitVcsDriver,
      git: yield* GitWorkflowService,
      settings: yield* ServerSettingsService,
      fence: makeSqlCheckoutFence(yield* SqlClient.SqlClient),
      migration: { sql: yield* SqlClient.SqlClient, stateDir: (yield* ServerConfig).stateDir },
    });
  }),
);
