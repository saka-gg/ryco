import { lstatSync } from "node:fs";
import path from "node:path";

import { Data, Effect } from "effect";
import type { OrchestrationShellSnapshot, ProjectId, WorktreeId } from "@ryco/contracts";
import { parseWorktreeStatus, type ParsedWorktreeStatus } from "@ryco/shared/workspaceLifecycle";

import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import type { WorkspaceAccessPolicyShape } from "./Services/WorkspaceAccessPolicy.ts";

/** A checkout could not be inspected safely. The detail is user-facing. */
export class CheckoutInspectionError extends Data.TaggedError("CheckoutInspectionError")<{
  readonly detail: string;
}> {}

const fail = (detail: string) => Effect.fail(new CheckoutInspectionError({ detail }));

const normalized = (value: string) => {
  const result = path.resolve(value).replace(/[\\/]+$/g, "");
  return process.platform === "darwin" || process.platform === "win32"
    ? result.toLowerCase()
    : result;
};
export const samePath = (a: string, b: string) => normalized(a) === normalized(b);
export const containsPath = (a: string, b: string) =>
  samePath(a, b) || normalized(b).startsWith(normalized(a) + path.sep);

export interface CheckoutStatus extends ParsedWorktreeStatus {
  /** Output exceeded its bound: treated as blocking, never as clean. */
  readonly truncated: boolean;
}

export interface CheckoutFacts {
  readonly rootIdentity: string;
  readonly checkoutIdentity: string | null;
  readonly checkout: "present" | "missing";
  readonly gitRegistered: boolean;
  readonly repository: string;
  readonly repositoryIdentity: string;
  readonly baseHead: string;
  readonly branchHead: string | null;
  readonly head: string | null;
  readonly status: CheckoutStatus | null;
  readonly unmerged: boolean | null;
}

/** Anything Git would refuse to discard, or ignored content that is not a known cache. */
export const checkoutHasBlockingChanges = (status: CheckoutStatus): boolean =>
  status.truncated ||
  status.modified > 0 ||
  status.untracked > 0 ||
  status.protectedIgnored.length > 0;

/**
 * Read-only Git/filesystem facts for one checkout. Shared by the human workspace
 * lifecycle service and Agent Control preflight so both apply the same rules:
 * exact path spelling, no symlinks, no overlap with other projects or checkouts,
 * no locked registration, and the branch must match its record.
 */
export const inspectCheckout = (
  deps: { readonly policy: WorkspaceAccessPolicyShape; readonly git: GitVcsDriverShape },
  input: {
    readonly snapshot: Pick<OrchestrationShellSnapshot, "projects" | "threads" | "worktrees">;
    readonly project: { readonly id: ProjectId; readonly workspaceRoot: string };
    readonly directory: string;
    readonly rowWorktreeId: WorktreeId | null;
    readonly branch: string | null;
    readonly operation: string;
  },
): Effect.Effect<CheckoutFacts, CheckoutInspectionError> =>
  Effect.gen(function* () {
    const { policy, git } = deps;
    const { snapshot, project, directory, operation } = input;
    const root = yield* policy
      .assertExistingPath({ path: project.workspaceRoot, operation })
      .pipe(
        Effect.mapError(
          () => new CheckoutInspectionError({ detail: "Project root is unavailable." }),
        ),
      );
    const authorized = yield* policy
      .assertPath({ path: directory, operation })
      .pipe(
        Effect.mapError(
          () =>
            new CheckoutInspectionError({ detail: "Checkout path is outside the allowed roots." }),
        ),
      );
    if (!samePath(root, project.workspaceRoot) || !samePath(authorized, directory))
      return yield* fail("Workspace path spelling or symlink changed.");
    for (const other of snapshot.projects)
      if (
        other.id !== project.id &&
        (containsPath(directory, other.workspaceRoot) ||
          containsPath(other.workspaceRoot, directory))
      )
        return yield* fail("Workspace overlaps another project.");
    for (const other of snapshot.threads)
      if (
        other.projectId !== project.id &&
        other.worktreePath !== null &&
        (containsPath(directory, other.worktreePath) || containsPath(other.worktreePath, directory))
      )
        return yield* fail("Workspace overlaps sessions in another project.");
    for (const other of snapshot.worktrees ?? [])
      if (
        other.worktreeId !== input.rowWorktreeId &&
        other.worktreePath !== null &&
        other.checkoutRemovedAt == null &&
        (containsPath(directory, other.worktreePath) || containsPath(other.worktreePath, directory))
      )
        return yield* fail("Workspace overlaps another registered workspace.");
    const lstat = (candidate: string, detail: string) =>
      Effect.try({
        try: () => {
          try {
            return lstatSync(candidate);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw e;
          }
        },
        catch: () => new CheckoutInspectionError({ detail }),
      });
    const stat = yield* lstat(directory, "Path inspection failed.");
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory()))
      return yield* fail("Checkout is not a plain directory.");
    const run = (cwd: string, args: readonly string[], maxOutputBytes = 8192) =>
      git
        .execute({
          operation,
          cwd,
          args: ["-c", "core.fsmonitor=false", ...args],
          timeoutMs: 10_000,
          maxOutputBytes,
          env: { GIT_OPTIONAL_LOCKS: "0" },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CheckoutInspectionError({ detail: `Git inspection failed: ${cause.message}` }),
          ),
          Effect.flatMap((r) =>
            r.stdoutTruncated || r.stderrTruncated
              ? fail("Git inspection exceeded its bounded output limit.")
              : Effect.succeed(r.stdout.replace(/\r?\n$/, "")),
          ),
        );
    const rootStat = yield* lstat(root, "Project path inspection failed.");
    if (!rootStat) return yield* fail("Project root is missing.");
    const repository = yield* run(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    yield* policy
      .assertExistingPath({ path: repository, operation })
      .pipe(
        Effect.mapError(
          () => new CheckoutInspectionError({ detail: "Git metadata is unavailable." }),
        ),
      );
    const repositoryStat = yield* lstat(repository, "Git metadata inspection failed.");
    if (!repositoryStat || repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory())
      return yield* fail("Git metadata must be a plain directory.");
    const baseHead = yield* run(root, ["rev-parse", "--verify", "HEAD"]);
    const listing = yield* run(root, ["worktree", "list", "--porcelain", "-z"], 256 * 1024);
    const entries = listing.split("\0\0").map((entry) => entry.split("\0"));
    const isEntryFor = (entry: readonly string[], candidate: string) =>
      entry.some((f) => f.startsWith("worktree ") && samePath(f.slice(9), candidate));
    if (
      entries.some((entry) =>
        entry.some(
          (f) =>
            f.startsWith("worktree ") &&
            !samePath(f.slice(9), directory) &&
            containsPath(directory, f.slice(9)),
        ),
      )
    )
      return yield* fail("Workspace contains another Git checkout.");
    const checkoutEntry = entries.find((entry) => isEntryFor(entry, directory));
    const registered = checkoutEntry !== undefined;
    if (checkoutEntry?.some((f) => f.startsWith("locked")))
      return yield* fail("The worktree is locked in Git.");
    const branchHead =
      input.branch === null
        ? null
        : yield* run(root, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `refs/heads/${input.branch}`,
          ]).pipe(Effect.catch(() => Effect.succeed(null)));
    const head =
      stat && registered ? yield* run(directory, ["rev-parse", "--verify", "HEAD"]) : null;
    const status: CheckoutStatus | null =
      stat && registered
        ? yield* git
            .execute({
              operation,
              cwd: directory,
              // Traditional ignored mode collapses ignored directories, so a cache such as
              // node_modules/ is one entry. Every ignored entry is classified; unknown
              // ignored content (credentials, databases, outputs) stays protected.
              args: [
                "-c",
                "core.fsmonitor=false",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
                "--ignored=traditional",
              ],
              timeoutMs: 10_000,
              maxOutputBytes: 256 * 1024,
              truncateOutputAtMaxBytes: true,
              env: { GIT_OPTIONAL_LOCKS: "0" },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new CheckoutInspectionError({ detail: `Git status failed: ${cause.message}` }),
              ),
              Effect.map((result): CheckoutStatus =>
                Object.assign(parseWorktreeStatus(result.stdout), {
                  truncated: result.stdoutTruncated || result.stderrTruncated,
                }),
              ),
            )
        : null;
    const unmerged = branchHead
      ? (yield* run(root, ["rev-list", "--count", `${baseHead}..${branchHead}`])) !== "0"
      : null;
    if (stat && registered && input.branch !== null) {
      if (!checkoutEntry?.includes(`branch refs/heads/${input.branch}`))
        return yield* fail("Registered branch differs from the checkout branch.");
      if (
        (yield* run(directory, ["symbolic-ref", "--quiet", "HEAD"])) !==
        `refs/heads/${input.branch}`
      )
        return yield* fail("Checkout branch changed.");
      const actualRepo = yield* run(directory, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      if (!samePath(actualRepo, repository) || head !== branchHead)
        return yield* fail("Checkout repository or branch does not match its registration.");
    }
    if (
      input.branch !== null &&
      entries.some(
        (entry) =>
          entry.includes(`branch refs/heads/${input.branch}`) && !isEntryFor(entry, directory),
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
      status,
      unmerged,
    };
  });
