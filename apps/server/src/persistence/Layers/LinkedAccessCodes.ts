/**
 * LinkedAccessCodes - A device's unredeemed Hub-linked codes (`auth_pairing_links`
 * rows with a link), read and revoked only by the Hub connector, so these queries
 * load with it rather than at boot. Linked codes are never listed to the owner, so
 * revoking one announces nothing.
 *
 * @module persistence/Layers/LinkedAccessCodes
 */
import { DateTime, Effect, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AuthPairingLinkRepositoryError,
} from "../Errors.ts";
import { AuthAccessLink } from "../Services/AuthAccessLink.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AuthPairingLinkRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/**
 * A device's codes: by Hub enrollment, or by client key narrowed like its sessions; or every
 * linked code, when the Hub revoked this node.
 */
export type LinkedCodeSelector =
  | { readonly enrollmentId: string }
  | { readonly allLinks: true }
  | {
      readonly clientFingerprint: string;
      readonly trustSource?: AuthAccessLink["trustSource"];
      readonly enrollmentId?: string | null;
      readonly accountId?: string | null;
    };

export interface LinkedAccessCodes {
  /** The links of unredeemed, unexpired linked codes: devices about to hold a session. */
  readonly listPending: () => Effect.Effect<
    ReadonlyArray<AuthAccessLink>,
    AuthPairingLinkRepositoryError
  >;
  /** Revokes the selected device's unredeemed linked codes; returns how many. */
  readonly revoke: (
    selector: LinkedCodeSelector,
  ) => Effect.Effect<number, AuthPairingLinkRepositoryError>;
}

const PendingLinkRow = Schema.Struct({
  trustSource: AuthAccessLink.fields.trustSource,
  enrollmentId: Schema.NullOr(Schema.String),
  clientFingerprint: Schema.String,
  role: AuthAccessLink.fields.role,
  accountId: Schema.NullOr(Schema.String),
});

export const makeLinkedAccessCodes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listPendingRows = SqlSchema.findAll({
    Request: Schema.Struct({ now: Schema.DateTimeUtcFromString }),
    Result: PendingLinkRow,
    execute: ({ now }) => sql`
      SELECT
        link_trust_source AS "trustSource",
        link_enrollment_id AS "enrollmentId",
        link_client_fingerprint AS "clientFingerprint",
        link_role AS "role",
        link_account_id AS "accountId"
      FROM auth_pairing_links
      WHERE revoked_at IS NULL
        AND consumed_at IS NULL
        AND expires_at > ${now}
        AND link_trust_source IS NOT NULL
        AND link_client_fingerprint IS NOT NULL
        AND link_role IS NOT NULL
    `,
  });

  const listPending: LinkedAccessCodes["listPending"] = () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const rows = yield* listPendingRows({ now });
      return rows.map((row): AuthAccessLink => ({
        trustSource: row.trustSource,
        enrollmentId: row.enrollmentId,
        clientFingerprint: row.clientFingerprint,
        role: row.role,
        ...(row.accountId === null ? {} : { accountId: row.accountId }),
      }));
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LinkedAccessCodes.listPending:query",
          "LinkedAccessCodes.listPending:decodeRows",
        ),
      ),
    );

  const revoke: LinkedAccessCodes["revoke"] = (selector) =>
    Effect.gen(function* () {
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const conditions =
        "clientFingerprint" in selector
          ? [
              sql`link_client_fingerprint = ${selector.clientFingerprint}`,
              ...(selector.trustSource === undefined
                ? []
                : [sql`link_trust_source = ${selector.trustSource}`]),
              ...(selector.enrollmentId === undefined
                ? []
                : [
                    selector.enrollmentId === null
                      ? sql`link_enrollment_id IS NULL`
                      : sql`link_enrollment_id = ${selector.enrollmentId}`,
                  ]),
              ...(selector.accountId === undefined
                ? []
                : [
                    selector.accountId === null
                      ? sql`link_account_id IS NULL`
                      : sql`link_account_id = ${selector.accountId}`,
                  ]),
            ]
          : "allLinks" in selector
            ? [sql`link_trust_source IS NOT NULL`]
            : [sql`link_enrollment_id = ${selector.enrollmentId}`];
      const rows = yield* sql<{ readonly id: string }>`
        UPDATE auth_pairing_links
        SET revoked_at = ${revokedAt}
        WHERE ${sql.and([...conditions, sql`revoked_at IS NULL`, sql`consumed_at IS NULL`])}
        RETURNING id AS "id"
      `;
      return rows.length;
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LinkedAccessCodes.revoke:query",
          "LinkedAccessCodes.revoke:decodeRows",
        ),
      ),
    );

  return { listPending, revoke } satisfies LinkedAccessCodes;
});
