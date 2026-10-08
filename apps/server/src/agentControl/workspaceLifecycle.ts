import { workspaceSessionActive } from "../workspace/lifecycleSafety.ts";
export { workspaceSessionActive } from "../workspace/lifecycleSafety.ts";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import {
  type AgentControlWorkspaceState,
  type AgentControlWorkspaceLifecyclePlan,
  type ProjectId,
  type ThreadId,
  type OrchestrationShellSnapshot,
  type WorkspaceLifecycleAction,
} from "@ryco/contracts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { AgentControlPlanValidationError } from "./Errors.ts";
import {
  CheckoutInspectionError,
  checkoutHasBlockingChanges,
  inspectCheckout,
} from "../workspace/checkoutInspection.ts";

const fail = (detail: string) =>
  Effect.fail(new AgentControlPlanValidationError({ reason: "worktree-preflight", detail }));
const normalized = (value: string) => {
  const result = path.resolve(value);
  return process.platform === "darwin" || process.platform === "win32"
    ? result.toLowerCase()
    : result;
};
const same = (a: string, b: string) => normalized(a) === normalized(b);
const syntheticId = (projectId: string, directory: string) =>
  `synthetic-${createHash("sha256")
    .update(`${projectId}:${normalized(directory)}`)
    .digest("hex")}`;

/**
 * Same lifecycle rules as human workspace management: conversations are never deleted,
 * a record conversations reference is never dropped, and the main checkout is protected.
 */
export const workspacePlanBlockers = (
  plan: AgentControlWorkspaceLifecyclePlan,
): readonly string[] => {
  const s = plan.expected;
  const blockers = [...s.blockers];
  if (s.registration !== "registered")
    blockers.push("Synthetic groups have no workspace record to mutate.");
  if (s.main) blockers.push("The main workspace is protected.");
  if (s.current) blockers.push("The caller's current workspace is protected.");
  if (s.sessions.some((thread) => thread.active))
    blockers.push("Associated sessions have active work.");
  if (plan.sessions === "delete")
    blockers.push(
      "Workspace actions never delete conversations; move conversations to Trash individually.",
    );
  if (plan.action === "delete" && s.sessions.length > 0)
    blockers.push(
      "Conversations reference this workspace record; archive it with remove-checkout to keep their provenance.",
    );
  if (plan.action === "restore") {
    if (s.archivedAt === null) blockers.push("Restore requires an archived workspace record.");
    if (plan.checkoutMode === "restore-checkout") {
      if (
        plan.deleteBranch ||
        s.checkout !== "missing" ||
        s.gitRegistered !== false ||
        s.branchHead === null
      )
        blockers.push(
          "Recreating a checkout requires an absent checkout and registration and a retained branch.",
        );
    } else if (plan.checkoutMode !== "record-only")
      blockers.push("Invalid checkout mode for restore.");
  } else if (plan.checkoutMode === "record-only") {
    if (plan.deleteBranch) blockers.push("Record-only actions retain the branch.");
    if (s.checkout === "missing" && s.gitRegistered !== false)
      blockers.push("The checkout is missing but Git still registers it; prune it first.");
    if (plan.action === "delete" && s.checkout !== "missing")
      blockers.push("Record-only deletion requires a verified absent checkout.");
  } else if (plan.checkoutMode === "remove-checkout") {
    if (
      s.checkout !== "present" ||
      s.gitRegistered !== true ||
      s.dirty !== false ||
      s.unmerged !== false
    )
      blockers.push(
        "Checkout removal requires a registered, clean checkout merged into the project HEAD.",
      );
  } else blockers.push("Invalid checkout mode for archive/delete.");
  if (
    plan.deleteBranch &&
    (plan.checkoutMode !== "remove-checkout" || s.branchHead === null || s.unmerged !== false)
  )
    blockers.push("Branch deletion requires removing a checkout whose branch is verified merged.");
  return [...new Set(blockers)];
};

/** The shared lifecycle action an approved Agent Control plan performs. */
export const workspacePlanLifecycleAction = (
  plan: AgentControlWorkspaceLifecyclePlan,
): WorkspaceLifecycleAction =>
  plan.action === "restore"
    ? plan.checkoutMode === "restore-checkout"
      ? "recreate-checkout"
      : "restore"
    : plan.checkoutMode === "remove-checkout"
      ? "remove-checkout"
      : plan.expected.checkout === "missing"
        ? "remove-stale-record"
        : "archive";

export class AgentControlWorkspaces extends Context.Service<
  AgentControlWorkspaces,
  {
    /**
     * `caller` is the requesting thread, whose workspace is protected as current.
     * `null` is a standalone reader without a Ryco thread: no workspace is current.
     */
    readonly list: (
      projectId: ProjectId,
      caller: ThreadId | null,
      after?: string,
      limit?: number,
    ) => Effect.Effect<
      { workspaces: readonly AgentControlWorkspaceState[]; nextCursor: string | null },
      AgentControlPlanValidationError
    >;
    readonly read: (
      projectId: ProjectId,
      workspaceId: string,
      caller: ThreadId | null,
    ) => Effect.Effect<AgentControlWorkspaceState, AgentControlPlanValidationError>;
    readonly revalidate: (
      plan: AgentControlWorkspaceLifecyclePlan,
      caller: ThreadId,
    ) => Effect.Effect<void, AgentControlPlanValidationError>;
  }
>()("ryco/agentControl/AgentControlWorkspaces") {}

export const AgentControlWorkspacesLive = Layer.effect(
  AgentControlWorkspaces,
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    const policy = yield* WorkspaceAccessPolicy;
    const git = yield* GitVcsDriver;
    const load = (projectId: ProjectId, callerId: ThreadId | null) =>
      Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot();
        const caller = callerId === null ? null : snapshot.threads.find((t) => t.id === callerId);
        const project = snapshot.projects.find((p) => p.id === projectId);
        if (!project || caller === undefined || (caller !== null && caller.projectId !== projectId))
          return yield* fail("Project scope denied.");
        const rows = (snapshot.worktrees ?? []).filter((w) => w.projectId === projectId);
        const groups = new Map<
          string,
          { id: string; directory: string; row: (typeof rows)[number] | undefined }
        >();
        for (const row of rows)
          groups.set(row.worktreeId, {
            id: row.worktreeId,
            directory: row.worktreePath ?? project.workspaceRoot,
            row,
          });
        for (const thread of snapshot.threads.filter((t) => t.projectId === projectId)) {
          const directory = thread.worktreePath ?? project.workspaceRoot;
          if (
            rows.some(
              (w) =>
                w.worktreeId === thread.worktreeId ||
                same(w.worktreePath ?? project.workspaceRoot, directory),
            )
          )
            continue;
          const id = syntheticId(projectId, directory);
          groups.set(id, { id, directory, row: undefined });
        }
        return { snapshot, caller, project, groups };
      }).pipe(
        Effect.mapError(
          () =>
            new AgentControlPlanValidationError({
              reason: "project-scope",
              detail: "Workspace scope or project state unavailable.",
            }),
        ),
      );

    const inspect = (
      context: Effect.Success<ReturnType<typeof load>>,
      group: {
        id: string;
        directory: string;
        row: NonNullable<OrchestrationShellSnapshot["worktrees"]>[number] | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const { snapshot, caller, project } = context;
        const { row, directory } = group;
        const sessions = snapshot.threads.filter(
          (t) =>
            t.projectId === project.id &&
            ((t.worktreeId === row?.worktreeId && row !== undefined) ||
              same(t.worktreePath ?? project.workspaceRoot, directory)),
        );
        if (sessions.length > 500)
          return yield* fail(
            "Workspace has more than 500 sessions; lifecycle inspection is blocked.",
          );
        const state: AgentControlWorkspaceState = {
          mainWorkspaceId:
            (snapshot.worktrees ?? []).find(
              (w) =>
                w.projectId === project.id &&
                w.origin === "main" &&
                w.archivedAt === null &&
                (w.worktreePath === null || same(w.worktreePath, project.workspaceRoot)),
            )?.worktreeId ?? null,
          checkoutIdentity: null,
          rootIdentity: null,
          workspaceId: group.id,
          projectId: project.id,
          registration: row ? "registered" : "synthetic",
          worktreeId: row?.worktreeId ?? null,
          title: row?.title ?? row?.branch ?? "Manual",
          origin: row?.origin ?? "manual",
          branch: row?.branch ?? null,
          path: directory,
          projectRoot: project.workspaceRoot,
          projectUpdatedAt: project.updatedAt,
          updatedAt: row?.updatedAt ?? project.updatedAt,
          archivedAt: row?.archivedAt ?? null,
          main: row?.origin === "main" || same(directory, project.workspaceRoot),
          current:
            caller !== null &&
            (same(directory, caller.worktreePath ?? project.workspaceRoot) ||
              sessions.some((t) => t.id === caller.id)),
          checkout: "unavailable",
          gitRegistered: null,
          repository: null,
          repositoryIdentity: null,
          head: null,
          branchHead: null,
          baseHead: null,
          dirty: null,
          unmerged: null,
          sessions: sessions
            .map((t) => ({
              threadId: t.id,
              updatedAt: t.updatedAt,
              archived: t.archivedAt !== null,
              active: workspaceSessionActive(t),
            }))
            .toSorted((a, b) => a.threadId.localeCompare(b.threadId)),
          blockers: [],
        };
        const inspection = yield* Effect.exit(
          inspectCheckout(
            { policy, git },
            {
              snapshot,
              project,
              directory,
              rowWorktreeId: row?.worktreeId ?? null,
              branch: row?.branch ?? null,
              operation: "Agent Control workspace inspection",
            },
          ).pipe(
            Effect.map(({ status, ...facts }) => ({
              ...facts,
              // Same rule as human checkout removal: modified, untracked or protected
              // ignored content is dirty; known regenerable caches are not.
              dirty: status === null ? null : checkoutHasBlockingChanges(status),
            })),
          ),
        );
        if (inspection._tag === "Success") return { ...state, ...inspection.value };
        const failure = Cause.squash(inspection.cause);
        return {
          ...state,
          blockers: [
            Schema.is(AgentControlPlanValidationError)(failure) ||
            failure instanceof CheckoutInspectionError
              ? failure.detail
              : "Filesystem/Git inspection could not safely verify this workspace.",
          ],
        };
      });
    const read = (projectId: ProjectId, workspaceId: string, caller: ThreadId | null) =>
      Effect.gen(function* () {
        const context = yield* load(projectId, caller);
        const group = context.groups.get(workspaceId);
        if (!group) return yield* fail("Workspace is unavailable in this project.");
        return yield* inspect(context, group);
      });
    return {
      read,
      list: (projectId, caller, after, limit = 25) =>
        Effect.gen(function* () {
          const context = yield* load(projectId, caller);
          const groups = [...context.groups.values()]
            .toSorted((a, b) => a.id.localeCompare(b.id))
            .filter((g) => after === undefined || g.id.localeCompare(after) > 0);
          const selected = groups.slice(0, Math.min(50, Math.max(1, limit)));
          const workspaces = yield* Effect.forEach(selected, (g) => inspect(context, g), {
            concurrency: 2,
          });
          return {
            workspaces,
            nextCursor: groups.length > selected.length ? selected.at(-1)!.id : null,
          };
        }),
      revalidate: (plan, caller) =>
        Effect.gen(function* () {
          const current = yield* read(plan.projectId, plan.expected.workspaceId, caller);
          if (!isDeepStrictEqual(current, plan.expected))
            return yield* fail("Workspace state changed; inspect and request a new plan.");
          const blockers = workspacePlanBlockers(plan);
          if (blockers.length) return yield* fail(blockers.join(" "));
        }),
    };
  }),
);
