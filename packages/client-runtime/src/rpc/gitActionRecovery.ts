import type {
  EnvironmentId,
  GitActionRecoveryState,
  GitRunStackedActionInput,
  GitRunStackedActionOptions,
  GitRunStackedActionResult,
} from "@ryco/contracts";
import {
  GitActionResultUnavailableError,
  type GitActionResultUnavailableReason,
} from "@ryco/contracts/git";

import { hasErrorTag, isAwaitingAdmission, RpcRequestRefusedError } from "./protocol.ts";
import type { WsRpcClient } from "./wsRpcClient.ts";
import {
  isRpcTransportFailure,
  isUnsupportedRpcError,
  RpcTransportDisposedError,
} from "./wsTransport.ts";

/**
 * How long a dropped action waits for a connection that can follow it again,
 * counted from its last progress or the environment's last new connection. The
 * node keeps a settled outcome for as long (`GIT_ACTION_RECEIPT_TTL_MS`).
 */
export const GIT_ACTION_RESUME_HORIZON_MS = 30 * 60_000;
/** First delay before following again on a connection that failed to carry a resume. */
export const GIT_ACTION_RESUME_RETRY_MIN_MS = 500;
export const GIT_ACTION_RESUME_RETRY_MAX_MS = 8_000;

/**
 * The typed errors a node answers a stacked action with (the error unions of
 * `git.runStackedAction` and `git.resumeStackedAction`). Each one is the
 * action's outcome, never a lost connection.
 */
const GIT_ACTION_NODE_ERROR_TAGS = [
  "GitManagerError",
  "GitCommandError",
  "GitStagedIndexChangedError",
  "SourceControlProviderError",
  "TextGenerationError",
  "GitActionStoppedError",
  "AuthRpcError",
] as const;

function isGitActionNodeError(error: unknown): boolean {
  return GIT_ACTION_NODE_ERROR_TAGS.some((tag) => hasErrorTag(error, tag));
}

/**
 * Whether a recoverable start's failure is its outcome: this client refused it
 * or its transport was gone before sending, or the node answered with a typed
 * error. Anything else may have left the action running on the node, so the
 * client follows it again; that only observes, so doing it once too often is
 * harmless.
 */
function isDefiniteStartFailure(error: unknown): boolean {
  return (
    error instanceof RpcRequestRefusedError ||
    error instanceof RpcTransportDisposedError ||
    isGitActionNodeError(error)
  );
}

/** Whether a connection may carry a resume now, and when that may have changed. */
export interface GitActionRecoveryReadiness {
  readonly read: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface GitActionRecoveryTimers {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  /** Receives exactly what {@link setTimeout} returned. */
  readonly clearTimeout: (timer: unknown) => void;
}

export interface GitActionRecoveryAttachmentInput {
  readonly environmentId: EnvironmentId;
  readonly git: Pick<WsRpcClient["git"], "runStackedAction" | "resumeStackedAction">;
  /**
   * Connected, on the current lifecycle generation, with a shell snapshot
   * accepted on the current socket attempt (hosted: the session is adoptable).
   */
  readonly readiness: GitActionRecoveryReadiness;
  /**
   * The connection is not disposed and its lifecycle generation is still the
   * owner's current one. Progress is forwarded only while this holds.
   */
  readonly isCurrent: () => boolean;
  /** The node said on this connection that recoverable actions outlive their request. */
  readonly supportsRecoverable: () => boolean;
  /** The connection belongs to the hosted account session; see `endAccountSession`. */
  readonly accountBound: boolean;
  /**
   * Hosted connections only: make the environment's delivery unknown. Called when a
   * request-owned action may have been lost with this connection; see
   * `bindHostedGitActionDelivery`.
   */
  readonly markUncertain?: () => void;
}

export interface GitActionRecoveryAttachment {
  /** The connection's `git.runStackedAction`, with recovery for callers that ask for it. */
  readonly runStackedAction: WsRpcClient["git"]["runStackedAction"];
  /** The connection is being disposed: it carries no resume from now on. */
  readonly detach: () => void;
}

interface Attachment extends GitActionRecoveryAttachmentInput {
  detached: boolean;
  unwatch: (() => void) | null;
}

interface Flight {
  readonly environmentId: EnvironmentId;
  readonly accountBound: boolean;
  readonly accountSession: number;
  readonly epoch: number;
  deadline: number;
}

interface Waiter {
  readonly flight: Flight;
  readonly check: () => void;
}

interface EnvironmentAttachments {
  /** In attach order: the newest last. */
  readonly attachments: Attachment[];
  readonly waiters: Set<Waiter>;
}

/** A failed resume, and from when the same uninterrupted connection may carry the next one. */
interface Retry {
  readonly attachment: Attachment;
  readonly notBefore: number;
}

type WaitOutcome = Attachment | Extract<GitActionResultUnavailableReason, "ended" | "expired">;

const defaultTimers: GitActionRecoveryTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function isLive(attachment: Attachment): boolean {
  return !attachment.detached && attachment.isCurrent();
}

/**
 * Whether a request-owned start's failure may have left it running, or half done, on the node:
 * its socket failed while it was in flight, or its connection was disposed or replaced under it.
 * A refusal, a transport disposed before sending, or the node's own answer (an interruption on a
 * live connection included) is its outcome.
 */
function isLostWithConnection(origin: Attachment, error: unknown): boolean {
  if (hasErrorTag(error, "RpcClientError")) return true;
  return (
    isRpcTransportFailure(error) && !(error instanceof RpcTransportDisposedError) && !isLive(origin)
  );
}

/** Reports a recovery state. A caller's notice that throws never ends the run. */
function notifyRecoveryState(
  options: GitRunStackedActionOptions | undefined,
  state: GitActionRecoveryState,
): void {
  try {
    options?.onRecoveryState?.(state);
  } catch {
    // The action's outcome still reaches the caller through the promise.
  }
}

function retryDelayMs(failures: number): number {
  return Math.min(
    GIT_ACTION_RESUME_RETRY_MAX_MS,
    GIT_ACTION_RESUME_RETRY_MIN_MS * 2 ** Math.min(Math.max(failures - 1, 0), 16),
  );
}

/**
 * Follows a recoverable Git action again after its connection drops.
 *
 * A caller asks for recovery per call (`runStackedAction(input, { recoverable: true })`), and
 * only a caller that offers Stop should: closing the client no longer stops the action. The run
 * is recoverable when the node it goes to advertises `recoverableGitActions` on that
 * connection; otherwise it is today's request-owned action and a drop fails it.
 *
 * A recoverable start that ends without a definite answer waits until some connection of the
 * same environment is ready again (newest first: overlapping connection attempts may come and
 * go), then sends `git.resumeStackedAction` with the same input. A resume never starts Git, so
 * repeating it is harmless, and `runStackedAction` is never sent twice for one action. The node
 * answers with the action's progress and outcome, or `GitActionResultUnavailableError` when it
 * holds no record of the action; then the caller asks the user to check the repository.
 *
 * Progress is forwarded only from a connection that is still attached and on its current
 * lifecycle generation, so a replaced hosted generation publishes nothing. In-flight actions
 * are held in memory only: a reloaded client cannot follow them again.
 */
export class GitActionRecovery {
  readonly #timers: GitActionRecoveryTimers;
  readonly #environments = new Map<EnvironmentId, EnvironmentAttachments>();
  #accountSession = 0;
  #epoch = 0;

  constructor(timers: GitActionRecoveryTimers = defaultTimers) {
    this.#timers = timers;
  }

  /** Registers one connection of an environment; returns its wrapped `git.runStackedAction`. */
  attach(input: GitActionRecoveryAttachmentInput): GitActionRecoveryAttachment {
    const attachment: Attachment = { ...input, detached: false, unwatch: null };
    const environment = this.#entry(input.environmentId);
    environment.attachments.push(attachment);
    if (environment.waiters.size > 0) {
      this.#watch(attachment);
      // A new connection gives every waiting action another horizon to reach it.
      const deadline = this.#timers.now() + GIT_ACTION_RESUME_HORIZON_MS;
      for (const waiter of environment.waiters) {
        waiter.flight.deadline = Math.max(waiter.flight.deadline, deadline);
      }
      this.#wake(input.environmentId);
    }
    return {
      runStackedAction: (runInput, options) => this.#run(attachment, runInput, options),
      detach: () => this.#detach(attachment),
    };
  }

  /**
   * The hosted account session ended (sign-out or account change). Every action started on
   * one of its connections that waits to be followed again fails with
   * `GitActionResultUnavailableError("ended")`.
   */
  endAccountSession(): void {
    this.#accountSession += 1;
    for (const environmentId of Array.from(this.#environments.keys())) this.#wake(environmentId);
  }

  resetForTests(): void {
    this.#accountSession += 1;
    this.#epoch += 1;
    for (const environmentId of Array.from(this.#environments.keys())) this.#wake(environmentId);
    for (const environment of this.#environments.values()) {
      for (const attachment of environment.attachments) {
        attachment.detached = true;
        attachment.unwatch?.();
        attachment.unwatch = null;
      }
    }
    this.#environments.clear();
  }

  async #run(
    origin: Attachment,
    input: GitRunStackedActionInput,
    options: GitRunStackedActionOptions | undefined,
  ): Promise<GitRunStackedActionResult> {
    // The wire key is set here only: a run outlives its connection when its caller asked and
    // the node it goes to supports it.
    const { recoverable: _requested, ...request } = input;
    const recoverable = options?.recoverable === true && origin.supportsRecoverable();
    notifyRecoveryState(options, { kind: "started", recoverable });
    const onProgress = options?.onProgress;
    const flight: Flight = {
      environmentId: origin.environmentId,
      accountBound: origin.accountBound,
      accountSession: this.#accountSession,
      epoch: this.#epoch,
      deadline: Number.POSITIVE_INFINITY,
    };
    if (!recoverable) {
      try {
        return await origin.git.runStackedAction(request, onProgress ? { onProgress } : undefined);
      } catch (error) {
        // Nothing follows it again, so its delivery stays unknown, as any other mutation lost
        // with its connection would leave it. An account session that ended has none to hold.
        if (!this.#isOver(flight) && isLostWithConnection(origin, error)) {
          try {
            origin.markUncertain?.();
          } catch {
            // Marking is best effort; the caller still gets the failure.
          }
        }
        throw error;
      }
    }
    // A recoverable start's outcome is the recovery's to report: the node's answer, a resume's,
    // or `GitActionResultUnavailableError`. It never makes the environment's delivery unknown.
    try {
      return await origin.git.runStackedAction(
        { ...request, recoverable: true },
        {
          onProgress: (event) => {
            if (isLive(origin)) onProgress?.(event);
          },
        },
      );
    } catch (error) {
      if (isDefiniteStartFailure(error)) throw error;
    }
    return this.#reattach(flight, request, options);
  }

  async #reattach(
    flight: Flight,
    request: GitRunStackedActionInput,
    options: GitRunStackedActionOptions | undefined,
  ): Promise<GitRunStackedActionResult> {
    flight.deadline = this.#timers.now() + GIT_ACTION_RESUME_HORIZON_MS;
    notifyRecoveryState(options, { kind: "reconnecting" });
    let following = false;
    let failures = 0;
    let retry: Retry | null = null;
    for (;;) {
      const target = await this.#waitForTarget(flight, retry);
      if (target === "ended" || target === "expired") {
        throw new GitActionResultUnavailableError({ actionId: request.actionId, reason: target });
      }
      let delivered = false;
      try {
        return await target.git.resumeStackedAction(request, {
          onProgress: (event) => {
            delivered = true;
            flight.deadline = this.#timers.now() + GIT_ACTION_RESUME_HORIZON_MS;
            if (!isLive(target)) return;
            if (!following) {
              following = true;
              notifyRecoveryState(options, { kind: "reattached" });
            }
            options?.onProgress?.(event);
          },
        });
      } catch (error) {
        if (isGitActionNodeError(error) || hasErrorTag(error, "GitActionResultUnavailableError")) {
          throw error;
        }
        if (isUnsupportedRpcError(error)) {
          // An older (or downgraded) node: it cannot follow the action, and nothing re-runs it.
          throw new GitActionResultUnavailableError({
            actionId: request.actionId,
            reason: "unsupported",
          });
        }
        const lost = !isLive(target) || !target.readiness.read();
        if (!lost && !isAwaitingAdmission(error) && !isRpcTransportFailure(error)) {
          // A live, current connection answered: a node defect, not a drop. Never loop on it.
          throw error;
        }
        if (following) {
          following = false;
          notifyRecoveryState(options, { kind: "reconnecting" });
        }
        failures = delivered ? 1 : failures + 1;
        retry = { attachment: target, notBefore: this.#timers.now() + retryDelayMs(failures) };
      }
    }
  }

  /**
   * Resolves with the newest attached connection of the flight's environment that is ready,
   * or why the flight stops waiting. A connection that just failed a resume is used again
   * only after its retry delay, unless it went down in between (a fresh attempt).
   */
  #waitForTarget(flight: Flight, retry: Retry | null): Promise<WaitOutcome> {
    return new Promise((resolve) => {
      const environment = this.#entry(flight.environmentId);
      let timer: unknown = null;
      let retryWentDown = false;
      const waiter: Waiter = {
        flight,
        check: () => {
          if (timer !== null) {
            this.#timers.clearTimeout(timer);
            timer = null;
          }
          const settle = (outcome: WaitOutcome) => {
            environment.waiters.delete(waiter);
            this.#unwatchIfIdle(flight.environmentId);
            resolve(outcome);
          };
          if (this.#isOver(flight)) return settle("ended");
          const now = this.#timers.now();
          if (now >= flight.deadline) return settle("expired");
          if (
            retry !== null &&
            !retryWentDown &&
            (retry.attachment.detached || !retry.attachment.readiness.read())
          ) {
            retryWentDown = true;
          }
          const holdUntil = retry !== null && !retryWentDown ? retry.notBefore : 0;
          for (let index = environment.attachments.length - 1; index >= 0; index -= 1) {
            const candidate = environment.attachments[index]!;
            if (candidate === retry?.attachment && now < holdUntil) continue;
            if (candidate.readiness.read()) return settle(candidate);
          }
          const wakeAt = holdUntil > now ? Math.min(holdUntil, flight.deadline) : flight.deadline;
          timer = this.#timers.setTimeout(waiter.check, Math.max(0, wakeAt - now));
        },
      };
      environment.waiters.add(waiter);
      for (const attachment of environment.attachments) this.#watch(attachment);
      waiter.check();
    });
  }

  #isOver(flight: Flight): boolean {
    return (
      flight.epoch !== this.#epoch ||
      (flight.accountBound && flight.accountSession !== this.#accountSession)
    );
  }

  #entry(environmentId: EnvironmentId): EnvironmentAttachments {
    let environment = this.#environments.get(environmentId);
    if (!environment) {
      environment = { attachments: [], waiters: new Set() };
      this.#environments.set(environmentId, environment);
    }
    return environment;
  }

  /** Readiness is observed only while an action of the environment waits. */
  #watch(attachment: Attachment): void {
    if (attachment.unwatch !== null || attachment.detached) return;
    attachment.unwatch = attachment.readiness.subscribe(() => this.#wake(attachment.environmentId));
  }

  #wake(environmentId: EnvironmentId): void {
    const environment = this.#environments.get(environmentId);
    if (!environment) return;
    for (const waiter of Array.from(environment.waiters)) waiter.check();
  }

  #unwatchIfIdle(environmentId: EnvironmentId): void {
    const environment = this.#environments.get(environmentId);
    if (!environment || environment.waiters.size > 0) return;
    for (const attachment of environment.attachments) {
      attachment.unwatch?.();
      attachment.unwatch = null;
    }
    if (environment.attachments.length === 0) this.#environments.delete(environmentId);
  }

  #detach(attachment: Attachment): void {
    if (attachment.detached) return;
    attachment.detached = true;
    attachment.unwatch?.();
    attachment.unwatch = null;
    const environment = this.#environments.get(attachment.environmentId);
    if (!environment) return;
    const index = environment.attachments.indexOf(attachment);
    if (index !== -1) environment.attachments.splice(index, 1);
    if (environment.waiters.size > 0) this.#wake(attachment.environmentId);
    else if (environment.attachments.length === 0) {
      this.#environments.delete(attachment.environmentId);
    }
  }
}

let gitActionRecovery: GitActionRecovery | null = null;

/** The process-wide recovery every environment connection attaches to. */
export function getGitActionRecovery(): GitActionRecovery {
  gitActionRecovery ??= new GitActionRecovery();
  return gitActionRecovery;
}

/**
 * One hosted connection's claim on its `git.runStackedAction` deliveries. Pass it to the relay
 * attempt factory's `lifecycleHandlers` and to `createEnvironmentConnection`. Once the
 * connection's recovery is attached it answers for every start: it follows a recoverable one
 * again, and marks the environment's delivery unknown for a request-owned one lost with its
 * connection. So the factory stops counting them, and an action the recovery follows again no
 * longer holds every mutation of the session (stopping that action included) for the user's
 * acknowledgement. Until then they are tracked like any other mutation. The claim never makes a
 * session ready: mutations still wait for a fresh relay attempt and the session's own accepted
 * snapshot.
 */
export interface HostedGitActionDeliveryBinding {
  readonly ownsGitActionStarts: () => boolean;
  /** Make the environment's delivery unknown, whatever the generation. */
  readonly markUncertain: () => void;
  /** The connection's recovery is attached and answers for its starts from now on. */
  readonly claim: () => void;
}

export function bindHostedGitActionDelivery(
  markUncertain: () => void,
): HostedGitActionDeliveryBinding {
  let claimed = false;
  return {
    ownsGitActionStarts: () => claimed,
    markUncertain,
    claim: () => {
      claimed = true;
    },
  };
}
