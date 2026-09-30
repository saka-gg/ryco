/**
 * `ryco hub login`: link a headless node to a Ryco account without a browser.
 *
 * The CLI signs in with the Hub's native password login — the one account
 * sign-in that needs neither a browser callback nor a platform authenticator —
 * under a DPoP key that exists only for this command. It then approves this
 * node's own device-code enrollment through the owner routes the Hub web app
 * uses, after checking the enrollment's public-key fingerprint against the
 * fingerprint the local node reported, and signs out. The node's own polling
 * completes enrollment; from then on it authenticates with its own Ed25519 key
 * and no account credential stays on the machine.
 */
import { randomUUID, webcrypto } from "node:crypto";

import { HostedHubApi, HostedHubApiError } from "@ryco/client-runtime/authorization";
import type {
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";
import { createDpopProofSigner } from "@ryco/client-runtime/relay";

const unavailablePasskeys: PasskeyCeremonyService = {
  authenticate: async () => {
    throw new Error("Passkeys are unavailable in the ryco CLI.");
  },
  register: async () => {
    throw new Error("Passkeys are unavailable in the ryco CLI.");
  },
};

export interface CliHubAccount {
  readonly api: HostedHubApi;
  /** Bind the native session token the login returned; it is never persisted. */
  readonly useSessionToken: (token: string) => void;
}

/** A Hub API client whose session and DPoP key live only in this process. */
export async function createCliHubAccount(
  origin: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<CliHubAccount> {
  const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  if (publicJwk.x === undefined || publicJwk.y === undefined) {
    throw new Error("Unable to create a DPoP key.");
  }
  const dpopSigner = createDpopProofSigner(
    {
      algorithm: "ES256",
      publicJwk: { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y },
      // WebCrypto ECDSA signatures are already the raw r||s form JWS expects.
      sign: async (signingInput) =>
        new Uint8Array(
          await webcrypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            keyPair.privateKey,
            signingInput,
          ),
        ),
    },
    {
      now: Date.now,
      randomJti: () => randomUUID(),
      sha256: async (bytes) =>
        new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes)),
    },
  );
  let bearerToken: string | null = null;
  let csrfToken: string | null = null;
  const sessionCredentials: SessionCredentialsService = {
    mode: "bearer",
    readCsrfToken: () => csrfToken,
    writeCsrfToken: (token) => {
      csrfToken = token;
    },
    readBearerToken: () => bearerToken,
    writeBearerToken: (token) => {
      bearerToken = token;
    },
  };
  const httpClient: HttpClientService = {
    fetch: (url, init) =>
      fetchImpl(url, init === undefined ? undefined : (init as RequestInit)) as Promise<Response>,
  };
  const api = new HostedHubApi({
    endpoint: {
      origin: () => origin,
      readPrimaryTarget: () => null,
      resolveHttpUrl: (pathname, searchParams) => {
        const url = new URL(pathname, origin);
        for (const [key, value] of Object.entries(searchParams ?? {})) {
          url.searchParams.set(key, value);
        }
        return url.toString();
      },
      resolveWsUrl: (url) => url,
    },
    httpClient,
    passkeyCeremony: unavailablePasskeys,
    sessionCredentials,
    dpopSigner,
  });
  return {
    api,
    useSessionToken: (token) => {
      bearerToken = token;
    },
  };
}

export type AccountSecondFactor = "totp" | "email_code";

export class AccountLinkError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AccountLinkError";
  }
}

/** A bounded, user-facing explanation for a Hub refusal; never the Hub's raw text. */
export function describeAccountLinkFailure(error: unknown): string {
  if (error instanceof AccountLinkError) return error.message;
  if (!(error instanceof HostedHubApiError)) {
    return "The Hub could not be reached. Check the network and the Hub address (--hub-origin).";
  }
  if (error.status === 404) {
    return "This Hub does not offer password sign-in for apps. Run `ryco hub enroll` and approve the code in the Ryco web app instead.";
  }
  if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
  if (error.status === 401 || error.status === 403) {
    return "Sign-in was refused. Check the username, password, and code; accounts that sign in only with a passkey or GitHub cannot use `ryco hub login` — use `ryco hub enroll` instead.";
  }
  return `The Hub refused the request (${error.code}).`;
}

/**
 * Start the Hub's native password login. The Hub always asks for a second
 * factor; the caller reads it from the user and passes it to `finish`, which
 * binds the resulting session to `account`.
 */
export async function startPasswordSignIn(
  account: CliHubAccount,
  input: { readonly username: string; readonly password: string },
): Promise<{
  readonly factor: AccountSecondFactor;
  readonly finish: (code: string) => Promise<void>;
}> {
  const started = await account.api.startNativeIdentityPasswordLogin({
    kind: "username",
    username: input.username as never,
    password: input.password as never,
  });
  return {
    factor: started.factor,
    finish: async (code) => {
      const finished = await account.api.finishNativeIdentityPasswordLogin({
        attemptId: started.attemptId,
        attemptSecret: started.attemptSecret,
        factor: started.factor,
        code: code.trim() as never,
      } as Parameters<HostedHubApi["finishNativeIdentityPasswordLogin"]>[0]);
      // The finish call does not keep the token; the session is this process's alone.
      account.useSessionToken(finished.token);
    },
  };
}

/**
 * Approve this node's pending enrollment — and only it. The Hub resolves the
 * device code to an enrollment; its fingerprint must equal the one the local
 * node reported over its authenticated loopback API, so a code that collided
 * with, or was swapped for, another node's is never approved.
 */
export async function approveOwnEnrollment(
  api: HostedHubApi,
  local: { readonly deviceCode: string; readonly fingerprint: string },
): Promise<void> {
  const enrollment = await api.lookupNodeEnrollment(local.deviceCode);
  if (enrollment.fingerprint !== local.fingerprint) {
    throw new AccountLinkError(
      "The Hub's pending enrollment for this code does not match this node's key, so it was not approved. Run `ryco hub cancel` and try again.",
    );
  }
  await api.approveNodeEnrollment(local.deviceCode);
}
