import type { BackgroundStayPolicy } from "../connection/connectivityRecovery.ts";
import type { EnvironmentId } from "@ryco/contracts";
import {
  canAdoptHostedEnvironmentSession,
  hostedBrowserRevalidated,
  isHostedEnvironmentSessionLive,
  type HostedEnvironmentSessionRecord,
  type HostedEnvironmentSessions,
} from "./hostedEnvironmentSessions.ts";
import type { HostedHubState } from "./state.ts";

/** How long a return waits for a kept connection whose last heartbeat is old to answer one. */
export const BACKGROUND_STAY_HEARTBEAT_WAIT_MS = 4_000;
const HEARTBEAT_POLL_MS = 200;

/** A platform's background time (an iOS background task). */
export interface PlatformBackgroundStay {
  /** How long the platform lets the app run from now, in ms (`Infinity` when it does not say). */
  readonly remainingMs: number;
  /** Whether the platform took the time back on its own (it announced suspension). */
  readonly expiredByPlatform: () => boolean;
  readonly end: () => void;
}

export interface HostedBackgroundStayDeps {
  readonly readHosted: () => Pick<HostedHubState, "accountStatus" | "browserStatus">;
  readonly sessions: Pick<HostedEnvironmentSessions, "list" | "read" | "subscribe">;
  /**
   * Asks the platform for background time; `expire` runs when the platform
   * announces suspension. Null when it grants none.
   */
  readonly beginPlatformStay: (expire: () => void) => PlatformBackgroundStay | null;
  /**
   * Whether the environment's connection of `generation` answered a heartbeat
   * recently; `missing` when no such connection exists.
   */
  readonly connectionHeartbeat: (
    environmentId: EnvironmentId,
    generation: number,
  ) => "fresh" | "stale" | "missing";
  /** Planning continues where it was (the platform's foreground re-plan). */
  readonly resumeKept: () => void;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

interface KeptSession {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
}

/**
 * Sessions are worth keeping through a background stay only when nothing is
 * half done: the account is signed in, this browser lifecycle revalidated its
 * access, and every session that runs is adoptable (completed its fresh relay
 * attempt and accepted its current snapshot). A session that is still
 * establishing would negotiate in the background, which the relay's E2EE
 * provider refuses, so the stay would only delay its recovery.
 */
export function hostedSessionsKeepable(
  hosted: Pick<HostedHubState, "accountStatus" | "browserStatus">,
  records: ReadonlyArray<HostedEnvironmentSessionRecord>,
): ReadonlyArray<KeptSession> | null {
  if (hosted.accountStatus !== "authenticated" || !hostedBrowserRevalidated(hosted.browserStatus)) {
    return null;
  }
  const kept: KeptSession[] = [];
  for (const record of records) {
    if (canAdoptHostedEnvironmentSession(record)) {
      kept.push({ environmentId: record.environmentId, generation: record.generation });
    } else if (isHostedEnvironmentSessionLive(record)) {
      return null;
    }
  }
  return kept.length > 0 ? kept : null;
}

function stillKept(
  sessions: Pick<HostedEnvironmentSessions, "read">,
  session: KeptSession,
): boolean {
  const record = sessions.read(session.environmentId);
  return (
    record !== undefined &&
    record.generation === session.generation &&
    canAdoptHostedEnvironmentSession(record)
  );
}

/**
 * The hosted plane's background stay (findings F1): which sessions a stay
 * keeps, when it must end early, and what a return inside it checks. The
 * connection policy that runs it is `bindConnectivityRecovery`; the platform
 * supplies only its background time and its connections' heartbeats.
 *
 * A stay keeps exactly the sessions that were adoptable when the app left. It
 * ends early, and everything is suspended as before, when any of them stops
 * being adoptable (its relay dropped, it was suspended or replaced): nothing is
 * re-established in the background. A return keeps them only when every one is
 * still adoptable with the same generation and its connection still answers
 * heartbeats; otherwise the ordinary suspension and recovery run, so the
 * session readiness rules of a recovery are unchanged.
 */
export function createHostedBackgroundStayPolicy(
  deps: HostedBackgroundStayDeps,
): BackgroundStayPolicy {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer =
    deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let kept: ReadonlyArray<KeptSession> = [];
  /** The last stay's platform time was taken back before the app returned. */
  let lastExpiredByPlatform = false;

  const heartbeatsAnswer = (): Promise<boolean> =>
    new Promise((resolve) => {
      const deadline = now() + BACKGROUND_STAY_HEARTBEAT_WAIT_MS;
      const check = () => {
        let waiting = false;
        for (const session of kept) {
          if (!stillKept(deps.sessions, session)) return resolve(false);
          const heartbeat = deps.connectionHeartbeat(session.environmentId, session.generation);
          if (heartbeat === "missing") return resolve(false);
          if (heartbeat === "stale") waiting = true;
        }
        if (!waiting) return resolve(true);
        if (now() >= deadline) return resolve(false);
        setTimer(check, HEARTBEAT_POLL_MS);
      };
      check();
    });

  return {
    eligible: () => hostedSessionsKeepable(deps.readHosted(), deps.sessions.list()) !== null,
    begin: (expire) => {
      kept = hostedSessionsKeepable(deps.readHosted(), deps.sessions.list()) ?? [];
      lastExpiredByPlatform = false;
      if (kept.length === 0) return null;
      const platform = deps.beginPlatformStay(expire);
      if (platform === null) return null;
      // A kept session that drops ends the stay: it is not re-established in the background.
      const unsubscribe = deps.sessions.subscribe(() => {
        if (!kept.every((session) => stillKept(deps.sessions, session))) expire();
      });
      let ended = false;
      return {
        remainingMs: platform.remainingMs,
        end: () => {
          if (ended) return;
          ended = true;
          unsubscribe();
          lastExpiredByPlatform = platform.expiredByPlatform();
          platform.end();
        },
      };
    },
    // The platform's announcement may arrive after the return; its own record decides.
    confirmKept: () => (lastExpiredByPlatform ? Promise.resolve(false) : heartbeatsAnswer()),
    resumeKept: deps.resumeKept,
    now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
  };
}
