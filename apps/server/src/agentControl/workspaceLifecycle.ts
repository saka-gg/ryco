import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import {
  type AgentControlWorkspaceState,
  type AgentControlWorkspaceLifecyclePlan,
  type ProjectId,
  type ThreadId,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { AgentControlPlanValidationError } from "./Errors.ts";

const fail = (detail: string) =>
  Effect.fail(new AgentControlPlanValidationError({ reason: "worktree-preflight", detail }));
const normalized = (value: string) => {
  const result = path.resolve(value);
  return process.platform === "darwin" || process.platform === "win32"
    ? result.toLowerCase()
    : result;
};
const same = (a: string, b: string) => normalized(a) === normalized(b);
const contains = (a: string, b: string) =>
  same(a, b) || normalized(b).startsWith(normalized(a) + path.sep);
const syntheticId = (projectId: string, directory: string) =>
  `synthetic-${createHash("sha256")
    .update(`${projectId}:${normalized(directory)}`)
    .digest("hex")}`;

export const workspaceSessionActive = (thread: OrchestrationShellSnapshot["threads"][number]) =>
  thread.session?.status === "running" ||
  thread.session?.status === "starting" ||
  thread.session?.activeTurnId != null ||
  Boolean(thread.backgroundLiveness) ||
  thread.latestTurn?.state === "running";

export const workspacePlanBlockers = (
  plan: AgentControlWorkspaceLifecyclePlan,
): readonly string[] => {
  const s = plan.expected;
  const blockers = [...s.blockers];
  if (s.registration !== "registered")
    blockers.push("Synthetic groups have no workspace record to mutate.");
  if (
    plan.action === "delete" &&
    plan.sessions === "preserve" &&
    s.sessions.length &&
    s.mainWorkspaceId === null
  )
    blockers.push("A registered main workspace is required to preserve sessions.");
  if (s.main) blockers.push("The main workspace is protected.");
  if (s.current) blockers.push("The caller's current workspace is protected.");
  if (s.sessions.some((thread) => thread.active))
    blockers.push("Associated sessions have active work.");
  if (plan.action !== "delete" && plan.sessions !== "preserve")
    blockers.push("Only delete supports session deletion.");
  if (plan.action === "restore") {
    if (
      plan.checkoutMode !== "restore-checkout" ||
      plan.deleteBranch ||
      s.archivedAt === null ||
      s.checkout !== "missing" ||
      s.gitRegistered !== false ||
      s.branchHead === null
    )
      blockers.push(
        "Restore requires an archived record, absent checkout/registration and retained branch.",
      );
  } else if (plan.checkoutMode === "record-only") {
    if (s.checkout !== "missing" || s.gitRegistered !== false || plan.deleteBranch)
      blockers.push(
        "Record-only cleanup requires a verified absent path and Git registration; branches are retained.",
      );
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
  if (plan.deleteBranch && (s.branchHead === null || s.unmerged !== false))
    blockers.push("Branch deletion requires a verified merged branch.");
  return [...new Set(blockers)];
};

export class AgentControlWorkspaces extends Context.Service<
  AgentControlWorkspaces,
  {
    readonly list: (
      projectId: ProjectId,
      caller: ThreadId,
      after?: string,
      limit?: number,
    ) => Effect.Effect<
      { workspaces: readonly AgentControlWorkspaceState[]; nextCursor: string | null },
      AgentControlPlanValidationError
    >;
    readonly read: (
      projectId: ProjectId,
      workspaceId: string,
      caller: ThreadId,
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
    const load = (projectId: ProjectId, callerId: ThreadId) =>
      Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot();
        const caller = snapshot.threads.find((t) => t.id === callerId);
        const project = snapshot.projects.find((p) => p.id === projectId);
        if (!project || caller?.projectId !== projectId)
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
            same(directory, caller.worktreePath ?? project.workspaceRoot) ||
            sessions.some((t) => t.id === caller.id),
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
          Effect.gen(function* () {
            const root = yield* policy.assertExistingPath({
              path: project.workspaceRoot,
              operation: "Agent Control workspace inspection",
            });
            const authorized = yield* policy.assertPath({
              path: directory,
              operation: "Agent Control workspace inspection",
            });
            if (!same(root, project.workspaceRoot) || !same(authorized, directory))
              return yield* fail("Workspace path spelling or symlink changed.");
            for (const other of snapshot.projects)
              if (
                other.id !== project.id &&
                (contains(directory, other.workspaceRoot) ||
                  contains(other.workspaceRoot, directory))
              )
                return yield* fail("Workspace overlaps another project.");
            for (const other of snapshot.threads)
              if (
                other.projectId !== project.id &&
                other.worktreePath !== null &&
                (contains(directory, other.worktreePath) || contains(other.worktreePath, directory))
              )
                return yield* fail("Workspace overlaps sessions in another project.");
            for (const other of snapshot.worktrees ?? [])
              if (
                other.worktreeId !== row?.worktreeId &&
                other.worktreePath !== null &&
                (contains(directory, other.worktreePath) || contains(other.worktreePath, directory))
              )
                return yield* fail("Workspace overlaps another registered workspace.");
            const stat = yield* Effect.try({
              try: () => {
                try {
                  return lstatSync(directory);
                } catch (e) {
                  if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
                  throw e;
                }
              },
              catch: () =>
                new AgentControlPlanValidationError({
                  reason: "worktree-preflight",
                  detail: "Path inspection failed.",
                }),
            });
            if (stat?.isSymbolicLink() || (stat && !stat.isDirectory()))
              return yield* fail("Checkout is not a plain directory.");
            const run = (cwd: string, args: readonly string[], maxOutputBytes = 8192) =>
              git
                .execute({
                  operation: "Agent Control workspace inspection",
                  cwd,
                  args: ["-c", "core.fsmonitor=false", ...args],
                  timeoutMs: 10_000,
                  maxOutputBytes,
                  env: { GIT_OPTIONAL_LOCKS: "0" },
                })
                .pipe(
                  Effect.flatMap((r) =>
                    r.stdoutTruncated || r.stderrTruncated
                      ? fail("Git inspection exceeded its bounded output limit.")
                      : Effect.succeed(r.stdout.replace(/\r?\n$/, "")),
                  ),
                );
            const rootStat = yield* Effect.try({
              try: () => lstatSync(root),
              catch: () =>
                new AgentControlPlanValidationError({
                  reason: "worktree-preflight",
                  detail: "Project path inspection failed.",
                }),
            });
            const repository = yield* run(root, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]);
            yield* policy.assertExistingPath({
              path: repository,
              operation: "Agent Control Git metadata inspection",
            });
            const repositoryStat = yield* Effect.try({
              try: () => lstatSync(repository),
              catch: () =>
                new AgentControlPlanValidationError({
                  reason: "worktree-preflight",
                  detail: "Git metadata inspection failed.",
                }),
            });
            if (repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory())
              return yield* fail("Git metadata must be a plain directory.");
            const baseHead = yield* run(root, ["rev-parse", "--verify", "HEAD"]);
            const listing = yield* run(root, ["worktree", "list", "--porcelain", "-z"], 256 * 1024);
            const entries = listing.split("\0\0").map((entry) => entry.split("\0"));
            if (
              entries.some((entry) =>
                entry.some(
                  (f) =>
                    f.startsWith("worktree ") &&
                    !same(f.slice(9), directory) &&
                    contains(directory, f.slice(9)),
                ),
              )
            )
              return yield* fail("Workspace contains another Git checkout.");
            const registered = entries.some((entry) =>
              entry.some(
                (field) => field.startsWith("worktree ") && same(field.slice(9), directory),
              ),
            );
            if (
              entries.some(
                (entry) =>
                  entry.some((f) => f.startsWith("worktree ") && same(f.slice(9), directory)) &&
                  entry.some((f) => f.startsWith("locked")),
              )
            )
              return yield* fail("Locked worktree.");
            const branchHead = row
              ? yield* run(root, [
                  "rev-parse",
                  "--verify",
                  "--end-of-options",
                  `refs/heads/${row.branch}`,
                ]).pipe(Effect.catch(() => Effect.succeed(null)))
              : null;
            const head =
              stat && registered ? yield* run(directory, ["rev-parse", "--verify", "HEAD"]) : null;
            const dirty =
              stat && registered
                ? (yield* run(
                    directory,
                    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"],
                    256 * 1024,
                  )).length > 0
                : null;
            const unmerged = branchHead
              ? (yield* run(root, ["rev-list", "--count", `${baseHead}..${branchHead}`])) !== "0"
              : null;
            if (stat && registered) {
              const checkoutEntry = entries.find((entry) =>
                entry.some(
                  (field) => field.startsWith("worktree ") && same(field.slice(9), directory),
                ),
              );
              if (row && !checkoutEntry?.includes(`branch refs/heads/${row.branch}`))
                return yield* fail("Registered branch differs from the checkout branch.");
              if (
                row &&
                (yield* run(directory, ["symbolic-ref", "--quiet", "HEAD"])) !==
                  `refs/heads/${row.branch}`
              )
                return yield* fail("Checkout branch changed.");
              const actualRepo = yield* run(directory, [
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
              ]);
              if (!same(actualRepo, repository) || head !== branchHead)
                return yield* fail(
                  "Checkout repository or branch does not match its registration.",
                );
            }
            if (
              row &&
              entries.some(
                (entry) =>
                  entry.includes(`branch refs/heads/${row.branch}`) &&
                  !entry.some((f) => f.startsWith("worktree ") && same(f.slice(9), directory)),
              )
            )
              return yield* fail("Branch is checked out in another workspace.");
            return {
              rootIdentity: `${rootStat.dev}:${rootStat.ino}`,
              checkoutIdentity: stat ? `${stat.dev}:${stat.ino}` : null,
              checkout: stat ? ("present" as const) : ("missing" as const),
              gitRegistered: registered,
              repository,
              repositoryIdentity: `${repositoryStat.dev}:${repositoryStat.ino}`,
              baseHead,
              branchHead,
              head,
              dirty,
              unmerged,
            };
          }),
        );
        if (inspection._tag === "Success") return { ...state, ...inspection.value };
        const failure = Cause.squash(inspection.cause);
        return {
          ...state,
          blockers: [
            Schema.is(AgentControlPlanValidationError)(failure)
              ? failure.detail
              : "Filesystem/Git inspection could not safely verify this workspace.",
          ],
        };
      });
    const read = (projectId: ProjectId, workspaceId: string, caller: ThreadId) =>
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
