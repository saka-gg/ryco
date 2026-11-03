/**
 * ProjectImportGitLive - the git steps of an import on the destination node.
 *
 * The sequence a clone import runs: `git clone --no-checkout` from the remote, fetch the commits
 * bundle's HEAD into a temporary ref, check out the source's exact commit (`-B` the branch, or
 * detached), then apply the uncommitted changes when HEAD is their base. A repository bundle
 * import replaces the clone with `git init` plus a fetch of the bundle's branches, tags and
 * remote-tracking refs. Every command runs in the repository root with `GitNetwork.env`, an
 * explicit timeout and the user's hooks disabled (`NO_USER_HOOK_ARGS`), and reads bundles and
 * patches by path. Network commands (clone, submodules, LFS) go through `GitNetwork`, each in one
 * of the clone slots `sourceControl` clones share (`gitCloneCommon.ts`).
 *
 * @module ProjectImportGitLive
 */
import { lstat } from "node:fs/promises";

import type { GitObjectId, GitRemoteName } from "@ryco/contracts/project-copy";
import {
  classifyRemoteUrl,
  isRecreatableRemoteKind,
  redactGitCredentials,
  sanitizeRemoteUrl,
} from "@ryco/shared/gitRemoteUrl";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  CLONE_ENV,
  CLONE_STALL_TIMEOUT_MS,
  gitFailureSummary,
  withGitCloneSlot,
} from "../../sourceControl/gitCloneCommon.ts";
import { NO_USER_HOOK_ARGS } from "../../vcs/GitDurableWrites.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import { type GitNetworkError, ProjectImportStepError } from "../Errors.ts";
import {
  GIT_DETAIL_MAX_CHARS,
  GIT_LFS_FILTER_OFF_ARGS,
  runProjectCopyGit,
  tailOfText,
  type ProjectCopyGitOutput,
} from "../gitProcess.ts";
import { GitNetwork } from "../Services/GitNetwork.ts";
import type { ProjectCopyProcessObserver } from "../Services/ProjectCopyProcess.ts";
import {
  ProjectImportGit,
  type ProjectImportApplyChangesInput,
  type ProjectImportCheckoutInput,
  type ProjectImportCheckoutResult,
  type ProjectImportChangesOutcome,
  type ProjectImportCloneInput,
  type ProjectImportCloneProgress,
} from "../Services/ProjectImportGit.ts";
import { remoteAccessDetail } from "./GitNetworkLive.ts";

/**
 * The network transfers (clone, submodules, LFS) have no time limit, as `sourceControl` clones:
 * they print progress and fail after `CLONE_STALL_TIMEOUT_MS` without any output.
 */
const TRANSFER_TIMEOUT_MS = Number.POSITIVE_INFINITY;
/** Fetching a bundle, a checkout, applying a patch: local, but up to hundreds of MiB. */
const LOCAL_LONG_TIMEOUT_MS = 10 * 60_000;
const LOCAL_SHORT_TIMEOUT_MS = 30_000;
const OUTPUT_DETAIL_MAX_CHARS = 4_000;
const LFS_SKIP_SMUDGE = { GIT_LFS_SKIP_SMUDGE: "1" } as const;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const PREREQUISITES_MISSING = /lacks these prerequisite commits/i;

export const COMMITS_PREREQUISITES_MESSAGE =
  "The remote no longer has commits this copy builds on; retry with Send files";

/** The ref a commits bundle's HEAD is fetched into, until the checkout step deletes it. */
export const importHeadRef = (importId: string) => `refs/ryco-import/${importId}/head`;

/**
 * Whole-clone progress from one git progress line: receiving objects is the first 80 %,
 * resolving deltas the rest. Null for any other line.
 */
export function parseCloneProgress(line: string): ProjectImportCloneProgress | null {
  const match = /(Receiving objects|Resolving deltas):\s+(\d{1,3})%/.exec(line);
  if (!match?.[1] || !match[2]) return null;
  const phasePercent = Math.min(100, Number(match[2]));
  const percent = match[1] === "Receiving objects" ? phasePercent * 0.8 : 80 + phasePercent * 0.2;
  return { percent, detail: line.trim() };
}

/** A `.git/info/exclude` line matching exactly this repository-relative path. */
export function excludePatternFor(relativePath: string): string {
  const escaped = relativePath
    .replace(/[\\*?[\]!#]/g, "\\$&")
    .replace(/ +$/, (spaces) => spaces.replaceAll(" ", "\\ "));
  return `/${escaped}`;
}

const stepError = (
  code: ProjectImportStepError["code"],
  message: string,
  detail: string | null = null,
) =>
  new ProjectImportStepError({
    code,
    message: tailOfText(redactGitCredentials(message), GIT_DETAIL_MAX_CHARS) || code,
    detail:
      detail === null || detail.trim().length === 0
        ? null
        : tailOfText(redactGitCredentials(detail), OUTPUT_DETAIL_MAX_CHARS),
  });

/** A network step's failure: unreachable remotes (and unknown host keys) are `remote-unreachable`. */
const networkStepError = (
  action: string,
  failedCode: ProjectImportStepError["code"],
  error: GitNetworkError,
) => {
  switch (error.reason) {
    case "host-key-unknown":
      return stepError("remote-unreachable", remoteAccessDetail(error), error.detail);
    case "unreachable":
    case "invalid-url":
    case "insecure-transport":
      return stepError(
        "remote-unreachable",
        `The remote could not be reached from this node: ${remoteAccessDetail(error)}`,
        error.detail,
      );
    case "timeout":
    case "stalled":
    case "failed":
      return stepError(failedCode, `${action} failed: ${remoteAccessDetail(error)}`, error.detail);
    case "internal":
      return stepError("internal", `${action} failed: ${error.detail}`, error.detail);
  }
};

export const makeProjectImportGit = Effect.gen(function* () {
  const gitNetwork = yield* GitNetwork;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;

  /** A local git command in the repository root; a non-zero exit is part of the result. */
  const git = (
    code: ProjectImportStepError["code"],
    input: {
      readonly operation: string;
      readonly repositoryRoot: string;
      /** `-c` options before the subcommand, e.g. `GIT_LFS_FILTER_OFF_ARGS`. */
      readonly config?: ReadonlyArray<string>;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly env?: Readonly<Record<string, string>>;
      readonly maxOutputBytes?: number;
      readonly observer?: ProjectCopyProcessObserver | undefined;
    },
  ): Effect.Effect<ProjectCopyGitOutput, ProjectImportStepError> =>
    runProjectCopyGit({
      operation: `ProjectImportGit.${input.operation}`,
      cwd: input.repositoryRoot,
      args: [...NO_USER_HOOK_ARGS, ...(input.config ?? []), ...input.args],
      env: { ...gitNetwork.env, ...input.env },
      timeoutMs: input.timeoutMs ?? LOCAL_SHORT_TIMEOUT_MS,
      maxOutputBytes: input.maxOutputBytes,
      observer: input.observer,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((error) =>
        stepError(
          error.reason === "internal" ? "internal" : code,
          `git ${input.args[0] ?? ""} failed: ${error.detail}`,
          error.detail,
        ),
      ),
    );

  /** As `git`, failing `code` with `${action} failed: <git's reason>` on a non-zero exit. */
  const gitOk = (
    code: ProjectImportStepError["code"],
    action: string,
    input: Parameters<typeof git>[1],
  ) =>
    git(code, input).pipe(
      Effect.flatMap((output) =>
        output.exitCode === 0
          ? Effect.succeed(output)
          : Effect.fail(
              stepError(
                code,
                `${action} failed: ${gitFailureSummary(output.stderrTail) || `exit code ${output.exitCode}`}`,
                output.stderrTail,
              ),
            ),
      ),
    );

  /** The commit `rev` names, or null when it names none. */
  const resolveCommit = (
    code: ProjectImportStepError["code"],
    repositoryRoot: string,
    rev: string,
    observer?: ProjectCopyProcessObserver,
  ): Effect.Effect<GitObjectId | null, ProjectImportStepError> =>
    git(code, {
      operation: "resolveCommit",
      repositoryRoot,
      args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
      observer,
    }).pipe(
      Effect.map((output) => {
        const oid = output.stdout.trim();
        return output.exitCode === 0 && OBJECT_ID.test(oid) ? oid : null;
      }),
    );

  /** `git rev-parse --git-path <name>`, absolute. */
  const gitPath = (repositoryRoot: string, name: string) =>
    gitOk("internal", "Finding the git directory", {
      operation: "gitPath",
      repositoryRoot,
      args: ["rev-parse", "--git-path", name],
    }).pipe(
      Effect.map((output) => {
        const resolved = output.stdout.trim();
        return path.isAbsolute(resolved) ? resolved : path.join(repositoryRoot, resolved);
      }),
    );

  const fsStep =
    (code: ProjectImportStepError["code"], action: string) =>
    (cause: { readonly message: string }) =>
      stepError(code, `${action} failed: ${cause.message}`);

  const cloneNoCheckout = Effect.fn("ProjectImportGit.cloneNoCheckout")(function* (
    input: ProjectImportCloneInput,
  ) {
    let lastPercent = -1;
    const onProgress = input.onProgress;
    const onOutput = (chunk: string) =>
      Effect.gen(function* () {
        if (input.observer?.onOutput) yield* input.observer.onOutput(chunk);
        if (!onProgress) return;
        for (const line of chunk.split(/[\r\n]+/)) {
          const progress = parseCloneProgress(line);
          if (progress === null || Math.floor(progress.percent) === lastPercent) continue;
          lastPercent = Math.floor(progress.percent);
          yield* onProgress(progress);
        }
      });
    yield* gitNetwork
      .runGitNetworkCommand({
        operation: "ProjectImportGit.cloneNoCheckout",
        cwd: path.dirname(input.repositoryRoot),
        args: [
          ...NO_USER_HOOK_ARGS,
          "clone",
          "--progress",
          "--no-checkout",
          "--origin",
          input.remoteName,
          "--",
          input.remoteUrl,
          input.repositoryRoot,
        ],
        remoteUrl: input.remoteUrl,
        env: { ...CLONE_ENV, ...LFS_SKIP_SMUDGE },
        timeoutMs: TRANSFER_TIMEOUT_MS,
        stallTimeoutMs: CLONE_STALL_TIMEOUT_MS,
        observer: { onChild: input.observer?.onChild, onOutput },
      })
      .pipe(
        withGitCloneSlot,
        Effect.mapError((error) => networkStepError("git clone", "clone-failed", error)),
      );
  });

  const initFromBundle = Effect.fn("ProjectImportGit.initFromBundle")(function* (input: {
    readonly repositoryRoot: string;
    readonly bundlePath: string;
    readonly observer?: ProjectCopyProcessObserver | undefined;
  }) {
    const { repositoryRoot, bundlePath, observer } = input;
    yield* gitOk("clone-failed", "git init", {
      operation: "initFromBundle.init",
      repositoryRoot,
      args: ["init", "--quiet"],
      observer,
    });
    yield* gitOk("clone-failed", "Verifying the repository bundle", {
      operation: "initFromBundle.verify",
      repositoryRoot,
      args: ["bundle", "verify", "--", bundlePath],
      timeoutMs: LOCAL_LONG_TIMEOUT_MS,
      observer,
    });
    // `--update-head-ok`: the unborn branch HEAD names may be one of the bundle's branches.
    yield* gitOk("clone-failed", "Fetching the repository bundle", {
      operation: "initFromBundle.fetch",
      repositoryRoot,
      args: [
        "fetch",
        "--no-tags",
        "--update-head-ok",
        "--",
        bundlePath,
        "+refs/heads/*:refs/heads/*",
        "+refs/tags/*:refs/tags/*",
        "+refs/remotes/*:refs/remotes/*",
      ],
      timeoutMs: LOCAL_LONG_TIMEOUT_MS,
      observer,
    });
    // HEAD follows the bundle's HEAD: the branch at that commit, else detached there.
    const heads = yield* gitOk("clone-failed", "Reading the repository bundle", {
      operation: "initFromBundle.listHeads",
      repositoryRoot,
      args: ["bundle", "list-heads", "--", bundlePath],
      timeoutMs: LOCAL_LONG_TIMEOUT_MS,
    });
    const refs = heads.stdout
      .split("\n")
      .map((line) => /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\S+)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null);
    const headOid = refs.find((match) => match[2] === "HEAD")?.[1];
    if (headOid === undefined) return;
    const branchRef = refs.find(
      (match) => match[1] === headOid && match[2]?.startsWith("refs/heads/") === true,
    )?.[2];
    yield* gitOk("clone-failed", "Pointing HEAD at the bundle's HEAD", {
      operation: "initFromBundle.head",
      repositoryRoot,
      args:
        branchRef === undefined
          ? ["update-ref", "--no-deref", "--", "HEAD", headOid]
          : ["symbolic-ref", "--", "HEAD", branchRef],
    });
  });

  const fetchCommitsBundle = Effect.fn("ProjectImportGit.fetchCommitsBundle")(function* (input: {
    readonly repositoryRoot: string;
    readonly importId: string;
    readonly bundlePath: string;
    readonly observer?: ProjectCopyProcessObserver | undefined;
  }) {
    const { repositoryRoot, bundlePath, observer } = input;
    const failed = (action: string, output: ProjectCopyGitOutput) =>
      stepError(
        "commits-failed",
        PREREQUISITES_MISSING.test(output.stderrTail)
          ? COMMITS_PREREQUISITES_MESSAGE
          : `${action} failed: ${gitFailureSummary(output.stderrTail) || `exit code ${output.exitCode}`}`,
        output.stderrTail,
      );
    const verify = yield* git("commits-failed", {
      operation: "fetchCommitsBundle.verify",
      repositoryRoot,
      args: ["bundle", "verify", "--", bundlePath],
      timeoutMs: LOCAL_LONG_TIMEOUT_MS,
      observer,
    });
    if (verify.exitCode !== 0) return yield* failed("Verifying the commits bundle", verify);
    const ref = importHeadRef(input.importId);
    const fetch = yield* git("commits-failed", {
      operation: "fetchCommitsBundle.fetch",
      repositoryRoot,
      args: ["fetch", "--no-tags", "--", bundlePath, `+HEAD:${ref}`],
      timeoutMs: LOCAL_LONG_TIMEOUT_MS,
      observer,
    });
    if (fetch.exitCode !== 0) return yield* failed("Fetching the commits bundle", fetch);
    const headOid = yield* resolveCommit("commits-failed", repositoryRoot, ref, observer);
    if (headOid === null) {
      return yield* stepError("commits-failed", "The commits bundle has no HEAD commit.");
    }
    return { headOid };
  });

  /** Where the checkout ends: the given commit, the given branch's tip, or the default branch. */
  const resolveCheckoutTarget = Effect.fn("ProjectImportGit.resolveCheckoutTarget")(function* (
    input: ProjectImportCheckoutInput,
  ) {
    const { repositoryRoot, remoteName, checkout, observer } = input;
    const commitOf = (rev: string) =>
      resolveCommit("checkout-failed", repositoryRoot, rev, observer);
    if (checkout?.headOid) {
      const oid = yield* commitOf(checkout.headOid);
      if (oid === null) {
        return yield* stepError(
          "checkout-failed",
          `Commit ${checkout.headOid.slice(0, 12)} is not in this repository; the copy cannot end where the source is.`,
        );
      }
      return { branch: checkout.branch, oid };
    }
    if (checkout?.branch) {
      const candidates = [
        ...(remoteName === null ? [] : [`refs/remotes/${remoteName}/${checkout.branch}`]),
        `refs/heads/${checkout.branch}`,
      ];
      for (const candidate of candidates) {
        const oid = yield* commitOf(candidate);
        if (oid !== null) return { branch: checkout.branch, oid };
      }
      return yield* stepError(
        "checkout-failed",
        `Branch ${checkout.branch} does not exist in this repository.`,
      );
    }
    if (remoteName !== null) {
      // The remote's default branch: its HEAD, else main or master.
      const prefix = `refs/remotes/${remoteName}/`;
      const remoteHead = yield* git("checkout-failed", {
        operation: "checkout.remoteHead",
        repositoryRoot,
        args: ["symbolic-ref", "--quiet", "--", `${prefix}HEAD`],
      });
      const symbolic = remoteHead.stdout.trim();
      const branches = [
        ...(remoteHead.exitCode === 0 && symbolic.startsWith(prefix)
          ? [symbolic.slice(prefix.length)]
          : []),
        "main",
        "master",
      ];
      for (const branch of branches) {
        const oid = yield* commitOf(`${prefix}${branch}`);
        if (oid !== null) return { branch, oid };
      }
      return yield* stepError("checkout-failed", "The remote has no default branch to check out.");
    }
    // A repository bundle: wherever `initFromBundle` pointed HEAD.
    const oid = yield* commitOf("HEAD");
    if (oid === null) {
      return yield* stepError("checkout-failed", "The repository has no commits to check out.");
    }
    const head = yield* git("checkout-failed", {
      operation: "checkout.head",
      repositoryRoot,
      args: ["symbolic-ref", "--quiet", "--", "HEAD"],
    });
    const symbolic = head.stdout.trim();
    return {
      branch:
        head.exitCode === 0 && symbolic.startsWith("refs/heads/")
          ? symbolic.slice("refs/heads/".length)
          : null,
      oid,
    };
  });

  /** Sets the branch's upstream to the first remote that has it (`remoteName`, else origin first). */
  const setUpstream = Effect.fn("ProjectImportGit.setUpstream")(function* (
    repositoryRoot: string,
    branch: string,
    remoteName: GitRemoteName | null,
  ) {
    let remotes: ReadonlyArray<string> = remoteName === null ? [] : [remoteName];
    if (remoteName === null) {
      const listed = yield* git("checkout-failed", {
        operation: "checkout.remotes",
        repositoryRoot,
        args: ["remote"],
      });
      const names = listed.stdout.split("\n").map((name) => name.trim());
      remotes = names
        .filter((name) => name.length > 0)
        .toSorted((left, right) => Number(right === "origin") - Number(left === "origin"));
    }
    for (const remote of remotes) {
      if (
        (yield* resolveCommit(
          "checkout-failed",
          repositoryRoot,
          `refs/remotes/${remote}/${branch}`,
        )) === null
      ) {
        continue;
      }
      const tracking = yield* git("checkout-failed", {
        operation: "checkout.upstream",
        repositoryRoot,
        args: ["branch", `--set-upstream-to=${remote}/${branch}`, "--", branch],
      });
      return tracking.exitCode === 0 ? `${remote}/${branch}` : null;
    }
    return null;
  });

  /** The project root (`<root>/<relative>`) is a real directory inside the repository. */
  const assertProjectRoot = Effect.fn("ProjectImportGit.assertProjectRoot")(function* (
    repositoryRoot: string,
    relativeRoot: string,
  ) {
    if (relativeRoot === "") return;
    const missing = stepError(
      "checkout-failed",
      `The project folder ${relativeRoot} does not exist as a folder in this checkout.`,
    );
    const resolved = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: repositoryRoot, relativePath: relativeRoot })
      .pipe(Effect.mapError(() => missing));
    const info = yield* Effect.tryPromise(() => lstat(resolved.absolutePath)).pipe(
      Effect.mapError(() => missing),
    );
    if (!info.isDirectory()) return yield* missing;
    const [realRepository, realProject] = yield* Effect.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(resolved.absolutePath),
    ]).pipe(Effect.mapError(() => missing));
    const relative = path.relative(realRepository, realProject);
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* missing;
    }
  });

  const checkout = Effect.fn("ProjectImportGit.checkout")(function* (
    input: ProjectImportCheckoutInput,
  ) {
    const { repositoryRoot, observer } = input;
    const result = yield* Effect.gen(function* () {
      const target = yield* resolveCheckoutTarget(input);
      if (target.branch !== null) {
        // The contract already refuses a leading `-`; git has the final word on the rest.
        const valid = yield* git("checkout-failed", {
          operation: "checkout.checkRefFormat",
          repositoryRoot,
          args: ["check-ref-format", "--branch", target.branch],
        });
        if (target.branch.startsWith("-") || valid.exitCode !== 0) {
          return yield* stepError(
            "checkout-failed",
            `${target.branch} is not a valid branch name.`,
          );
        }
      }
      yield* gitOk("checkout-failed", "git checkout", {
        operation: "checkout.checkout",
        repositoryRoot,
        // LFS files stay pointers until the `lfs` step; a missing git-lfs must not fail this.
        config: GIT_LFS_FILTER_OFF_ARGS,
        args:
          target.branch === null
            ? ["checkout", "-f", "--detach", target.oid, "--"]
            : ["checkout", "-f", "-B", target.branch, target.oid, "--"],
        timeoutMs: LOCAL_LONG_TIMEOUT_MS,
        observer,
      });
      const upstream =
        target.branch === null
          ? null
          : yield* setUpstream(repositoryRoot, target.branch, input.remoteName);
      yield* assertProjectRoot(repositoryRoot, input.relativeRootInRepository);
      const headOid = yield* resolveCommit("checkout-failed", repositoryRoot, "HEAD");
      if (headOid === null) {
        return yield* stepError(
          "checkout-failed",
          "HEAD does not name a commit after the checkout.",
        );
      }
      return { branch: target.branch, headOid, upstream } satisfies ProjectImportCheckoutResult;
    }).pipe(
      Effect.ensuring(
        git("checkout-failed", {
          operation: "checkout.deleteImportRef",
          repositoryRoot,
          args: ["update-ref", "-d", "--", importHeadRef(input.importId)],
        }).pipe(Effect.ignore),
      ),
    );
    return result;
  });

  const setRemotes = Effect.fn("ProjectImportGit.setRemotes")(function* (input: {
    readonly repositoryRoot: string;
    readonly remotes: ReadonlyArray<{ readonly name: GitRemoteName; readonly url: string }>;
    readonly keepRemoteName: GitRemoteName | null;
  }) {
    const { repositoryRoot } = input;
    const listed = yield* gitOk("internal", "Listing remotes", {
      operation: "setRemotes.list",
      repositoryRoot,
      args: ["remote"],
    });
    const existing = new Set(listed.stdout.split("\n").map((name) => name.trim()));
    const warnings: Array<string> = [];
    for (const remote of input.remotes) {
      // The clone remote keeps the URL that was actually used.
      if (remote.name === input.keepRemoteName) continue;
      if (!isRecreatableRemoteKind(classifyRemoteUrl(remote.url))) {
        warnings.push(
          `Remote ${remote.name} was not recreated: its URL only works on the node it came from.`,
        );
        continue;
      }
      const url = sanitizeRemoteUrl(remote.url);
      const output = yield* git("internal", {
        operation: "setRemotes.write",
        repositoryRoot,
        args: existing.has(remote.name)
          ? ["remote", "set-url", "--", remote.name, url]
          : ["remote", "add", "--", remote.name, url],
      });
      if (output.exitCode === 0) {
        existing.add(remote.name);
      } else {
        warnings.push(
          `Remote ${remote.name} could not be added: ${gitFailureSummary(output.stderrTail)}`,
        );
      }
    }
    return { warnings };
  });

  /** The opted-in ignored files this repository does not ignore go into `info/exclude`. */
  const excludeIgnoredPaths = Effect.fn("ProjectImportGit.excludeIgnoredPaths")(function* (
    repositoryRoot: string,
    ignoredPaths: ReadonlyArray<string>,
  ) {
    const unignored: Array<string> = [];
    for (const relativePath of ignoredPaths) {
      const check = yield* git("internal", {
        operation: "applyChanges.checkIgnore",
        repositoryRoot,
        args: ["check-ignore", "-q", "--", relativePath],
      });
      if (check.exitCode !== 0) unignored.push(relativePath);
    }
    if (unignored.length === 0) return;
    const excludePath = yield* gitPath(repositoryRoot, "info/exclude");
    const current = (yield* fileSystem.exists(excludePath))
      ? yield* fileSystem.readFileString(excludePath)
      : "";
    const present = new Set(current.split("\n").map((line) => line.trim()));
    const lines = unignored.map(excludePatternFor).filter((line) => !present.has(line));
    if (lines.length === 0) return;
    yield* fileSystem.makeDirectory(path.dirname(excludePath), { recursive: true });
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    yield* fileSystem.writeFileString(
      excludePath,
      `${separator}# Ignored files copied by Ryco\n${lines.join("\n")}\n`,
      { flag: "a" },
    );
  });

  const applyChanges = Effect.fn("ProjectImportGit.applyChanges")(function* (
    input: ProjectImportApplyChangesInput,
  ) {
    const { repositoryRoot, patchPath, observer } = input;
    const keep = (reason: "base-mismatch" | "apply-failed", detail: string) =>
      Effect.gen(function* () {
        const directory = yield* gitPath(repositoryRoot, "ryco-imports");
        const keptPath = path.join(directory, `${input.importId}.patch`);
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.copyFile(patchPath, keptPath);
        const realRoot = yield* fileSystem.realPath(repositoryRoot);
        const realKept = yield* fileSystem.realPath(keptPath);
        const outcome: ProjectImportChangesOutcome = {
          status: "kept",
          reason,
          keptPatchPath: path.relative(realRoot, realKept).split(path.sep).join("/"),
          detail: tailOfText(redactGitCredentials(detail), OUTPUT_DETAIL_MAX_CHARS),
        };
        return outcome;
      }).pipe(Effect.mapError(fsStep("internal", "Keeping the uncommitted changes")));

    const head = yield* resolveCommit("changes-conflict", repositoryRoot, "HEAD", observer);
    if (head !== input.baseOid) {
      return yield* keep(
        "base-mismatch",
        `The changes were made on ${input.baseOid.slice(0, 12)}, but this checkout is at ${head?.slice(0, 12) ?? "no commit"}.`,
      );
    }
    // Both are atomic and leave the index alone; no three-way fallback. Reading a preimage runs
    // its clean filter, so the LFS filter is off here as in the checkout.
    const applyArgs = ["apply", "--binary", "--whitespace=nowarn"];
    const check = yield* git("changes-conflict", {
      operation: "applyChanges.check",
      repositoryRoot,
      config: GIT_LFS_FILTER_OFF_ARGS,
      args: [...applyArgs, "--check", "--", patchPath],
      timeoutMs: LOCAL_LONG_TIMEOUT_MS,
      observer,
    });
    if (check.exitCode !== 0) return yield* keep("apply-failed", check.stderrTail);
    const apply = yield* git("changes-conflict", {
      operation: "applyChanges.apply",
      repositoryRoot,
      config: GIT_LFS_FILTER_OFF_ARGS,
      args: [...applyArgs, "--", patchPath],
      timeoutMs: LOCAL_LONG_TIMEOUT_MS,
      observer,
    });
    if (apply.exitCode !== 0) return yield* keep("apply-failed", apply.stderrTail);
    // The changes are in; an exclude that cannot be written is logged, not a failed step.
    yield* excludeIgnoredPaths(repositoryRoot, input.ignoredPaths).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("project import could not exclude copied ignored files", {
          cause: cause.message,
        }),
      ),
    );
    const outcome: ProjectImportChangesOutcome = { status: "applied" };
    return outcome;
  });

  const updateSubmodules = Effect.fn("ProjectImportGit.updateSubmodules")(function* (input: {
    readonly repositoryRoot: string;
    readonly observer?: ProjectCopyProcessObserver | undefined;
  }) {
    yield* gitNetwork
      .runGitNetworkCommand({
        operation: "ProjectImportGit.updateSubmodules",
        cwd: input.repositoryRoot,
        // Without `--progress` a submodule's clone prints nothing to a pipe until it is done, and
        // the no-output stall limit would end a long one.
        args: [
          ...NO_USER_HOOK_ARGS,
          "submodule",
          "update",
          "--init",
          "--recursive",
          "--progress",
          "--",
        ],
        remoteUrl: null,
        env: CLONE_ENV,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        stallTimeoutMs: CLONE_STALL_TIMEOUT_MS,
        observer: input.observer,
      })
      .pipe(
        withGitCloneSlot,
        Effect.mapError((error) => networkStepError("git submodule update", "clone-failed", error)),
      );
  });

  const lfsPull = Effect.fn("ProjectImportGit.lfsPull")(function* (input: {
    readonly repositoryRoot: string;
    readonly remoteName: GitRemoteName | null;
    readonly observer?: ProjectCopyProcessObserver | undefined;
  }) {
    // Only a checkout whose attributes route files through LFS needs git-lfs (the source may not
    // know: a plain clone from Agent Control always asks). Any tracked path is enough to tell.
    const tracked = yield* git("internal", {
      operation: "lfsPull.tracked",
      repositoryRoot: input.repositoryRoot,
      args: ["ls-files", "-z", "--", ":(attr:filter=lfs)"],
      env: { GIT_LITERAL_PATHSPECS: "0" },
      maxOutputBytes: 4096,
    });
    if (tracked.exitCode === 0 && tracked.stdout.length === 0 && !tracked.stdoutTruncated) {
      return { status: "not-used" as const };
    }
    const installed = yield* git("internal", {
      operation: "lfsPull.version",
      repositoryRoot: input.repositoryRoot,
      args: ["lfs", "version"],
    }).pipe(
      Effect.map((output) => output.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );
    if (!installed) return { status: "lfs-missing" as const };
    yield* gitNetwork
      .runGitNetworkCommand({
        operation: "ProjectImportGit.lfsPull",
        cwd: input.repositoryRoot,
        args: [
          ...NO_USER_HOOK_ARGS,
          "lfs",
          "pull",
          ...(input.remoteName === null ? [] : ["--", input.remoteName]),
        ],
        remoteUrl: null,
        // `GIT_LFS_FORCE_PROGRESS`: git-lfs prints no progress to a pipe otherwise, and a long
        // download would read as a stall.
        env: CLONE_ENV,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        stallTimeoutMs: CLONE_STALL_TIMEOUT_MS,
        observer: input.observer,
      })
      .pipe(
        withGitCloneSlot,
        Effect.mapError((error) => networkStepError("git lfs pull", "clone-failed", error)),
      );
    return { status: "pulled" as const };
  });

  return ProjectImportGit.of({
    cloneNoCheckout,
    initFromBundle,
    fetchCommitsBundle,
    checkout,
    setRemotes,
    applyChanges,
    updateSubmodules,
    lfsPull,
  });
});

export const ProjectImportGitLive = Layer.effect(ProjectImportGit, makeProjectImportGit);
