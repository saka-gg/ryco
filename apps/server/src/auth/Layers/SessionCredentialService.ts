import { AuthSessionId, type AuthClientMetadata, type AuthClientSession } from "@ryco/contracts";
import { Clock, DateTime, Duration, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect";
import { Option } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { LocalDiagnosticsMetrics } from "../../observability/Services/LocalDiagnosticsMetrics.ts";
import { AuthSessionRepositoryLive } from "../../persistence/Layers/AuthSessions.ts";
import {
  type AuthSessionRecord,
  AuthSessionRepository,
} from "../../persistence/Services/AuthSessions.ts";
import { ServerSecretStore } from "../Services/ServerSecretStore.ts";
import {
  SessionCredentialError,
  SessionCredentialService,
  SessionCredentialUnavailableError,
  SessionRotationError,
  type IssuedSession,
  type SessionCredentialChange,
  type SessionCredentialServiceShape,
  type VerifiedSession,
} from "../Services/SessionCredentialService.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  resolveLegacySessionCookieNames,
  resolveSessionCookieName,
  signPayload,
  timingSafeEqualBase64Url,
} from "../utils.ts";

const SIGNING_SECRET_NAME = "server-signing-key";
/**
 * A session's own lifetime. For a direct (bearer) pairing it is also the idle
 * limit: the client rotates its bearer while in use, so a pairing left unused
 * this long expires and has to be made again.
 */
const DEFAULT_SESSION_TTL = Duration.days(30);
/** Rotation never carries a direct pairing past this age, counted from pairing. */
const BEARER_PAIRING_MAX_AGE = Duration.days(365);
/**
 * How long a superseded bearer still authenticates: requests already in flight
 * when its successor took over. Presented later, the pairing is revoked.
 */
const SUPERSEDED_SESSION_GRACE = Duration.minutes(1);
/** The least time between two rotations of one pairing. */
const BEARER_ROTATION_MIN_INTERVAL = Duration.hours(1);
const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);

const SessionClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  iat: Schema.Number,
  exp: Schema.Number,
});
type SessionClaims = typeof SessionClaims.Type;

const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  iat: Schema.Number,
  exp: Schema.Number,
});
type WebSocketClaims = typeof WebSocketClaims.Type;

const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));
const decodeWebSocketClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(WebSocketClaims));

/**
 * One fixed key order, so a session's token can be derived again from its row:
 * an unused rotation successor is handed out again rather than issued twice.
 */
function sessionClaims(input: {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly role: SessionClaims["role"];
  readonly method: SessionClaims["method"];
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}): SessionClaims {
  return {
    v: 1,
    kind: "session",
    sid: input.sessionId,
    sub: input.subject,
    role: input.role,
    method: input.method,
    iat: input.issuedAtMs,
    exp: input.expiresAtMs,
  };
}

/** Live sockets per session, and the pairing (rotation chain) the session belongs to. */
type ConnectedSessions = ReadonlyMap<
  string,
  { readonly count: number; readonly chainId: AuthSessionId }
>;
type DisconnectOutcome = {
  readonly becameFullyDisconnected: boolean;
  readonly chainId: AuthSessionId;
};

function createDefaultClientMetadata(): AuthClientMetadata {
  return {
    deviceType: "unknown",
  };
}

function toClientMetadata(record: {
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceType: AuthClientMetadata["deviceType"];
  readonly os: string | null;
  readonly browser: string | null;
}): AuthClientMetadata {
  return {
    ...(record.label ? { label: record.label } : {}),
    ...(record.ipAddress ? { ipAddress: record.ipAddress } : {}),
    ...(record.userAgent ? { userAgent: record.userAgent } : {}),
    deviceType: record.deviceType,
    ...(record.os ? { os: record.os } : {}),
    ...(record.browser ? { browser: record.browser } : {}),
  };
}

function toAuthClientSession(input: Omit<AuthClientSession, "current">): AuthClientSession {
  return {
    ...input,
    current: false,
  };
}

export const makeSessionCredentialService = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const secretStore = yield* ServerSecretStore;
  const authSessions = yield* AuthSessionRepository;
  const localDiagnosticsMetrics = yield* Effect.serviceOption(LocalDiagnosticsMetrics);
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  // Live sockets per session, and the pairing (rotation chain) each belongs to:
  // a pairing reads as connected while any of its sessions holds a socket.
  const connectedSessionsRef = yield* Ref.make<ConnectedSessions>(new Map());
  // Rotations run one at a time, so two concurrent requests for one session
  // receive the same successor instead of two.
  const rotationLock = yield* Semaphore.make(1);
  const wsReconnectEligibleSessionsRef = yield* Ref.make(new Set<string>());
  const changesPubSub = yield* PubSub.unbounded<SessionCredentialChange>();
  const cookieName = resolveSessionCookieName({
    mode: serverConfig.mode,
    port: serverConfig.port,
  });
  const legacyCookieNames = resolveLegacySessionCookieNames({
    mode: serverConfig.mode,
    port: serverConfig.port,
  });

  const toSessionCredentialError = (message: string) => (cause: unknown) =>
    new SessionCredentialError({
      message,
      cause,
    });

  // A verification rejects a credential only for what the credential is. A
  // session store that failed to answer is a passing fault on this node: read
  // as a rejection, it would send a valid pairing to be made again.
  const toVerificationFailure =
    (message: string) =>
    (cause: unknown): SessionCredentialError | SessionCredentialUnavailableError =>
      cause instanceof SessionCredentialError
        ? cause
        : new SessionCredentialUnavailableError({ message, cause });

  const signSessionClaims = (claims: SessionClaims) => {
    const encodedPayload = base64UrlEncode(JSON.stringify(claims));
    return `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  };

  const isChainConnected = (
    connectedSessions: ReadonlyMap<string, { readonly chainId: AuthSessionId }>,
    chainId: AuthSessionId,
  ) => {
    for (const entry of connectedSessions.values()) {
      if (entry.chainId === chainId) return true;
    }
    return false;
  };

  const toClientSession = (
    record: AuthSessionRecord,
    connectedSessions: ReadonlyMap<string, { readonly chainId: AuthSessionId }>,
  ) =>
    toAuthClientSession({
      sessionId: record.sessionId,
      subject: record.subject,
      role: record.role,
      method: record.method,
      client: toClientMetadata(record.client),
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      lastConnectedAt: record.lastConnectedAt,
      connected: isChainConnected(connectedSessions, record.chainId),
    });

  const emitUpsert = (clientSession: AuthClientSession) =>
    PubSub.publish(changesPubSub, {
      type: "clientUpserted",
      clientSession,
    }).pipe(Effect.asVoid);

  const emitRemoved = (sessionId: AuthSessionId) =>
    PubSub.publish(changesPubSub, {
      type: "clientRemoved",
      sessionId,
    }).pipe(Effect.asVoid);

  // A pairing shows as its current session; rotation and sockets of earlier
  // sessions in its chain update that one entry.
  const publishChainHead = (chainId: AuthSessionId) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const head = yield* authSessions.getChainHead({ chainId, now });
      if (Option.isNone(head)) return;
      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      yield* emitUpsert(toClientSession(head.value, connectedSessions));
    });

  const markConnected: SessionCredentialServiceShape["markConnected"] = (sessionId) =>
    Effect.gen(function* () {
      const row = yield* authSessions.getById({ sessionId });
      const chainId = Option.isSome(row) ? row.value.chainId : sessionId;
      const wasDisconnected = yield* Ref.modify(connectedSessionsRef, (current) => {
        const next = new Map(current);
        const entry = next.get(sessionId);
        next.set(sessionId, { count: (entry?.count ?? 0) + 1, chainId });
        return [entry === undefined, next] as const;
      });
      if (wasDisconnected) {
        const reconnectEligible = yield* Ref.get(wsReconnectEligibleSessionsRef);
        const lastConnectedAt = yield* DateTime.now;
        yield* authSessions.setLastConnectedAt({ sessionId, lastConnectedAt });
        if (reconnectEligible.has(sessionId) && Option.isSome(localDiagnosticsMetrics)) {
          yield* localDiagnosticsMetrics.value.recordWsReconnect();
        }
      }
      yield* publishChainHead(chainId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish connected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
    );

  const markDisconnected: SessionCredentialServiceShape["markDisconnected"] = (sessionId) =>
    Effect.gen(function* () {
      const { becameFullyDisconnected, chainId } = yield* Ref.modify(
        connectedSessionsRef,
        (current): readonly [DisconnectOutcome, ConnectedSessions] => {
          const next = new Map(current);
          const entry = next.get(sessionId);
          const chainId = entry?.chainId ?? sessionId;
          const remaining = (entry?.count ?? 0) - 1;
          if (entry !== undefined && remaining > 0) {
            next.set(sessionId, { count: remaining, chainId });
            return [{ becameFullyDisconnected: false, chainId }, next];
          }
          next.delete(sessionId);
          return [{ becameFullyDisconnected: true, chainId }, next];
        },
      );
      if (becameFullyDisconnected) {
        yield* Ref.update(wsReconnectEligibleSessionsRef, (current) => {
          const next = new Set(current);
          next.add(sessionId);
          return next;
        });
      }
      yield* publishChainHead(chainId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish disconnected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
    );

  // Revoking any session of a pairing revokes the whole pairing.
  const revokeChain = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      const revokedAt = yield* DateTime.now;
      const revokedSessionIds = yield* authSessions.revoke({ sessionId, revokedAt });
      if (revokedSessionIds.length > 0) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          for (const revokedSessionId of revokedSessionIds) next.delete(revokedSessionId);
          return next;
        });
        yield* Effect.forEach(revokedSessionIds, emitRemoved, {
          concurrency: "unbounded",
          discard: true,
        });
      }
      return revokedSessionIds;
    });

  // A rotated session's first use: the session it replaced is superseded, and
  // the pairing's entry moves to the new session.
  const activateRotatedSession = (record: AuthSessionRecord, predecessorId: AuthSessionId) =>
    Effect.gen(function* () {
      const supersededAt = yield* DateTime.now;
      const superseded = yield* authSessions.supersede({
        sessionId: predecessorId,
        supersededAt,
      });
      if (!superseded) return;
      yield* emitRemoved(predecessorId);
      yield* publishChainHead(record.chainId);
    });

  const issue: SessionCredentialServiceShape["issue"] = (input) =>
    Effect.gen(function* () {
      const sessionId = AuthSessionId.make(crypto.randomUUID());
      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.add(issuedAt, {
        milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_SESSION_TTL),
      });
      const claims = sessionClaims({
        sessionId,
        subject: input?.subject ?? "browser",
        role: input?.role ?? "client",
        method: input?.method ?? "browser-session-cookie",
        issuedAtMs: issuedAt.epochMilliseconds,
        expiresAtMs: expiresAt.epochMilliseconds,
      });
      const client = input?.client ?? createDefaultClientMetadata();
      yield* authSessions.create({
        sessionId,
        subject: claims.sub,
        role: claims.role,
        method: claims.method,
        client: {
          label: client.label ?? null,
          ipAddress: client.ipAddress ?? null,
          userAgent: client.userAgent ?? null,
          deviceType: client.deviceType,
          os: client.os ?? null,
          browser: client.browser ?? null,
        },
        issuedAt,
        expiresAt,
      });
      yield* emitUpsert(
        toAuthClientSession({
          sessionId,
          subject: claims.sub,
          role: claims.role,
          method: claims.method,
          client,
          issuedAt,
          expiresAt,
          lastConnectedAt: null,
          connected: false,
        }),
      );

      return {
        sessionId,
        token: signSessionClaims(claims),
        method: claims.method,
        client,
        expiresAt: expiresAt,
        role: claims.role,
      } satisfies IssuedSession;
    }).pipe(Effect.mapError(toSessionCredentialError("Failed to issue session credential.")));

  const verify: SessionCredentialServiceShape["verify"] = (token) =>
    Effect.gen(function* () {
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* new SessionCredentialError({
          message: "Malformed session token.",
        });
      }

      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* new SessionCredentialError({
          message: "Invalid session token signature.",
        });
      }

      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError(
          (cause) =>
            new SessionCredentialError({
              message: "Invalid session token payload.",
              cause,
            }),
        ),
      );

      const now = yield* Clock.currentTimeMillis;
      if (claims.exp <= now) {
        return yield* new SessionCredentialError({
          message: "Session token expired.",
        });
      }

      const row = yield* authSessions.getById({ sessionId: claims.sid });
      if (Option.isNone(row)) {
        return yield* new SessionCredentialError({
          message: "Unknown session token.",
        });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionCredentialError({
          message: "Session token revoked.",
        });
      }
      const record = row.value;
      if (record.supersededAt !== null) {
        if (
          now - record.supersededAt.epochMilliseconds >
          Duration.toMillis(SUPERSEDED_SESSION_GRACE)
        ) {
          // Its successor took over and this copy is still in use: another
          // holder has the pairing's credential, so the pairing ends for both.
          yield* revokeChain(record.sessionId);
          return yield* new SessionCredentialError({
            message: "Superseded session token reused; its pairing was revoked.",
          });
        }
      } else if (record.rotatedFrom !== null && record.predecessorSupersededAt === null) {
        yield* activateRotatedSession(record, record.rotatedFrom);
      }

      return {
        sessionId: claims.sid,
        token,
        method: claims.method,
        client: toClientMetadata(row.value.client),
        expiresAt: DateTime.makeUnsafe(claims.exp),
        subject: claims.sub,
        role: claims.role,
      } satisfies VerifiedSession;
    }).pipe(Effect.mapError(toVerificationFailure("Failed to verify session credential.")));

  const issueWebSocketToken: SessionCredentialServiceShape["issueWebSocketToken"] = (
    sessionId,
    input,
  ) =>
    Effect.gen(function* () {
      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.add(issuedAt, {
        milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_WEBSOCKET_TOKEN_TTL),
      });
      const claims: WebSocketClaims = {
        v: 1,
        kind: "websocket",
        sid: sessionId,
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };
      const encodedPayload = base64UrlEncode(JSON.stringify(claims));
      const signature = signPayload(encodedPayload, signingSecret);
      return {
        token: `${encodedPayload}.${signature}`,
        expiresAt,
      };
    }).pipe(Effect.mapError(toSessionCredentialError("Failed to issue websocket token.")));

  const verifyWebSocketToken: SessionCredentialServiceShape["verifyWebSocketToken"] = (token) =>
    Effect.gen(function* () {
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* new SessionCredentialError({
          message: "Malformed websocket token.",
        });
      }

      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* new SessionCredentialError({
          message: "Invalid websocket token signature.",
        });
      }

      const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError(
          (cause) =>
            new SessionCredentialError({
              message: "Invalid websocket token payload.",
              cause,
            }),
        ),
      );

      const now = yield* Clock.currentTimeMillis;
      if (claims.exp <= now) {
        return yield* new SessionCredentialError({
          message: "Websocket token expired.",
        });
      }

      const row = yield* authSessions.getById({ sessionId: claims.sid });
      if (Option.isNone(row)) {
        return yield* new SessionCredentialError({
          message: "Unknown websocket session.",
        });
      }
      if (row.value.expiresAt.epochMilliseconds <= now) {
        return yield* new SessionCredentialError({
          message: "Websocket session expired.",
        });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionCredentialError({
          message: "Websocket session revoked.",
        });
      }

      return {
        sessionId: row.value.sessionId,
        token,
        method: row.value.method,
        client: toClientMetadata(row.value.client),
        expiresAt: row.value.expiresAt,
        subject: row.value.subject,
        role: row.value.role,
      } satisfies VerifiedSession;
    }).pipe(Effect.mapError(toVerificationFailure("Failed to verify websocket token.")));

  const listActive: SessionCredentialServiceShape["listActive"] = () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      const rows = yield* authSessions.listActive({ now });

      return rows.map((row) => toClientSession(row, connectedSessions));
    }).pipe(Effect.mapError(toSessionCredentialError("Failed to list active sessions.")));

  const revoke: SessionCredentialServiceShape["revoke"] = (sessionId) =>
    revokeChain(sessionId).pipe(
      Effect.map((revokedSessionIds) => revokedSessionIds.length > 0),
      Effect.mapError(toSessionCredentialError("Failed to revoke session.")),
    );

  const rotate: SessionCredentialServiceShape["rotate"] = (sessionId) =>
    rotationLock
      .withPermits(1)(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const row = yield* authSessions.getById({ sessionId });
          if (Option.isNone(row) || row.value.revokedAt !== null) {
            return yield* new SessionCredentialError({ message: "Unknown session." });
          }
          const current = row.value;
          if (current.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
            return yield* new SessionCredentialError({ message: "Session token expired." });
          }
          if (current.method !== "bearer-session-token") {
            return yield* new SessionRotationError({
              reason: "not-bearer",
              message: "Only bearer sessions renew by rotation.",
            });
          }
          if (current.supersededAt !== null) {
            return yield* new SessionRotationError({
              reason: "superseded",
              message: "This session was already renewed; use its successor.",
            });
          }

          // A successor issued earlier that never reached use (a lost response, a
          // second window): hand out that one again.
          const pending = yield* authSessions.findPendingSuccessor({ sessionId, now });
          if (Option.isSome(pending)) {
            const successor = pending.value;
            return {
              sessionId: successor.sessionId,
              token: signSessionClaims(
                sessionClaims({
                  sessionId: successor.sessionId,
                  subject: successor.subject,
                  role: successor.role,
                  method: successor.method,
                  issuedAtMs: successor.issuedAt.epochMilliseconds,
                  expiresAtMs: successor.expiresAt.epochMilliseconds,
                }),
              ),
              method: successor.method,
              client: toClientMetadata(successor.client),
              expiresAt: successor.expiresAt,
              role: successor.role,
            } satisfies IssuedSession;
          }

          const nowMs = now.epochMilliseconds;
          const lastUsedMs = Math.max(
            current.issuedAt.epochMilliseconds,
            current.lastConnectedAt?.epochMilliseconds ?? 0,
          );
          if (nowMs - lastUsedMs > Duration.toMillis(DEFAULT_SESSION_TTL)) {
            return yield* new SessionRotationError({
              reason: "idle",
              message: "This pairing went unused too long to renew. Pair it again.",
            });
          }
          if (
            nowMs - current.issuedAt.epochMilliseconds <
            Duration.toMillis(BEARER_ROTATION_MIN_INTERVAL)
          ) {
            return yield* new SessionRotationError({
              reason: "renewed-recently",
              message: "This session was renewed recently.",
            });
          }
          const expiresAtMs = Math.min(
            nowMs + Duration.toMillis(DEFAULT_SESSION_TTL),
            current.chainIssuedAt.epochMilliseconds + Duration.toMillis(BEARER_PAIRING_MAX_AGE),
          );
          if (expiresAtMs <= current.expiresAt.epochMilliseconds) {
            return yield* new SessionRotationError({
              reason: "renewal-limit",
              message: "This pairing is a year old and cannot renew again. Pair it again.",
            });
          }

          const successorId = AuthSessionId.make(crypto.randomUUID());
          const expiresAt = DateTime.makeUnsafe(expiresAtMs);
          yield* authSessions.create({
            sessionId: successorId,
            subject: current.subject,
            role: current.role,
            method: current.method,
            client: current.client,
            issuedAt: now,
            expiresAt,
            rotation: {
              rotatedFrom: current.sessionId,
              chainId: current.chainId,
              chainIssuedAt: current.chainIssuedAt,
              lastConnectedAt: current.lastConnectedAt,
            },
          });
          return {
            sessionId: successorId,
            token: signSessionClaims(
              sessionClaims({
                sessionId: successorId,
                subject: current.subject,
                role: current.role,
                method: current.method,
                issuedAtMs: nowMs,
                expiresAtMs,
              }),
            ),
            method: current.method,
            client: toClientMetadata(current.client),
            expiresAt,
            role: current.role,
          } satisfies IssuedSession;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionRotationError || cause instanceof SessionCredentialError
            ? cause
            : new SessionCredentialError({
                message: "Failed to rotate session credential.",
                cause,
              }),
        ),
      );

  const revokeAllExcept: SessionCredentialServiceShape["revokeAllExcept"] = (sessionId) =>
    Effect.gen(function* () {
      const revokedAt = yield* DateTime.now;
      const revokedSessionIds = yield* authSessions.revokeAllExcept({
        currentSessionId: sessionId,
        revokedAt,
      });
      if (revokedSessionIds.length > 0) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          for (const revokedSessionId of revokedSessionIds) {
            next.delete(revokedSessionId);
          }
          return next;
        });
        yield* Effect.forEach(
          revokedSessionIds,
          (revokedSessionId) => emitRemoved(revokedSessionId),
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      }
      return revokedSessionIds.length;
    }).pipe(Effect.mapError(toSessionCredentialError("Failed to revoke other sessions.")));

  return {
    cookieName,
    legacyCookieNames,
    issue,
    verify,
    rotate,
    issueWebSocketToken,
    verifyWebSocketToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    revokeAllExcept,
    markConnected,
    markDisconnected,
  } satisfies SessionCredentialServiceShape;
});

export const SessionCredentialServiceLive = Layer.effect(
  SessionCredentialService,
  makeSessionCredentialService,
).pipe(Layer.provideMerge(AuthSessionRepositoryLive));
