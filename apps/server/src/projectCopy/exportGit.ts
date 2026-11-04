/**
 * The git side of a cross-node project export (ProjectExportLive): what the source repository
 * is, what its clone remote already has, what the working tree holds, and the artifacts built
 * from it (commits bundle, repository bundle, changes patch).
 *
 * Artifact bytes never pass through JS strings: `git bundle create <file>` and `git diff
 * --output=<file>` write them, and callers size and hash the files. Every git process runs
 * non-interactively in the C locale with an explicit timeout, and none of them writes to the
 * checkout's index, its object store or its refs: the patch is built in a temporary index with a
 * temporary object directory that borrows the repository's objects as an alternate.
 *
 * @module exportGit
 */
import * as fsp from "node:fs/promises";
import nodePath from "node:path";

import {
  PROJECT_COPY_MAX_IGNORED_FILE_BYTES,
  PROJECT_EXPORT_INSECURE_CHANNEL_REASON,
  ProjectCopyError,
  ProjectCopyRelativePath,
  type ProjectExportPushedState,
  type ProjectExportSkippedArtifact,
} from "@ryco/contracts/project-copy";
import { pickCloneRemoteName } from "@ryco/shared/gitRemoteUrl";
import { Effect, Schema } from "effect";
import type { FileSystem, Path } from "effect";

import {
  parseRemoteFetchUrls,
  pickPrimaryRemote,
  remoteNamed,
} from "../project/gitRemoteListing.ts";
import { seedIndexFromCheckout } from "../vcs/GitTemporaryIndex.ts";
import { NO_FSMONITOR_CONFIG_ARGS, SCRATCH_INDEX_CONFIG_ARGS } from "../vcs/GitDurableWrites.ts";
import { BINARY_PATCH_DIFF_ARGS } from "../vcs/GitVcsDriver.ts";
import { GIT_LFS_FILTER_OFF_ARGS } from "./gitProcess.ts";
import type { GitNetworkShape } from "./Services/GitNetwork.ts";

/** Bundles, the patch's `add` and `diff`: long, but never unbounded. */
export const EXPORT_STEP_TIMEOUT_MS = 10 * 60 * 1000;
/** Reads of refs, config and the index. */
const EXPORT_READ_TIMEOUT_MS = 60 * 1000;
/** `ls-remote` of the clone remote (amendment 9). */
const EXPORT_LS_REMOTE_TIMEOUT_MS = 30 * 1000;
/** Size estimates are best effort: past this they report 0 instead of holding up `inspect`. */
const EXPORT_ESTIMATE_TIMEOUT_MS = 30 * 1000;
/** Status and listings of large working trees; past this the export reports "over limit". */
const EXPORT_LISTING_MAX_BYTES = 64 * 1024 * 1024;
/** Ignored files offered for the opt-in; the export accepts at most 32 of them. */
const IGNORED_CANDIDATES_MAX = 100;
/** Paths listed per kind of content a patch leaves out (nested repositories, submodules, LFS). */
const SKIPPED_PATHS_MAX = 20;
const LSTAT_BATCH = 64;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Why an artifact was not built, or what a built patch leaves out. */
export const PROJECT_EXPORT_SKIP_REASON = {
  notGitRepository: "not a git repository",
  noCommits: "Repository has no commits yet",
  noRemote: "no remote",
  nothingUnpushed: "nothing unpushed",
  shallow: "shallow repository",
  conflicts: "conflicts",
  sparseCheckout: "sparse checkout",
  noChanges: "no changes",
  overLimit: "over limit",
  insecureChannel: PROJECT_EXPORT_INSECURE_CHANNEL_REASON,
  noCustomAvatar: "no custom avatar",
} as const;

/** Prefixes of the per-path `skipped` entries of a built patch. */
export const PROJECT_EXPORT_SKIPPED_PATH_PREFIX = {
  nestedRepository: "nested repository: ",
  submodule: "submodule: ",
  lfs: "lfs: ",
} as const;

/**
 * `-c` options of every export git command that reads the working tree, which builds its patch in
 * a scratch index: none of the user's hooks, no split index, no fsmonitor daemon, and no LFS
 * filter. LFS paths never enter the patch, so git-lfs never needs to run (and a
 * configured-but-missing git-lfs with `required=true` cannot fail the export).
 */
const EXPORT_GIT_CONFIG_ARGS: ReadonlyArray<string> = [
  ...SCRATCH_INDEX_CONFIG_ARGS,
  ...NO_FSMONITOR_CONFIG_ARGS,
  ...GIT_LFS_FILTER_OFF_ARGS,
];

export interface ExportGitCommand {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
  /** No optional locks: a read never rewrites the checkout's index. */
  readonly readOnly?: boolean;
}

export interface ExportGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
}

/** Runs one git command in the export's environment; failures are already `ProjectCopyError`s. */
export type ExportGit = (
  command: ExportGitCommand,
) => Effect.Effect<ExportGitResult, ProjectCopyError>;

/** Bounded, never empty: what `ProjectCopyError.message` accepts. */
export const projectCopyError = (code: ProjectCopyError["code"], message: string) => {
  const trimmed = message.trim();
  const bounded = trimmed.length > 2_000 ? `${trimmed.slice(0, 1_997).trimEnd()}...` : trimmed;
  return new ProjectCopyError({ code, message: bounded.length > 0 ? bounded : code });
};

/** A file-system step of the export; a failure is an `internal` `ProjectCopyError`. */
export const projectCopyIo = <A>(operation: string, action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) =>
      projectCopyError(
        "internal",
        `${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });

const lstatOrNull = (filePath: string) => fsp.lstat(filePath).catch(() => null);

// ── Repository facts ──────────────────────────────────────────────────

export interface ExportRemote {
  readonly remoteName: string;
  /** As configured (credentials included); only `ls-remote` sees it, never a result. */
  readonly remoteUrl: string;
}

export interface ExportRepositoryFacts {
  /** The repository's top level as git resolves it; every git command runs here. */
  readonly repositoryRoot: string;
  /** The top level as the project's own path spells it (no resolved symlinks), for display. */
  readonly displayRoot: string;
  /** `""` or the project's subfolder, slash-separated. */
  readonly relativeRoot: string;
  readonly commonDir: string;
  readonly objectsDir: string;
  readonly isShallow: boolean;
  readonly branch: string | null;
  readonly headOid: string | null;
  /** Fetch URLs by remote name, as configured. */
  readonly remotes: ReadonlyMap<string, string>;
  /** Where the repository's identity (its canonical key) comes from: `upstream` first. */
  readonly identityRemote: ExportRemote | null;
  /**
   * What the copy clones from, and what the pushed state is measured against: the project's
   * preferred remote, else `origin`, else the identity remote (`pickCloneRemoteName`).
   */
  readonly cloneRemote: ExportRemote | null;
  readonly hasSubmodules: boolean;
  readonly usesLfs: boolean;
}

const NOT_A_REPOSITORY = /not a git repository|must be run in a work tree/i;

/** The top level as `checkoutPath` spells it, when the project lives `relativeRoot` below it. */
const displayRootOf = (checkoutPath: string, relativeRoot: string, repositoryRoot: string) => {
  const resolved = nodePath.resolve(checkoutPath);
  if (relativeRoot === "") return resolved;
  const suffix = `${nodePath.sep}${relativeRoot.split("/").join(nodePath.sep)}`;
  return resolved.endsWith(suffix) ? resolved.slice(0, -suffix.length) : repositoryRoot;
};

const readUsesLfs = (repositoryRoot: string, commonDir: string) =>
  Effect.promise(async () => {
    const attributes = nodePath.join(repositoryRoot, ".gitattributes");
    const info = await lstatOrNull(attributes);
    if (info?.isFile() && info.size <= 1024 * 1024) {
      const text = await fsp.readFile(attributes, "utf8").catch(() => "");
      if (/\bfilter=lfs\b/.test(text)) return true;
    }
    return (await lstatOrNull(nodePath.join(commonDir, "lfs")))?.isDirectory() === true;
  });

/**
 * What git says about the checkout; null when it is not inside a git working tree. The project's
 * preferred remote picks the clone remote when the checkout has it.
 */
export const readRepositoryFacts = (
  git: ExportGit,
  checkoutPath: string,
  preferredRemoteName: string | null,
) =>
  Effect.gen(function* () {
    const operation = "ProjectExport.readRepository";
    const probe = yield* git({
      operation,
      cwd: checkoutPath,
      args: [
        "rev-parse",
        "--is-inside-work-tree",
        "--is-shallow-repository",
        "--show-toplevel",
        "--show-prefix",
        "--path-format=absolute",
        "--git-common-dir",
        "--git-path",
        "objects",
      ],
      allowNonZeroExit: true,
      readOnly: true,
      timeoutMs: EXPORT_READ_TIMEOUT_MS,
    });
    if (probe.exitCode !== 0) {
      if (NOT_A_REPOSITORY.test(probe.stderr)) return null;
      return yield* projectCopyError(
        "internal",
        `git could not read the repository: ${probe.stderr || `exit code ${probe.exitCode}`}`,
      );
    }
    const lines = probe.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
    if (lines[0] !== "true") return null;
    const [, shallow, repositoryRoot = "", prefix = "", commonDir = "", objectsDir = ""] = lines;
    if (
      lines.length !== 6 ||
      ![repositoryRoot, commonDir, objectsDir].every((value) => nodePath.isAbsolute(value))
    ) {
      return yield* projectCopyError("invalid", "This repository's path is not supported.");
    }
    const relativeRoot = prefix.replace(/\/$/, "");

    const [head, symbolic, remoteListing, hasSubmodules, usesLfs] = yield* Effect.all(
      [
        git({
          operation,
          cwd: repositoryRoot,
          args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
          allowNonZeroExit: true,
          readOnly: true,
          timeoutMs: EXPORT_READ_TIMEOUT_MS,
        }),
        git({
          operation,
          cwd: repositoryRoot,
          args: ["symbolic-ref", "--quiet", "HEAD"],
          allowNonZeroExit: true,
          readOnly: true,
          timeoutMs: EXPORT_READ_TIMEOUT_MS,
        }),
        git({
          operation,
          cwd: repositoryRoot,
          args: ["remote", "-v"],
          readOnly: true,
          timeoutMs: EXPORT_READ_TIMEOUT_MS,
        }),
        Effect.promise(
          async () =>
            (await lstatOrNull(nodePath.join(repositoryRoot, ".gitmodules")))?.isFile() === true,
        ),
        readUsesLfs(repositoryRoot, commonDir),
      ],
      { concurrency: "unbounded" },
    );
    const headOid = head.exitCode === 0 ? head.stdout.trim() : "";
    const symbolicRef = symbolic.exitCode === 0 ? symbolic.stdout.trim() : "";
    const remotes = parseRemoteFetchUrls(remoteListing.stdout);
    return {
      repositoryRoot,
      displayRoot: displayRootOf(checkoutPath, relativeRoot, repositoryRoot),
      relativeRoot,
      commonDir,
      objectsDir,
      isShallow: shallow === "true",
      branch: symbolicRef.startsWith("refs/heads/")
        ? symbolicRef.slice("refs/heads/".length)
        : null,
      headOid: OBJECT_ID.test(headOid) ? headOid : null,
      remotes,
      identityRemote: pickPrimaryRemote(remotes),
      cloneRemote: remoteNamed(
        remotes,
        pickCloneRemoteName({ remoteNames: [...remotes.keys()], preferredRemoteName }),
      ),
      hasSubmodules,
      usesLfs,
    } satisfies ExportRepositoryFacts;
  });

// ── Pushed state (amendment 9) ────────────────────────────────────────

/** What the commits bundle and the unpushed count exclude: what the clone source already has. */
export type ExportExclusion =
  /** Commits the clone remote advertises (`ls-remote`) that exist here. */
  | { readonly kind: "advertised"; readonly oids: ReadonlyArray<string> }
  /** `ls-remote` failed: the clone remote's tracking refs stand in. */
  | { readonly kind: "remote-tracking"; readonly remoteName: string }
  /** No remote: nothing is excluded. */
  | { readonly kind: "none" };

export interface ExportPushedState {
  readonly state: ProjectExportPushedState;
  /** Null for an unborn HEAD. */
  readonly exclusion: ExportExclusion | null;
}

/** `rev-list`-style arguments and stdin for "HEAD, minus what the clone source has". */
const headMinus = (exclusion: ExportExclusion) => {
  switch (exclusion.kind) {
    case "advertised":
      // Through stdin: a repository with thousands of tags would overflow a command line.
      return {
        args: ["--stdin"],
        stdin: `HEAD\n${exclusion.oids.map((oid) => `^${oid}\n`).join("")}`,
      };
    case "remote-tracking":
      return { args: ["HEAD", "--not", `--remotes=${exclusion.remoteName}`] };
    case "none":
      return { args: ["HEAD"] };
  }
};

/** The advertised oids this repository has as commits (peeled tags are advertised too). */
const localCommits = (git: ExportGit, cwd: string, oids: ReadonlyArray<string>) =>
  oids.length === 0
    ? Effect.succeed<ReadonlyArray<string>>([])
    : git({
        operation: "ProjectExport.localCommits",
        cwd,
        args: ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        stdin: `${oids.join("\n")}\n`,
        readOnly: true,
        timeoutMs: EXPORT_READ_TIMEOUT_MS,
        maxOutputBytes: EXPORT_LISTING_MAX_BYTES,
      }).pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .map((line) => line.trim().split(" "))
            .filter(([oid, type]) => type === "commit" && OBJECT_ID.test(oid ?? ""))
            .map(([oid]) => oid!),
        ),
      );

const countCommits = (git: ExportGit, cwd: string, exclusion: ExportExclusion) => {
  const range = headMinus(exclusion);
  return git({
    operation: "ProjectExport.countUnpushed",
    cwd,
    args: ["rev-list", "--count", ...range.args],
    ...(range.stdin === undefined ? {} : { stdin: range.stdin }),
    readOnly: true,
    timeoutMs: EXPORT_READ_TIMEOUT_MS,
  }).pipe(
    Effect.flatMap((result) => {
      const count = Number.parseInt(result.stdout.trim(), 10);
      return Number.isSafeInteger(count) && count >= 0
        ? Effect.succeed(count)
        : Effect.fail(projectCopyError("internal", "git could not count the unpushed commits."));
    }),
  );
};

/**
 * Measured against the clone remote itself (`ls-remote`), not its tracking refs: those can be
 * stale, and commits that exist only on another remote (the fork's upstream, a mirror) are not
 * on the clone source. When `ls-remote` fails, the clone remote's tracking refs stand in.
 */
export const readPushedState = (
  git: ExportGit,
  network: Pick<GitNetworkShape, "lsRemote">,
  facts: ExportRepositoryFacts,
) =>
  Effect.gen(function* () {
    const cwd = facts.repositoryRoot;
    if (facts.headOid === null) {
      return {
        state: { headOnRemote: false, upstreamBranch: null, unpushedCommitCount: 0 },
        exclusion: null,
      } satisfies ExportPushedState;
    }
    if (facts.cloneRemote === null) {
      const exclusion: ExportExclusion = { kind: "none" };
      return {
        state: {
          headOnRemote: false,
          upstreamBranch: null,
          unpushedCommitCount: yield* countCommits(git, cwd, exclusion),
        },
        exclusion,
      } satisfies ExportPushedState;
    }
    const cloneRemote = facts.cloneRemote;
    const advertised = yield* network
      .lsRemote({
        remoteUrl: cloneRemote.remoteUrl,
        // The repository's own configured remote: a `file://` or local path is fine here.
        allowLocalRemote: true,
        heads: true,
        tags: true,
        timeoutMs: EXPORT_LS_REMOTE_TIMEOUT_MS,
        // In the checkout, so its own config applies as when the user fetches: a per-repository
        // or `includeIf "gitdir:"` `core.sshCommand`, `url.*.insteadOf`, credential helpers, and
        // a relative remote path.
        cwd,
      })
      .pipe(
        Effect.map((refs) => ({ ok: true as const, refs })),
        // The tracking refs then stand in, and they can be stale: what gets copied may change.
        Effect.catch((error) =>
          Effect.logWarning("project export: ls-remote of the clone remote failed", {
            reason: error.reason,
          }).pipe(Effect.as({ ok: false as const })),
        ),
      );

    let exclusion: ExportExclusion;
    let upstreamBranch: string | null = null;
    if (advertised.ok) {
      const oids = [...new Set(advertised.refs.map((ref) => ref.oid))];
      exclusion = { kind: "advertised", oids: yield* localCommits(git, cwd, oids) };
      if (
        facts.branch !== null &&
        advertised.refs.some((ref) => ref.ref === `refs/heads/${facts.branch}`)
      ) {
        upstreamBranch = `${cloneRemote.remoteName}/${facts.branch}`;
      }
    } else {
      exclusion = { kind: "remote-tracking", remoteName: cloneRemote.remoteName };
      if (facts.branch !== null) {
        const tracking = yield* git({
          operation: "ProjectExport.trackingBranch",
          cwd,
          args: [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            `refs/remotes/${cloneRemote.remoteName}/${facts.branch}`,
          ],
          allowNonZeroExit: true,
          readOnly: true,
          timeoutMs: EXPORT_READ_TIMEOUT_MS,
        });
        if (tracking.exitCode === 0) upstreamBranch = `${cloneRemote.remoteName}/${facts.branch}`;
      }
    }
    const unpushedCommitCount = yield* countCommits(git, cwd, exclusion);
    return {
      state: { headOnRemote: unpushedCommitCount === 0, upstreamBranch, unpushedCommitCount },
      exclusion,
    } satisfies ExportPushedState;
  });

// ── Working tree ──────────────────────────────────────────────────────

export interface ExportWorkingTreeScan {
  /** Tracked paths with staged or unstaged changes (conflicts included). */
  readonly trackedChanged: ReadonlyArray<string>;
  /** Untracked, not ignored files. */
  readonly untrackedFiles: ReadonlyArray<string>;
  /** Untracked directories holding their own repository (no trailing slash). */
  readonly nestedRepositories: ReadonlyArray<string>;
  /** Ignored files named like `.env*` or `*.local`, outside ignored directories. */
  readonly ignoredCandidateNames: ReadonlyArray<string>;
  readonly hasConflicts: boolean;
  /** The listing hit its size limit; counts are then lower bounds. */
  readonly truncated: boolean;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const isIgnoredCandidateName = (filePath: string) => {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  return name.startsWith(".env") || name.endsWith(".local");
};

/**
 * One `git status` for tracked changes, untracked files and the ignored files a copy may carry
 * on request. `--ignored=matching` lists an ignored directory (`node_modules/`) without
 * entering it.
 */
export const scanWorkingTree = (git: ExportGit, facts: ExportRepositoryFacts) =>
  git({
    operation: "ProjectExport.status",
    cwd: facts.repositoryRoot,
    args: [
      ...EXPORT_GIT_CONFIG_ARGS,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--no-renames",
      // A submodule's moved commit counts; walking each submodule's own working tree does not.
      "--ignore-submodules=dirty",
    ],
    readOnly: true,
    timeoutMs: EXPORT_STEP_TIMEOUT_MS,
    maxOutputBytes: EXPORT_LISTING_MAX_BYTES,
    truncateOutputAtMaxBytes: true,
  }).pipe(
    Effect.map((result): ExportWorkingTreeScan => {
      const trackedChanged: string[] = [];
      const untrackedFiles: string[] = [];
      const nestedRepositories: string[] = [];
      const ignoredCandidateNames: string[] = [];
      let hasConflicts = false;
      const records = result.stdout.split("\0");
      // A cut listing ends in a partial record.
      if (result.stdoutTruncated) records.pop();
      for (const record of records) {
        if (record.length < 4) continue;
        const code = record.slice(0, 2);
        const filePath = record.slice(3);
        if (code === "??") {
          // `--untracked-files=all` lists files; only an embedded repository stays a directory.
          if (filePath.endsWith("/")) nestedRepositories.push(filePath.slice(0, -1));
          else untrackedFiles.push(filePath);
        } else if (code === "!!") {
          if (!filePath.endsWith("/") && isIgnoredCandidateName(filePath)) {
            ignoredCandidateNames.push(filePath);
          }
        } else {
          if (CONFLICT_CODES.has(code)) hasConflicts = true;
          trackedChanged.push(filePath);
        }
      }
      return {
        trackedChanged,
        untrackedFiles,
        nestedRepositories,
        ignoredCandidateNames,
        hasConflicts,
        truncated: result.stdoutTruncated,
      };
    }),
  );

/**
 * Ignored files a copy may carry on request (`.env*`, `*.local`): regular files of at most 1 MiB,
 * as paths relative to the repository root.
 */
export const readIgnoredCandidates = (facts: ExportRepositoryFacts, scan: ExportWorkingTreeScan) =>
  Effect.gen(function* () {
    const names = scan.ignoredCandidateNames
      .filter((entry) => entry === entry.trim() && Schema.is(ProjectCopyRelativePath)(entry))
      .toSorted();
    const candidates: Array<{ path: string; byteLength: number }> = [];
    for (
      let start = 0;
      start < names.length && candidates.length < IGNORED_CANDIDATES_MAX;
      start += LSTAT_BATCH
    ) {
      const batch = names.slice(start, start + LSTAT_BATCH);
      const infos = yield* Effect.promise(() =>
        Promise.all(
          batch.map((name) => lstatOrNull(nodePath.join(facts.repositoryRoot, ...name.split("/")))),
        ),
      );
      batch.forEach((name, index) => {
        const info = infos[index];
        if (info?.isFile() && info.size <= PROJECT_COPY_MAX_IGNORED_FILE_BYTES) {
          candidates.push({ path: name, byteLength: info.size });
        }
      });
    }
    return candidates.slice(0, IGNORED_CANDIDATES_MAX);
  });

/**
 * Sums the lstat sizes of `paths` (relative to `root`) and stops as soon as the sum passes
 * `limit`. Paths that vanished, or that the file system cannot name, count as empty.
 */
export const sumFileSizes = (root: string, paths: ReadonlyArray<string>, limit: number) =>
  Effect.promise(async () => {
    let total = 0;
    for (let start = 0; start < paths.length; start += LSTAT_BATCH) {
      const infos = await Promise.all(
        paths
          .slice(start, start + LSTAT_BATCH)
          .map((name) => lstatOrNull(nodePath.join(root, ...name.split("/")))),
      );
      for (const info of infos) total += info?.isFile() ? info.size : 0;
      if (total > limit) return { total, overLimit: true };
    }
    return { total, overLimit: false };
  });

// ── Artifacts ─────────────────────────────────────────────────────────

/** Whether the artifact's file was written, and what it (or its absence) leaves out. */
export interface BuiltArtifact {
  readonly built: boolean;
  readonly skipped: ReadonlyArray<ProjectExportSkippedArtifact>;
}

const skip = (kind: ProjectExportSkippedArtifact["kind"], reason: string): BuiltArtifact => ({
  built: false,
  skipped: [{ kind, reason }],
});

/** A git step whose failure fails the export, with git's own words. */
const requireSuccess = (step: string, result: ExportGitResult) =>
  result.exitCode === 0
    ? Effect.void
    : Effect.fail(
        projectCopyError(
          "internal",
          `${step} failed: ${result.stderr.trim() || `git exited with code ${result.exitCode}`}`,
        ),
      );

/**
 * The commits the clone remote lacks, always ending at HEAD: `git bundle create <file> HEAD
 * --not <what the remote has>`. Skipped for an unborn HEAD, without a remote, and when nothing
 * is unpushed (git refuses an empty bundle).
 */
export const buildCommitsBundle = (input: {
  readonly git: ExportGit;
  readonly facts: ExportRepositoryFacts;
  readonly pushed: ExportPushedState;
  readonly file: string;
}) =>
  Effect.gen(function* () {
    const { facts, pushed } = input;
    if (facts.headOid === null || pushed.exclusion === null) {
      return skip("commits-bundle", PROJECT_EXPORT_SKIP_REASON.noCommits);
    }
    if (facts.cloneRemote === null) {
      return skip("commits-bundle", PROJECT_EXPORT_SKIP_REASON.noRemote);
    }
    if (pushed.state.unpushedCommitCount === 0) {
      return skip("commits-bundle", PROJECT_EXPORT_SKIP_REASON.nothingUnpushed);
    }
    const range = headMinus(pushed.exclusion);
    const result = yield* input.git({
      operation: "ProjectExport.commitsBundle",
      cwd: facts.repositoryRoot,
      args: ["bundle", "create", input.file, ...range.args],
      ...(range.stdin === undefined ? {} : { stdin: range.stdin }),
      allowNonZeroExit: true,
      timeoutMs: EXPORT_STEP_TIMEOUT_MS,
      truncateOutputAtMaxBytes: true,
    });
    yield* requireSuccess("git bundle create", result);
    return { built: true, skipped: [] } satisfies BuiltArtifact;
  });

/**
 * Branches, tags and remote-tracking refs plus HEAD, for a repository the destination cannot
 * clone. Never Ryco's checkpoint refs (`refs/ryco/*`) or stashes. Refused for a shallow
 * repository (its history is incomplete) and an unborn HEAD.
 */
export const buildRepositoryBundle = (input: {
  readonly git: ExportGit;
  readonly facts: ExportRepositoryFacts;
  readonly file: string;
}) =>
  Effect.gen(function* () {
    const { facts } = input;
    if (facts.headOid === null) {
      return skip("repository-bundle", PROJECT_EXPORT_SKIP_REASON.noCommits);
    }
    if (facts.isShallow) return skip("repository-bundle", PROJECT_EXPORT_SKIP_REASON.shallow);
    const result = yield* input.git({
      operation: "ProjectExport.repositoryBundle",
      cwd: facts.repositoryRoot,
      args: ["bundle", "create", input.file, "--branches", "--tags", "--remotes", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: EXPORT_STEP_TIMEOUT_MS,
      truncateOutputAtMaxBytes: true,
    });
    yield* requireSuccess("git bundle create", result);
    return { built: true, skipped: [] } satisfies BuiltArtifact;
  });

/** Git's quoting for one entry of `GIT_ALTERNATE_OBJECT_DIRECTORIES`. */
const alternateEntry = (directory: string) =>
  directory.includes(nodePath.delimiter) || directory.startsWith('"')
    ? `"${directory.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : directory;

const listedPaths = (
  prefix: string,
  paths: ReadonlyArray<string>,
): ReadonlyArray<ProjectExportSkippedArtifact> => {
  const shown = paths
    .slice(0, SKIPPED_PATHS_MAX)
    .map((entry) => ({ kind: "changes-patch" as const, reason: `${prefix}${entry}` }));
  return paths.length > SKIPPED_PATHS_MAX
    ? [
        ...shown,
        {
          kind: "changes-patch",
          reason: `${prefix}and ${paths.length - SKIPPED_PATHS_MAX} more`,
        },
      ]
    : shown;
};

/** `git check-attr filter` over `paths`: the ones git-lfs owns. */
const lfsPaths = (git: ExportGit, cwd: string, paths: ReadonlyArray<string>) =>
  paths.length === 0
    ? Effect.succeed<ReadonlyArray<string>>([])
    : git({
        operation: "ProjectExport.lfsPaths",
        cwd,
        args: ["check-attr", "-z", "--stdin", "filter"],
        stdin: paths.map((entry) => `${entry}\0`).join(""),
        readOnly: true,
        timeoutMs: EXPORT_READ_TIMEOUT_MS,
        maxOutputBytes: EXPORT_LISTING_MAX_BYTES,
        truncateOutputAtMaxBytes: true,
      }).pipe(
        Effect.map((result) => {
          const fields = result.stdout.split("\0");
          const owned: string[] = [];
          for (let index = 0; index + 2 < fields.length; index += 3) {
            if (fields[index + 2] === "lfs") owned.push(fields[index]!);
          }
          return owned;
        }),
      );

/** Submodules whose recorded commit the patch's index moved (`--raw`, mode 160000). */
const movedSubmodules = (git: ExportGit, cwd: string, env: NodeJS.ProcessEnv) =>
  git({
    operation: "ProjectExport.movedSubmodules",
    cwd,
    args: [
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-renames",
      "--ignore-submodules=none",
      "HEAD",
      "--",
    ],
    env,
    readOnly: true,
    timeoutMs: EXPORT_READ_TIMEOUT_MS,
    maxOutputBytes: EXPORT_LISTING_MAX_BYTES,
    truncateOutputAtMaxBytes: true,
  }).pipe(
    Effect.map((result) => {
      const fields = result.stdout.split("\0");
      const moved: string[] = [];
      for (let index = 0; index + 1 < fields.length; index += 2) {
        const [sourceMode, targetMode] = fields[index]!.replace(/^:/, "").split(" ");
        if (sourceMode === "160000" || targetMode === "160000") moved.push(fields[index + 1]!);
      }
      return moved;
    }),
  );

/**
 * A binary patch from HEAD to the working tree (staged, unstaged and untracked, not ignored),
 * plus the opted-in ignored files, written to `file`.
 *
 * Built in a temporary index (seeded from the checkout's own, else `read-tree HEAD`) and a
 * temporary object directory that borrows the repository's objects as an alternate, so neither
 * the index nor the object store of the checkout changes. Untracked and opted-in sizes are
 * summed before anything is hashed; past 4 × `limitBytes` the patch is skipped "over limit".
 * Nested repositories, submodule changes and LFS files are left out and listed in `skipped`.
 */
export const buildChangesPatch = (input: {
  readonly git: ExportGit;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly facts: ExportRepositoryFacts;
  readonly scan: ExportWorkingTreeScan;
  /** Staged, unstaged and untracked changes; without it the patch carries only `ignoredPaths`. */
  readonly workingTreeChanges: boolean;
  /** Opted-in ignored files, already checked against the candidates. */
  readonly ignoredPaths: ReadonlyArray<string>;
  readonly limitBytes: number;
  /** An empty directory the build may fill (temporary index and objects). */
  readonly workDirectory: string;
  readonly file: string;
}) =>
  Effect.gen(function* () {
    const { git, facts, scan } = input;
    const cwd = facts.repositoryRoot;
    if (facts.headOid === null) return skip("changes-patch", PROJECT_EXPORT_SKIP_REASON.noCommits);
    if (scan.hasConflicts) return skip("changes-patch", PROJECT_EXPORT_SKIP_REASON.conflicts);
    if (input.workingTreeChanges) {
      if (scan.truncated) return skip("changes-patch", PROJECT_EXPORT_SKIP_REASON.overLimit);
      const sparse = yield* git({
        operation: "ProjectExport.sparseCheckout",
        cwd,
        args: ["config", "--bool", "core.sparseCheckout"],
        allowNonZeroExit: true,
        readOnly: true,
        timeoutMs: EXPORT_READ_TIMEOUT_MS,
      });
      // The index would not be seeded from the checkout's (skip-worktree entries), and `add -A`
      // over `read-tree HEAD` records every file outside the sparse cone as deleted.
      if (sparse.stdout.trim() === "true") {
        return skip("changes-patch", PROJECT_EXPORT_SKIP_REASON.sparseCheckout);
      }
    }
    const sized = yield* sumFileSizes(
      cwd,
      [...(input.workingTreeChanges ? scan.untrackedFiles : []), ...input.ignoredPaths],
      4 * input.limitBytes,
    );
    if (sized.overLimit) return skip("changes-patch", PROJECT_EXPORT_SKIP_REASON.overLimit);

    const tempIndexPath = nodePath.join(input.workDirectory, "index");
    const objectsDirectory = nodePath.join(input.workDirectory, "objects");
    yield* projectCopyIo("Preparing the patch", () =>
      fsp.mkdir(nodePath.join(objectsDirectory, "pack"), { recursive: true }),
    );
    const env: NodeJS.ProcessEnv = {
      GIT_INDEX_FILE: tempIndexPath,
      GIT_OBJECT_DIRECTORY: objectsDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateEntry(facts.objectsDir),
    };
    const step = (
      operation: string,
      args: ReadonlyArray<string>,
      extra: { readonly stdin?: string; readonly env?: NodeJS.ProcessEnv } = {},
    ) =>
      git({
        operation,
        cwd,
        args: [...EXPORT_GIT_CONFIG_ARGS, ...args],
        env: { ...env, ...extra.env },
        ...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
        allowNonZeroExit: true,
        timeoutMs: EXPORT_STEP_TIMEOUT_MS,
        truncateOutputAtMaxBytes: true,
      });

    const seeded =
      input.workingTreeChanges &&
      (yield* seedIndexFromCheckout({
        git: (command) => git({ ...command, timeoutMs: EXPORT_STEP_TIMEOUT_MS }),
        fs: input.fs,
        path: input.path,
        operation: "ProjectExport.seedIndex",
        cwd,
        tempIndexPath,
        env,
      }));
    if (!seeded) {
      // A partly prepared copy must not leak into the HEAD-seeded index.
      yield* projectCopyIo("Preparing the patch", () => fsp.rm(tempIndexPath, { force: true }));
      yield* requireSuccess(
        "git read-tree",
        yield* step("ProjectExport.readTree", ["read-tree", "HEAD"]),
      );
    }
    if (input.workingTreeChanges) {
      // Fixed pathspecs, so pathspec magic stays on here: LFS files and nested repositories
      // never enter the index (`add` would run the LFS filter, or refuse a repository without
      // commits). Nested repository paths come from git and are matched literally.
      const pathspecs = [
        ".",
        ":(exclude,attr:filter=lfs)",
        ...scan.nestedRepositories.map((entry) => `:(exclude,literal)${entry}`),
      ];
      yield* requireSuccess(
        "git add",
        yield* step(
          "ProjectExport.addChanges",
          ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
          {
            stdin: pathspecs.map((entry) => `${entry}\0`).join(""),
            env: { GIT_LITERAL_PATHSPECS: "0" },
          },
        ),
      );
    }
    if (input.ignoredPaths.length > 0) {
      yield* requireSuccess(
        "git add --force",
        yield* step("ProjectExport.addIgnored", ["add", "--force", "--", ...input.ignoredPaths], {
          env: { GIT_LITERAL_PATHSPECS: "1" },
        }),
      );
    }
    yield* requireSuccess(
      "git diff",
      yield* step("ProjectExport.diff", [
        ...BINARY_PATCH_DIFF_ARGS,
        "--cached",
        "--ignore-submodules=all",
        `--output=${input.file}`,
        "HEAD",
        "--",
      ]),
    );

    const skipped: ProjectExportSkippedArtifact[] = [];
    if (input.workingTreeChanges) {
      skipped.push(
        ...listedPaths(
          PROJECT_EXPORT_SKIPPED_PATH_PREFIX.nestedRepository,
          scan.nestedRepositories,
        ),
      );
      if (facts.hasSubmodules) {
        skipped.push(
          ...listedPaths(
            PROJECT_EXPORT_SKIPPED_PATH_PREFIX.submodule,
            yield* movedSubmodules(git, cwd, env),
          ),
        );
      }
      skipped.push(
        ...listedPaths(
          PROJECT_EXPORT_SKIPPED_PATH_PREFIX.lfs,
          yield* lfsPaths(git, cwd, [...scan.trackedChanged, ...scan.untrackedFiles]),
        ),
      );
    }
    const size = (yield* projectCopyIo("Reading the patch", () => fsp.stat(input.file))).size;
    if (size === 0) {
      return {
        built: false,
        skipped: [
          { kind: "changes-patch", reason: PROJECT_EXPORT_SKIP_REASON.noChanges },
          ...skipped,
        ],
      } satisfies BuiltArtifact;
    }
    if (size > input.limitBytes) {
      return {
        built: false,
        skipped: [
          { kind: "changes-patch", reason: PROJECT_EXPORT_SKIP_REASON.overLimit },
          ...skipped,
        ],
      } satisfies BuiltArtifact;
    }
    return { built: true, skipped } satisfies BuiltArtifact;
  });

// ── Estimates ─────────────────────────────────────────────────────────

/** What a commits bundle would weigh: the on-disk size of the objects it would carry. */
export const estimateCommitsBundle = (git: ExportGit, cwd: string, exclusion: ExportExclusion) => {
  const range = headMinus(exclusion);
  return git({
    operation: "ProjectExport.estimateCommits",
    cwd,
    args: ["rev-list", "--objects", "--disk-usage", ...range.args],
    ...(range.stdin === undefined ? {} : { stdin: range.stdin }),
    allowNonZeroExit: true,
    readOnly: true,
    timeoutMs: EXPORT_ESTIMATE_TIMEOUT_MS,
  }).pipe(
    Effect.map((result) => {
      const bytes = Number.parseInt(result.stdout.trim(), 10);
      return result.exitCode === 0 && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
    }),
    Effect.orElseSucceed(() => 0),
  );
};

/** What a repository bundle would weigh: the repository's whole object store. */
export const estimateRepositoryBundle = (git: ExportGit, cwd: string) =>
  git({
    operation: "ProjectExport.estimateRepository",
    cwd,
    args: ["count-objects", "-v"],
    allowNonZeroExit: true,
    readOnly: true,
    timeoutMs: EXPORT_ESTIMATE_TIMEOUT_MS,
  }).pipe(
    Effect.map((result) => {
      const kibibytes = (key: string) => {
        const match = new RegExp(`^${key}: (\\d+)$`, "m").exec(result.stdout);
        return match ? Number.parseInt(match[1]!, 10) : 0;
      };
      return result.exitCode === 0 ? (kibibytes("size") + kibibytes("size-pack")) * 1024 : 0;
    }),
    Effect.orElseSucceed(() => 0),
  );
