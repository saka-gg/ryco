import { shouldRenewSavedSession } from "@ryco/client-runtime/connection";
import type { KVService } from "@ryco/client-runtime/platform";
import type { AuthSessionState, EnvironmentId } from "@ryco/contracts";

/**
 * The node's last answer about each saved environment's session.
 *
 * A direct connect used to ask `GET /api/auth/session` before every ws-token
 * request, only to learn whether the session was due for renewal and which
 * role it carries. That answer barely moves: a pairing renews once a day of its
 * 30-day lifetime has passed. Keeping it lets a connect whose session is not
 * due go straight to the ws-token request — which rejects an expired or revoked
 * bearer with a terminal 401 anyway — and re-ask in the background once the
 * socket is up.
 *
 * Only non-secret session metadata is kept (method, expiry, role, the node's
 * auth descriptor); nothing here is or is derived from the bearer. A hint that
 * outlives its bearer only errs towards checking: a bearer that replaced it
 * (renewal, pairing again) is newer, so it is never due earlier.
 */
export const SAVED_SESSION_HINTS_STORAGE_KEY = "ryco.savedEnvironments.sessionHints.v1";

/** Never skip the check for a session this close to its expiry. */
const MIN_REMAINING_MS = 60 * 60 * 1000;

export interface SavedSessionHints {
  readonly read: (environmentId: EnvironmentId) => Promise<AuthSessionState | null>;
  readonly record: (environmentId: EnvironmentId, session: AuthSessionState) => void;
  readonly forget: (environmentId: EnvironmentId) => void;
}

/**
 * A hint is held in its JSON form (see `sessionHintFields`), where `expiresAt`
 * is the ISO string the node sent; anything else is no usable expiry.
 */
function expiresAtMillis(session: AuthSessionState): number | null {
  const value: unknown = session.expiresAt;
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * The hint, when a connect may present the stored bearer to the ws-token
 * endpoint without asking for the session first: a bearer session the node
 * answered for, comfortably before expiry and not yet due for renewal (renewal
 * must happen before a socket is built on the bearer, so it keeps the check).
 */
export function usableSavedSessionHint(
  hint: AuthSessionState | null,
  nowMs: number,
): AuthSessionState | null {
  if (hint === null || hint.authenticated !== true) return null;
  if (hint.sessionMethod !== "bearer-session-token") return null;
  const expiresAtMs = expiresAtMillis(hint);
  if (expiresAtMs === null || expiresAtMs - nowMs < MIN_REMAINING_MS) return null;
  return shouldRenewSavedSession(hint, nowMs) ? null : hint;
}

/**
 * The fields a hint keeps. The answer arrives as raw JSON, so anything else the
 * node may add is dropped rather than persisted. Kept in its JSON form, so a
 * hint read back in this process is the same value a later launch decodes.
 */
function sessionHintFields(session: AuthSessionState): AuthSessionState {
  return JSON.parse(
    JSON.stringify({
      authenticated: session.authenticated,
      auth: session.auth,
      ...(session.role !== undefined ? { role: session.role } : {}),
      ...(session.sessionMethod !== undefined ? { sessionMethod: session.sessionMethod } : {}),
      ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
    }),
  ) as AuthSessionState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeHints(raw: string | null): Map<string, AuthSessionState> {
  const hints = new Map<string, AuthSessionState>();
  if (raw === null) return hints;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.sessions)) return hints;
    for (const [environmentId, session] of Object.entries(parsed.sessions)) {
      if (isRecord(session) && session.authenticated === true && isRecord(session.auth)) {
        hints.set(environmentId, session as unknown as AuthSessionState);
      }
    }
  } catch {
    // A corrupt record is no hint: every connect checks first.
  }
  return hints;
}

export function createSavedSessionHints(
  kv: Pick<KVService, "getItem" | "setItem">,
): SavedSessionHints {
  let loaded: Map<string, AuthSessionState> | null = null;
  let loading: Promise<Map<string, AuthSessionState>> | null = null;
  /** Changes made before the stored record was read; `null` forgets. */
  const pending = new Map<string, AuthSessionState | null>();
  /** Serializes KV writes so they land in call order. */
  let persistence: Promise<void> = Promise.resolve();

  const load = (): Promise<Map<string, AuthSessionState>> => {
    if (loaded !== null) return Promise.resolve(loaded);
    loading ??= kv
      .getItem(SAVED_SESSION_HINTS_STORAGE_KEY)
      .catch(() => null)
      .then((raw) => {
        const hints = decodeHints(raw);
        // Changes made while the read was in flight are newer than what it read.
        for (const [environmentId, session] of pending) {
          if (session === null) hints.delete(environmentId);
          else hints.set(environmentId, session);
        }
        pending.clear();
        loaded = hints;
        return hints;
      });
    return loading;
  };

  const persist = (hints: Map<string, AuthSessionState>) => {
    const snapshot = JSON.stringify({ version: 1, sessions: Object.fromEntries(hints) });
    persistence = persistence
      .then(() => kv.setItem(SAVED_SESSION_HINTS_STORAGE_KEY, snapshot))
      .catch(() => undefined);
  };

  const change = (environmentId: EnvironmentId, session: AuthSessionState | null) => {
    if (loaded === null) pending.set(environmentId, session);
    else if (session === null) loaded.delete(environmentId);
    else loaded.set(environmentId, session);
    void load().then(persist);
  };

  return {
    read: async (environmentId) => (await load()).get(environmentId) ?? null,
    record: (environmentId, session) => {
      if (session.authenticated === true) change(environmentId, sessionHintFields(session));
    },
    forget: (environmentId) => change(environmentId, null),
  };
}
