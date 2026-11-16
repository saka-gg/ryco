import {
  McpServerName,
  McpSettingsError,
  McpWorkspaceId,
  type McpListServersResult,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { CodexMcpServiceShape } from "../CodexMcpService.ts";
import {
  externalAgentControlConfigFingerprint,
  externalAgentControlServerConfig,
} from "../externalAgentControlEntry.ts";
import { makeCodexMcpAdapter } from "./CodexMcpAdapter.ts";

const name = McpServerName.make("ryco");
const workspaceId = McpWorkspaceId.make("workspace-1");
const config = externalAgentControlServerConfig({
  command: "/runtime/node",
  args: ["/runtime/ryco", "mcp", "serve"],
});
const expectedFingerprint = externalAgentControlConfigFingerprint(config);
const installed = { name, config };

const listing = (servers: ReadonlyArray<unknown>) =>
  ({ workspace: {}, servers, warnings: [] }) as unknown as McpListServersResult;

function makeAdapter(input: {
  readonly listed: ReadonlyArray<unknown>;
  readonly afterRemove: ReadonlyArray<unknown>;
}) {
  const removeServer = vi.fn(() => Effect.succeed(listing(input.afterRemove)));
  const service = {
    listServers: () => Effect.succeed(listing(input.listed)),
    removeServer,
  } as unknown as CodexMcpServiceShape;
  return { adapter: makeCodexMcpAdapter(service), removeServer };
}

describe("CodexMcpAdapter external agent control remove", () => {
  it("fails when the entry is still listed after the removal", async () => {
    const { adapter } = makeAdapter({ listed: [installed], afterRemove: [installed] });
    const error = await Effect.runPromise(
      Effect.flip(
        adapter.externalAgentControl!.remove({ workspaceId, name, expectedFingerprint }),
      ),
    );
    expect(error).toBeInstanceOf(McpSettingsError);
    expect(error.message).toBe("Codex did not remove the MCP entry.");
  });

  it("reports removed when the listing after the removal no longer has the entry", async () => {
    const { adapter, removeServer } = makeAdapter({ listed: [installed], afterRemove: [] });
    const result = await Effect.runPromise(
      adapter.externalAgentControl!.remove({ workspaceId, name, expectedFingerprint }),
    );
    expect(result).toEqual({ removed: true, preservedUserChanges: false });
    expect(removeServer).toHaveBeenCalledTimes(1);
  });

  it("does not call the CLI when the entry is absent", async () => {
    const { adapter, removeServer } = makeAdapter({ listed: [], afterRemove: [] });
    const result = await Effect.runPromise(
      adapter.externalAgentControl!.remove({ workspaceId, name, expectedFingerprint }),
    );
    expect(result).toEqual({ removed: false, preservedUserChanges: false });
    expect(removeServer).not.toHaveBeenCalled();
  });
});
