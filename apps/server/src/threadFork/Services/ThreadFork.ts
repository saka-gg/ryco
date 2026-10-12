/**
 * ThreadFork - branches a thread at the reply of a completed turn into a new thread.
 *
 * One server operation serves every client (`threads.fork`). A request is keyed by a
 * client-chosen fork key: it is accepted once (the boundary, destination and provider strategy
 * are pinned in the `thread_forks` ledger before anything is created), then run through
 * resumable phases (checkout, provider copy, attachments, publication). A retry with the same key
 * joins or resumes the same fork. The node finishes an unfinished fork on its own as well: at
 * startup, after a run stopped (with a growing wait), and in a periodic sweep; a fork whose runs
 * keep stopping is cleaned up and recorded as failed instead.
 * See docs/thread-forks.md.
 *
 * @module ThreadFork
 */
import type {
  ThreadForkAttemptState,
  ThreadForkError,
  ThreadForkInput,
  ThreadForkKey,
  ThreadForkResult,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ThreadForkShape {
  /**
   * Creates (or returns) the fork a key names. Idempotent per key: a completed fork answers
   * with its stored result (`replayed`), an unfinished one resumes, and the same key with a
   * different request fails with `idempotency-conflict`. The work runs detached from the
   * caller, so a dropped connection never cuts a fork off halfway.
   */
  readonly fork: (input: ThreadForkInput) => Effect.Effect<ThreadForkResult, ThreadForkError>;
  /**
   * What the node holds for a key, for an error reported before `fork` ran (e.g. the startup
   * gate refused it): `running` while an attempt runs here or its row is unfinished, also when
   * the ledger cannot be read, so a client never starts a second fork meanwhile.
   */
  readonly attemptState: (forkKey: ThreadForkKey) => Effect.Effect<ThreadForkAttemptState>;
  /**
   * One recovery sweep: settles retryable failures nobody retried within the retry window, then
   * resumes every unfinished fork no attempt is running or scheduled for (at startup: every fork
   * an earlier process left unfinished). Never fails; outcomes are logged.
   */
  readonly recover: () => Effect.Effect<void>;
}

export class ThreadFork extends Context.Service<ThreadFork, ThreadForkShape>()(
  "ryco/threadFork/Services/ThreadFork",
) {}
