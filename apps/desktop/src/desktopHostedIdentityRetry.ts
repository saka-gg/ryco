/**
 * Retries the background (non-interactive) Hub session resume while it keeps
 * ending `unavailable`.
 *
 * The resume runs once per backend start. A launch while the Hub cannot be
 * reached (offline at login, a Hub restart, a captive network) used to end
 * `unavailable` for good: the catalog refresh does nothing unless signed in, so
 * the app showed the sign-in prompt over a stored session that was still
 * valid until the user acted. Here a resume that ends `unavailable` while
 * stored session material exists is tried again on a capped, jittered backoff,
 * and at once when the conditions that usually caused it change: the machine
 * woke or was unlocked, the network came back, or the window gained focus (at
 * most once per {@link DESKTOP_IDENTITY_RETRY_FOCUS_THROTTLE_MS}).
 *
 * It stops at the first definite answer (`ready` or `signed-out`), on sign-out,
 * and on {@link DesktopHostedIdentityResumeRetry.stop}, which is also what an
 * account revocation calls: the `unavailable` a revocation sets is never
 * retried, and the answer of a resume that was still running when it was
 * stopped is ignored. An interactive Connect needs nothing here: the identity
 * coordinator serializes account operations, so a background resume and a
 * Connect never run their restores side by side.
 *
 * Timers are unref'd so a pending retry never keeps the main process alive.
 */
import { HostedReconnectPolicy } from "@ryco/client-runtime/relay/reconnectPolicy";

/** The first retry follows a failed resume after about this long... */
export const DESKTOP_IDENTITY_RETRY_INITIAL_MS = 5_000;
/** ...doubling (±20 % jitter) up to this ceiling. */
export const DESKTOP_IDENTITY_RETRY_MAX_MS = 120_000;
/** Window focus retries at most this often; wake, unlock and network return are not throttled. */
export const DESKTOP_IDENTITY_RETRY_FOCUS_THROTTLE_MS = 30_000;

export type DesktopIdentityResumeOutcome = "ready" | "signed-out" | "unavailable";
export type DesktopIdentityRetryNudge = "wake" | "network" | "focus";

export interface DesktopIdentityRetryTimers {
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const systemTimers: DesktopIdentityRetryTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DesktopHostedIdentityResumeRetry {
  /**
   * Run the background resume now, as a fresh series: what a backend start
   * does. A resume of an earlier series still running is not waited for, and
   * its answer is ignored. Never rejects.
   */
  readonly restart: () => Promise<void>;
  /** A sign that the Hub may be reachable again: runs a pending retry now. */
  readonly nudge: (reason: DesktopIdentityRetryNudge) => void;
  /**
   * The outcome of an account operation outside this series (an interactive
   * Connect): a definite answer ends the series; `unavailable` changes nothing.
   */
  readonly noteOutcome: (outcome: DesktopIdentityResumeOutcome) => void;
  /** Sign-out or revocation: no retry runs until the next {@link restart}. */
  readonly stop: () => void;
  /** Whether a retry is scheduled (for tests and diagnostics). */
  readonly pending: () => boolean;
}

export function createDesktopHostedIdentityResumeRetry(input: {
  /** One background resume; resolves to its outcome. */
  readonly resume: () => Promise<DesktopIdentityResumeOutcome>;
  /** The status is still `unavailable` and stored session material exists. */
  readonly canRetry: () => boolean;
  readonly onRetry?: (attempt: number, delayMs: number) => void;
  readonly timers?: DesktopIdentityRetryTimers;
  readonly random?: () => number;
  readonly now?: () => number;
}): DesktopHostedIdentityResumeRetry {
  const timers = input.timers ?? systemTimers;
  const now = input.now ?? Date.now;
  const newPolicy = () =>
    new HostedReconnectPolicy({
      baseDelayMs: DESKTOP_IDENTITY_RETRY_INITIAL_MS,
      maxDelayMs: DESKTOP_IDENTITY_RETRY_MAX_MS,
      jitterRatio: 0.2,
      ...(input.random === undefined ? {} : { random: input.random }),
    });
  /** Bumped by every restart and stop: answers of an older series are ignored. */
  let generation = 0;
  let policy = newPolicy();
  let attempt = 0;
  let timer: unknown = null;
  let running = false;
  let lastFocusRetryAt = Number.NEGATIVE_INFINITY;

  const cancelTimer = () => {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  };
  const end = () => {
    generation += 1;
    cancelTimer();
    running = false;
    policy = newPolicy();
    attempt = 0;
  };

  const run = async (): Promise<void> => {
    const series = generation;
    cancelTimer();
    running = true;
    let outcome: DesktopIdentityResumeOutcome;
    try {
      outcome = await input.resume();
    } catch {
      outcome = "unavailable";
    }
    if (series !== generation) return;
    running = false;
    if (outcome !== "unavailable" || !input.canRetry()) {
      end();
      return;
    }
    attempt += 1;
    const delayMs = policy.nextDelay();
    input.onRetry?.(attempt, delayMs);
    timer = timers.setTimeout(() => {
      timer = null;
      if (series !== generation) return;
      if (!input.canRetry()) {
        end();
        return;
      }
      void run();
    }, delayMs);
  };

  return {
    restart: () => {
      end();
      return run();
    },
    nudge: (reason) => {
      // Only a scheduled retry is pulled forward; a running one is already trying.
      if (timer === null || running) return;
      if (reason === "focus") {
        if (now() - lastFocusRetryAt < DESKTOP_IDENTITY_RETRY_FOCUS_THROTTLE_MS) return;
        lastFocusRetryAt = now();
      }
      if (!input.canRetry()) {
        end();
        return;
      }
      void run();
    },
    noteOutcome: (outcome) => {
      if (outcome !== "unavailable") end();
    },
    stop: end,
    pending: () => timer !== null,
  };
}
