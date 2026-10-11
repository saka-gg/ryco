import {
  AtlassianCapability,
  AtlassianProduct,
  type AtlassianConnectionKind,
  type AtlassianConnectionStatus,
  type AtlassianConnectionId,
} from "@ryco/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeCauseError,
  toPersistenceSqlError,
  type AtlassianConnectionRepositoryError,
} from "../Errors.ts";
import {
  AtlassianConnectionRecord,
  AtlassianConnectionRepository,
  type AtlassianConnectionRepositoryShape,
} from "../Services/AtlassianConnections.ts";

interface AtlassianConnectionDbRow {
  readonly connectionId: AtlassianConnectionId;
  readonly kind: AtlassianConnectionKind;
  readonly label: string;
  readonly status: AtlassianConnectionStatus;
  readonly productsJson: string;
  readonly capabilitiesJson: string;
  readonly accountName: string | null;
  readonly accountEmail: string | null;
  readonly avatarUrl: string | null;
  readonly baseUrl: string | null;
  readonly expiresAt: string | null;
  readonly lastVerifiedAt: string | null;
  readonly readonly: number;
  readonly isDefault: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function decodeProducts(
  raw: string,
): Effect.Effect<ReadonlyArray<typeof AtlassianProduct.Type>, AtlassianConnectionRepositoryError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.Array(AtlassianProduct))(JSON.parse(raw)),
    catch: toPersistenceDecodeCauseError("AtlassianConnectionRepository.decodeProducts"),
  });
}

function decodeCapabilities(
  raw: string,
): Effect.Effect<
  ReadonlyArray<typeof AtlassianCapability.Type>,
  AtlassianConnectionRepositoryError
> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.Array(AtlassianCapability))(JSON.parse(raw)),
    catch: toPersistenceDecodeCauseError("AtlassianConnectionRepository.decodeCapabilities"),
  });
}

function toRecord(
  row: AtlassianConnectionDbRow,
): Effect.Effect<AtlassianConnectionRecord, AtlassianConnectionRepositoryError> {
  return Effect.all({
    products: decodeProducts(row.productsJson),
    capabilities: decodeCapabilities(row.capabilitiesJson),
  }).pipe(
    Effect.map(({ products, capabilities }) => ({
      connectionId: row.connectionId,
      kind: row.kind,
      label: row.label,
      status: row.status,
      products: [...products],
      capabilities: [...capabilities],
      accountName: row.accountName,
      accountEmail: row.accountEmail,
      avatarUrl: row.avatarUrl,
      baseUrl: row.baseUrl,
      expiresAt: row.expiresAt,
      lastVerifiedAt: row.lastVerifiedAt,
      readonly: row.readonly === 1,
      isDefault: row.isDefault === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  );
}

const makeAtlassianConnectionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsert: AtlassianConnectionRepositoryShape["upsert"] = (row) =>
    sql`
      INSERT INTO atlassian_connections (
        connection_id,
        kind,
        label,
        status,
        products_json,
        capabilities_json,
        account_name,
        account_email,
        avatar_url,
        base_url,
        expires_at,
        last_verified_at,
        readonly,
        is_default,
        created_at,
        updated_at
      )
      VALUES (
        ${row.connectionId},
        ${row.kind},
        ${row.label},
        ${row.status},
        ${JSON.stringify(row.products)},
        ${JSON.stringify(row.capabilities)},
        ${row.accountName},
        ${row.accountEmail},
        ${row.avatarUrl},
        ${row.baseUrl},
        ${row.expiresAt},
        ${row.lastVerifiedAt},
        ${row.readonly ? 1 : 0},
        ${row.isDefault ? 1 : 0},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (connection_id)
      DO UPDATE SET
        kind = excluded.kind,
        label = excluded.label,
        status = excluded.status,
        products_json = excluded.products_json,
        capabilities_json = excluded.capabilities_json,
        account_name = excluded.account_name,
        account_email = excluded.account_email,
        avatar_url = excluded.avatar_url,
        base_url = excluded.base_url,
        expires_at = excluded.expires_at,
        last_verified_at = excluded.last_verified_at,
        readonly = excluded.readonly,
        is_default = excluded.is_default,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("AtlassianConnectionRepository.upsert:query")),
    );

  const getById: AtlassianConnectionRepositoryShape["getById"] = ({ connectionId }) =>
    sql<AtlassianConnectionDbRow>`
      SELECT
        connection_id AS "connectionId",
        kind,
        label,
        status,
        products_json AS "productsJson",
        capabilities_json AS "capabilitiesJson",
        account_name AS "accountName",
        account_email AS "accountEmail",
        avatar_url AS "avatarUrl",
        base_url AS "baseUrl",
        expires_at AS "expiresAt",
        last_verified_at AS "lastVerifiedAt",
        readonly,
        is_default AS "isDefault",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM atlassian_connections
      WHERE connection_id = ${connectionId}
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("AtlassianConnectionRepository.getById:query")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none())
          : toRecord(rows[0]).pipe(Effect.map(Option.some)),
      ),
    );

  const list: AtlassianConnectionRepositoryShape["list"] = (input = {}) => {
    const rows =
      input.status === undefined
        ? sql<AtlassianConnectionDbRow>`
            SELECT
              connection_id AS "connectionId",
              kind,
              label,
              status,
              products_json AS "productsJson",
              capabilities_json AS "capabilitiesJson",
              account_name AS "accountName",
              account_email AS "accountEmail",
              avatar_url AS "avatarUrl",
              base_url AS "baseUrl",
              expires_at AS "expiresAt",
              last_verified_at AS "lastVerifiedAt",
              readonly,
              is_default AS "isDefault",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM atlassian_connections
            ORDER BY is_default DESC, updated_at DESC, label ASC
          `
        : sql<AtlassianConnectionDbRow>`
            SELECT
              connection_id AS "connectionId",
              kind,
              label,
              status,
              products_json AS "productsJson",
              capabilities_json AS "capabilitiesJson",
              account_name AS "accountName",
              account_email AS "accountEmail",
              avatar_url AS "avatarUrl",
              base_url AS "baseUrl",
              expires_at AS "expiresAt",
              last_verified_at AS "lastVerifiedAt",
              readonly,
              is_default AS "isDefault",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM atlassian_connections
            WHERE status = ${input.status}
            ORDER BY is_default DESC, updated_at DESC, label ASC
          `;

    return rows.pipe(
      Effect.mapError(toPersistenceSqlError("AtlassianConnectionRepository.list:query")),
      Effect.flatMap((items) => Effect.forEach(items, toRecord)),
    );
  };

  const disconnect: AtlassianConnectionRepositoryShape["disconnect"] = (input) =>
    sql<{ readonly connectionId: AtlassianConnectionId }>`
      UPDATE atlassian_connections
      SET status = 'revoked',
          updated_at = ${input.updatedAt}
      WHERE connection_id = ${input.connectionId}
        AND status <> 'revoked'
      RETURNING connection_id AS "connectionId"
    `.pipe(
      Effect.mapError(toPersistenceSqlError("AtlassianConnectionRepository.disconnect:query")),
      Effect.map((rows) => rows.length > 0),
    );

  const deleteById: AtlassianConnectionRepositoryShape["deleteById"] = ({ connectionId }) =>
    sql`
      DELETE FROM atlassian_connections
      WHERE connection_id = ${connectionId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("AtlassianConnectionRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    list,
    disconnect,
    deleteById,
  } satisfies AtlassianConnectionRepositoryShape;
});

export const AtlassianConnectionRepositoryLive = Layer.effect(
  AtlassianConnectionRepository,
  makeAtlassianConnectionRepository,
);
