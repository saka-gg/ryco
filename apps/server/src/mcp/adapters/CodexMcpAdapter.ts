import { McpSettingsError, ProviderDriverKind } from "@ryco/contracts";
import { Effect } from "effect";

import { mcpSupportForDriver, type CodexMcpServiceShape } from "../CodexMcpService.ts";
import type { ProviderMcpAdapter } from "../ProviderMcpAdapter.ts";
import {
  externalAgentControlConfigFingerprint,
  externalAgentControlServerConfig,
} from "../externalAgentControlEntry.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

export function makeCodexMcpAdapter(service: CodexMcpServiceShape): ProviderMcpAdapter {
  const inspect: NonNullable<ProviderMcpAdapter["externalAgentControl"]>["inspect"] = (input) =>
    service.listServers({ workspaceId: input.workspaceId, detail: "full" }).pipe(
      Effect.map((result) => {
        const server = result.servers.find((entry) => entry.name === input.name);
        if (!server) return { state: "absent" as const, fingerprint: null };
        const fingerprint = externalAgentControlConfigFingerprint(server.config);
        const desiredFingerprint = externalAgentControlConfigFingerprint(
          externalAgentControlServerConfig(input),
        );
        return {
          state:
            fingerprint === desiredFingerprint ? ("matching" as const) : ("different" as const),
          fingerprint,
        };
      }),
    );

  return {
    driver: CODEX_DRIVER,
    capabilities: {
      ...mcpSupportForDriver(CODEX_DRIVER).capabilities,
      externalAgentControl: "available",
    },
    listWorkspaces: service.listWorkspaces,
    listServers: service.listServers,
    upsertServer: service.upsertServer,
    setServerEnabled: service.setServerEnabled,
    removeServer: service.removeServer,
    reloadServers: service.reloadServers,
    startOauthLogin: service.startOauthLogin,
    externalAgentControl: {
      inspect,
      install: (input) =>
        Effect.gen(function* () {
          const before = yield* inspect(input);
          if (
            (input.expectedFingerprint === null && before.state !== "absent") ||
            (input.expectedFingerprint !== null && before.fingerprint !== input.expectedFingerprint)
          ) {
            return yield* Effect.fail(
              new McpSettingsError({ message: "MCP server changed before installation." }),
            );
          }
          const config = externalAgentControlServerConfig(input);
          yield* service.upsertServer({
            workspaceId: input.workspaceId,
            name: input.name,
            config,
          });
          const after = yield* inspect(input);
          if (after.state !== "matching" || after.fingerprint === null) {
            return yield* Effect.fail(
              new McpSettingsError({
                message: "Codex did not preserve the installed MCP entry.",
              }),
            );
          }
          return { fingerprint: after.fingerprint };
        }),
      remove: (input) =>
        Effect.gen(function* () {
          const current = yield* service.listServers({
            workspaceId: input.workspaceId,
            detail: "full",
          });
          const server = current.servers.find((entry) => entry.name === input.name);
          if (!server) return { removed: false, preservedUserChanges: false };
          if (externalAgentControlConfigFingerprint(server.config) !== input.expectedFingerprint) {
            return { removed: false, preservedUserChanges: true };
          }
          const after = yield* service.removeServer({
            workspaceId: input.workspaceId,
            name: input.name,
          });
          if (after.servers.some((entry) => entry.name === input.name)) {
            return yield* Effect.fail(
              new McpSettingsError({ message: "Codex did not remove the MCP entry." }),
            );
          }
          return { removed: true, preservedUserChanges: false };
        }),
    },
  };
}
