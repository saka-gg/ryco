import { AuthClientMetadataDeviceType, AuthSessionId } from "@ryco/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { AuthSessionRepositoryError } from "../Errors.ts";

export const AuthSessionClientMetadataRecord = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
});
export type AuthSessionClientMetadataRecord = typeof AuthSessionClientMetadataRecord.Type;

export const AuthSessionRecord = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** The session this one replaced by bearer rotation; `null` for a pairing. */
  rotatedFrom: Schema.NullOr(AuthSessionId),
  /** The pairing's first session: every rotation of one pairing shares it. */
  chainId: AuthSessionId,
  /** When the pairing was made. Rotation never moves it; it caps the chain. */
  chainIssuedAt: Schema.DateTimeUtcFromString,
  /** Set once this session's successor first authenticated. */
  supersededAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** The predecessor's `supersededAt`: `null` while this successor is unused. */
  predecessorSupersededAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type AuthSessionRecord = typeof AuthSessionRecord.Type;

export const CreateAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  /** Omitted for a new pairing, which starts its own chain. */
  rotation: Schema.optionalKey(
    Schema.Struct({
      rotatedFrom: AuthSessionId,
      chainId: AuthSessionId,
      chainIssuedAt: Schema.DateTimeUtcFromString,
      lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    }),
  ),
});
export type CreateAuthSessionInput = typeof CreateAuthSessionInput.Type;

export const FindPendingAuthSessionSuccessorInput = Schema.Struct({
  sessionId: AuthSessionId,
  now: Schema.DateTimeUtcFromString,
});
export type FindPendingAuthSessionSuccessorInput = typeof FindPendingAuthSessionSuccessorInput.Type;

export const SupersedeAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  supersededAt: Schema.DateTimeUtcFromString,
});
export type SupersedeAuthSessionInput = typeof SupersedeAuthSessionInput.Type;

export const GetAuthSessionChainHeadInput = Schema.Struct({
  chainId: AuthSessionId,
  now: Schema.DateTimeUtcFromString,
});
export type GetAuthSessionChainHeadInput = typeof GetAuthSessionChainHeadInput.Type;

export const GetAuthSessionByIdInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type GetAuthSessionByIdInput = typeof GetAuthSessionByIdInput.Type;

export const ListActiveAuthSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ListActiveAuthSessionsInput = typeof ListActiveAuthSessionsInput.Type;

export const RevokeAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthSessionInput = typeof RevokeAuthSessionInput.Type;

export const RevokeOtherAuthSessionsInput = Schema.Struct({
  currentSessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeOtherAuthSessionsInput = typeof RevokeOtherAuthSessionsInput.Type;

export const SetAuthSessionLastConnectedAtInput = Schema.Struct({
  sessionId: AuthSessionId,
  lastConnectedAt: Schema.DateTimeUtcFromString,
});
export type SetAuthSessionLastConnectedAtInput = typeof SetAuthSessionLastConnectedAtInput.Type;

export interface AuthSessionRepositoryShape {
  readonly create: (
    input: CreateAuthSessionInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  readonly getById: (
    input: GetAuthSessionByIdInput,
  ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
  readonly listActive: (
    input: ListActiveAuthSessionsInput,
  ) => Effect.Effect<ReadonlyArray<AuthSessionRecord>, AuthSessionRepositoryError>;
  /** Revokes the session's whole rotation chain; returns every session revoked. */
  readonly revoke: (
    input: RevokeAuthSessionInput,
  ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
  /** Revokes every session outside the current session's rotation chain. */
  readonly revokeAllExcept: (
    input: RevokeOtherAuthSessionsInput,
  ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
  /** The unused successor a rotation already issued for this session, if any. */
  readonly findPendingSuccessor: (
    input: FindPendingAuthSessionSuccessorInput,
  ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
  /** Marks the session superseded unless it already is; `true` when this call did. */
  readonly supersede: (
    input: SupersedeAuthSessionInput,
  ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
  /** The chain's current session: the one a client list shows for the pairing. */
  readonly getChainHead: (
    input: GetAuthSessionChainHeadInput,
  ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
  readonly setLastConnectedAt: (
    input: SetAuthSessionLastConnectedAtInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
}

export class AuthSessionRepository extends Context.Service<
  AuthSessionRepository,
  AuthSessionRepositoryShape
>()("ryco/persistence/Services/AuthSessions/AuthSessionRepository") {}
