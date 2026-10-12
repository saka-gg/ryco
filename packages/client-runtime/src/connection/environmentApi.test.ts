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

  it("exposes thread forks only when the client has them", () => {
    const id = EnvironmentId.make("node");
    const fork = vi.fn();
    const withFork = {
      ...client(),
      threads: { setManualBucket: vi.fn(), setManualPosition: vi.fn(), fork },
    } as unknown as WsRpcClient;
    const api = createEnvironmentApiLookup({
      canReadConnections: () => true,
      readClient: () => withFork,
    }).read(id);
    expect(api?.threads?.fork).toBe(fork);

    const withoutFork = {
      ...client(),
      threads: { setManualBucket: vi.fn(), setManualPosition: vi.fn() },
    } as unknown as WsRpcClient;
    const legacy = createEnvironmentApiLookup({
      canReadConnections: () => true,
      readClient: () => withoutFork,
    }).read(id);
    expect(legacy?.threads).toBeDefined();
    expect(legacy?.threads).not.toHaveProperty("fork");
  });
});
