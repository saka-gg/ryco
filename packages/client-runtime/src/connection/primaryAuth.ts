import type {
  HubConnectorStatus,
  HubEnrollmentCeremonyDetail,
  HubEnrollmentStartResult,
  HubIdentitySummary,
  AuthBootstrapInput,
  AuthBootstrapResult,
  AuthClientMetadata,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthSessionId,
  AuthSessionState,
  AuthWebSocketTokenResult,
} from "@ryco/contracts";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

import type {
  EndpointService,
  HttpClientService,
  PairingCredentialSourceService,
  SessionCredentialsService,
} from "../platform/index.ts";
import { fetchWithDeadline, isAbortOrTimeoutError } from "./fetchWithDeadline.ts";
import type {
  NodeE2eeAuthorizationChange,
  NodeE2eeAuthorizationRequest,
  NodeE2eeClientListing,
  NodeE2eeContinuity,
  NodeE2eeCrossDeviceApproval,
  NodeE2eeContinuityChange,
  NodeE2eeFallback,
  NodeE2eePolicy,
  NodeE2eePolicyChange,
  NodeE2eePolicyProposal,
  NodeE2eePrekey,
  NodeE2eeSessionList,
} from "./nodeE2eeOperator.ts";

export class BootstrapHttpError extends Data.TaggedError("BootstrapHttpError")<{
  readonly message: string;
  readonly status: number;
}> {}
const isBootstrapHttpError = (value: unknown): value is BootstrapHttpError =>
  Predicate.isTagged(value, "BootstrapHttpError");

export interface ServerPairingLinkRecord {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ServerClientSessionRecord {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly role: "owner" | "client";
  readonly method: "browser-session-cookie" | "bearer-session-token";
  readonly client: AuthClientMetadata;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}

export type ServerAuthGateState =
  | { status: "authenticated" }
  | { status: "requires-auth"; auth: AuthSessionState["auth"]; errorMessage?: string };

export interface PrimaryAuthDependencies {
  readonly endpoint: EndpointService;
  readonly httpClient: HttpClientService;
  readonly sessionCredentials: SessionCredentialsService;
  readonly pairingCredentialSource: PairingCredentialSourceService;
  readonly readBootstrapCredential: () => string | null;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000;
const AUTH_SESSION_ESTABLISH_STEP_MS = 100;
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;
const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);
const INVALID_BOOTSTRAP_CREDENTIAL_MESSAGES = new Set([
  "Invalid bootstrap credential.",
  "Unknown bootstrap credential.",
]);

export function createPrimaryAuth(deps: PrimaryAuthDependencies) {
  let bootstrapPromise: Promise<ServerAuthGateState> | null = null;
  let resolvedAuthenticatedGateState: ServerAuthGateState | null = null;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), milliseconds);
      }));
  const credentials =
    deps.sessionCredentials.mode === "cookie" ? { credentials: "include" as const } : {};
  /**
   * Retries a control-plane request that failed the way a restarting server
   * fails it: refused, timed out by its deadline, or answered 502-504. A
   * caller `signal` stops the retries, so an abandoned attempt sends nothing.
   */
  const retryTransientBootstrap = async <T>(
    operation: () => Promise<T>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T> => {
    const startedAt = now();
    const abandoned = () => options?.signal?.aborted === true;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const transient = isBootstrapHttpError(error)
          ? TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status)
          : error instanceof TypeError || isAbortOrTimeoutError(error);
        if (!transient || abandoned() || now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS) {
          throw error;
        }
        await sleep(BOOTSTRAP_RETRY_STEP_MS);
        if (abandoned()) throw error;
      }
    }
  };
  const fetchControlPlane = (pathname: string, init: Parameters<HttpClientService["fetch"]>[1]) =>
    fetchWithDeadline(deps.httpClient, deps.endpoint.resolveHttpUrl(pathname), init);
  const readErrorMessage = async (
    response: Awaited<ReturnType<HttpClientService["fetch"]>>,
    fallbackMessage: string,
  ) => (await response.text()) || fallbackMessage;
  const fetchSessionState = async (): Promise<AuthSessionState> =>
    retryTransientBootstrap(async () => {
      const response = await fetchControlPlane("/api/auth/session", credentials);
      if (!response.ok) {
        throw new BootstrapHttpError({
          message: `Failed to load server auth session state (${response.status}).`,
          status: response.status,
        });
      }
      return (await response.json()) as AuthSessionState;
    });
  /**
   * Every reconnect attempt resolves its socket URL through this request, so a
   * hung one would stall reconnecting; `signal` lets the attempt abandon it.
   */
  const issuePrimaryWebSocketToken = async (
    signal?: AbortSignal,
  ): Promise<AuthWebSocketTokenResult> =>
    retryTransientBootstrap(
      async () => {
        const response = await fetchControlPlane("/api/auth/ws-token", {
          ...credentials,
          method: "POST",
          ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok)
          throw new BootstrapHttpError({
            message: `Failed to issue websocket token (${response.status}).`,
            status: response.status,
          });
        return (await response.json()) as AuthWebSocketTokenResult;
      },
      signal === undefined ? undefined : { signal },
    );
  const exchangeBootstrapCredential = async (credential: string): Promise<AuthBootstrapResult> =>
    retryTransientBootstrap(async () => {
      const response = await fetchControlPlane("/api/auth/bootstrap", {
        ...credentials,
        body: JSON.stringify({ credential } satisfies AuthBootstrapInput),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const raw = await response.text();
        let message = raw.trim();
        try {
          const parsed = JSON.parse(message) as { error?: unknown };
          if (typeof parsed.error === "string" && parsed.error.trim())
            message = parsed.error.trim();
        } catch {
          /* plain text */
        }
        if (response.status === 401 && INVALID_BOOTSTRAP_CREDENTIAL_MESSAGES.has(message))
          message = "Invalid pairing token. Check the token and try again.";
        throw new BootstrapHttpError({
          message: message || `Failed to bootstrap auth session (${response.status}).`,
          status: response.status,
        });
      }
      return (await response.json()) as AuthBootstrapResult;
    });
  const waitForAuthenticatedSessionAfterBootstrap = async (): Promise<AuthSessionState> => {
    const startedAt = now();
    for (;;) {
      const session = await fetchSessionState();
      if (session.authenticated) return session;
      if (now() - startedAt >= AUTH_SESSION_ESTABLISH_TIMEOUT_MS)
        throw new Error("Timed out waiting for authenticated session after bootstrap.");
      await sleep(AUTH_SESSION_ESTABLISH_STEP_MS);
    }
  };
  const bootstrapServerAuth = async (): Promise<ServerAuthGateState> => {
    const bootstrapCredential = deps.readBootstrapCredential();
    const currentSession = await fetchSessionState();
    if (currentSession.authenticated) return { status: "authenticated" };
    if (!bootstrapCredential) return { status: "requires-auth", auth: currentSession.auth };
    try {
      await exchangeBootstrapCredential(bootstrapCredential);
      await waitForAuthenticatedSessionAfterBootstrap();
      return { status: "authenticated" };
    } catch (error) {
      return {
        status: "requires-auth",
        auth: currentSession.auth,
        errorMessage: error instanceof Error ? error.message : "Authentication failed.",
      };
    }
  };
  const post = async <T>(pathname: string, body?: unknown): Promise<T> => {
    const response = await deps.httpClient.fetch(deps.endpoint.resolveHttpUrl(pathname), {
      ...credentials,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      method: "POST",
    });
    if (!response.ok)
      throw new Error(await readErrorMessage(response, `Request failed (${response.status}).`));
    return (await response.json()) as T;
  };
  const get = async <T>(pathname: string, fallback: string): Promise<T> => {
    const response = await deps.httpClient.fetch(
      deps.endpoint.resolveHttpUrl(pathname),
      credentials,
    );
    if (!response.ok) throw new Error(await readErrorMessage(response, fallback));
    return (await response.json()) as T;
  };
  /**
   * Hub connector control, over the node's own owner-gated HTTP routes.
   *
   * Reached through this factory rather than a panel-local fetch so it inherits
   * the cookie-versus-bearer credential choice, the transient-bootstrap retry,
   * and the bounded error extraction that already live here. These routes are
   * unreachable over the relay by construction: the relay carries only
   * `ryco.rpc` channels, and there is no HTTP tunnel.
   */
  const getHubOrNull = async <T>(pathname: string, fallback: string): Promise<T | null> => {
    const response = await deps.httpClient.fetch(
      deps.endpoint.resolveHttpUrl(pathname),
      credentials,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await readErrorMessage(response, fallback));
    return (await response.json()) as T;
  };

  return {
    fetchSessionState,
    issuePrimaryWebSocketToken,
    fetchHubStatus: () => get<HubConnectorStatus>("/api/hub/status", "Unable to read Hub status."),
    fetchHubIdentity: () =>
      get<HubIdentitySummary>("/api/hub/identity", "Unable to read Hub identity state."),
    fetchHubEnrollment: () =>
      getHubOrNull<HubEnrollmentCeremonyDetail>(
        "/api/hub/enrollment",
        "Unable to read the pending Hub enrollment.",
      ),
    startHubEnrollment: () => post<HubEnrollmentStartResult>("/api/hub/enrollment"),
    cancelHubEnrollment: () => post<HubConnectorStatus>("/api/hub/enrollment/cancel"),
    resumeHubConnector: () => post<HubConnectorStatus>("/api/hub/resume"),
    leaveHub: () => post<HubConnectorStatus>("/api/hub/leave"),
    // ─── the node's E2EE operator surface (§6.4, §7.5, §12.5, §12.6, §13.4–§13.6) ───
    //
    // The same local routes the node CLI drives, reached the same way the Hub
    // connector controls above are: through this factory, so they inherit the
    // cookie-versus-bearer credential choice and the bounded error extraction
    // rather than growing a second opinion about either.
    //
    // EVERY ONE OF THEM IS LOCAL-ONLY, AND NOT BY CONVENTION. `resolveHttpUrl`
    // is the hosted HTTP boundary: in hosted mode it throws before a request is
    // built, so a hosted browser cannot reach a node route even if a surface
    // asked it to. That is the outer half of the `requireApprovedClientE2EE`
    // block — the inner half is in the panel's own logic, which never offers the
    // control there (`NodeSecuritySettings.logic.ts`).
    fetchNodeE2eeClients: () =>
      get<NodeE2eeClientListing>(
        "/api/hub/e2ee/clients",
        "Unable to read client authorization records.",
      ),
    applyNodeE2eeAuthorization: (request: NodeE2eeAuthorizationRequest) =>
      post<NodeE2eeAuthorizationChange>("/api/hub/e2ee/clients/authorization", request),
    createNodeE2eeClientApprovalQr: (request: {
      readonly hubOrigin: string;
      readonly accountId: string;
      readonly fingerprint: string;
    }) => post<NodeE2eeCrossDeviceApproval>("/api/hub/e2ee/clients/approval-qr", request),
    setNodeE2eePairingWindow: (
      request:
        | { readonly action: "open"; readonly fingerprint: string }
        | { readonly action: "close" },
    ) => post<NodeE2eeClientListing>("/api/hub/e2ee/clients/pairing-window", request),
    clearNodeE2eeRefusals: () =>
      post<NodeE2eeClientListing>("/api/hub/e2ee/clients/refusals/clear"),
    fetchNodeE2eeSessions: () =>
      get<NodeE2eeSessionList>("/api/hub/e2ee/sessions", "Unable to read E2EE sessions."),
    fetchNodeE2eePolicy: () =>
      get<NodeE2eePolicy>("/api/hub/e2ee/policy", "Unable to read the node admission policy."),
    // §12.6 keeps the preview a separate request that mutates nothing, so a
    // surface can warn before anything commits. It stays separate here for the
    // same reason: one function that could warn or sweep depending on a flag is
    // the shape most likely to sweep when an operator meant to look.
    previewNodeE2eePolicy: (proposal: NodeE2eePolicyProposal) =>
      post<NodeE2eePolicyChange>("/api/hub/e2ee/policy/preview", proposal),
    applyNodeE2eePolicy: (proposal: NodeE2eePolicyProposal) =>
      post<NodeE2eePolicyChange>("/api/hub/e2ee/policy", proposal),
    recoverNodeE2eePolicyGeneration: () =>
      post<NodeE2eePolicyChange>("/api/hub/e2ee/policy/recover"),
    fetchNodeE2eePrekey: () =>
      get<NodeE2eePrekey>("/api/hub/e2ee/prekey", "Unable to read the agreement prekey."),
    rotateNodeE2eePrekey: () => post<NodeE2eePrekey>("/api/hub/e2ee/prekey/rotate"),
    fetchNodeE2eeContinuity: () =>
      get<NodeE2eeContinuity>("/api/hub/e2ee/continuity", "Unable to read continuity state."),
    applyNodeE2eeContinuity: (
      request:
        | { readonly action: "adopt"; readonly continuityId: string }
        | { readonly action: "remint" }
        | { readonly action: "break" },
    ) => post<NodeE2eeContinuityChange>("/api/hub/e2ee/continuity", request),
    fetchNodeE2eeFallback: () =>
      get<NodeE2eeFallback>("/api/hub/e2ee/fallback", "Unable to read fallback diagnostics."),
    resetNodeE2eeFallback: () => post<NodeE2eeFallback>("/api/hub/e2ee/fallback/reset"),
    retryTransientBootstrap,
    takePairingCredential: () => deps.pairingCredentialSource.take(),
    submitServerAuthCredential: async (credential: string) => {
      const trimmedCredential = credential.trim();
      if (!trimmedCredential) throw new Error("Enter a pairing token to continue.");
      resolvedAuthenticatedGateState = null;
      await exchangeBootstrapCredential(trimmedCredential);
      bootstrapPromise = null;
    },
    createServerPairingCredential: (label?: string) =>
      post<AuthPairingCredentialResult>(
        "/api/auth/pairing-token",
        label?.trim() ? ({ label: label.trim() } satisfies AuthCreatePairingCredentialInput) : {},
      ),
    listServerPairingLinks: () =>
      get<ReadonlyArray<ServerPairingLinkRecord>>(
        "/api/auth/pairing-links",
        "Failed to load pairing links.",
      ),
    revokeServerPairingLink: async (id: string) =>
      void (await post<void>("/api/auth/pairing-links/revoke", {
        id,
      } satisfies AuthRevokePairingLinkInput)),
    listServerClientSessions: () =>
      get<ReadonlyArray<ServerClientSessionRecord>>(
        "/api/auth/clients",
        "Failed to load paired clients.",
      ),
    revokeServerClientSession: async (sessionId: AuthSessionId) =>
      void (await post<void>("/api/auth/clients/revoke", {
        sessionId,
      } satisfies AuthRevokeClientSessionInput)),
    revokeOtherServerClientSessions: async () =>
      (await post<{ revokedCount?: number }>("/api/auth/clients/revoke-others")).revokedCount ?? 0,
    resolveInitialServerAuthGateState: (): Promise<ServerAuthGateState> => {
      if (resolvedAuthenticatedGateState?.status === "authenticated")
        return Promise.resolve(resolvedAuthenticatedGateState);
      if (bootstrapPromise) return bootstrapPromise;
      const nextPromise = bootstrapServerAuth();
      bootstrapPromise = nextPromise;
      return nextPromise
        .then((result) => {
          if (result.status === "authenticated") resolvedAuthenticatedGateState = result;
          return result;
        })
        .finally(() => {
          if (bootstrapPromise === nextPromise) bootstrapPromise = null;
        });
    },
    resetForTests: () => {
      bootstrapPromise = null;
      resolvedAuthenticatedGateState = null;
    },
  };
}

export type PrimaryAuth = ReturnType<typeof createPrimaryAuth>;
