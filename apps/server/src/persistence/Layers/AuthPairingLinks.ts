import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AuthPairingLinkRepositoryError,
} from "../Errors.ts";
import {
  type AuthPairingLinkRecord,
  AuthPairingLinkRepository,
  type AuthPairingLinkRepositoryShape,
  ConsumeAuthPairingLinkInput,
  CreateAuthPairingLinkInput,
  GetAuthPairingLinkByCredentialInput,
  ListActiveAuthPairingLinksInput,
  RevokeAuthPairingLinkInput,
} from "../Services/AuthPairingLinks.ts";

const AuthPairingLinkDbRow = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  method: Schema.Literals(["desktop-bootstrap", "one-time-token"]),
  role: Schema.Literals(["owner", "client"]),
  subject: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  consumedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  linkTrustSource: Schema.NullOr(Schema.Literals(["account-enrolled", "locally-verified"])),
  linkEnrollmentId: Schema.NullOr(Schema.String),
  linkClientFingerprint: Schema.NullOr(Schema.String),
  linkRole: Schema.NullOr(Schema.Literals(["viewer", "operator", "owner"])),
});

function toAuthPairingLinkRecord(row: typeof AuthPairingLinkDbRow.Type): AuthPairingLinkRecord {
  return {
    id: row.id,
    credential: row.credential,
    method: row.method,
    role: row.role,
    subject: row.subject,
    label: row.label,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    revokedAt: row.revokedAt,
    link:
      row.linkTrustSource !== null && row.linkClientFingerprint !== null && row.linkRole !== null
        ? {
            trustSource: row.linkTrustSource,
            enrollmentId: row.linkEnrollmentId,
            clientFingerprint: row.linkClientFingerprint,
            role: row.linkRole,
          }
        : null,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AuthPairingLinkRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeAuthPairingLinkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingLinkColumns = sql.literal(`
    id AS "id",
    credential AS "credential",
    method AS "method",
    role AS "role",
    subject AS "subject",
    label AS "label",
    created_at AS "createdAt",
    expires_at AS "expiresAt",
    consumed_at AS "consumedAt",
    revoked_at AS "revokedAt",
    link_trust_source AS "linkTrustSource",
    link_enrollment_id AS "linkEnrollmentId",
    link_client_fingerprint AS "linkClientFingerprint",
    link_role AS "linkRole"
  `);

  const createPairingLinkRow = SqlSchema.void({
    Request: CreateAuthPairingLinkInput,
    execute: (input) =>
      sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          role,
          subject,
          label,
          created_at,
          expires_at,
          consumed_at,
          revoked_at,
          link_trust_source,
          link_enrollment_id,
          link_client_fingerprint,
          link_role
        )
        VALUES (
          ${input.id},
          ${input.credential},
          ${input.method},
          ${input.role},
          ${input.subject},
          ${input.label},
          ${input.createdAt},
          ${input.expiresAt},
          NULL,
          NULL,
          ${input.link?.trustSource ?? null},
          ${input.link?.enrollmentId ?? null},
          ${input.link?.clientFingerprint ?? null},
          ${input.link?.role ?? null}
        )
      `,
  });

  const consumeAvailablePairingLinkRow = SqlSchema.findOneOption({
    Request: ConsumeAuthPairingLinkInput,
    Result: AuthPairingLinkDbRow,
    execute: ({ credential, consumedAt, now }) =>
      sql`
        UPDATE auth_pairing_links
        SET consumed_at = ${consumedAt}
        WHERE credential = ${credential}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
        RETURNING ${pairingLinkColumns}
      `,
  });

  const listActivePairingLinkRows = SqlSchema.findAll({
    Request: ListActiveAuthPairingLinksInput,
    Result: AuthPairingLinkDbRow,
    execute: ({ now }) =>
      sql`
        SELECT
          ${pairingLinkColumns}
        FROM auth_pairing_links
        WHERE revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
          AND link_trust_source IS NULL
        ORDER BY created_at DESC, id DESC
      `,
  });

  const revokePairingLinkRow = SqlSchema.findAll({
    Request: RevokeAuthPairingLinkInput,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ id, revokedAt }) =>
      sql`
        UPDATE auth_pairing_links
        SET revoked_at = ${revokedAt}
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
        RETURNING id AS "id"
      `,
  });

  const getPairingLinkRowByCredential = SqlSchema.findOneOption({
    Request: GetAuthPairingLinkByCredentialInput,
    Result: AuthPairingLinkDbRow,
    execute: ({ credential }) =>
      sql`
        SELECT
          ${pairingLinkColumns}
        FROM auth_pairing_links
        WHERE credential = ${credential}
      `,
  });

  const create: AuthPairingLinkRepositoryShape["create"] = (input) =>
    createPairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.create:query",
          "AuthPairingLinkRepository.create:encodeRequest",
        ),
      ),
    );

  const consumeAvailable: AuthPairingLinkRepositoryShape["consumeAvailable"] = (input) =>
    consumeAvailablePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.consumeAvailable:query",
          "AuthPairingLinkRepository.consumeAvailable:decodeRow",
        ),
      ),
      Effect.map(Option.map(toAuthPairingLinkRecord)),
    );

  const listActive: AuthPairingLinkRepositoryShape["listActive"] = (input) =>
    listActivePairingLinkRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.listActive:query",
          "AuthPairingLinkRepository.listActive:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toAuthPairingLinkRecord)),
    );

  const revoke: AuthPairingLinkRepositoryShape["revoke"] = (input) =>
    revokePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.revoke:query",
          "AuthPairingLinkRepository.revoke:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const getByCredential: AuthPairingLinkRepositoryShape["getByCredential"] = (input) =>
    getPairingLinkRowByCredential(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.getByCredential:query",
          "AuthPairingLinkRepository.getByCredential:decodeRow",
        ),
      ),
      Effect.map(Option.map(toAuthPairingLinkRecord)),
    );

  return {
    create,
    consumeAvailable,
    listActive,
    revoke,
    getByCredential,
  } satisfies AuthPairingLinkRepositoryShape;
});

export const AuthPairingLinkRepositoryLive = Layer.effect(
  AuthPairingLinkRepository,
  makeAuthPairingLinkRepository,
);
