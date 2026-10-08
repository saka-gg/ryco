import {
  type AuthBearerBootstrapResult,
  type AuthClientSession,
  type AuthBootstrapResult,
  type AuthPairingCredentialResult,
  type AuthSessionState,
  type AuthWebSocketTokenResult,
} from "@ryco/contracts";
import { DateTime, Effect, Layer, Option } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { isLoopbackHost } from "../../startupAccess.ts";
import { AuthControlPlane } from "../Services/AuthControlPlane.ts";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy.ts";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService.ts";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import {
  ServerAuth,
  type AuthenticatedSession,
  AuthError,
  type ServerAuthShape,
} from "../Services/ServerAuth.ts";
import {
  type SessionCredentialError,
  SessionCredentialService,
  type SessionCredentialUnavailableError,
  type SessionRotationRefusal,
} from "../Services/SessionCredentialService.ts";
import { AuthControlPlaneLive, AuthCoreLive } from "./AuthControlPlane.ts";

type BootstrapExchangeResult = {
  readonly response: AuthBootstrapResult;
  readonly sessionToken: string;
};

const AUTHORIZATION_PREFIX = "Bearer ";
const WEBSOCKET_TOKEN_QUERY_PARAM = "wsToken";

function normalizeHost(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseOrigin(value: string | undefined): URL | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostnameFromHostHeader(value: string | undefined): string | null {
  const host = normalizeHost(value);
  if (host === null) {
    return null;
  }
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return host.split(":")[0]?.toLowerCase() ?? null;
  }
}

function defaultPortForProtocol(protocol: string): string | null {
  switch (protocol) {
    case "http:":
      return "80";
    case "https:":
      return "443";
    default:
      return null;
  }
}

function resolvedOriginPort(origin: URL): string | null {
  return origin.port || defaultPortForProtocol(origin.protocol);
}

function portFromHostHeader(value: string | undefined): string | null {
  const host = normalizeHost(value);
  if (host === null) {
    return null;
  }
  try {
    return new URL(`http://${host}`).port || null;
  } catch {
    const port = host.split(":")[1];
    return port && /^\d+$/u.test(port) ? port : null;
  }
}

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a state-changing request that rides the session cookie came from a
 * document other than the app's own. Browsers can attach the cookie to
 * requests the app never made: WebKit sends it from sandboxed, opaque-origin
 * frames such as agent HTML renders (`Origin: null`, and a beacon that reuses
 * the parent's Origin but says `Sec-Fetch-Site: cross-site`), and SameSite
 * ignores ports. Bearer callers carry their own credential and are not checked.
 */
function isForeignCookieMutation(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerConfigShape,
): boolean {
  if (SAFE_HTTP_METHODS.has((request.method ?? "GET").toUpperCase())) return false;
  if (request.headers["sec-fetch-site"]?.trim().toLowerCase() === "cross-site") return true;
  return !isAcceptedWebSocketOrigin({
    origin: request.headers.origin,
    host: request.headers.host,
    config,
  });
}

function isAcceptedWebSocketOrigin(input: {
  readonly origin: string | undefined;
  readonly host: string | undefined;
  readonly config: ServerConfigShape;
}): boolean {
  const origin = parseOrigin(input.origin);
  if (origin === null) {
    return input.origin === undefined || input.origin.trim().length === 0;
  }

  const originHost = normalizeHost(origin.host);
  if (originHost === null) {
    return false;
  }

  const requestHost = normalizeHost(input.host);
  if (requestHost !== null && originHost === requestHost) {
    return true;
  }

  if (input.config.devUrl !== undefined && origin.origin === input.config.devUrl.origin) {
    return true;
  }

  const configuredHost = normalizeHost(input.config.host);
  const configuredPort = String(input.config.port);
  const originPort = resolvedOriginPort(origin);
  if (
    configuredHost !== null &&
    origin.hostname.toLowerCase() === configuredHost &&
    originPort === configuredPort
  ) {
    return true;
  }

  const requestHostname = hostnameFromHostHeader(input.host);
  const requestPort = portFromHostHeader(input.host);
  return (
    requestHostname !== null &&
    requestPort !== null &&
    originPort === requestPort &&
    isLoopbackHost(origin.hostname) &&
    isLoopbackHost(requestHostname)
  );
}

export function toBootstrapExchangeAuthError(cause: BootstrapCredentialError): AuthError {
  if (cause.status === 500) {
    return new AuthError({
      message: "Failed to validate bootstrap credential.",
      status: 500,
      cause,
    });
  }

  return new AuthError({
    message: "Invalid bootstrap credential.",
    status: 401,
    cause,
  });
}

const toCredentialRejection = (cause: SessionCredentialError) =>
  new AuthError({
    message: "Unauthorized request.",
    status: 401,
    cause,
  });

/** The session store did not answer: a passing fault, not a rejected credential. */
const toCredentialCheckUnavailable = (cause: SessionCredentialUnavailableError) =>
  new AuthError({
    message: "Session credentials cannot be checked right now. Try again.",
    status: 503,
    cause,
  });

const ROTATION_REFUSAL_STATUS = {
  "not-bearer": 403,
  superseded: 409,
  "renewed-recently": 409,
  "renewal-limit": 409,
  idle: 401,
} as const satisfies Record<SessionRotationRefusal, 401 | 403 | 409>;

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export const makeServerAuth = Effect.gen(function* () {
  const policy = yield* ServerAuthPolicy;
  const config = yield* ServerConfig;
  const bootstrapCredentials = yield* BootstrapCredentialService;
  const authControlPlane = yield* AuthControlPlane;
  const sessions = yield* SessionCredentialService;
  const descriptor = yield* policy.getDescriptor();

  const authenticateToken = (token: string): Effect.Effect<AuthenticatedSession, AuthError> =>
    sessions.verify(token).pipe(
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        role: session.role,
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
      Effect.catchTags({
        SessionCredentialError: (cause) =>
          Effect.logWarning("Rejected authenticated session credential.").pipe(
            Effect.annotateLogs({
              reason: cause.message,
            }),
            Effect.andThen(Effect.fail(toCredentialRejection(cause))),
          ),
        SessionCredentialUnavailableError: (cause) =>
          Effect.fail(toCredentialCheckUnavailable(cause)),
      }),
    );

  const authenticateRequest = (request: HttpServerRequest.HttpServerRequest) => {
    const cookieToken =
      request.cookies[sessions.cookieName] ??
      sessions.legacyCookieNames
        .map((cookieName) => request.cookies[cookieName])
        .find((token): token is string => typeof token === "string" && token.length > 0);
    const bearerToken = parseBearerToken(request);
    const credential = cookieToken ?? bearerToken;
    if (!credential) {
      return Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      );
    }
    if (cookieToken !== undefined && isForeignCookieMutation(request, config)) {
      return Effect.logWarning("Rejected a cross-site request carrying the session cookie.", {
        method: request.method,
        origin: request.headers.origin ?? null,
        fetchSite: request.headers["sec-fetch-site"] ?? null,
      }).pipe(
        Effect.andThen(
          Effect.fail(new AuthError({ message: "Invalid request origin.", status: 403 })),
        ),
      );
    }
    return authenticateToken(credential);
  };

  const getSessionState: ServerAuthShape["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            role: session.role,
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          }) satisfies AuthSessionState,
      ),
      // A missing or rejected credential is an answer; a credential that could
      // not be checked is not one, and is left to fail for the caller to retry.
      Effect.catchIf(
        (error) => error.status === 401,
        () =>
          Effect.succeed({
            authenticated: false,
            auth: descriptor,
          } satisfies AuthSessionState),
      ),
    );

  const exchangeBootstrapCredential: ServerAuthShape["exchangeBootstrapCredential"] = (
    credential,
    requestMetadata,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeAuthError),
      Effect.flatMap((grant) =>
        sessions
          .issue({
            method: "browser-session-cookie",
            subject: grant.subject,
            role: grant.role,
            client: {
              ...requestMetadata,
              ...(grant.label ? { label: grant.label } : {}),
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Failed to issue authenticated session.",
                  cause,
                }),
            ),
          ),
      ),
      Effect.map(
        (session) =>
          ({
            response: {
              authenticated: true,
              role: session.role,
              sessionMethod: session.method,
              expiresAt: DateTime.toUtc(session.expiresAt),
            } satisfies AuthBootstrapResult,
            sessionToken: session.token,
          }) satisfies BootstrapExchangeResult,
      ),
    );

  const exchangeBootstrapCredentialForBearerSession: ServerAuthShape["exchangeBootstrapCredentialForBearerSession"] =
    (credential, requestMetadata) =>
      bootstrapCredentials.consume(credential).pipe(
        Effect.mapError(toBootstrapExchangeAuthError),
        Effect.flatMap((grant) =>
          sessions
            .issue({
              method: "bearer-session-token",
              subject: grant.subject,
              role: grant.role,
              client: {
                ...requestMetadata,
                ...(grant.label ? { label: grant.label } : {}),
              },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message: "Failed to issue authenticated session.",
                    cause,
                  }),
              ),
            ),
        ),
        Effect.map(
          (session) =>
            ({
              authenticated: true,
              role: session.role,
              sessionMethod: "bearer-session-token",
              expiresAt: DateTime.toUtc(session.expiresAt),
              sessionToken: session.token,
            }) satisfies AuthBearerBootstrapResult,
        ),
      );

  const issuePairingCredential: ServerAuthShape["issuePairingCredential"] = (input) =>
    authControlPlane
      .createPairingLink({
        role: input?.role ?? "client",
        subject: input?.role === "owner" ? "owner-bootstrap" : "one-time-token",
        ...(input?.label ? { label: input.label } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to issue pairing credential.",
              cause,
            }),
        ),
        Effect.map(
          (issued) =>
            ({
              id: issued.id,
              credential: issued.credential,
              ...(issued.label ? { label: issued.label } : {}),
              expiresAt: issued.expiresAt,
            }) satisfies AuthPairingCredentialResult,
        ),
      );

  const listPairingLinks: ServerAuthShape["listPairingLinks"] = () =>
    authControlPlane
      .listPairingLinks({
        role: "client",
        excludeSubjects: ["owner-bootstrap"],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load pairing links.",
              cause,
            }),
        ),
      );

  const revokePairingLink: ServerAuthShape["revokePairingLink"] = (id) =>
    authControlPlane.revokePairingLink(id).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke pairing link.",
            cause,
          }),
      ),
    );

  const listClientSessions: ServerAuthShape["listClientSessions"] = (currentSessionId) =>
    authControlPlane.listSessions().pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load paired clients.",
            cause,
          }),
      ),
      Effect.map((clientSessions) =>
        clientSessions.map((clientSession): AuthClientSession => ({
          ...clientSession,
          current: clientSession.sessionId === currentSessionId,
        })),
      ),
    );

  const revokeClientSession: ServerAuthShape["revokeClientSession"] = (
    currentSessionId,
    targetSessionId,
  ) =>
    Effect.gen(function* () {
      if (currentSessionId === targetSessionId) {
        return yield* new AuthError({
          message: "Use revoke other clients to keep the current owner session active.",
          status: 403,
        });
      }
      return yield* authControlPlane.revokeSession(targetSessionId).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to revoke client session.",
              cause,
            }),
        ),
      );
    });

  const revokeOtherClientSessions: ServerAuthShape["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    authControlPlane.revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke other client sessions.",
            cause,
          }),
      ),
    );

  const issueStartupPairingUrl: ServerAuthShape["issueStartupPairingUrl"] = (baseUrl) =>
    issuePairingCredential({ role: "owner" }).pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
    );

  const issueWebSocketToken: ServerAuthShape["issueWebSocketToken"] = (session) =>
    sessions.issueWebSocketToken(session.sessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to issue websocket token.",
            cause,
          }),
      ),
      Effect.map(
        (issued) =>
          ({
            token: issued.token,
            expiresAt: DateTime.toUtc(issued.expiresAt),
          }) satisfies AuthWebSocketTokenResult,
      ),
    );

  const rotateBearerSession: ServerAuthShape["rotateBearerSession"] = (request) =>
    Effect.gen(function* () {
      // Only the bearer itself renews: a cookie on the same request is ignored.
      const bearerToken = parseBearerToken(request);
      if (!bearerToken) {
        return yield* new AuthError({
          message: "A bearer session is required.",
          status: 401,
        });
      }
      const session = yield* authenticateToken(bearerToken);
      if (session.method !== "bearer-session-token") {
        return yield* new AuthError({
          message: "Only bearer sessions renew by rotation.",
          status: 403,
        });
      }
      const rotated = yield* sessions.rotate(session.sessionId).pipe(
        Effect.catchTags({
          SessionRotationError: (cause) =>
            Effect.fail(
              new AuthError({
                message: cause.message,
                status: ROTATION_REFUSAL_STATUS[cause.reason],
                cause,
              }),
            ),
          SessionCredentialError: (cause) =>
            Effect.fail(
              new AuthError({
                message: "Failed to renew the session.",
                cause,
              }),
            ),
        }),
      );
      return {
        authenticated: true,
        role: rotated.role,
        sessionMethod: "bearer-session-token",
        expiresAt: DateTime.toUtc(rotated.expiresAt),
        sessionToken: rotated.token,
      } satisfies AuthBearerBootstrapResult;
    });

  const authenticateWebSocketUpgrade: ServerAuthShape["authenticateWebSocketUpgrade"] = (request) =>
    Effect.gen(function* () {
      if (
        !isAcceptedWebSocketOrigin({
          origin: request.headers.origin,
          host: request.headers.host,
          config,
        })
      ) {
        yield* Effect.logWarning("Rejected websocket upgrade from unexpected origin.", {
          origin: request.headers.origin ?? null,
          host: request.headers.host ?? null,
        });
        return yield* new AuthError({
          message: "WebSocket origin is not allowed.",
          status: 403,
        });
      }

      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const websocketToken = requestUrl.value.searchParams.get(WEBSOCKET_TOKEN_QUERY_PARAM);
        if (websocketToken && websocketToken.trim().length > 0) {
          return yield* sessions.verifyWebSocketToken(websocketToken).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              role: session.role,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            Effect.mapError((cause) =>
              cause._tag === "SessionCredentialUnavailableError"
                ? toCredentialCheckUnavailable(cause)
                : toCredentialRejection(cause),
            ),
          );
        }
      }

      return yield* new AuthError({
        message: "WebSocket token required.",
        status: 401,
      });
    });

  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState,
    exchangeBootstrapCredential,
    exchangeBootstrapCredentialForBearerSession,
    issuePairingCredential,
    listPairingLinks,
    revokePairingLink,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest: authenticateRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketToken,
    rotateBearerSession,
    issueStartupPairingUrl,
  } satisfies ServerAuthShape;
});

export const ServerAuthLive = Layer.effect(ServerAuth, makeServerAuth).pipe(
  Layer.provideMerge(AuthControlPlaneLive),
  Layer.provideMerge(AuthCoreLive),
  Layer.provideMerge(ServerAuthPolicyLive),
);
