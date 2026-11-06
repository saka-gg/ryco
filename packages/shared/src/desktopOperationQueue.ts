// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
import { AsyncLocalStorage } from "node:async_hooks";

import {
  ComputerLaneScheduler,
  computerExclusiveLane,
  computerKeyedLane,
  computerLanesCover,
  type ComputerLaneClaim,
  type ComputerLaneHold,
} from "./computerLanes.ts";

export interface DesktopOperationContext {
  active: boolean;
  signal?: AbortSignal | undefined;
}

const execution = new AsyncLocalStorage<DesktopOperationContext>();

/** The raw operation context — the `active` half is what admission checks
 * need; `desktopOperationSignal` hides it on purpose for ordinary callers. */
export function desktopOperationContext(): DesktopOperationContext | undefined {
  return execution.getStore();
}

export function desktopOperationSignal(): AbortSignal | undefined {
  const operation = execution.getStore();
  return operation?.active ? operation.signal : undefined;
}

export async function withDesktopOperationSignal<A>(
  signal: AbortSignal,
  action: () => Promise<A>,
): Promise<A> {
  const parent = desktopOperationSignal();
  const scope = { active: true, signal: parent ? AbortSignal.any([parent, signal]) : signal };
  try {
    return await execution.run(scope, action);
  } finally {
    scope.active = false;
  }
}

export function assertDesktopOperationActive(): void {
  desktopOperationSignal()?.throwIfAborted();
}

export function withoutDesktopCancellation<A>(action: () => A): A {
  return execution.run({ active: true }, action);
}

const delivery = new AsyncLocalStorage<"background" | "foreground">();
export const desktopDeliveryMode = () => delivery.getStore() ?? "background";
export const withDesktopDeliveryMode = <A>(mode: "background" | "foreground", action: () => A): A =>
  delivery.run(mode, action);

export const DESKTOP_OPERATION_QUEUE_LIMIT = 64;

/** The error a queue throws for closed/full/target-switch failures. Any
 * `Error` subtype with this constructor shape qualifies — the host product
 * injects its classified backend error so callers keep flag-based checks. */
export type DesktopOperationErrorCtor = new (
  message: string,
  options?: { retryable?: boolean; cause?: unknown },
) => Error;

interface LaneTransaction {
  active: boolean;
  readonly claims: readonly ComputerLaneClaim[];
  /** The admission this transaction (and every inline nested call) runs under. */
  hold: ComputerLaneHold | undefined;
  readonly signal: AbortSignal;
}

/**
 * One desktop operation includes targeting, input, and its returned
 * observation. Operations run in lanes (`@ryco/shared/computerLanes`): `run`
 * is whole-desktop, `runScoped` one target key, `runLanes` any claim set.
 * Calls that conflict keep their FIFO order; calls that do not, overlap.
 */
export class DesktopOperationQueue {
  private readonly context = new AsyncLocalStorage<LaneTransaction>();
  private readonly lanes: ComputerLaneScheduler;
  private readonly controllers = new Set<AbortController>();
  private readonly activeWork = new Set<Promise<unknown>>();
  private pending = 0;
  private closed = false;

  private readonly errorCtor: DesktopOperationErrorCtor;
  constructor(errorCtor: DesktopOperationErrorCtor = Error) {
    this.errorCtor = errorCtor;
    this.lanes = new ComputerLaneScheduler({
      // The queue owns its own backlog bound, counting running work too.
      limit: Number.MAX_SAFE_INTEGER,
      createError: (failure, message, retryable) =>
        failure === "closed"
          ? new this.errorCtor("Computer manager is closed.")
          : new this.errorCtor(message, { retryable }),
    });
  }

  /** Whole-desktop work: waits for everything admitted before it. */
  run<A>(action: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    return this.runLanes(computerExclusiveLane(), action, signal);
  }

  /**
   * Run an exact-target operation concurrently with other exact targets.
   *
   * Calls sharing a key stay ordered. An exclusive `run` waits for every
   * already-admitted scoped call, while a scoped call waits behind an
   * exclusive call that was queued first. This is a writer barrier with
   * per-key readers: focus-sensitive desktop work remains globally exclusive,
   * but independently addressed semantic mutations can overlap.
   */
  runScoped<A>(key: string, action: () => Promise<A>, signal?: AbortSignal): Promise<A> {
    return this.runLanes(computerKeyedLane(`scoped:${key}`), action, signal);
  }

  /** The claims of the operation running in this async context, if any. */
  currentLanes(): readonly ComputerLaneClaim[] | undefined {
    const transaction = this.context.getStore();
    return transaction?.active ? transaction.claims : undefined;
  }

  /**
   * Run `action` in the given lanes. Inside a running operation the action
   * runs inline when the held lanes cover it, and is refused otherwise: an
   * operation never switches targets or widens to the whole desktop halfway.
   */
  runLanes<A>(
    claims: readonly ComputerLaneClaim[],
    action: () => Promise<A>,
    signal?: AbortSignal,
  ): Promise<A> {
    if (this.closed) return Promise.reject(new this.errorCtor("Computer manager is closed."));
    const outer = this.context.getStore();
    if (outer?.active) {
      if (!computerLanesCover(outer.claims, claims)) {
        return Promise.reject(
          new this.errorCtor(
            "A scoped computer operation cannot switch targets before it finishes.",
          ),
        );
      }
      assertDesktopOperationActive();
      if (signal) {
        return withDesktopOperationSignal(signal, async () => {
          assertDesktopOperationActive();
          return action();
        });
      }
      return action();
    }
    if (this.pending >= DESKTOP_OPERATION_QUEUE_LIMIT) {
      return Promise.reject(
        new this.errorCtor("Too many computer operations are queued; try again later.", {
          retryable: true,
        }),
      );
    }
    // Capture the caller's live scope before waiting: the queue owns its own
    // transaction, but RPC interruption and caller revocation still cancel it.
    const inheritedSignal = desktopOperationSignal();
    const callerSignal =
      signal && inheritedSignal
        ? AbortSignal.any([signal, inheritedSignal])
        : (signal ?? inheritedSignal);
    this.pending += 1;
    const work = this.execute(claims, action, callerSignal);
    const tracked = work.then(
      () => undefined,
      () => undefined,
    );
    this.activeWork.add(tracked);
    void tracked.finally(() => {
      this.pending -= 1;
      this.activeWork.delete(tracked);
    });
    return work;
  }

  /**
   * Leave the current operation's lanes while `wait` runs, then queue for
   * them again (behind work that arrived meanwhile). For waits on another
   * conversation, which may need these very lanes to finish. Callers must
   * re-check targets afterwards: the desktop may have changed.
   */
  async yieldLanes<A>(wait: () => Promise<A>): Promise<A> {
    const transaction = this.context.getStore();
    if (!transaction?.active || !transaction.hold) return wait();
    transaction.hold.release();
    transaction.hold = undefined;
    let outcome:
      | { readonly ok: true; readonly value: A }
      | { readonly ok: false; readonly error: unknown };
    try {
      outcome = { ok: true, value: await wait() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (this.closed) throw new this.errorCtor("Computer manager is closed.");
    transaction.hold = await this.lanes.acquire(transaction.claims, {
      signal: transaction.signal,
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private async execute<A>(
    claims: readonly ComputerLaneClaim[],
    action: () => Promise<A>,
    callerSignal: AbortSignal | undefined,
  ): Promise<A> {
    const hold = await this.lanes.acquire(claims, { signal: callerSignal });
    const controller = new AbortController();
    const transaction: LaneTransaction = {
      active: true,
      claims: hold.claims,
      hold,
      signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
    };
    this.controllers.add(controller);
    try {
      if (this.closed) throw new this.errorCtor("Computer manager is closed.");
      callerSignal?.throwIfAborted();
      const scope = { active: true, signal: transaction.signal };
      try {
        return await execution.run(scope, () => this.context.run(transaction, action));
      } finally {
        scope.active = false;
      }
    } finally {
      transaction.active = false;
      this.controllers.delete(controller);
      transaction.hold?.release();
      transaction.hold = undefined;
    }
  }

  /** Abort active work and reject queued work; native cleanup is backend-owned. */
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.lanes.close();
    await Promise.all(this.activeWork);
  }
}
