import type {
  AuthClientMetadata,
  AuthClientSession,
  AuthPairingLink,
  AuthSessionId,
} from "@ryco/contracts";
import { Data, DateTime, Duration, Effect, Context } from "effect";
import type { SessionRole } from "./SessionCredentialService.ts";

export const DEFAULT_SESSION_SUBJECT = "cli-issued-session";

/**
 * Subject of the owner link a server mints for itself at startup (the printed
 * `/pair` URL). Pairing lists leave it out: it belongs to the node's own launch,
 * not to a link someone created.
 */
export const OWNER_BOOTSTRAP_PAIRING_SUBJECT = "owner-bootstrap";

/**
 * The longest an owner pairing link may stay redeemable. Redeeming one grants
 * everything the node's user can do through Ryco, so it never outlives a
 * pairing ceremony.
 */
export const OWNER_PAIRING_LINK_MAX_TTL = Duration.minutes(15);

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly role: SessionRole;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: "bearer-session-token";
  readonly role: SessionRole;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

export class AuthControlPlaneError extends Data.TaggedError("AuthControlPlaneError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AuthControlPlaneShape {
  readonly createPairingLink: (input?: {
    readonly ttl?: Duration.Duration;
    readonly label?: string;
    readonly role?: SessionRole;
    readonly subject?: string;
  }) => Effect.Effect<IssuedPairingLink, AuthControlPlaneError>;
  readonly listPairingLinks: (input?: {
    readonly role?: SessionRole;
    readonly excludeSubjects?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, AuthControlPlaneError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, AuthControlPlaneError>;
  readonly issueSession: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly role?: SessionRole;
    readonly label?: string;
  }) => Effect.Effect<IssuedBearerSession, AuthControlPlaneError>;
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<AuthClientSession>,
    AuthControlPlaneError
  >;
  readonly revokeSession: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<boolean, AuthControlPlaneError>;
  readonly revokeOtherSessionsExcept: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<number, AuthControlPlaneError>;
}

export class AuthControlPlane extends Context.Service<AuthControlPlane, AuthControlPlaneShape>()(
  "ryco/AuthControlPlane",
) {}
