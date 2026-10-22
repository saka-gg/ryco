/**
 * ProjectImportGit - the git steps of an import on the destination node, one method per step.
 *
 * Every step runs with cwd = the repository root (the staging directory until the job publishes
 * it, then the destination), never the project root of a monorepo subfolder. Every git call
 * puts `--` or `--end-of-options` before positional arguments, uses `GitNetwork.env`, passes an
 * explicit timeout, and hands bundles and patches to git by path, never through stdin or as JS
 * strings. A step fails with the `ProjectImportStepError` code the snapshot reports; interrupting
 * it cancels (see `ProjectCopyProcess`).
 *
 * @module ProjectImportGit
 */
import type {
  GitObjectId,
  GitRemoteName,
  ProjectCopyRemote,
  ProjectCopyRelativePath,
  ProjectCopyRelativeRoot,
  ProjectImportCheckout,
  ProjectImportId,
} from "@ryco/contracts/project-copy";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ProjectImportStepError } from "../Errors.ts";
import type { ProjectCopyProcessObserver } from "./ProjectCopyProcess.ts";

export interface ProjectImportGitStepInput {
  /** The repository root git runs in: the staging directory, or the published destination. */
  readonly repositoryRoot: string;
  readonly observer?: ProjectCopyProcessObserver | undefined;
}

/** Clone progress, from git's "Receiving objects" and "Resolving deltas" lines. */
export interface ProjectImportCloneProgress {
  /** Of the whole clone, 0 to 100. */
  readonly percent: number;
  /** git's current progress line, e.g. "Receiving objects: 42% (420/1000)". */
  readonly detail: string;
}

export interface ProjectImportCloneInput extends ProjectImportGitStepInput {
  /** The URL preflight settled on (the given one or its alternate); it stays the clone remote. */
  readonly remoteUrl: string;
  readonly remoteName: GitRemoteName;
  readonly onProgress?: ((progress: ProjectImportCloneProgress) => Effect.Effect<void>) | undefined;
}

export interface ProjectImportCheckoutInput extends ProjectImportGitStepInput {
  readonly importId: ProjectImportId;
  /** The clone remote, for the upstream and the default branch; null for a repository bundle. */
  readonly remoteName: GitRemoteName | null;
  /** Null checks out the remote's default branch (a bundle's HEAD). */
  readonly checkout: ProjectImportCheckout | null;
  /** Must exist as a directory, not a symlink, inside the repository after the checkout. */
  readonly relativeRootInRepository: ProjectCopyRelativeRoot;
}

export interface ProjectImportCheckoutResult {
  /** Null when detached. */
  readonly branch: string | null;
  readonly headOid: GitObjectId;
  /** `<remote>/<branch>` when the upstream was set. */
  readonly upstream: string | null;
}

export interface ProjectImportApplyChangesInput extends ProjectImportGitStepInput {
  readonly importId: ProjectImportId;
  /** The claimed `changes-patch` file. */
  readonly patchPath: string;
  /** Applied only when HEAD is this commit. */
  readonly baseOid: GitObjectId;
  /**
   * The opted-in ignored files the patch carries (`ProjectImportChanges.ignoredPaths`). Each one
   * this repository does not ignore is added to `.git/info/exclude`, so it is never committed or
   * checkpointed here.
   */
  readonly ignoredPaths: ReadonlyArray<ProjectCopyRelativePath>;
}

/**
 * A patch that was not applied stays in the repository's git directory (never tracked or
 * checkpointed); the job's warning names it and `git apply --binary <path>`.
 */
export type ProjectImportChangesOutcome =
  | { readonly status: "applied" }
  | {
      readonly status: "kept";
      readonly reason: "base-mismatch" | "apply-failed";
      /** Relative to the repository root (`.git/ryco-imports/<importId>.patch`), so it stays right after publishing. */
      readonly keptPatchPath: string;
      readonly detail: string;
    };

export interface ProjectImportGitShape {
  /**
   * `git clone --progress --no-checkout --origin <remoteName> -- <url> <repositoryRoot>` into the
   * job's empty staging directory, without submodules and with `GIT_LFS_SKIP_SMUDGE=1`
   * (30 min, 5 min stall). Fails `remote-unreachable` (detail `host-key-unknown <host>` for an
   * unknown ssh host) or `clone-failed`.
   */
  readonly cloneNoCheckout: (
    input: ProjectImportCloneInput,
  ) => Effect.Effect<void, ProjectImportStepError>;
  /**
   * A fresh repository from a `repository-bundle` file: `git init`, then fetch its branches,
   * tags and remote-tracking refs. No remote is created.
   */
  readonly initFromBundle: (
    input: ProjectImportGitStepInput & { readonly bundlePath: string },
  ) => Effect.Effect<void, ProjectImportStepError>;
  /**
   * `git bundle verify`, then fetch the bundle's HEAD into `refs/ryco-import/<importId>/head`.
   * Missing prerequisites fail `commits-failed`.
   */
  readonly fetchCommitsBundle: (
    input: ProjectImportGitStepInput & {
      readonly importId: ProjectImportId;
      readonly bundlePath: string;
    },
  ) => Effect.Effect<{ readonly headOid: GitObjectId }, ProjectImportStepError>;
  /**
   * Ends on `checkout` (its `headOid` is authoritative; one that is missing fails
   * `checkout-failed`), sets the upstream when the remote has the branch, deletes the import's
   * temporary ref, and checks the project root exists inside the repository.
   */
  readonly checkout: (
    input: ProjectImportCheckoutInput,
  ) => Effect.Effect<ProjectImportCheckoutResult, ProjectImportStepError>;
  /**
   * Adds the source's other remotes. Never replaces `keepRemoteName` (the clone remote keeps the
   * URL that was actually used); only https, http, ssh and scp-style URLs are written, the rest
   * are skipped with a warning.
   */
  readonly setRemotes: (input: {
    readonly repositoryRoot: string;
    readonly remotes: ReadonlyArray<ProjectCopyRemote>;
    readonly keepRemoteName: GitRemoteName | null;
  }) => Effect.Effect<{ readonly warnings: ReadonlyArray<string> }, ProjectImportStepError>;
  /**
   * `git apply --binary --check`, then `git apply --binary` when HEAD is `baseOid`; never
   * touches the index and never falls back to a three-way merge. Not applying is an outcome,
   * not a failure.
   */
  readonly applyChanges: (
    input: ProjectImportApplyChangesInput,
  ) => Effect.Effect<ProjectImportChangesOutcome, ProjectImportStepError>;
  /** `git submodule update --init --recursive` (10 min); the job only warns when it fails. */
  readonly updateSubmodules: (
    input: ProjectImportGitStepInput,
  ) => Effect.Effect<void, ProjectImportStepError>;
  /**
   * `git lfs pull` when the checkout tracks files with `filter=lfs`; `not-used` when it tracks
   * none (nothing runs), `lfs-missing` when it does but git-lfs is not installed on this node.
   */
  readonly lfsPull: (
    input: ProjectImportGitStepInput & { readonly remoteName: GitRemoteName | null },
  ) => Effect.Effect<
    { readonly status: "pulled" | "not-used" | "lfs-missing" },
    ProjectImportStepError
  >;
}

export class ProjectImportGit extends Context.Service<ProjectImportGit, ProjectImportGitShape>()(
  "ryco/projectCopy/Services/ProjectImportGit",
) {}
