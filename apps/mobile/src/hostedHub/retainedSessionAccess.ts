import type { HostedAccountStatus } from "@ryco/client-runtime/authorization";
import type { KVService } from "@ryco/client-runtime/platform";

/**
 * A retained Hub sign-in: what lets the phone open its saved workspace at
 * launch before the Hub has answered, and while the Hub cannot be reached.
 *
 * The launch-time access check costs a keychain read, a hardware key load and
 * a Hub round trip, and the workspace used to stay behind the logo for all of
 * it: on a slow link for seconds, and offline for good, although everything
 * the workspace shows first is already saved on this device. A direct machine
 * never had that wait: its readable credential opens the workspace at once.
 * This is the same grant for the Hub plane, with two bounds a direct
 * credential does not need:
 *
 * - the device still holds the stored session credential, and
 * - the Hub confirmed that session within {@link RETAINED_SESSION_ACCESS_WINDOW_MS}.
 *
 * It opens the saved, read-only view and nothing else. It is no mutation
 * authority and no connection: every machine still needs the revalidated
 * session, a fresh relay attempt and its own current shell snapshot before
 * anything can be sent to it. It ends the moment the Hub says the session is
 * gone (the app locks, as before), and it lapses by itself when the Hub has
 * not confirmed the session for the whole window, so a device whose session
 * was revoked while it was offline cannot keep reading its saved copy
 * indefinitely.
 *
 * Free of React and of native modules: the gate and the lazily loaded hosted
 * runtime both import it.
 */

/** How long after the Hub last confirmed the session the saved workspace opens without it. */
export const RETAINED_SESSION_ACCESS_WINDOW_MS = 72 * 60 * 60 * 1000;

/** The session is confirmed again on every resume; the stamp need not follow each one. */
const CONFIRMATION_WRITE_INTERVAL_MS = 10 * 60 * 1000;

export const HUB_SESSION_CONFIRMED_AT_KEY = "ryco.hostedHub.sessionConfirmedAt.v1";

type ConfirmationKV = Pick<KVService, "getItem" | "setItem" | "removeItem">;

/** Whether the Hub confirmed the session recently enough; a stamp from the future is not trusted. */
export function isHubSessionConfirmationFresh(confirmedAt: number | null, now: number): boolean {
  return (
    confirmedAt !== null &&
    confirmedAt <= now &&
    now - confirmedAt < RETAINED_SESSION_ACCESS_WINDOW_MS
  );
}

export interface RetainedHubSessionFacts {
  /** The stored session credential was read from the keychain; `null` until that read settled. */
  readonly storedSession: boolean | null;
  /** When the Hub last confirmed the session, as saved on this device; `null` when never or unread. */
  readonly confirmedAt: number | null;
  readonly now: number;
  /** The launch-time access check has settled: `accountStatus` is an answer, not the initial value. */
  readonly accessCheckSettled: boolean;
  readonly accountStatus: HostedAccountStatus;
}

/**
 * Whether the saved workspace may open on the retained sign-in alone. Once the
 * launch check has settled, an account that is signed out or expired is the
 * Hub's (or the user's) answer and ends it; `unavailable` is no answer at all.
 */
export function deriveRetainedHubSession(facts: RetainedHubSessionFacts): boolean {
  if (facts.storedSession !== true) return false;
  if (!isHubSessionConfirmationFresh(facts.confirmedAt, facts.now)) return false;
  if (!facts.accessCheckSettled) return true;
  return facts.accountStatus !== "signed-out" && facts.accountStatus !== "session-expired";
}

export async function readHubSessionConfirmedAt(
  kv: Pick<ConfirmationKV, "getItem">,
): Promise<number | null> {
  try {
    const raw = await kv.getItem(HUB_SESSION_CONFIRMED_AT_KEY);
    if (raw === null) return null;
    const confirmedAt = Number(raw);
    return Number.isFinite(confirmedAt) && confirmedAt > 0 ? confirmedAt : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the confirmation stamp: written while the account is authenticated
 * (each transition into it, and again at most every ten minutes as later
 * checks land), removed when the session ends. `unavailable`, a check in
 * flight and a sign-out still under way change nothing. Returns the stop.
 */
export function watchHubSessionConfirmation(input: {
  readonly kv: ConfirmationKV;
  readonly now: () => number;
  readonly readAccountStatus: () => HostedAccountStatus;
  readonly subscribe: (listener: () => void) => () => void;
}): () => void {
  let lastWrittenAt: number | null = null;
  let previous: HostedAccountStatus | null = null;
  const observe = () => {
    const status = input.readAccountStatus();
    const changed = status !== previous;
    previous = status;
    if (status === "authenticated") {
      const now = input.now();
      if (
        !changed &&
        lastWrittenAt !== null &&
        now - lastWrittenAt < CONFIRMATION_WRITE_INTERVAL_MS
      ) {
        return;
      }
      lastWrittenAt = now;
      void input.kv.setItem(HUB_SESSION_CONFIRMED_AT_KEY, String(now)).catch(() => undefined);
      return;
    }
    if (changed && (status === "signed-out" || status === "session-expired")) {
      lastWrittenAt = null;
      void input.kv.removeItem(HUB_SESSION_CONFIRMED_AT_KEY).catch(() => undefined);
    }
  };
  const unsubscribe = input.subscribe(observe);
  // The initial status is only recorded: before the launch check, `signed-out`
  // is the store's starting value and must not erase the stamp it is about to need.
  previous = input.readAccountStatus();
  if (previous === "authenticated") observe();
  return unsubscribe;
}

// ---------------------------------------------------------------------------
// The stored-session read, published by the hosted runtime's session setup
// (after the Hub profile is authoritative, before any Hub request) and read by
// the access gate.
// ---------------------------------------------------------------------------

let storedSession: boolean | null = null;
const listeners = new Set<() => void>();

export function publishStoredHubSession(present: boolean | null): void {
  if (storedSession === present) return;
  storedSession = present;
  for (const listener of Array.from(listeners)) listener();
}

export function readStoredHubSession(): boolean | null {
  return storedSession;
}

export function subscribeStoredHubSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function resetStoredHubSessionForTests(): void {
  storedSession = null;
  listeners.clear();
}
