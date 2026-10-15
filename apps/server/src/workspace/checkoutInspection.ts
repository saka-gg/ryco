import { lstatSync, type Stats } from "node:fs";
import { lstat, readdir, readFile, stat as statAsync } from "node:fs/promises";
import path from "node:path";

import { Data, Duration, Effect, Exit } from "effect";
import type {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  OrchestrationWorktreeShell,
  ProjectId,
  WorktreeId,
} from "@ryco/contracts";
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

/**
 * Git facts about a project's repository that every checkout's inspection
 * shares: read once per listing instead of once per workspace.
 */
export interface ProjectGitFacts {
  readonly projectId: ProjectId;
  readonly rootIdentity: string;
  readonly repository: string;
  readonly repositoryIdentity: string;
  readonly baseHead: string;
  /** `git worktree list --porcelain -z` records, one field array each. */
  readonly worktreeEntries: ReadonlyArray<ReadonlyArray<string>>;
  /** Local branch name to its commit. */
  readonly branchHeads: ReadonlyMap<string, string>;
  /**
   * Local branches with commits `baseHead` does not contain, read in one pass for listings
   * (see `withUnmergedBranches`); absent when each inspection counts its own branch.
   */
  readonly unmergedBranches?: ReadonlySet<string> | undefined;
}

/** Bound on directory entries visited while deciding ignored directories are empty. */
const IGNORED_DIRECTORY_SCAN_LIMIT = 4_096;

/**
 * Whether `directory` holds anything but (nested) empty directories. Files,
 * symlinks and unreadable directories count as content; null when the bound
 * runs out first (callers keep the entry protected).
 */
async function directoryHoldsContent(
  directory: string,
  budget: { remaining: number },
): Promise<boolean | null> {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      budget.remaining -= 1;
      if (budget.remaining < 0) return null;
      if (!entry.isDirectory()) return true;
      pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

/**
 * `--ignored=matching` lists an ignored directory even when it holds only
 * empty directories, which traditional mode never reported: nothing there can
 * be lost, so such entries are not protected content.
 */
export const dropEmptyIgnoredDirectories = (
  checkout: string,
  status: ParsedWorktreeStatus,
): Effect.Effect<ParsedWorktreeStatus> =>
  Effect.promise(async () => {
    if (!status.protectedIgnored.some((entry) => entry.endsWith("/"))) return status;
    const budget = { remaining: IGNORED_DIRECTORY_SCAN_LIMIT };
    const protectedIgnored: string[] = [];
    for (const entry of status.protectedIgnored) {
      if (
        entry.endsWith("/") &&
        (await directoryHoldsContent(path.join(checkout, entry), budget)) === false
      ) {
        continue;
      }
      protectedIgnored.push(entry);
    }
    return { ...status, protectedIgnored };
  });

/** Anything Git would refuse to discard, or ignored content that is not a known cache. */
export const checkoutHasBlockingChanges = (status: CheckoutStatus): boolean =>
  status.truncated ||
  status.modified > 0 ||
  status.untracked > 0 ||
  status.protectedIgnored.length > 0;

/**
 * Reuses a checkout's Git reads across listings. Each read has one slot
 * (`key`, e.g. the read kind and checkout) holding the run for the latest
 * `version` it was asked for: what the read depends on (a stat fingerprint
 * of the checkout's HEAD, index and directory plus its branch head). A run
 * is shared while in flight and kept for a short TTL so a reopened Projects
 * page or the lifecycle suggestions do not re-run every checkout's Git; a
 * new version replaces the slot, so superseded results are never retained.
 * Failures are never kept. Only read-only listings use it; preview and apply
 * always inspect from scratch.
 */
export interface CheckoutReadCache {
  readonly through: <A>(
    key: string,
    version: string,
    read: Effect.Effect<A, CheckoutInspectionError>,
  ) => Effect.Effect<A, CheckoutInspectionError>;
}

export const CHECKOUT_READ_TTL = Duration.seconds(30);
/** Commit ancestry never changes for a pair of commits; kept longer. */
const CHECKOUT_ANCESTRY_TTL = Duration.minutes(10);
const CHECKOUT_READ_CACHE_CAPACITY = 1_024;

export const makeCheckoutReadCache = (
  options: { readonly ttl?: Duration.Input; readonly capacity?: number } = {},
): CheckoutReadCache => {
  const ttl = options.ttl ?? CHECKOUT_READ_TTL;
  const capacity = options.capacity ?? CHECKOUT_READ_CACHE_CAPACITY;
  const slots = new Map<
    string,
    { readonly version: string; readonly run: Effect.Effect<unknown, CheckoutInspectionError> }
  >();
  return {
    through: <A>(key: string, version: string, read: Effect.Effect<A, CheckoutInspectionError>) =>
      Effect.suspend(() => {
        const slot = slots.get(key);
        slots.delete(key);
        const run =
          slot?.version === version
            ? (slot.run as Effect.Effect<A, CheckoutInspectionError>)
            : // Concurrent readers join one run; an abandoned (interrupted) run
              // and a failure are not kept.
              Effect.runSync(
                Effect.cachedWithTTL(read, (exit) => (Exit.isSuccess(exit) ? ttl : Duration.zero)),
              );
        slots.set(key, { version, run });
        for (const oldest of slots.keys()) {
          if (slots.size <= capacity) break;
          slots.delete(oldest);
        }
        return run;
      }),
  };
};

export interface CheckoutInspectionCaches {
  /** Per-checkout reads (HEAD, status, branch, common dir). */
  readonly reads: CheckoutReadCache;
  /** Whether a branch head has commits its base lacks. */
  readonly ancestry: CheckoutReadCache;
  /** Each linked checkout's git dir, by its `.git` link file (read once, then only stat'ed). */
  readonly gitDirs: Map<string, { readonly link: string; readonly gitDir: string }>;
}

export const makeCheckoutInspectionCaches = (): CheckoutInspectionCaches => ({
  reads: makeCheckoutReadCache(),
  ancestry: makeCheckoutReadCache({ ttl: CHECKOUT_ANCESTRY_TTL }),
  gitDirs: new Map(),
});

const statFingerprint = (stats: Pick<Stats, "ino" | "size" | "mtimeMs">): string =>
  `${stats.ino}:${stats.size}:${stats.mtimeMs}`;

const statFingerprintOf = (file: string): Promise<string> =>
  statAsync(file).then(statFingerprint, () => "-");

/**
 * What a checkout's Git reads depend on, from a few stats and no Git process:
 * the directory, its `.git` link, the worktree's HEAD and index, and the
 * branch head Git reported for this listing. Null when the layout is not one
 * this can vouch for (the reads then run uncached). Off the main thread: the
 * checkout may sit in a cloud-synced folder.
 */
export const checkoutReadFingerprint = (
  gitDirs: CheckoutInspectionCaches["gitDirs"],
  directory: string,
  directoryStat: Pick<Stats, "ino" | "mtimeMs">,
  branchHead: string | null,
): Effect.Effect<string | null> =>
  Effect.promise(async () => {
    const dotGit = path.join(directory, ".git");
    let link: Stats;
    try {
      link = await lstat(dotGit);
    } catch {
      return null;
    }
    const linkFingerprint = statFingerprint(link);
    let gitDir: string;
    if (link.isDirectory()) {
      gitDir = dotGit;
    } else if (link.isFile() && link.size <= 4_096) {
      const known = gitDirs.get(dotGit);
      if (known?.link === linkFingerprint) {
        gitDir = known.gitDir;
      } else {
        let text: string;
        try {
          text = await readFile(dotGit, "utf8");
        } catch {
          return null;
        }
        const match = /^gitdir:\s*(.+?)\s*$/mu.exec(text);
        if (!match?.[1]) return null;
        gitDir = path.resolve(directory, match[1]);
        gitDirs.delete(dotGit);
        gitDirs.set(dotGit, { link: linkFingerprint, gitDir });
        for (const oldest of gitDirs.keys()) {
          if (gitDirs.size <= CHECKOUT_READ_CACHE_CAPACITY) break;
          gitDirs.delete(oldest);
        }
      }
    } else {
      return null;
    }
    const [head, index] = await Promise.all([
      statFingerprintOf(path.join(gitDir, "HEAD")),
      statFingerprintOf(path.join(gitDir, "index")),
    ]);
    return [
      `${directoryStat.ino}:${directoryStat.mtimeMs}`,
      linkFingerprint,
      gitDir,
      head,
      index,
      branchHead ?? "",
    ].join("|");
  });

type InspectionDeps = {
  readonly policy: WorkspaceAccessPolicyShape;
  readonly git: GitVcsDriverShape;
};

const lstatFor = (candidate: string, detail: string) =>
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

/** Read-only, lock-free, bounded git for inspection; output over the bound fails. */
const inspectionGit =
  (git: GitVcsDriverShape, operation: string) =>
  (cwd: string, args: readonly string[], maxOutputBytes = 8192) =>
    git
      .execute({
        operation,
        cwd,
        args: ["-c", "core.fsmonitor=false", ...args],
        timeoutMs: 10_000,
        maxOutputBytes,
        readOnly: true,
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

const assertProjectRoot = (
  policy: WorkspaceAccessPolicyShape,
  project: { readonly workspaceRoot: string },
  operation: string,
) =>
  policy.assertExistingPath({ path: project.workspaceRoot, operation }).pipe(
    Effect.mapError(() => new CheckoutInspectionError({ detail: "Project root is unavailable." })),
    Effect.flatMap((root) =>
      samePath(root, project.workspaceRoot)
        ? Effect.succeed(root)
        : fail("Workspace path spelling or symlink changed."),
    ),
  );

/**
 * The project-level half of {@link inspectCheckout}: repository metadata, the
 * root's HEAD, Git's worktree registrations and every local branch head.
 * Listing many checkouts computes it once and passes it to each inspection.
 */
export const inspectProjectGitFacts = (
  deps: InspectionDeps,
  input: {
    readonly project: { readonly id: ProjectId; readonly workspaceRoot: string };
    readonly operation: string;
    /**
     * Also read which local branches `baseHead` does not contain, in one `for-each-ref`,
     * instead of one `rev-list` per diverged branch: for listings of many checkouts.
     */
    readonly withUnmergedBranches?: boolean | undefined;
  },
): Effect.Effect<ProjectGitFacts, CheckoutInspectionError> =>
  Effect.gen(function* () {
    const { policy, git } = deps;
    const { project, operation } = input;
    const root = yield* assertProjectRoot(policy, project, operation);
    const run = inspectionGit(git, operation);
    const rootStat = yield* lstatFor(root, "Project path inspection failed.");
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
    const repositoryStat = yield* lstatFor(repository, "Git metadata inspection failed.");
    if (!repositoryStat || repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory())
      return yield* fail("Git metadata must be a plain directory.");
    const baseHead = yield* run(root, ["rev-parse", "--verify", "HEAD"]);
    const listing = yield* run(root, ["worktree", "list", "--porcelain", "-z"], 256 * 1024);
    const heads = yield* run(
      root,
      ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"],
      4 * 1024 * 1024,
    );
    const branchHeads = new Map<string, string>();
    for (const line of heads.split("\n")) {
      const [refname, objectname] = line.split("\0");
      if (refname?.startsWith("refs/heads/") && objectname)
        branchHeads.set(refname.slice("refs/heads/".length), objectname);
    }
    const unmergedBranches = input.withUnmergedBranches
      ? new Set(
          (yield* run(
            root,
            ["for-each-ref", `--no-merged=${baseHead}`, "--format=%(refname)", "refs/heads"],
            4 * 1024 * 1024,
          ))
            .split("\n")
            .flatMap((refname) =>
              refname.startsWith("refs/heads/") ? [refname.slice("refs/heads/".length)] : [],
            ),
        )
      : undefined;
    return {
      projectId: project.id,
      rootIdentity: `${rootStat.dev}:${rootStat.ino}`,
      repository,
      repositoryIdentity: `${repositoryStat.dev}:${repositoryStat.ino}`,
      baseHead,
      worktreeEntries: listing.split("\0\0").map((entry) => entry.split("\0")),
      branchHeads,
      ...(unmergedBranches ? { unmergedBranches } : {}),
    } satisfies ProjectGitFacts;
  });

/**
 * Read-only Git/filesystem facts for one checkout. Shared by the human workspace
 * lifecycle service and Agent Control preflight so both apply the same rules:
 * exact path spelling, no symlinks, no overlap with other projects or checkouts,
 * no locked registration, and the branch must match its record.
 */
export const inspectCheckout = (
  deps: InspectionDeps,
  input: {
    /** Every live project, thread placement and workspace, for the overlap checks. */
    readonly snapshot: {
      readonly projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "workspaceRoot">>;
      readonly threads: ReadonlyArray<Pick<OrchestrationThreadShell, "projectId" | "worktreePath">>;
      readonly worktrees?:
        | ReadonlyArray<
            Pick<OrchestrationWorktreeShell, "worktreeId" | "worktreePath" | "checkoutRemovedAt">
          >
        | undefined;
    };
    readonly project: { readonly id: ProjectId; readonly workspaceRoot: string };
    readonly directory: string;
    readonly rowWorktreeId: WorktreeId | null;
    readonly branch: string | null;
    readonly operation: string;
    /** Precomputed for this project by {@link inspectProjectGitFacts}; read fresh when absent. */
    readonly projectFacts?: ProjectGitFacts | undefined;
    /** Read-only listings reuse recent Git reads; absent means every read runs. */
    readonly caches?: CheckoutInspectionCaches | undefined;
  },
): Effect.Effect<CheckoutFacts, CheckoutInspectionError> =>
  Effect.gen(function* () {
    const { policy, git } = deps;
    const { snapshot, project, directory, operation } = input;
    yield* assertProjectRoot(policy, project, operation);
    const authorized = yield* policy
      .assertPath({ path: directory, operation })
      .pipe(
        Effect.mapError(
          () =>
            new CheckoutInspectionError({ detail: "Checkout path is outside the allowed roots." }),
        ),
      );
    if (!samePath(authorized, directory))
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
    const stat = yield* lstatFor(directory, "Path inspection failed.");
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory()))
      return yield* fail("Checkout is not a plain directory.");
    const run = inspectionGit(git, operation);
    const projectFacts =
      input.projectFacts?.projectId === project.id
        ? input.projectFacts
        : yield* inspectProjectGitFacts(deps, { project, operation });
    const { repository, baseHead } = projectFacts;
    const entries = projectFacts.worktreeEntries;
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
      input.branch === null ? null : (projectFacts.branchHeads.get(input.branch) ?? null);
    const fingerprint =
      input.caches && stat && registered
        ? yield* checkoutReadFingerprint(input.caches.gitDirs, directory, stat, branchHead)
        : null;
    const reads = input.caches?.reads;
    const cachedRead = <A>(kind: string, read: Effect.Effect<A, CheckoutInspectionError>) =>
      reads && fingerprint !== null
        ? reads.through(`${kind}\u0000${directory}`, fingerprint, read)
        : read;
    const head =
      stat && registered
        ? yield* cachedRead("head", run(directory, ["rev-parse", "--verify", "HEAD"]))
        : null;
    const status: CheckoutStatus | null =
      stat && registered
        ? yield* cachedRead(
            "status",
            git
              .execute({
                operation,
                cwd: directory,
                // Matching ignored mode reports a directory an ignore pattern matches
                // (node_modules/, dist/) as one entry without descending into it, an
                // order of magnitude faster than traditional mode on large ignored
                // trees. Every ignored entry is classified; unknown ignored content
                // (credentials, databases, outputs) stays protected, and directories
                // holding only empty directories (which traditional mode never listed)
                // are dropped.
                args: [
                  "-c",
                  "core.fsmonitor=false",
                  "status",
                  "--porcelain=v1",
                  "-z",
                  "--untracked-files=normal",
                  "--ignored=matching",
                ],
                timeoutMs: 10_000,
                maxOutputBytes: 256 * 1024,
                truncateOutputAtMaxBytes: true,
                readOnly: true,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new CheckoutInspectionError({ detail: `Git status failed: ${cause.message}` }),
                ),
                Effect.flatMap((result) =>
                  dropEmptyIgnoredDirectories(directory, parseWorktreeStatus(result.stdout)).pipe(
                    Effect.map((parsed): CheckoutStatus =>
                      Object.assign(parsed, {
                        truncated: result.stdoutTruncated || result.stderrTruncated,
                      }),
                    ),
                  ),
                ),
              ),
          )
        : null;
    const countUnmerged = (head: string) =>
      run(project.workspaceRoot, ["rev-list", "--count", `${baseHead}..${head}`]).pipe(
        Effect.map((count) => count !== "0"),
      );
    const unmerged = branchHead
      ? branchHead !== baseHead &&
        (projectFacts.unmergedBranches
          ? input.branch !== null && projectFacts.unmergedBranches.has(input.branch)
          : yield* input.caches
              ? input.caches.ancestry.through(
                  `${repository}\u0000${input.branch ?? ""}`,
                  `${baseHead}..${branchHead}`,
                  countUnmerged(branchHead),
                )
              : countUnmerged(branchHead))
      : null;
    if (stat && registered && input.branch !== null) {
      if (!checkoutEntry?.includes(`branch refs/heads/${input.branch}`))
        return yield* fail("Registered branch differs from the checkout branch.");
      if (
        (yield* cachedRead("symbolic-ref", run(directory, ["symbolic-ref", "--quiet", "HEAD"]))) !==
        `refs/heads/${input.branch}`
      )
        return yield* fail("Checkout branch changed.");
      const actualRepo = yield* cachedRead(
        "common-dir",
        run(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      );
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
      rootIdentity: projectFacts.rootIdentity,
      checkoutIdentity: stat ? `${stat.dev}:${stat.ino}` : null,
      checkout: stat ? ("present" as const) : ("missing" as const),
      gitRegistered: registered,
      repository,
      repositoryIdentity: projectFacts.repositoryIdentity,
      baseHead,
      branchHead,
      head,
      status,
      unmerged,
    };
  });
