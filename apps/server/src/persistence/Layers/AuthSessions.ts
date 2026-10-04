import { AuthSessionId } from "@ryco/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AuthSessionRepositoryError,
} from "../Errors.ts";
import {
  AuthSessionRecord,
  AuthSessionRepository,
  type AuthSessionRepositoryShape,
  CreateAuthSessionInput,
  FindPendingAuthSessionSuccessorInput,
  GetAuthSessionByIdInput,
  GetAuthSessionChainHeadInput,
  ListActiveAuthSessionsInput,
  RevokeAuthSessionInput,
  RevokeOtherAuthSessionsInput,
  SetAuthSessionLastConnectedAtInput,
  SupersedeAuthSessionInput,
} from "../Services/AuthSessions.ts";

const AuthSessionDbRow = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  clientLabel: Schema.NullOr(Schema.String),
  clientIpAddress: Schema.NullOr(Schema.String),
  clientUserAgent: Schema.NullOr(Schema.String),
  clientDeviceType: Schema.Literals(["desktop", "mobile", "tablet", "bot", "unknown"]),
  clientOs: Schema.NullOr(Schema.String),
  clientBrowser: Schema.NullOr(Schema.String),
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  rotatedFrom: Schema.NullOr(AuthSessionId),
  chainId: AuthSessionId,
  chainIssuedAt: Schema.DateTimeUtcFromString,
  supersededAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  predecessorSupersededAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

function toAuthSessionRecord(row: typeof AuthSessionDbRow.Type): typeof AuthSessionRecord.Type {
  return {
    sessionId: row.sessionId,
    subject: row.subject,
    role: row.role,
    method: row.method,
    client: {
      label: row.clientLabel,
      ipAddress: row.clientIpAddress,
      userAgent: row.clientUserAgent,
      deviceType: row.clientDeviceType,
      os: row.clientOs,
      browser: row.clientBrowser,
    },
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastConnectedAt: row.lastConnectedAt,
    revokedAt: row.revokedAt,
    rotatedFrom: row.rotatedFrom,
    chainId: row.chainId,
    chainIssuedAt: row.chainIssuedAt,
    supersededAt: row.supersededAt,
    predecessorSupersededAt: row.predecessorSupersededAt,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AuthSessionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeAuthSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Rows from before bearer rotation have no chain columns and read as their
  // own chain. `p` is the predecessor a rotated session replaced.
  const sessionColumns = sql.literal(`
    s.session_id AS "sessionId",
    s.subject AS "subject",
    s.role AS "role",
    s.method AS "method",
    s.client_label AS "clientLabel",
    s.client_ip_address AS "clientIpAddress",
    s.client_user_agent AS "clientUserAgent",
    s.client_device_type AS "clientDeviceType",
    s.client_os AS "clientOs",
    s.client_browser AS "clientBrowser",
    s.issued_at AS "issuedAt",
    s.expires_at AS "expiresAt",
    s.last_connected_at AS "lastConnectedAt",
    s.revoked_at AS "revokedAt",
    s.rotated_from AS "rotatedFrom",
    COALESCE(s.chain_id, s.session_id) AS "chainId",
    COALESCE(s.chain_issued_at, s.issued_at) AS "chainIssuedAt",
    s.superseded_at AS "supersededAt",
    p.superseded_at AS "predecessorSupersededAt"
  `);
  const sessionsWithPredecessor = sql.literal(`
    auth_sessions s
    LEFT JOIN auth_sessions p ON p.session_id = s.rotated_from
  `);
  // A chain's current session: not revoked, not expired, not superseded, and
  // not a successor nobody has used yet while its predecessor still stands.
  const isChainHead = (now: string) => sql`
    s.revoked_at IS NULL
    AND s.superseded_at IS NULL
    AND s.expires_at > ${now}
    AND (
      s.rotated_from IS NULL
      OR p.superseded_at IS NOT NULL
      OR p.revoked_at IS NOT NULL
      OR p.expires_at <= ${now}
    )
  `;

  const createSessionRow = SqlSchema.void({
    Request: CreateAuthSessionInput,
    execute: (input) =>
      sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          revoked_at,
          last_connected_at,
          rotated_from,
          chain_id,
          chain_issued_at
        )
        VALUES (
          ${input.sessionId},
          ${input.subject},
          ${input.role},
          ${input.method},
          ${input.client.label},
          ${input.client.ipAddress},
          ${input.client.userAgent},
          ${input.client.deviceType},
          ${input.client.os},
          ${input.client.browser},
          ${input.issuedAt},
          ${input.expiresAt},
          NULL,
          ${input.rotation?.lastConnectedAt ?? null},
          ${input.rotation?.rotatedFrom ?? null},
          ${input.rotation?.chainId ?? input.sessionId},
          ${input.rotation?.chainIssuedAt ?? input.issuedAt}
        )
      `,
  });

  const getSessionRowById = SqlSchema.findOneOption({
    Request: GetAuthSessionByIdInput,
    Result: AuthSessionDbRow,
    execute: ({ sessionId }) =>
      sql`
        SELECT ${sessionColumns}
        FROM ${sessionsWithPredecessor}
        WHERE s.session_id = ${sessionId}
      `,
  });

  const listActiveSessionRows = SqlSchema.findAll({
    Request: ListActiveAuthSessionsInput,
    Result: AuthSessionDbRow,
    execute: ({ now }) =>
      sql`
        SELECT ${sessionColumns}
        FROM ${sessionsWithPredecessor}
        WHERE ${isChainHead(now)}
        ORDER BY s.issued_at DESC, s.session_id DESC
      `,
  });

  const getChainHeadRow = SqlSchema.findOneOption({
    Request: GetAuthSessionChainHeadInput,
    Result: AuthSessionDbRow,
    execute: ({ chainId, now }) =>
      sql`
        SELECT ${sessionColumns}
        FROM ${sessionsWithPredecessor}
        WHERE COALESCE(s.chain_id, s.session_id) = ${chainId}
          AND ${isChainHead(now)}
        ORDER BY s.issued_at DESC, s.session_id DESC
        LIMIT 1
      `,
  });

  const findPendingSuccessorRow = SqlSchema.findOneOption({
    Request: FindPendingAuthSessionSuccessorInput,
    Result: AuthSessionDbRow,
    execute: ({ sessionId, now }) =>
      sql`
        SELECT ${sessionColumns}
        FROM ${sessionsWithPredecessor}
        WHERE s.rotated_from = ${sessionId}
          AND s.revoked_at IS NULL
          AND s.superseded_at IS NULL
          AND s.expires_at > ${now}
        ORDER BY s.issued_at DESC, s.session_id DESC
        LIMIT 1
      `,
  });

  const setLastConnectedAtRow = SqlSchema.void({
    Request: SetAuthSessionLastConnectedAtInput,
    execute: ({ sessionId, lastConnectedAt }) =>
      sql`
        UPDATE auth_sessions
        SET last_connected_at = ${lastConnectedAt}
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
      `,
  });

  const supersedeSessionRows = SqlSchema.findAll({
    Request: SupersedeAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, supersededAt }) =>
      sql`
        UPDATE auth_sessions
        SET superseded_at = ${supersededAt}
        WHERE session_id = ${sessionId}
          AND superseded_at IS NULL
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  // Revoking any session of a pairing revokes the pairing: every rotation of
  // it, before and after.
  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE COALESCE(chain_id, session_id) = (
            SELECT COALESCE(chain_id, session_id)
            FROM auth_sessions
            WHERE session_id = ${sessionId}
          )
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ currentSessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE COALESCE(chain_id, session_id) <> COALESCE(
            (
              SELECT COALESCE(chain_id, session_id)
              FROM auth_sessions
              WHERE session_id = ${currentSessionId}
            ),
            ${currentSessionId}
          )
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const create: AuthSessionRepositoryShape["create"] = (input) =>
    createSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.create:query",
          "AuthSessionRepository.create:encodeRequest",
        ),
      ),
    );

  const getById: AuthSessionRepositoryShape["getById"] = (input) =>
    getSessionRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getById:query",
          "AuthSessionRepository.getById:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => Effect.succeed(Option.some(toAuthSessionRecord(row))),
        }),
      ),
    );

  const listActive: AuthSessionRepositoryShape["listActive"] = (input) =>
    listActiveSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listActive:query",
          "AuthSessionRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) => Effect.succeed(rows.map((row) => toAuthSessionRecord(row)))),
    );

  const revoke: AuthSessionRepositoryShape["revoke"] = (input) =>
    revokeSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revoke:query",
          "AuthSessionRepository.revoke:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const revokeAllExcept: AuthSessionRepositoryShape["revokeAllExcept"] = (input) =>
    revokeOtherSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeAllExcept:query",
          "AuthSessionRepository.revokeAllExcept:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const setLastConnectedAt: AuthSessionRepositoryShape["setLastConnectedAt"] = (input) =>
    setLastConnectedAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setLastConnectedAt:query",
          "AuthSessionRepository.setLastConnectedAt:encodeRequest",
        ),
      ),
    );

  const findPendingSuccessor: AuthSessionRepositoryShape["findPendingSuccessor"] = (input) =>
    findPendingSuccessorRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.findPendingSuccessor:query",
          "AuthSessionRepository.findPendingSuccessor:decodeRow",
        ),
      ),
      Effect.map(Option.map(toAuthSessionRecord)),
    );

  const supersede: AuthSessionRepositoryShape["supersede"] = (input) =>
    supersedeSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.supersede:query",
          "AuthSessionRepository.supersede:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const getChainHead: AuthSessionRepositoryShape["getChainHead"] = (input) =>
    getChainHeadRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getChainHead:query",
          "AuthSessionRepository.getChainHead:decodeRow",
        ),
      ),
      Effect.map(Option.map(toAuthSessionRecord)),
    );

  return {
    create,
    getById,
    listActive,
    revoke,
    revokeAllExcept,
    setLastConnectedAt,
    findPendingSuccessor,
    supersede,
    getChainHead,
  } satisfies AuthSessionRepositoryShape;
});

export const AuthSessionRepositoryLive = Layer.effect(
  AuthSessionRepository,
  makeAuthSessionRepository,
);
