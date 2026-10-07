import { AgentControlIntegrationId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeExternalIntegrationSetup } from "./externalSetup.ts";

describe("external MCP runtime configuration", () => {
  it.each(["codex", "claude-code", "claude-desktop", "generic-mcp"] as const)(
    "starts Electron in Node mode for %s without changing ordinary CLI launches",
    (clientKind) => {
      for (const isElectron of [true, false]) {
        const setup = makeExternalIntegrationSetup({
          clientKind,
          integrationId: AgentControlIntegrationId.make("integration-test"),
          runtime: {
            command: "/runtime with spaces/ryco",
            entryPoint: "/bundled/bin.mjs",
            stateDir: "/state",
            isElectron,
          },
        });
        if (clientKind === "codex") {
          expect(setup.configuration.includes('env = { ELECTRON_RUN_AS_NODE = "1" }')).toBe(
            isElectron,
          );
        } else {
          const server = JSON.parse(setup.configuration).mcpServers.ryco;
          expect(server.command).toBe(setup.serveCommand.command);
          expect(server.args).toEqual(setup.serveCommand.args);
          expect(server.env).toEqual(isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : undefined);
        }
      }
    },
  );
});
