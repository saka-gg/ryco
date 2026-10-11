import { AgentControlMcpInstallationId, NonNegativeInt } from "@ryco/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AgentControlMcpInstallationRepositoryError,
} from "../Errors.ts";
import {
  AgentControlMcpInstallationRepository,
  type AgentControlMcpInstallationRepositoryShape,
  StoredAgentControlMcpInstallation,
} from "../Services/AgentControlMcpInstallation.ts";

const InstallationDbRow = StoredAgentControlMcpInstallation.mapFields(
  Struct.assign({
    ownsNativeConfig: Schema.BooleanFromBit,
    preservedUserChanges: Schema.BooleanFromBit,
  }),
);
const InstallationIdResult = Schema.Struct({ installationId: AgentControlMcpInstallationId });

const toError =
  (sqlOperation: string, decodeOperation: string) =>
  (cause: unknown): AgentControlMcpInstallationRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRows = SqlSchema.findAll({
    Request: InstallationDbRow,
    Result: InstallationIdResult,
    execute: (row) => sql`
      INSERT INTO agent_control_mcp_installations (
        installation_id, integration_id, workspace_id, provider_driver, server_name, state,
        desired_fingerprint, native_fingerprint, last_error, owns_native_config,
        preserved_user_changes, revision, created_at, updated_at, connected_at
      ) VALUES (
        ${row.installationId}, ${row.integrationId}, ${row.workspaceId}, ${row.driver},
        ${row.serverName}, ${row.state}, ${row.desiredFingerprint}, ${row.nativeFingerprint},
        ${row.lastError}, ${row.ownsNativeConfig}, ${row.preservedUserChanges}, ${row.revision},
        ${row.createdAt}, ${row.updatedAt}, ${row.connectedAt}
      )
      ON CONFLICT DO NOTHING
      RETURNING installation_id AS "installationId"
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ installationId: AgentControlMcpInstallationId }),
    Result: InstallationDbRow,
    execute: ({ installationId }) => sql`
      SELECT installation_id AS "installationId", integration_id AS "integrationId",
        workspace_id AS "workspaceId", provider_driver AS "driver",
        server_name AS "serverName", state, desired_fingerprint AS "desiredFingerprint",
        native_fingerprint AS "nativeFingerprint", last_error AS "lastError",
        owns_native_config AS "ownsNativeConfig",
        preserved_user_changes AS "preservedUserChanges", revision,
        created_at AS "createdAt", updated_at AS "updatedAt", connected_at AS "connectedAt"
      FROM agent_control_mcp_installations
      WHERE installation_id = ${installationId}
      LIMIT 1
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: InstallationDbRow,
    execute: () => sql`
      SELECT installation_id AS "installationId", integration_id AS "integrationId",
        workspace_id AS "workspaceId", provider_driver AS "driver",
        server_name AS "serverName", state, desired_fingerprint AS "desiredFingerprint",
        native_fingerprint AS "nativeFingerprint", last_error AS "lastError",
        owns_native_config AS "ownsNativeConfig",
        preserved_user_changes AS "preservedUserChanges", revision,
        created_at AS "createdAt", updated_at AS "updatedAt", connected_at AS "connectedAt"
      FROM agent_control_mcp_installations
      ORDER BY created_at ASC, installation_id ASC
    `,
  });

  const replaceRows = SqlSchema.findAll({
    Request: Schema.Struct({
      expectedRevision: NonNegativeInt,
      installation: InstallationDbRow,
    }),
    Result: InstallationIdResult,
    execute: ({ expectedRevision, installation: row }) => sql`
      UPDATE agent_control_mcp_installations SET
        integration_id = ${row.integrationId}, workspace_id = ${row.workspaceId},
        provider_driver = ${row.driver}, server_name = ${row.serverName}, state = ${row.state},
        desired_fingerprint = ${row.desiredFingerprint},
        native_fingerprint = ${row.nativeFingerprint}, last_error = ${row.lastError},
        owns_native_config = ${row.ownsNativeConfig},
        preserved_user_changes = ${row.preservedUserChanges}, revision = ${row.revision},
        updated_at = ${row.updatedAt}, connected_at = ${row.connectedAt}
      WHERE installation_id = ${row.installationId} AND revision = ${expectedRevision}
      RETURNING installation_id AS "installationId"
    `,
  });

  const map = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(toError(`${operation}:query`, `${operation}:decode`)));

  return {
    insert: (installation) =>
      map("McpInstallationRepository.insert", insertRows(installation)).pipe(
        Effect.map((rows) => rows.length === 1),
      ),
    get: (installationId) => map("McpInstallationRepository.get", getRow({ installationId })),
    list: () => map("McpInstallationRepository.list", listRows(undefined)),
    replace: (input) =>
      map("McpInstallationRepository.replace", replaceRows(input)).pipe(
        Effect.map((rows) => rows.length === 1),
      ),
  } satisfies AgentControlMcpInstallationRepositoryShape;
});

export const AgentControlMcpInstallationRepositoryLive = Layer.effect(
  AgentControlMcpInstallationRepository,
  makeRepository,
);
