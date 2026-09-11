import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@ryco/contracts";
import type { WsRpcClient } from "../rpc/index.ts";
import { createEnvironmentApiLookup } from "./environmentApi.ts";

function client(): WsRpcClient {
  return {
    server: {},
    projects: { readIcon: vi.fn() },
    filesystem: {},
    sourceControl: {},
    vcs: {},
    git: {},
    orchestration: {},
    contextHandoff: {},
    mcp: {},
    terminal: {},
  } as unknown as WsRpcClient;
}

describe("environment API lookup", () => {
  it("keeps wrappers stable for a connection and replaces them with the client", () => {
    const id = EnvironmentId.make("node");
    let current: WsRpcClient | null = client();
    let authorized = true;
    const lookup = createEnvironmentApiLookup({
      canReadConnections: () => authorized,
      readClient: () => current,
    });
    const first = lookup.read(id);
    expect(first?.projects.readIcon).toBe(current.projects.readIcon);
    expect(lookup.read(id)).toBe(first);
    authorized = false;
    expect(lookup.read(id)).toBeUndefined();
    authorized = true;
    current = null;
    expect(lookup.read(id)).toBeUndefined();
    current = client();
    expect(lookup.read(id)).not.toBe(first);
    expect(lookup.read(id)?.projects.readIcon).toBe(current.projects.readIcon);
  });
});
