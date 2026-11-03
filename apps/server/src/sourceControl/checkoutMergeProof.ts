/**
 * Proof that a checkout's commits are merged although the project HEAD does not contain them:
 * the remote default branch contains them, or the workspace's pull request merged into the
 * default branch at exactly that commit (a squash or rebase merge). A proof only lets removal
 * go ahead where unmerged commits would block it; nothing is removed or suggested because of one.
 * The implementation (`checkoutMergeProver.ts`) loads on first use, off the boot path.
 */
import { Context, Effect, Layer } from "effect";
import type { PullRequestState } from "@ryco/contracts";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";

export type CheckoutMergeProof =
  /** `ref` is the remote default branch as Git names it, e.g. `origin/main`. */
  | { readonly kind: "default-branch"; readonly head: string; readonly ref: string }
  | {
      readonly kind: "pull-request";
      readonly head: string;
      readonly number: number;
      readonly baseRefName: string;
    };

/** The proof in words: "merged through pull request #7", "contained in origin/main". */
export const describeMergeProof = (proof: CheckoutMergeProof) =>
  proof.kind === "pull-request"
    ? `merged through pull request #${proof.number}`
    : `contained in ${proof.ref}`;

/** Forge reads a caller may spend on pull request proofs; a listing shares one between rows. */
export interface MergeProofReads {
  remaining: number;
  readonly deadline: number;
}
export const mergeProofReads = (reads: number, ms: number): MergeProofReads => ({
  remaining: reads,
  deadline: Date.now() + ms,
});
/** One reviewed or removed checkout. */
export const reviewMergeProofReads = () => mergeProofReads(1, 15_000);
/** One listing, scan page or suggestion run, shared by its checkouts. */
export const listingMergeProofReads = () => mergeProofReads(3, 10_000);

/** A workspace's current pull request link, as a proof reads it; null when it links none. */
export const workspacePullRequestLink = (worktree: {
  readonly prNumber: number | null;
  readonly prState?: PullRequestState | null | undefined;
}) =>
  worktree.prNumber === null
    ? null
    : { number: worktree.prNumber, state: worktree.prState ?? null };

/** A repository's remote default branch and the local branches it does not contain. */
export interface RemoteDefaultBranches {
  /** `origin/main`. */
  readonly ref: string;
  /** `main`: what a pull request must have merged into. */
  readonly branch: string;
  /** Local branch names with commits `ref` does not contain. */
  readonly outside: ReadonlySet<string>;
}

export interface CheckoutMergeProverShape {
  /** Null when nothing proves `head` merged. Never fails and never fetches. */
  readonly prove: (input: {
    readonly projectRoot: string;
    readonly head: string;
    /** The checkout's branch; with `remoteDefault`, answers containment without Git. */
    readonly branch?: string | null | undefined;
    /** The workspace's current pull request link. */
    readonly pullRequest: {
      readonly number: number;
      readonly state: PullRequestState | null;
    } | null;
    /** Null: only what is already known (no forge read). */
    readonly reads: MergeProofReads | null;
    /** Read once for a listing (`remoteDefaultBranches`); absent: read here. */
    readonly remoteDefault?: RemoteDefaultBranches | null | undefined;
  }) => Effect.Effect<CheckoutMergeProof | null>;
  readonly remoteDefaultBranches: (
    projectRoot: string,
  ) => Effect.Effect<RemoteDefaultBranches | null>;
}

export class CheckoutMergeProver extends Context.Service<
  CheckoutMergeProver,
  CheckoutMergeProverShape
>()("ryco/sourceControl/CheckoutMergeProver") {}

export const CheckoutMergeProverLive = Layer.effect(
  CheckoutMergeProver,
  Effect.gen(function* () {
    const deps = { git: yield* GitVcsDriver, providers: yield* SourceControlProviderRegistry };
    const prover = yield* Effect.cached(
      Effect.promise(() => import("./checkoutMergeProver.ts")).pipe(
        Effect.map(({ makeCheckoutMergeProver }) => makeCheckoutMergeProver(deps)),
      ),
    );
    // Never fails, not even when the implementation cannot load: no proof is the safe answer.
    const none = Effect.catchDefect(() => Effect.succeed(null));
    return {
      prove: (input) => Effect.flatMap(prover, (live) => live.prove(input)).pipe(none),
      remoteDefaultBranches: (projectRoot) =>
        Effect.flatMap(prover, (live) => live.remoteDefaultBranches(projectRoot)).pipe(none),
    } satisfies CheckoutMergeProverShape;
  }),
);
