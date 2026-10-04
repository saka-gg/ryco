import type {
  AuthClientMetadata,
  AuthClientSession,
  AuthSessionId,
  ServerAuthSessionMethod,
} from "@ryco/contracts";
import { Data, DateTime, Duration, Context } from "effect";
import type { Effect, Stream } from "effect";

export type SessionRole = "owner" | "client";

export interface IssuedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.DateTime;
  readonly role: SessionRole;
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
  readonly role: SessionRole;
}

export type SessionCredentialChange =
  | {
      readonly type: "clientUpserted";
      readonly clientSession: AuthClientSession;
    }
  | {
      readonly type: "clientRemoved";
      readonly sessionId: AuthSessionId;
    };

export class SessionCredentialError extends Data.TaggedError("SessionCredentialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Why a bearer session could not rotate. `superseded`, `renewed-recently` and
 * `renewal-limit` leave the presented session as valid as it was; `idle` and
 * `not-bearer` say it can never rotate.
 */
export type SessionRotationRefusal =
  | "not-bearer"
  | "superseded"
  | "renewed-recently"
  | "renewal-limit"
  | "idle";

export class SessionRotationError extends Data.TaggedError("SessionRotationError")<{
  readonly reason: SessionRotationRefusal;
  readonly message: string;
}> {}

export interface SessionCredentialServiceShape {
  readonly cookieName: string;
  readonly legacyCookieNames: readonly string[];
  readonly issue: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly method?: ServerAuthSessionMethod;
    readonly role?: SessionRole;
    readonly client?: AuthClientMetadata;
  }) => Effect.Effect<IssuedSession, SessionCredentialError>;
  /**
   * Verifies a session token. A rotated session's first use supersedes the
   * session it replaced; a superseded session presented after its grace revokes
   * its whole pairing.
   */
  readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
  /**
   * Issues the successor of a bearer session: same subject, role and client,
   * never past a year from the original pairing. The presented session stays
   * valid until the successor is first used, and asking again before that
   * returns the same successor.
   */
  readonly rotate: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<IssuedSession, SessionCredentialError | SessionRotationError>;
  readonly issueWebSocketToken: (
    sessionId: AuthSessionId,
    input?: {
      readonly ttl?: Duration.Duration;
    },
  ) => Effect.Effect<
    {
      readonly token: string;
      readonly expiresAt: DateTime.DateTime;
    },
    SessionCredentialError
  >;
  readonly verifyWebSocketToken: (
    token: string,
  ) => Effect.Effect<VerifiedSession, SessionCredentialError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<AuthClientSession>,
    SessionCredentialError
  >;
  readonly streamChanges: Stream.Stream<SessionCredentialChange>;
  readonly revoke: (sessionId: AuthSessionId) => Effect.Effect<boolean, SessionCredentialError>;
  readonly revokeAllExcept: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<number, SessionCredentialError>;
  readonly markConnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
  readonly markDisconnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
}

export class SessionCredentialService extends Context.Service<
  SessionCredentialService,
  SessionCredentialServiceShape
>()("ryco/auth/Services/SessionCredentialService") {}
