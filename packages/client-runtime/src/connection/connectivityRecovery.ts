import type { AppLifecycleService } from "../platform/index.ts";

/**
 * The longest a background stay keeps connections open. iOS gives a
 * background task about 30 s; the stay ends before that, so the suspension
 * runs while the app still runs, and on its own clock.
 */
export const BACKGROUND_STAY_MAX_MS = 25_000;
/** A stay is not worth starting with less time than this left. */
export const BACKGROUND_STAY_MIN_MS = 3_000;
/** The stay ends this long before the platform's own deadline. */
const BACKGROUND_STAY_DEADLINE_MARGIN_MS = 3_000;

/** A platform's short permission to keep running after the app left the foreground. */
export interface BackgroundStay {
  /** How long the platform lets the app run from now, in ms (`Infinity` when it does not say). */
  readonly remainingMs: number;
  /** Gives the permission back. Idempotent. */
  readonly end: () => void;
}

/**
 * Keeping the connections of a short app switch (findings F1): instead of
 * suspending every session the moment the app leaves the foreground, the
 * sessions stay as they are for a short background stay. A return inside the
 * stay checks that the kept connections still answer their heartbeat and keeps
 * them; the stay running out, the platform announcing suspension, a kept
 * connection dropping, or going offline suspends exactly as an immediate
 * background would have. Nothing is established or recovered during a stay:
 * the sessions keep the authority they already had, and anything that was not
 * current when the app left goes through the ordinary suspension.
 */
export interface BackgroundStayPolicy {
  /** Whether the connections are worth keeping right now (every session current, none establishing). */
  readonly eligible: () => boolean;
  /**
   * Asks the platform for a background stay. `expire` is called when it must
   * end early: the platform announces suspension, or a kept connection dropped.
   * Null when the platform grants none.
   */
  readonly begin: (expire: () => void) => BackgroundStay | null;
  /** Back in the foreground inside the stay: whether every kept connection still answers. */
  readonly confirmKept: () => Promise<boolean>;
  /** The kept connections were confirmed: planning continues where it was. */
  readonly resumeKept: () => void;
  /** Wall clock and timers; injected by tests. */
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** Orders platform signals; the hosted controller still owns authorization and readiness. */
export function bindConnectivityRecovery(input: {
  readonly lifecycle: AppLifecycleService;
  readonly suspend: (reason: "hidden" | "offline") => void;
  readonly releaseBackground: () => Promise<void>;
  readonly recover: () => Promise<void>;
  readonly beginWake: () => () => void;
  readonly cancelWake: () => void;
  /** Without one, leaving the foreground suspends at once. */
  readonly backgroundStay?: BackgroundStayPolicy | undefined;
}): () => void {
  let disposed = false;
  let revision = 0;
  let requested = false;
  let running = false;
  let activeRevision: number | null = null;
  let cleanup = Promise.resolve();
  const available = () => input.lifecycle.isForeground() && input.lifecycle.isOnline();

  const policy = input.backgroundStay;
  const now = policy?.now ?? Date.now;
  const setTimer = policy?.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer =
    policy?.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  /** The background stay in progress: connections are kept until it ends. */
  let stay: {
    readonly permission: BackgroundStay;
    readonly deadline: number;
    readonly timer: unknown;
  } | null = null;
  /** Bumped whenever a stay starts or ends, so a late confirmation of an older one does nothing. */
  let stayRevision = 0;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      while (requested && !disposed) {
        requested = false;
        const current = revision;
        activeRevision = current;
        await cleanup;
        if (disposed || current !== revision || !available()) continue;
        const settled = input.beginWake();
        try {
          await input.recover();
          if (!disposed && current === revision && available()) settled();
        } catch {
          // The authoritative controller owns failures and its retry policy.
        }
      }
    } finally {
      running = false;
      activeRevision = null;
    }
  };

  const requestRecovery = () => {
    if (!available()) return;
    if (running && activeRevision === revision) return;
    requested = true;
    void run();
  };

  /** Today's background or offline: revoke readiness now, release in the background. */
  const suspendNow = (reason: "hidden" | "offline") => {
    revision += 1;
    requested = false;
    input.cancelWake();
    // Revoke readiness synchronously, before asynchronous socket cleanup.
    input.suspend(reason);
    if (reason === "hidden") {
      cleanup = cleanup.then(input.releaseBackground).catch(() => undefined);
    }
  };

  /** Ends the stay without suspending; returns whether it was still within its time. */
  const endStay = (): boolean => {
    const current = stay;
    if (current === null) return false;
    stay = null;
    stayRevision += 1;
    clearTimer(current.timer);
    current.permission.end();
    return now() < current.deadline;
  };

  /** The stay ran out or must end early while the app is still away: suspend as usual. */
  const expireStay = (revisionAtBegin: number) => {
    if (disposed || stay === null || stayRevision !== revisionAtBegin) return;
    endStay();
    suspendNow("hidden");
  };

  const beginStay = (): boolean => {
    if (policy === undefined || stay !== null || !policy.eligible()) return false;
    stayRevision += 1;
    const revisionAtBegin = stayRevision;
    const permission = policy.begin(() => expireStay(revisionAtBegin));
    // `expire` may have run inside `begin`.
    if (permission === null || stayRevision !== revisionAtBegin) {
      permission?.end();
      return false;
    }
    const budgetMs = Math.min(
      BACKGROUND_STAY_MAX_MS,
      permission.remainingMs - BACKGROUND_STAY_DEADLINE_MARGIN_MS,
    );
    if (!(budgetMs >= BACKGROUND_STAY_MIN_MS)) {
      permission.end();
      return false;
    }
    stay = {
      permission,
      deadline: now() + budgetMs,
      timer: setTimer(() => expireStay(revisionAtBegin), budgetMs),
    };
    return true;
  };

  /** Back in front during a stay: keep the connections if they still answer, else recover. */
  const returnFromStay = () => {
    const revisionAtReturn = stayRevision;
    const inTime = endStay();
    // Nothing that happened while away counts against a later signal.
    revision += 1;
    requested = false;
    if (!inTime) {
      // The app was frozen past the stay's end before its timer could run.
      suspendNow("hidden");
      requestRecovery();
      return;
    }
    const confirmedRevision = revision;
    void policy!
      .confirmKept()
      .catch(() => false)
      .then((alive) => {
        // A later background, offline or return owns what happens next.
        if (disposed || revision !== confirmedRevision || stayRevision !== revisionAtReturn + 1) {
          return;
        }
        if (alive && available()) {
          policy!.resumeKept();
          return;
        }
        suspendNow("hidden");
        requestRecovery();
      });
  };

  const unsubscribe = input.lifecycle.subscribe((event) => {
    if (event === "background") {
      if (stay !== null) return;
      if (beginStay()) {
        // Nothing owed to a recovery that a later return may still need is cancelled:
        // the sessions keep their authority, and the return confirms them.
        revision += 1;
        requested = false;
        return;
      }
      suspendNow("hidden");
    } else if (event === "offline") {
      // Gone offline, kept connections cannot answer: suspend as today.
      endStay();
      suspendNow("offline");
    } else if (event === "foreground" || event === "online") {
      if (event === "foreground" && stay !== null) {
        returnFromStay();
        return;
      }
      requestRecovery();
    }
  });
  return () => {
    disposed = true;
    revision += 1;
    endStay();
    unsubscribe();
    input.cancelWake();
  };
}
