/**
 * Lanes for Computer Use work: one scheduler that the desktop driver host and
 * the server's operation queue both use, so "who may run next to whom" has
 * one definition.
 *
 * A request names claims: a resource and a mode. Resources are paths
 * (`desktop`, `input`, `app:<pid>`, `app:<pid>/window:<id>`). Two claims
 * conflict when their resources are the same or one is an ancestor of the
 * other, and at least one of them is exclusive. A request starts when it
 * conflicts with nothing running and with no earlier request that is still
 * waiting: strict FIFO among conflicting requests, so a waiting exclusive
 * request is never starved by later readers, and same-app requests keep their
 * order. Requests that conflict with nothing ahead of them start at once.
 *
 * See docs/superpowers/specs/2026-11-06-computer-use-parallel-sessions.md.
 */

export type ComputerLaneMode = "shared" | "exclusive";

export interface ComputerLaneClaim {
  readonly resource: string;
  readonly mode: ComputerLaneMode;
}

/** Every request claims the desktop; whole-desktop work claims it exclusively. */
export const COMPUTER_LANE_DESKTOP = "desktop";
/** The driver's process-wide native input gate (desktop host only). */
export const COMPUTER_LANE_INPUT = "input";
export const COMPUTER_LANE_QUEUE_LIMIT = 64;

const shared = (resource: string): ComputerLaneClaim => ({ resource, mode: "shared" });
const exclusive = (resource: string): ComputerLaneClaim => ({ resource, mode: "exclusive" });

/** Resource path of one application (a pid, or a not yet running app's name). */
export function computerAppLaneResource(app: string | number): string {
  return `app:${String(app)}`;
}

/** Resource path of one window, nested under its application when known. */
export function computerWindowLaneResource(window: string | number, app?: string | number): string {
  const leaf = `window:${String(window)}`;
  return app === undefined ? leaf : `${computerAppLaneResource(app)}/${leaf}`;
}

/** Observation: runs next to everything except whole-desktop work. */
export function computerReadLane(): readonly ComputerLaneClaim[] {
  return [shared(COMPUTER_LANE_DESKTOP)];
}

/** Foreground, clipboard, drag, launch, Space changes: the whole desktop. */
export function computerExclusiveLane(): readonly ComputerLaneClaim[] {
  return [exclusive(COMPUTER_LANE_DESKTOP)];
}

/** Background work on one application. */
export function computerAppLane(app: string | number): readonly ComputerLaneClaim[] {
  return [shared(COMPUTER_LANE_DESKTOP), exclusive(computerAppLaneResource(app))];
}

/** Exact semantic writes on one window. */
export function computerWindowLane(
  window: string | number,
  app?: string | number,
): readonly ComputerLaneClaim[] {
  return [shared(COMPUTER_LANE_DESKTOP), exclusive(computerWindowLaneResource(window, app))];
}

/** Any lane resource for an arbitrary key, e.g. a browser thread. */
export function computerKeyedLane(resource: string): readonly ComputerLaneClaim[] {
  return [shared(COMPUTER_LANE_DESKTOP), exclusive(resource)];
}

/** Adds claims to a lane (for example the host's input gate). */
export function withComputerLaneClaims(
  lane: readonly ComputerLaneClaim[],
  ...extra: readonly ComputerLaneClaim[]
): readonly ComputerLaneClaim[] {
  return normalizeComputerLaneClaims([...lane, ...extra]);
}

export const computerLaneClaim = { shared, exclusive };

function related(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function claimsConflict(a: ComputerLaneClaim, b: ComputerLaneClaim): boolean {
  return related(a.resource, b.resource) && (a.mode === "exclusive" || b.mode === "exclusive");
}

export function computerLanesConflict(
  a: readonly ComputerLaneClaim[],
  b: readonly ComputerLaneClaim[],
): boolean {
  return a.some((left) => b.some((right) => claimsConflict(left, right)));
}

/**
 * Whether work holding `held` may run `requested` inline, without another
 * admission: every requested resource is held at the same path or an
 * ancestor, in a mode at least as strong. Holding the desktop exclusively
 * covers everything.
 */
export function computerLanesCover(
  held: readonly ComputerLaneClaim[],
  requested: readonly ComputerLaneClaim[],
): boolean {
  if (held.some((claim) => claim.resource === COMPUTER_LANE_DESKTOP && claim.mode === "exclusive"))
    return true;
  return requested.every((want) =>
    held.some(
      (have) =>
        (have.resource === want.resource || want.resource.startsWith(`${have.resource}/`)) &&
        (have.mode === "exclusive" || want.mode === "shared"),
    ),
  );
}

/** One claim per resource, keeping the stronger mode; empty resources are refused. */
export function normalizeComputerLaneClaims(
  claims: readonly ComputerLaneClaim[],
): readonly ComputerLaneClaim[] {
  const merged = new Map<string, ComputerLaneMode>();
  for (const claim of claims) {
    if (typeof claim.resource !== "string" || claim.resource.length === 0)
      throw new TypeError("A computer lane claim needs a resource.");
    if (merged.get(claim.resource) !== "exclusive") merged.set(claim.resource, claim.mode);
  }
  return [...merged].map(([resource, mode]) => ({ resource, mode }));
}

export type ComputerLaneFailure = "closed" | "full" | "timeout";

export interface ComputerLaneHold {
  readonly claims: readonly ComputerLaneClaim[];
  /** Idempotent. Lets the next compatible waiters start. */
  release(): void;
}

export interface ComputerLaneAcquireOptions {
  readonly signal?: AbortSignal | undefined;
  /** Bounded wait; absent waits until admitted, aborted or closed. */
  readonly timeoutMs?: number | undefined;
  /** Message for a timed-out wait. */
  readonly timeoutMessage?: string | undefined;
}

interface Waiter {
  readonly claims: readonly ComputerLaneClaim[];
  readonly resolve: (hold: ComputerLaneHold) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

/** Builds the error for closed/full/timeout so products keep their own classes. */
export type ComputerLaneErrorFactory = (
  failure: ComputerLaneFailure,
  message: string,
  retryable: boolean,
) => Error;

export class ComputerLaneError extends Error {
  readonly failure: ComputerLaneFailure;
  readonly retryable: boolean;
  constructor(failure: ComputerLaneFailure, message: string, retryable: boolean) {
    super(message);
    this.name = "ComputerLaneError";
    this.failure = failure;
    this.retryable = retryable;
  }
}

const defaultErrorFactory: ComputerLaneErrorFactory = (failure, message, retryable) =>
  new ComputerLaneError(failure, message, retryable);

export class ComputerLaneScheduler {
  private readonly running = new Set<readonly ComputerLaneClaim[]>();
  private readonly waiting: Waiter[] = [];
  private closedFlag = false;
  private readonly limit: number;
  private readonly createError: ComputerLaneErrorFactory;

  constructor(options: { limit?: number; createError?: ComputerLaneErrorFactory } = {}) {
    this.limit = options.limit ?? COMPUTER_LANE_QUEUE_LIMIT;
    this.createError = options.createError ?? defaultErrorFactory;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** Requests waiting for admission. */
  get waitingCount(): number {
    return this.waiting.length;
  }

  /** Requests currently admitted. */
  get runningCount(): number {
    return this.running.size;
  }

  acquire(
    claims: readonly ComputerLaneClaim[],
    options: ComputerLaneAcquireOptions = {},
  ): Promise<ComputerLaneHold> {
    if (this.closedFlag)
      return Promise.reject(this.createError("closed", "Computer lanes are closed.", false));
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const normalized = normalizeComputerLaneClaims(claims);
    if (
      !this.waiting.some((waiter) => computerLanesConflict(waiter.claims, normalized)) &&
      this.compatibleWithRunning(normalized)
    )
      return Promise.resolve(this.admit(normalized));
    if (this.waiting.length >= this.limit)
      return Promise.reject(
        this.createError("full", "Too many computer operations are queued; try again later.", true),
      );
    return new Promise<ComputerLaneHold>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => this.drop(waiter, signal?.reason);
      const waiter: Waiter = {
        claims: normalized,
        resolve,
        reject,
        cleanup: () => {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            this.drop(
              waiter,
              this.createError(
                "timeout",
                options.timeoutMessage ?? "Timed out waiting for another computer operation.",
                true,
              ),
            ),
          Math.max(0, options.timeoutMs),
        );
        timer.unref?.();
      }
      this.waiting.push(waiter);
      this.pump();
    });
  }

  async run<A>(
    claims: readonly ComputerLaneClaim[],
    action: (hold: ComputerLaneHold) => Promise<A>,
    options: ComputerLaneAcquireOptions = {},
  ): Promise<A> {
    const hold = await this.acquire(claims, options);
    try {
      return await action(hold);
    } finally {
      hold.release();
    }
  }

  /** Refuses new and waiting requests. Running work finishes on its own. */
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    const waiting = this.waiting.splice(0);
    for (const waiter of waiting) {
      waiter.cleanup();
      waiter.reject(this.createError("closed", "Computer lanes are closed.", false));
    }
  }

  private compatibleWithRunning(claims: readonly ComputerLaneClaim[]): boolean {
    for (const held of this.running) if (computerLanesConflict(held, claims)) return false;
    return true;
  }

  private admit(claims: readonly ComputerLaneClaim[]): ComputerLaneHold {
    // Each hold is its own identity in the running set, even for equal claims.
    const entry = [...claims];
    this.running.add(entry);
    let released = false;
    return {
      claims: entry,
      release: () => {
        if (released) return;
        released = true;
        this.running.delete(entry);
        this.pump();
      },
    };
  }

  private drop(waiter: Waiter, reason: unknown): void {
    const index = this.waiting.indexOf(waiter);
    if (index < 0) return;
    this.waiting.splice(index, 1);
    waiter.cleanup();
    waiter.reject(reason);
    // A removed waiter may have been the only thing holding later ones back.
    this.pump();
  }

  private pump(): void {
    const blocked: Waiter[] = [];
    for (let index = 0; index < this.waiting.length;) {
      const waiter = this.waiting[index]!;
      const behindConflict = blocked.some((earlier) =>
        computerLanesConflict(earlier.claims, waiter.claims),
      );
      if (!behindConflict && this.compatibleWithRunning(waiter.claims)) {
        this.waiting.splice(index, 1);
        waiter.cleanup();
        waiter.resolve(this.admit(waiter.claims));
        continue;
      }
      blocked.push(waiter);
      index += 1;
    }
  }
}
