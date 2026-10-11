import {
  AtlassianCapability,
  type AtlassianConnectionId,
  type AtlassianProduct,
  type AtlassianResourceId,
} from "@ryco/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import { Effect, Layer, Schema } from "effect";

import {
  toPersistenceDecodeCauseError,
  toPersistenceSqlError,
  type AtlassianResourceRepositoryError,
} from "../Errors.ts";
import {
  AtlassianResourceRecord,
  AtlassianResourceRepository,
  type AtlassianResourceRepositoryShape,
} from "../Services/AtlassianResources.ts";

interface AtlassianResourceDbRow {
  readonly resourceId: AtlassianResourceId;
  readonly connectionId: AtlassianConnectionId;
  readonly product: AtlassianProduct;
  readonly name: string;
  readonly url: string;
  readonly capabilitiesJson: string;
  readonly cloudId: string | null;
  readonly workspaceSlug: string | null;
  readonly avatarUrl: string | null;
  readonly updatedAt: string;
}

function decodeCapabilities(
  raw: string,
): Effect.Effect<ReadonlyArray<typeof AtlassianCapability.Type>, AtlassianResourceRepositoryError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.Array(AtlassianCapability))(JSON.parse(raw)),
    catch: toPersistenceDecodeCauseError("AtlassianResourceRepository.decodeCapabilities"),
  });
}

function toRecord(
  row: AtlassianResourceDbRow,
): Effect.Effect<AtlassianResourceRecord, AtlassianResourceRepositoryError> {
  return decodeCapabilities(row.capabilitiesJson).pipe(
    Effect.map((capabilities) => ({
      resourceId: row.resourceId,
      connectionId: row.connectionId,
      product: row.product,
      name: row.name,
      url: row.url,
      capabilities: [...capabilities],
      cloudId: row.cloudId,
      workspaceSlug: row.workspaceSlug,
      avatarUrl: row.avatarUrl,
      updatedAt: row.updatedAt,
    })),
  );
}

const makeAtlassianResourceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertOne = (row: AtlassianResourceRecord) =>
    sql`
      INSERT INTO atlassian_resources (
        resource_id,
        connection_id,
        product,
        name,
        url,
        capabilities_json,
        cloud_id,
        workspace_slug,
        avatar_url,
        updated_at
      )
      VALUES (
        ${row.resourceId},
        ${row.connectionId},
        ${row.product},
        ${row.name},
        ${row.url},
        ${JSON.stringify(row.capabilities)},
        ${row.cloudId},
        ${row.workspaceSlug},
        ${row.avatarUrl},
        ${row.updatedAt}
      )
      ON CONFLICT (resource_id)
      DO UPDATE SET
        connection_id = excluded.connection_id,
        product = excluded.product,
        name = excluded.name,
        url = excluded.url,
        capabilities_json = excluded.capabilities_json,
        cloud_id = excluded.cloud_id,
        workspace_slug = excluded.workspace_slug,
        avatar_url = excluded.avatar_url,
        updated_at = excluded.updated_at
    `;

  const upsertForConnection: AtlassianResourceRepositoryShape["upsertForConnection"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          DELETE FROM atlassian_resources
          WHERE connection_id = ${input.connectionId}
        `;
          yield* Effect.forEach(input.resources, upsertOne, { concurrency: 1 });
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("AtlassianResourceRepository.upsertForConnection:query"),
        ),
      );

  const list: AtlassianResourceRepositoryShape["list"] = (input = {}) => {
    const rows =
      input.connectionId !== undefined && input.product !== undefined
        ? sql<AtlassianResourceDbRow>`
            SELECT
              resource_id AS "resourceId",
              connection_id AS "connectionId",
              product,
              name,
              url,
              capabilities_json AS "capabilitiesJson",
              cloud_id AS "cloudId",
              workspace_slug AS "workspaceSlug",
              avatar_url AS "avatarUrl",
              updated_at AS "updatedAt"
            FROM atlassian_resources
            WHERE connection_id = ${input.connectionId}
              AND product = ${input.product}
            ORDER BY product ASC, name ASC
          `
        : input.connectionId !== undefined
          ? sql<AtlassianResourceDbRow>`
              SELECT
                resource_id AS "resourceId",
                connection_id AS "connectionId",
                product,
                name,
                url,
                capabilities_json AS "capabilitiesJson",
                cloud_id AS "cloudId",
                workspace_slug AS "workspaceSlug",
                avatar_url AS "avatarUrl",
                updated_at AS "updatedAt"
              FROM atlassian_resources
              WHERE connection_id = ${input.connectionId}
              ORDER BY product ASC, name ASC
            `
          : input.product !== undefined
            ? sql<AtlassianResourceDbRow>`
                SELECT
                  resource_id AS "resourceId",
                  connection_id AS "connectionId",
                  product,
                  name,
                  url,
                  capabilities_json AS "capabilitiesJson",
                  cloud_id AS "cloudId",
                  workspace_slug AS "workspaceSlug",
                  avatar_url AS "avatarUrl",
                  updated_at AS "updatedAt"
                FROM atlassian_resources
                WHERE product = ${input.product}
                ORDER BY product ASC, name ASC
              `
            : sql<AtlassianResourceDbRow>`
                SELECT
                  resource_id AS "resourceId",
                  connection_id AS "connectionId",
                  product,
                  name,
                  url,
                  capabilities_json AS "capabilitiesJson",
                  cloud_id AS "cloudId",
                  workspace_slug AS "workspaceSlug",
                  avatar_url AS "avatarUrl",
                  updated_at AS "updatedAt"
                FROM atlassian_resources
                ORDER BY product ASC, name ASC
              `;

    return rows.pipe(
      Effect.mapError(toPersistenceSqlError("AtlassianResourceRepository.list:query")),
      Effect.flatMap((items) => Effect.forEach(items, toRecord)),
    );
  };

  const deleteForConnection: AtlassianResourceRepositoryShape["deleteForConnection"] = ({
    connectionId,
  }) =>
    sql`
      DELETE FROM atlassian_resources
      WHERE connection_id = ${connectionId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(
        toPersistenceSqlError("AtlassianResourceRepository.deleteForConnection:query"),
      ),
    );

  return {
    upsertForConnection,
    list,
    deleteForConnection,
  } satisfies AtlassianResourceRepositoryShape;
});

export const AtlassianResourceRepositoryLive = Layer.effect(
  AtlassianResourceRepository,
  makeAtlassianResourceRepository,
);
