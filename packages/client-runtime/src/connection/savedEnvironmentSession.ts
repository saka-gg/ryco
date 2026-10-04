import type { AuthSessionState } from "@ryco/contracts";

import type { SavedEnvironmentRuntimeState } from "./catalog.ts";
import { isRemoteEnvironmentAuthHttpError } from "./remoteApi.ts";

/**
 * A saved environment's HTTP session check. An unreachable host has to fail
 * into the supervisor's retry schedule rather than hold a connect slot until the
 * operating system gives up on the TCP connection.
 */
export const SAVED_ENVIRONMENT_SESSION_CHECK_TIMEOUT_MS = 15_000;
/**
 * The first server config read over a freshly created socket. The socket
 * reconnects forever on its own, so without a bound a host that answers HTTP but
 * never opens the WebSocket would hold its connect slot for the app's lifetime.
 */
export const SAVED_ENVIRONMENT_INITIAL_CONFIG_TIMEOUT_MS = 20_000;

export const SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE =
  "This environment no longer accepts its saved pairing. Pair it again.";

export class SavedEnvironmentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedEnvironmentTimeoutError";
  }
}

/** Rejects with a `SavedEnvironmentTimeoutError` once `timeoutMs` passes. */
export function withSavedEnvironmentTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new SavedEnvironmentTimeoutError(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

/**
 * The node rejected the saved bearer itself. Expired and revoked sessions answer
 * `/api/auth/ws-token` with 401; no retry can recover them, only pairing again.
 * A 403 is not one: the node never answers a bearer with it, so it comes from
 * something in front of the node — an access gateway, a proxy — that pairing
 * again cannot satisfy.
 */
export function isSavedEnvironmentCredentialRejection(error: unknown): boolean {
  return isRemoteEnvironmentAuthHttpError(error) && error.status === 401;
}

export type SavedEnvironmentSessionCheck =
  | { readonly status: "authenticated"; readonly session: AuthSessionState }
  | { readonly status: "requires-auth" };

/**
 * Asks the node whether the saved bearer is still a session, before any socket
 * is built on it. The node answers an expired or revoked bearer with
 * `200 { authenticated: false }`, so the answer has to be read rather than
 * waiting for an HTTP error that never comes.
 */
export async function checkSavedEnvironmentSession(input: {
  readonly fetchSessionState: () => Promise<AuthSessionState>;
  readonly timeoutMs?: number;
}): Promise<SavedEnvironmentSessionCheck> {
  let session: AuthSessionState;
  try {
    session = await withSavedEnvironmentTimeout(
      input.fetchSessionState(),
      input.timeoutMs ?? SAVED_ENVIRONMENT_SESSION_CHECK_TIMEOUT_MS,
      "The environment did not answer its session check in time.",
    );
  } catch (error) {
    if (isSavedEnvironmentCredentialRejection(error)) return { status: "requires-auth" };
    throw error;
  }
  return session.authenticated ? { status: "authenticated", session } : { status: "requires-auth" };
}

/**
 * The node rejected this saved environment's credential, so background
 * reconnects leave it alone: each would only present the dead credential again.
 * Pairing again, or the user's own Connect, still tries it.
 */
export function isSavedEnvironmentAwaitingRepair(
  runtime: Pick<SavedEnvironmentRuntimeState, "authState"> | null | undefined,
): boolean {
  return runtime?.authState === "requires-auth";
}

/** The runtime state of a saved environment only pairing again can repair. */
export function savedEnvironmentRequiresAuthState(
  nowIso: string,
): Pick<
  SavedEnvironmentRuntimeState,
  "authState" | "connectionState" | "role" | "lastError" | "lastErrorAt"
> {
  return {
    authState: "requires-auth",
    connectionState: "disconnected",
    role: null,
    lastError: SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE,
    lastErrorAt: nowIso,
  };
}
