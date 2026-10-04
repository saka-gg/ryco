import type { AuthBearerBootstrapResult, AuthSessionState, EnvironmentId } from "@ryco/contracts";
import { DateTime } from "effect";

import { isRemoteEnvironmentAuthHttpError } from "./remoteApi.ts";
import {
  checkSavedEnvironmentSession,
  SAVED_ENVIRONMENT_SESSION_CHECK_TIMEOUT_MS,
  withSavedEnvironmentTimeout,
} from "./savedEnvironmentSession.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A direct pairing's session lives 30 days on the node, which renews it by
 * rotation only while it is in use. Renewing once a session is a day old keeps
 * a pairing in use alive and lets one left unused for 30 days lapse — the idle
 * limit — up to a year after pairing, which no renewal passes.
 */
export const SAVED_SESSION_LIFETIME_MS = 30 * DAY_MS;
export const SAVED_SESSION_RENEW_AFTER_MS = DAY_MS;
/** A connected client that could not reach its node to renew tries again after this. */
export const SAVED_SESSION_RENEWAL_RETRY_MS = 60 * 60 * 1000;

/** `expiresAt` arrives as an ISO string over HTTP, typed as a DateTime. */
function expiresAtMillis(value: unknown): number | null {
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  return DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : null;
}

/** When a bearer session becomes due for renewal, or `null` if it never renews. */
function savedSessionRenewalDueAt(session: AuthSessionState): number | null {
  if (!session.authenticated || session.sessionMethod !== "bearer-session-token") return null;
  const expiresAtMs = expiresAtMillis(session.expiresAt);
  return expiresAtMs === null
    ? null
    : expiresAtMs - (SAVED_SESSION_LIFETIME_MS - SAVED_SESSION_RENEW_AFTER_MS);
}

/** A bearer session at least a day into its lifetime is renewed on use. */
export function shouldRenewSavedSession(session: AuthSessionState, nowMs: number): boolean {
  const dueAtMs = savedSessionRenewalDueAt(session);
  return dueAtMs !== null && nowMs > dueAtMs;
}

/**
 * A saved environment's bearer could not be read from the platform's secret
 * store: a locked keychain, a failed decrypt, a pruned browser copy. Nothing is
 * presented in its place. A bearer held in memory may have been superseded by a
 * renewal since, here or in another window, and presenting it after its grace
 * revokes the whole pairing; the socket retries on its schedule instead.
 */
export class SavedEnvironmentBearerUnavailableError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super("This environment's saved credential could not be read.", options);
    this.name = "SavedEnvironmentBearerUnavailableError";
  }
}

export interface SavedSessionRenewalRequest {
  readonly environmentId: EnvironmentId;
  /** The node's answer for `bearerToken`, from the session check just made. */
  readonly session: AuthSessionState;
  readonly bearerToken: string;
  readonly fetchSessionState: (bearerToken: string) => Promise<AuthSessionState>;
  readonly rotate: (bearerToken: string) => Promise<AuthBearerBootstrapResult>;
}

export interface SavedSessionRenewalResult {
  /** The bearer to use from now on. */
  readonly bearerToken: string;
  /**
   * The node's latest answer for it. Where a renewed bearer's first use went
   * unanswered, this is the presented bearer's answer, which is already due: a
   * renewal kept from it checks the pairing again straight away.
   */
  readonly session: AuthSessionState;
}

export interface SavedSessionRenewal {
  /**
   * The bearer to present now: the one stored now, read on every use. Rejects
   * with a `SavedEnvironmentBearerUnavailableError` when the store cannot be
   * read, rather than falling back to a bearer remembered from earlier.
   */
  readonly readBearerToken: (environmentId: EnvironmentId) => Promise<string>;
  /**
   * Renews the pairing's bearer when it is due and resolves with the bearer to
   * use from now on. Never rejects: the presented bearer stays valid on the
   * node until its successor is first used, so a failed renewal keeps it.
   */
  readonly renew: (request: SavedSessionRenewalRequest) => Promise<SavedSessionRenewalResult>;
  /**
   * While `isCurrent()` holds, renews the pairing each time it falls due: a
   * client that stays connected for weeks never reconnects, which is where
   * renewal otherwise happens. Arms one timer per due time, from `session`, and
   * none for a session that never renews. The returned stop cancels the timer;
   * call it once the connection it serves is gone.
   */
  readonly keepRenewed: (
    request: Omit<SavedSessionRenewalRequest, "bearerToken"> & {
      readonly isCurrent: () => boolean;
    },
  ) => () => void;
}

/**
 * Proactive renewal of direct pairings, shared by web, desktop and mobile. The
 * bearer lives in the platform's secret store; every use of it reads it from
 * there through `readBearerToken`, so a renewed bearer reaches every socket's
 * next attempt and a superseded one is never presented again.
 */
export function createSavedSessionRenewal(input: {
  readonly readBearerToken: (environmentId: EnvironmentId) => Promise<string | null>;
  readonly writeBearerToken: (environmentId: EnvironmentId, token: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timeoutId: ReturnType<typeof setTimeout>) => void;
}): SavedSessionRenewal {
  const now = input.now ?? Date.now;
  const schedule = input.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = input.clearTimeout ?? ((timeoutId) => clearTimeout(timeoutId));
  const inFlight = new Map<EnvironmentId, Promise<SavedSessionRenewalResult>>();
  // Bearers the node declined to renew (renewed recently, a year old, or a node
  // without rotation): not asked again while this client runs.
  const declined = new Set<string>();

  const readBearerToken: SavedSessionRenewal["readBearerToken"] = async (environmentId) => {
    let stored: string | null;
    try {
      stored = await input.readBearerToken(environmentId);
    } catch (cause) {
      throw new SavedEnvironmentBearerUnavailableError({ cause });
    }
    if (!stored) throw new SavedEnvironmentBearerUnavailableError();
    return stored;
  };

  const kept = (request: SavedSessionRenewalRequest): SavedSessionRenewalResult => ({
    bearerToken: request.bearerToken,
    session: request.session,
  });

  const rotateAndStore = async (
    request: SavedSessionRenewalRequest,
  ): Promise<SavedSessionRenewalResult> => {
    // A renewal sits on the connect path, so neither of its requests may hold a
    // connect longer than a session check would. A rotation that runs out of
    // time keeps the presented bearer: the node keeps it valid, and asking again
    // hands out the successor it may have issued meanwhile.
    let rotated: AuthBearerBootstrapResult;
    try {
      rotated = await withSavedEnvironmentTimeout(
        request.rotate(request.bearerToken),
        SAVED_ENVIRONMENT_SESSION_CHECK_TIMEOUT_MS,
        "The environment did not answer its session renewal in time.",
      );
    } catch (error) {
      if (isRemoteEnvironmentAuthHttpError(error) && error.status !== 401 && error.status < 500) {
        declined.add(request.bearerToken);
      }
      return kept(request);
    }
    // The successor replaces only the bearer it renews. Pairing again or
    // removing the environment while the rotation was in flight replaced or
    // dropped that one, and the old pairing's successor must not come back.
    const holding = await input.readBearerToken(request.environmentId).catch(() => null);
    if (holding !== request.bearerToken) {
      return holding === null ? kept(request) : { ...kept(request), bearerToken: holding };
    }
    // The successor is used only once it is durably stored: written and read
    // back. Until it is used, the node keeps the presented bearer valid.
    const written = await input
      .writeBearerToken(request.environmentId, rotated.sessionToken)
      .catch(() => false);
    if (!written) return kept(request);
    const stored = await input.readBearerToken(request.environmentId).catch(() => null);
    if (stored !== rotated.sessionToken) return kept(request);
    // Its first use supersedes the presented bearer on the node. Unanswered, the
    // socket's next ws-token request is that first use instead.
    const activated = await withSavedEnvironmentTimeout(
      request.fetchSessionState(rotated.sessionToken),
      SAVED_ENVIRONMENT_SESSION_CHECK_TIMEOUT_MS,
      "The environment did not answer its session check in time.",
    ).catch(() => null);
    return {
      bearerToken: rotated.sessionToken,
      session: activated?.authenticated ? activated : request.session,
    };
  };

  const renew: SavedSessionRenewal["renew"] = (request) => {
    if (declined.has(request.bearerToken) || !shouldRenewSavedSession(request.session, now())) {
      return Promise.resolve(kept(request));
    }
    const running = inFlight.get(request.environmentId);
    if (running) return running;
    const renewal = rotateAndStore(request).finally(() => {
      if (inFlight.get(request.environmentId) === renewal) {
        inFlight.delete(request.environmentId);
      }
    });
    inFlight.set(request.environmentId, renewal);
    return renewal;
  };

  const keepRenewed: SavedSessionRenewal["keepRenewed"] = (request) => {
    let stopped = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      stopped = true;
      if (timeoutId !== null) cancel(timeoutId);
      timeoutId = null;
    };
    const after = (delayMs: number) => {
      if (stopped) return;
      timeoutId = schedule(
        () => {
          timeoutId = null;
          if (stopped || !request.isCurrent()) {
            stop();
            return;
          }
          void renewDue();
        },
        Math.max(0, delayMs),
      );
    };
    const arm = (session: AuthSessionState) => {
      const dueAtMs = savedSessionRenewalDueAt(session);
      if (dueAtMs === null) stop();
      else after(dueAtMs - now());
    };
    const ask = async (bearerToken: string) =>
      checkSavedEnvironmentSession({
        fetchSessionState: () => request.fetchSessionState(bearerToken),
      }).catch(() => null);
    const renewDue = async () => {
      const bearerToken = await input.readBearerToken(request.environmentId).catch(() => null);
      const answer = bearerToken === null ? null : await ask(bearerToken);
      if (bearerToken === null || answer === null) {
        after(SAVED_SESSION_RENEWAL_RETRY_MS);
        return;
      }
      // A rejected pairing surfaces on the socket's next attempt; nothing renews it.
      if (answer.status !== "authenticated") return stop();
      if (!shouldRenewSavedSession(answer.session, now())) return arm(answer.session);
      const renewed = await renew({ ...request, session: answer.session, bearerToken });
      if (renewed.bearerToken === bearerToken) {
        // Declined (a year old, say) for good, or the node was out of reach.
        if (declined.has(bearerToken)) stop();
        else after(SAVED_SESSION_RENEWAL_RETRY_MS);
        return;
      }
      arm(renewed.session);
    };
    arm(request.session);
    return stop;
  };

  return { readBearerToken, renew, keepRenewed };
}
