/**
 * How `CheckoutMergeProver` proves a checkout's commits merged (see `checkoutMergeProof.ts`).
 * Loaded on first use.
 *
 * 1. The remote default branch (`refs/remotes/<primary remote>/HEAD`, e.g. `origin/main`)
 *    contains the commit. Local only: the tracking ref as status polling last refreshed it, so
 *    a stale ref only means "not proven yet".
 * 2. The workspace's pull request merged into the default branch with exactly that commit as
 *    its head (squash and rebase merges leave the branch's own commits out of the default
 *    branch). Asked only when the workspace record already says the pull request merged, with
 *    the forge's own read of that pull request (`getChangeRequest`): the repository index's lean
 *    listing has no head commit on GitHub. A merged pull request never changes again, so its
 *    answer is kept for hours; anything else (still open, a failed or rate-limited read) is
 *    asked again a minute later at the earliest. A read the caller's deadline cut short is not
 *    kept at all.
 */
import { Effect } from "effect";
import type { ChangeRequest } from "@ryco/contracts";

import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import type {
  CheckoutMergeProof,
  CheckoutMergeProverShape,
  MergeProofReads,
  RemoteDefaultBranches,
} from "./checkoutMergeProof.ts";
import type { SourceControlProviderRegistryShape } from "./SourceControlProviderRegistry.ts";

/** One forge read at most this long, and never past the caller's deadline. */
export const MERGE_PROOF_READ_TIMEOUT_MS = 15_000;
/** A merged pull request's head and base are final. */
const MERGED_TTL_MS = 6 * 60 * 60_000;
/** Not merged according to the forge, or no answer: asked again after this. */
const UNSETTLED_TTL_MS = 60_000;
const DEFAULT_BRANCH_TTL_MS = 15 * 60_000;
const CACHE_CAPACITY = 512;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

type PullRequestFacts = Pick<ChangeRequest, "state" | "baseRefName" | "headSha">;

/**
 * Pure: a merged change request proves `head` merged when it merged into the default branch with
 * exactly `head` as its head commit. The head branch's name is not compared: the pull request is
 * the workspace's own link, and the commit is the binding fact.
 */
export function pullRequestProvesMerge(
  pr: PullRequestFacts,
  input: { readonly head: string; readonly defaultBranch: string },
): boolean {
  return (
    pr.state === "merged" &&
    pr.headSha !== undefined &&
    pr.headSha.toLowerCase() === input.head.toLowerCase() &&
    pr.baseRefName === input.defaultBranch
  );
}

/** A bounded map whose entries expire; the oldest go first when it is full. */
const expiringMap = <V>(now: () => number) => {
  const entries = new Map<string, { readonly value: V; readonly expiresAt: number }>();
  return {
    get: (key: string): { readonly value: V } | undefined => {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry;
    },
    set: (key: string, value: V, ttlMs: number) => {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      for (const oldest of entries.keys()) {
        if (entries.size <= CACHE_CAPACITY) break;
        entries.delete(oldest);
      }
    },
  };
};

export const makeCheckoutMergeProver = (deps: {
  readonly git: Pick<GitVcsDriverShape, "execute" | "resolvePrimaryRemoteName">;
  readonly providers: Pick<SourceControlProviderRegistryShape, "resolve">;
  readonly now?: () => number;
}): CheckoutMergeProverShape => {
  const now = deps.now ?? Date.now;
  const pullRequests = expiringMap<PullRequestFacts | null>(now);
  const defaultBranches = expiringMap<string>(now);

  const git = (cwd: string, args: readonly string[], maxOutputBytes: number) =>
    deps.git.execute({
      operation: "checkout merge proof",
      cwd,
      args: ["-c", "core.fsmonitor=false", ...args],
      timeoutMs: 5_000,
      maxOutputBytes,
      allowNonZeroExit: true,
      readOnly: true,
    });

  /** `origin/main` and `main`, from the primary remote's HEAD; null when Git has none. */
  const remoteDefault = (projectRoot: string) =>
    Effect.gen(function* () {
      const remote = yield* deps.git.resolvePrimaryRemoteName(projectRoot);
      const result = yield* git(
        projectRoot,
        ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
        4096,
      );
      const target = result.stdout.trim();
      const prefix = `refs/remotes/${remote}/`;
      if (result.exitCode !== 0 || !target.startsWith(prefix) || target.length === prefix.length)
        return null;
      return { ref: target.slice("refs/remotes/".length), branch: target.slice(prefix.length) };
    }).pipe(Effect.orElseSucceed(() => null));

  const containedIn = (projectRoot: string, head: string, ref: string) =>
    git(projectRoot, ["merge-base", "--is-ancestor", head, `refs/remotes/${ref}`], 4096).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

  /** The forge spends one of `reads` (none left, or past its deadline: no read). */
  const spend = (reads: MergeProofReads | null) => {
    if (reads === null || reads.remaining <= 0 || now() >= reads.deadline) return null;
    reads.remaining--;
    return Math.max(1, Math.min(MERGE_PROOF_READ_TIMEOUT_MS, reads.deadline - now()));
  };

  const pullRequestFacts = (projectRoot: string, number: number, reads: MergeProofReads | null) =>
    Effect.gen(function* () {
      const key = `${projectRoot}\u0000${number}`;
      const known = pullRequests.get(key);
      if (known) return known.value;
      const timeoutMs = spend(reads);
      if (timeoutMs === null) return null;
      // `undefined`: no answer in time.
      const answer = yield* deps.providers.resolve({ cwd: projectRoot }).pipe(
        Effect.flatMap((provider) =>
          provider.getChangeRequest({ cwd: projectRoot, reference: String(number) }),
        ),
        Effect.timeoutOption(timeoutMs),
        Effect.map((found) =>
          found._tag === "None" ? undefined : found.value.number === number ? found.value : null,
        ),
        Effect.orElseSucceed(() => null),
      );
      // Cut short by the caller's deadline (the last of a listing's reads), not by the forge:
      // nothing to keep, so a review with a read of its own asks again.
      if (answer === undefined && timeoutMs < MERGE_PROOF_READ_TIMEOUT_MS) return null;
      const read = answer ?? null;
      const facts: PullRequestFacts | null =
        read === null
          ? null
          : {
              state: read.state,
              baseRefName: read.baseRefName,
              ...(read.headSha !== undefined ? { headSha: read.headSha } : {}),
            };
      pullRequests.set(key, facts, facts?.state === "merged" ? MERGED_TTL_MS : UNSETTLED_TTL_MS);
      return facts;
    });

  /** The default branch when Git has no remote HEAD: the forge's answer, kept a while. */
  const forgeDefaultBranch = (projectRoot: string, reads: MergeProofReads | null) =>
    Effect.gen(function* () {
      const known = defaultBranches.get(projectRoot);
      if (known) return known.value;
      const timeoutMs = spend(reads);
      if (timeoutMs === null) return null;
      const branch = yield* deps.providers.resolve({ cwd: projectRoot }).pipe(
        Effect.flatMap((provider) => provider.getDefaultBranch({ cwd: projectRoot })),
        Effect.timeoutOption(timeoutMs),
        Effect.map((found) => (found._tag === "Some" ? found.value : null)),
        Effect.orElseSucceed(() => null),
      );
      if (branch) defaultBranches.set(projectRoot, branch, DEFAULT_BRANCH_TTL_MS);
      return branch;
    });

  const prove: CheckoutMergeProverShape["prove"] = (input) =>
    Effect.gen(function* () {
      const head = input.head.toLowerCase();
      if (!COMMIT.test(head)) return null;
      const remote =
        input.remoteDefault !== undefined
          ? input.remoteDefault
          : yield* remoteDefault(input.projectRoot);
      if (remote) {
        const contained =
          input.remoteDefault && input.branch
            ? !input.remoteDefault.outside.has(input.branch)
            : yield* containedIn(input.projectRoot, head, remote.ref);
        if (contained)
          return { kind: "default-branch", head, ref: remote.ref } satisfies CheckoutMergeProof;
      }
      const link = input.pullRequest;
      if (
        link === null ||
        link.state !== "merged" ||
        !Number.isSafeInteger(link.number) ||
        link.number <= 0
      )
        return null;
      const pr = yield* pullRequestFacts(input.projectRoot, link.number, input.reads);
      if (pr === null || pr.state !== "merged") return null;
      const defaultBranch =
        remote?.branch ?? (yield* forgeDefaultBranch(input.projectRoot, input.reads));
      if (!defaultBranch || !pullRequestProvesMerge(pr, { head, defaultBranch })) return null;
      return {
        kind: "pull-request",
        head,
        number: link.number,
        baseRefName: pr.baseRefName,
      } satisfies CheckoutMergeProof;
    }).pipe(Effect.catchDefect(() => Effect.succeed(null)));

  const remoteDefaultBranches: CheckoutMergeProverShape["remoteDefaultBranches"] = (projectRoot) =>
    Effect.gen(function* () {
      const remote = yield* remoteDefault(projectRoot);
      if (!remote) return null;
      const listing = yield* git(
        projectRoot,
        [
          "for-each-ref",
          `--no-merged=refs/remotes/${remote.ref}`,
          "--format=%(refname)",
          "refs/heads",
        ],
        4 * 1024 * 1024,
      );
      if (listing.exitCode !== 0 || listing.stdoutTruncated) return null;
      const outside = new Set(
        listing.stdout
          .split("\n")
          .flatMap((refname) =>
            refname.startsWith("refs/heads/") ? [refname.slice("refs/heads/".length)] : [],
          ),
      );
      return { ...remote, outside } satisfies RemoteDefaultBranches;
    }).pipe(
      Effect.orElseSucceed(() => null),
      Effect.catchDefect(() => Effect.succeed(null)),
    );

  return { prove, remoteDefaultBranches };
};
