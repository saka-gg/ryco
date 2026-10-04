import type { ClientOrchestrationCommand, EnvironmentId } from "@ryco/contracts";

import {
  getHostedRuntimeConfiguration,
  type HostedRuntimeTimers,
} from "../authorization/runtime.ts";
import type { HostedHubState } from "../authorization/state.ts";
import { isAwaitingAdmission, RpcRequestRefusedError } from "../rpc/protocol.ts";
import type { WsRpcClient } from "../rpc/wsRpcClient.ts";
import { RpcTransportDisposedError } from "../rpc/wsTransport.ts";
import type { HostedReceiptedRequestOwner } from "./transport.ts";

type DispatchCommand = WsRpcClient["orchestration"]["dispatchCommand"];

/**
 * How long after it was sent an orchestration command stays eligible for its
 * one replay. Any future receipt retention must outlive this horizon.
 */
export const HOSTED_DISPATCH_REPLAY_HORIZON_MS = 120_000;

export const HOSTED_DISPATCH_UNCONFIRMED_MESSAGE =
  "The connection dropped before this machine confirmed the action. Check the thread before sending it again.";

/** The command may or may not have run; Ryco could not confirm it within the replay horizon. */
export class HostedDispatchUnconfirmedError extends Error {
  constructor() {
    super(HOSTED_DISPATCH_UNCONFIRMED_MESSAGE);
    this.name = "HostedDispatchUnconfirmedError";
  }
}

/**
 * The account an attempt serves. A replay never crosses accounts. Hub session
 * ids do not take part: `restoreSession` re-mints one on every foreground, and
 * that is the same account session continuing. Signing out or expiring ends the
 * account session instead (`HostedDispatchReplay.endAccountSession`).
 */
export function hostedDispatchLineage(
  state: Pick<HostedHubState, "accountStatus" | "account">,
): string | null {
  if (state.accountStatus !== "authenticated" || !state.account) return null;
  return state.account.id;
}

function hasTag(error: unknown, tag: string): boolean {
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === tag;
}

/**
 * Effect's `Cause.squash` of a cause made only of interruptions: what a request
 * rejects with when its client is disposed or reconnected mid-request, or when
 * the node interrupts it on its way down. The wire test pins it.
 */
const INTERRUPTED_WITHOUT_ERROR = "All fibers interrupted without error";

/**
 * Whether the transport gave up on the request rather than the node answering
 * it: every socket failure reaches a pending request as an `RpcClientError`, a
 * disposal or reconnect interrupts it, and a disposed transport sends nothing.
 */
function isTransportFailure(error: unknown): boolean {
  return (
    hasTag(error, "RpcClientError") ||
    error instanceof RpcTransportDisposedError ||
    (error instanceof Error && error.message === INTERRUPTED_WITHOUT_ERROR)
  );
}

/**
 * Whether a first attempt's failure leaves its outcome unknown. A refusal by
 * this client before sending and the node's typed answer are always definite.
 * Otherwise only a failure of the transport itself is unknown — or any failure
 * at all once the attempt's connection was lost after the send, so a drop that
 * surfaces in a shape not recognised here still stays on the safe side.
 * Anything else the node answered on a live connection, such as the defect it
 * returns for a payload it cannot decode, is that request's outcome: holding it
 * would wait for a readiness that never comes, then misreport it as a drop.
 */
function isDeliveryUnknown(error: unknown, lostSinceSend: boolean): boolean {
  if (error instanceof RpcRequestRefusedError) return false;
  if (hasTag(error, "OrchestrationDispatchCommandError") || hasTag(error, "AuthRpcError")) {
    return false;
  }
  return lostSinceSend || isTransportFailure(error);
}

/**
 * Whether a replay's failure is the command's own outcome. The node consults
 * the command's receipt (or its still-running first attempt) before anything
 * else that could fail, so its command error is the original answer — except
 * for a bootstrap turn start: it creates its thread and worktree before its
 * receipt exists, so a first attempt cut off halfway by a node restart makes
 * the replay fail on what that attempt already created. A replay refused by
 * the node's role check, refused locally, or lost to a second drop says
 * nothing about the first attempt. (A replay refused only for now was never
 * sent, and waits for the next readiness instead.)
 */
function isReplayAnswer(command: ClientOrchestrationCommand, error: unknown): boolean {
  if (!hasTag(error, "OrchestrationDispatchCommandError")) return false;
  return !(command.type === "thread.turn.start" && command.bootstrap !== undefined);
}

interface Attempt {
  readonly lineage: string;
  /** The account session the attempt was bound in; see `endAccountSession`. */
  readonly accountSession: number;
  /** The visit to its environment the attempt was bound in; see `end`. */
  readonly visit: number;
  readonly dispatch: DispatchCommand;
  readonly markUncertain: () => void;
  /** How often its connection was lost, dropped or replaced; see `isDeliveryUnknown`. */
  losses: number;
}

type Replacement =
  | { readonly kind: "ready"; readonly attempt: Attempt }
  /** The environment or account session is gone; no session is left to hold. */
  | { readonly kind: "ended" }
  | { readonly kind: "expired" };

interface Waiter {
  readonly origin: Attempt;
  readonly readyAfter: number;
  readonly settle: (replacement: Replacement) => void;
}

const ENDED: Replacement = { kind: "ended" };
const EXPIRED: Replacement = { kind: "expired" };

/** Bound in the same account session and the same visit to the environment. */
function sameVisit(left: Attempt, right: Attempt): boolean {
  return (
    left.lineage === right.lineage &&
    left.accountSession === right.accountSession &&
    left.visit === right.visit
  );
}

/**
 * Replays `orchestration.dispatchCommand` — and only it — once after a hosted
 * reconnect.
 *
 * A relay drop leaves an in-flight command's outcome unknown. The node answers a
 * repeated `commandId` from the receipt it persists in the same transaction as
 * the command's events (or from the first attempt, while that still runs), so
 * sending the identical envelope again is safe: it either runs the command for
 * the first time or returns the original result. Every other non-read request
 * stays uncertain and is never replayed.
 *
 * The caller's promise stays pending through the reconnect, so the composer
 * neither reports a failure nor invites a resend under a new id. The replay is
 * sent only after the environment's session has completed the hosted lifecycle
 * again — fresh ticket, handshake, and accepted snapshot — since the failure,
 * which `markReady` signals, and only within the same account session and the
 * same visit to the environment. The session's own request authorization still
 * applies, and the node re-authorizes the replay under the current role.
 * Envelopes are held in memory only. When the replay cannot settle the outcome,
 * the caller gets `HostedDispatchUnconfirmedError` and the environment is
 * marked delivery unknown, exactly as an untracked mutation would have left it.
 *
 * Readiness is bound to the environment and account session rather than to a
 * hosted generation: every recovery publishes a new generation, and readiness
 * is only ever published through generation-fenced paths.
 */
export class HostedDispatchReplay {
  readonly #timers: () => HostedRuntimeTimers;
  readonly #latest = new Map<EnvironmentId, Attempt>();
  readonly #readySequence = new Map<EnvironmentId, number>();
  readonly #waiters = new Map<EnvironmentId, Set<Waiter>>();
  /** How often each environment was left; every return to it is a new visit. */
  readonly #departures = new Map<EnvironmentId, number>();
  #accountSession = 0;

  constructor(timers: () => HostedRuntimeTimers) {
    this.#timers = timers;
  }

  /**
   * Bind one hosted connection attempt's raw dispatch. The returned dispatch
   * replays through whichever attempt for the environment becomes ready next.
   */
  attach(input: {
    readonly environmentId: EnvironmentId;
    readonly lineage: string;
    readonly dispatch: DispatchCommand;
    /** Mark the environment delivery unknown; called when a replay gives up. */
    readonly markUncertain: () => void;
  }): {
    readonly dispatch: DispatchCommand;
    /** The connection dropped or is being replaced: what it has in flight may not have arrived. */
    readonly lost: () => void;
    /** The attempt's client is being disposed; it is no longer a replay target. */
    readonly detach: () => void;
  } {
    const { environmentId } = input;
    const attempt: Attempt = {
      lineage: input.lineage,
      accountSession: this.#accountSession,
      visit: this.#visit(environmentId),
      dispatch: input.dispatch,
      markUncertain: input.markUncertain,
      losses: 0,
    };
    this.#latest.set(environmentId, attempt);
    // A different account took the environment over.
    this.#settleWaiters(environmentId, (waiter) =>
      sameVisit(waiter.origin, attempt) ? undefined : ENDED,
    );
    const lost = () => {
      attempt.losses += 1;
    };
    return {
      dispatch: (command) => this.#dispatch(environmentId, attempt, command),
      lost,
      detach: () => {
        lost();
        if (this.#latest.get(environmentId) === attempt) this.#latest.delete(environmentId);
      },
    };
  }

  /** The environment's session accepted a current snapshot and admits commands again. */
  markReady(environmentId: EnvironmentId): void {
    const sequence = (this.#readySequence.get(environmentId) ?? 0) + 1;
    this.#readySequence.set(environmentId, sequence);
    const latest = this.#latest.get(environmentId);
    this.#settleWaiters(environmentId, (waiter) => {
      if (!latest) return undefined;
      if (!sameVisit(latest, waiter.origin)) return ENDED;
      return sequence > waiter.readyAfter ? { kind: "ready", attempt: latest } : undefined;
    });
  }

  /**
   * The client left the environment (switch, directory, sign-out). Pending
   * replays fail closed, and so does every command of this visit still in
   * flight — its client is disposed only after this — even when the client
   * returns to the environment within the horizon: returning is a new visit.
   */
  end(environmentId: EnvironmentId): void {
    this.#departures.set(environmentId, this.#visit(environmentId) + 1);
    this.#settleWaiters(environmentId, () => ENDED);
  }

  /**
   * The account session ended (sign-out or expiry). Every pending replay fails
   * closed, and a command still in flight from it will not replay even if the
   * same account signs in again.
   */
  endAccountSession(): void {
    this.#accountSession += 1;
    for (const environmentId of Array.from(this.#waiters.keys())) this.end(environmentId);
    this.#latest.clear();
  }

  resetForTests(): void {
    this.endAccountSession();
    this.#readySequence.clear();
    this.#departures.clear();
  }

  #visit(environmentId: EnvironmentId): number {
    return this.#departures.get(environmentId) ?? 0;
  }

  /** The account session or the visit the attempt was bound in is over. */
  #isOver(environmentId: EnvironmentId, attempt: Attempt): boolean {
    return (
      attempt.accountSession !== this.#accountSession ||
      attempt.visit !== this.#visit(environmentId)
    );
  }

  async #dispatch(
    environmentId: EnvironmentId,
    attempt: Attempt,
    command: ClientOrchestrationCommand,
  ): ReturnType<DispatchCommand> {
    const deadline = this.#timers().now() + HOSTED_DISPATCH_REPLAY_HORIZON_MS;
    const lossesAtSend = attempt.losses;
    try {
      return await attempt.dispatch(command);
    } catch (error) {
      if (!isDeliveryUnknown(error, attempt.losses !== lossesAtSend)) throw error;
    }
    // Only a readiness published after the failure belongs to a session that
    // replaced the one that lost the command.
    let readyAfter = this.#readySequence.get(environmentId) ?? 0;
    for (;;) {
      const replacement = await this.#awaitReplacement(
        environmentId,
        attempt,
        readyAfter,
        deadline,
      );
      if (replacement.kind === "ended") throw new HostedDispatchUnconfirmedError();
      if (replacement.kind === "expired") return this.#unconfirmed(environmentId, attempt);
      readyAfter = this.#readySequence.get(environmentId) ?? 0;
      try {
        return await replacement.attempt.dispatch(command);
      } catch (error) {
        // Refused before sending only for now — the session stopped being
        // current again, or holds mutations for the user's acknowledgement:
        // nothing was sent, so wait for its next readiness.
        if (isAwaitingAdmission(error)) continue;
        // One replay only: anything but the command's own answer leaves the
        // first attempt's outcome unknown.
        if (isReplayAnswer(command, error)) throw error;
        return this.#unconfirmed(environmentId, attempt);
      }
    }
  }

  #unconfirmed(environmentId: EnvironmentId, origin: Attempt): never {
    // An environment the client has left has no session left to hold.
    if (this.#isOver(environmentId, origin)) throw new HostedDispatchUnconfirmedError();
    try {
      origin.markUncertain();
    } catch {
      // Marking is best effort; the caller still learns the outcome is unknown.
    }
    throw new HostedDispatchUnconfirmedError();
  }

  #awaitReplacement(
    environmentId: EnvironmentId,
    origin: Attempt,
    readyAfter: number,
    deadline: number,
  ): Promise<Replacement> {
    if (this.#isOver(environmentId, origin)) return Promise.resolve(ENDED);
    const latest = this.#latest.get(environmentId);
    if (latest && !sameVisit(latest, origin)) return Promise.resolve(ENDED);
    const timers = this.#timers();
    const remaining = deadline - timers.now();
    if (remaining <= 0) return Promise.resolve(EXPIRED);
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(environmentId) ?? new Set<Waiter>();
      const waiter: Waiter = {
        origin,
        readyAfter,
        settle: (replacement) => {
          timers.clearTimeout(timer);
          waiters.delete(waiter);
          if (waiters.size === 0 && this.#waiters.get(environmentId) === waiters) {
            this.#waiters.delete(environmentId);
          }
          resolve(replacement);
        },
      };
      const timer = timers.setTimeout(() => waiter.settle(EXPIRED), remaining);
      waiters.add(waiter);
      this.#waiters.set(environmentId, waiters);
    });
  }

  /** `decide` returns how the waiter settles, or `undefined` to keep waiting. */
  #settleWaiters(
    environmentId: EnvironmentId,
    decide: (waiter: Waiter) => Replacement | undefined,
  ): void {
    const waiters = this.#waiters.get(environmentId);
    if (!waiters) return;
    for (const waiter of Array.from(waiters)) {
      const decision = decide(waiter);
      if (decision !== undefined) waiter.settle(decision);
    }
  }
}

let hostedDispatchReplay: HostedDispatchReplay | null = null;

export function getHostedDispatchReplay(): HostedDispatchReplay {
  hostedDispatchReplay ??= new HostedDispatchReplay(() => getHostedRuntimeConfiguration().timers);
  return hostedDispatchReplay;
}

/**
 * One hosted connection's claim on its orchestration commands. Pass it to the
 * relay attempt factory's `lifecycleHandlers` and wrap the connection's client
 * with it: from then on the client replays its commands itself, so the factory
 * stops counting them as uncertain. If it cannot attach — no environment or no
 * authenticated account — it claims nothing and the factory keeps tracking
 * them, so a dropped command still leaves the session delivery unknown. The
 * factory reports the connection's unexpected closes to it, and the wrapped
 * client its own disposal and reconnects, so that no failure after one of those
 * is taken for the node's answer.
 */
export interface HostedDispatchReplayBinding extends HostedReceiptedRequestOwner {
  readonly wrap: (client: WsRpcClient) => WsRpcClient;
}

export function bindHostedDispatchReplay(input: {
  readonly environmentId: EnvironmentId | null;
  readonly lineage: string | null;
  /** Mark this environment delivery unknown when a replay cannot confirm its command. */
  readonly markUncertain: () => void;
  readonly replay?: HostedDispatchReplay;
}): HostedDispatchReplayBinding {
  let attachment: ReturnType<HostedDispatchReplay["attach"]> | null = null;
  return {
    ownsReceiptedRequests: () => attachment !== null,
    connectionLost: () => attachment?.lost(),
    wrap: (client) => {
      const { environmentId, lineage } = input;
      if (attachment !== null || environmentId === null || lineage === null) return client;
      const attached = (input.replay ?? getHostedDispatchReplay()).attach({
        environmentId,
        lineage,
        dispatch: client.orchestration.dispatchCommand,
        markUncertain: input.markUncertain,
      });
      attachment = attached;
      return {
        ...client,
        dispose: async () => {
          attached.detach();
          await client.dispose();
        },
        reconnect: async () => {
          attached.lost();
          await client.reconnect();
        },
        orchestration: { ...client.orchestration, dispatchCommand: attached.dispatch },
      };
    },
  };
}
