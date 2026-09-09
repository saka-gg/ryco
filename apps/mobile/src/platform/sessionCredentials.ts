import type { SecretKVService, SessionCredentialsService } from "@ryco/client-runtime/platform";

import { mobileSecretKV } from "./secretKv";

/**
 * A native client cannot use the browser cookie session, so the hosted plane's
 * session mode is "bearer": requests present `Authorization: DPoP <token>` plus
 * a proof, and never a cookie.
 *
 * `HostedHubApi` fails closed at construction when a bearer adapter lacks a
 * DPoP signer or a bearer-token holder, and `configureHostedRuntime` builds the
 * API eagerly — so an adapter missing these accessors throws at app bootstrap
 * rather than at first request. Both accessors below are therefore mandatory,
 * not optional conveniences.
 *
 * The accessors are synchronous while SecretKV is async, so the token is held
 * in an in-memory cache and mirrored to SecretKV for durability across
 * restarts. The token is never logged, never returned from anything that feeds
 * a view model, and never included in an error message.
 */

/** `sanitizeSecretKey` escapes the dots, so this stays readable at the call site. */
export const HOSTED_SESSION_TOKEN_KEY = "ryco.hostedHub.sessionToken";

export interface MobileSessionCredentials extends SessionCredentialsService {
  /** Read the persisted token into the synchronous cache exactly once. */
  readonly hydrate: () => Promise<void>;
  /** Clear memory and durable storage, waiting until the removal has landed. */
  readonly clearBearerToken: () => Promise<void>;
  /** Durably write and read back a newly minted token before publishing it. */
  readonly commitBearerToken: (token: string) => Promise<boolean>;
}

export function createMobileSessionCredentials(
  secretKV: SecretKVService = mobileSecretKV,
): MobileSessionCredentials {
  let csrfToken: string | null = null;
  let bearerToken: string | null = null;
  let hydration: Promise<void> | undefined;
  let revision = 0;
  /** Serializes SecretKV writes so they land in call order. */
  let persistence: Promise<void> = Promise.resolve();
  const persistBearerToken = (token: string | null, requireSuccess = false): Promise<void> => {
    const operation = persistence.then(async () => {
      try {
        if (token === null) await secretKV.remove(HOSTED_SESSION_TOKEN_KEY);
        else await secretKV.set(HOSTED_SESSION_TOKEN_KEY, token);
      } catch {
        if (requireSuccess) {
          throw new Error("The Hub credential could not be cleared.");
        }
        // Persistence is best-effort; never surface the token in an error.
      }
    });
    // A failed required clear is reported to its caller, while the queue itself
    // recovers so a later retry is not permanently skipped.
    persistence = operation.catch(() => undefined);
    return operation;
  };

  return {
    mode: "bearer",
    // Retained because the contract requires them; unused in bearer mode, where
    // requests are sent with `credentials: "omit"` and no CSRF header.
    readCsrfToken: () => csrfToken,
    writeCsrfToken: (token) => {
      csrfToken = token;
    },
    readBearerToken: () => bearerToken,
    writeBearerToken: (token) => {
      revision += 1;
      bearerToken = token;
      // Mirror durably, strictly in call order. Unsequenced writes let a
      // delayed `set` land after the `remove` issued by sign-out, leaving a
      // live token in SecretKV that the next launch would hydrate back — the
      // in-memory holder would be clear but the session would resurrect.
      //
      // Failures are swallowed: losing persistence costs the user a re-login,
      // but must not surface the token in an error path.
      void persistBearerToken(token);
    },
    clearBearerToken: async () => {
      revision += 1;
      bearerToken = null;
      await persistBearerToken(null, true);
    },
    commitBearerToken: async (token) => {
      const commitRevision = ++revision;
      const operation = persistence.then(async () => {
        try {
          const written = await secretKV.set(HOSTED_SESSION_TOKEN_KEY, token);
          if (!written) return false;
          const verified = await secretKV.get(HOSTED_SESSION_TOKEN_KEY);
          if (verified !== token || revision !== commitRevision) return false;
          bearerToken = token;
          return true;
        } catch {
          return false;
        }
      });
      persistence = operation.then(() => undefined);
      return operation;
    },
    hydrate: () => {
      hydration ??= (async () => {
        const startedAtRevision = revision;
        try {
          const stored = await secretKV.get(HOSTED_SESSION_TOKEN_KEY);
          // A token written while hydration was in flight wins: it is newer.
          if (revision === startedAtRevision && stored !== null && stored.length > 0) {
            bearerToken = stored;
          }
        } catch {
          // A locked Keychain is not an absent session. Bootstrap can retry
          // after foreground/unlock without replacing the retained credential.
          hydration = undefined;
          throw new Error("The Hub credential store is unavailable.");
        }
      })();
      return hydration;
    },
  };
}

export const mobileSessionCredentials = createMobileSessionCredentials();

/** Read the persisted hosted session token into the synchronous holder. */
export function hydrateMobileHostedSessionToken(): Promise<void> {
  return mobileSessionCredentials.hydrate();
}

/** Clear a Hub credential before changing the origin it would be sent to. */
export function clearMobileHostedSessionToken(): Promise<void> {
  return mobileSessionCredentials.clearBearerToken();
}
