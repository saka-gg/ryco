/**
 * The OpenCode MCP adapter as the MCP registry and Agent Control see it. The implementation, which
 * reads and writes both OpenCode generations' config formats (`OpenCodeMcpConfig.ts`), loads with
 * the first call, so it stays out of the server's boot chunks.
 */
import { McpProviderCapabilities, McpSettingsError, ProviderDriverKind } from "@ryco/contracts";
import { Effect, Schema } from "effect";

import type { ServerConfig } from "../../config.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderMcpAdapter } from "../ProviderMcpAdapter.ts";
import type { OpenCodeMcpAdapterIo, OpenCodeMcpAdapterOptions } from "./OpenCodeMcpConfig.ts";

export const OPENCODE_MCP_DRIVER = ProviderDriverKind.make("opencode");
/** The adapter's capabilities, which are also those of a writable global profile. */
export const OPENCODE_MCP_CAPABILITIES = Schema.decodeSync(McpProviderCapabilities)({
  readConfiguration: "available",
  upsert: "available",
  remove: "available",
  enableDisable: "available",
  externalAgentControl: "available",
  automaticAgentControl: "unavailable",
  scopes: ["user"],
});

export const makeOpenCodeMcpAdapter = (
  io?: OpenCodeMcpAdapterIo,
  options?: OpenCodeMcpAdapterOptions,
) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ServerSettingsService | ServerConfig>();
    // Built once, by the first caller; concurrent first callers share that build.
    const adapter = yield* Effect.cached(
      Effect.tryPromise({
        try: () => import("./OpenCodeMcpConfig.ts"),
        catch: (cause) =>
          new McpSettingsError({ message: "Failed to load the OpenCode MCP adapter.", cause }),
      }).pipe(
        Effect.flatMap((module) => module.makeOpenCodeMcpConfigAdapter(io, options)),
        Effect.provideContext(services),
      ),
    );
    const use = <A>(
      run: (loaded: Effect.Success<typeof adapter>) => Effect.Effect<A, McpSettingsError>,
    ) => adapter.pipe(Effect.flatMap(run));
    return {
      driver: OPENCODE_MCP_DRIVER,
      capabilities: OPENCODE_MCP_CAPABILITIES,
      listWorkspaces: use((loaded) => loaded.listWorkspaces),
      listServers: (input) => use((loaded) => loaded.listServers(input)),
      upsertServer: (input) => use((loaded) => loaded.upsertServer(input)),
      setServerEnabled: (input) => use((loaded) => loaded.setServerEnabled(input)),
      removeServer: (input) => use((loaded) => loaded.removeServer(input)),
      externalAgentControl: {
        inspect: (input) => use((loaded) => loaded.externalAgentControl.inspect(input)),
        install: (input) => use((loaded) => loaded.externalAgentControl.install(input)),
        remove: (input) => use((loaded) => loaded.externalAgentControl.remove(input)),
      },
    } satisfies ProviderMcpAdapter;
  });
