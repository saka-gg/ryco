import { EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const rpc = vi.hoisted(() => ({ server: { readCliProxyHubs: vi.fn() } }));
vi.mock("../connection/environmentApi", () => ({ readRpcClient: () => rpc }));

import { forgetEnvironmentServerConfig } from "@ryco/client-runtime/rpc";

import { mobileCliProxyHubReads } from "./cliProxyHubReads";
import { writeEnvironmentServerConfig } from "./environmentServerConfigs";

const MAC = EnvironmentId.make("mac");
const config = { environment: { capabilities: { cliProxyHubs: true } } } as unknown as ServerConfig;

beforeEach(() => {
  vi.resetAllMocks();
  mobileCliProxyHubReads.clear();
});

describe("mobile hub reads", () => {
  it("drops a node's hubs when its config goes", async () => {
    writeEnvironmentServerConfig(MAC, config);
    rpc.server.readCliProxyHubs.mockResolvedValue({ hubs: [{ hubId: "home" }] });
    await mobileCliProxyHubReads.read(MAC);
    expect(mobileCliProxyHubReads.snapshot().has(MAC)).toBe(true);

    // Another node's config changing keeps it.
    writeEnvironmentServerConfig(EnvironmentId.make("mini"), config);
    expect(mobileCliProxyHubReads.snapshot().has(MAC)).toBe(true);

    forgetEnvironmentServerConfig(MAC);
    expect(mobileCliProxyHubReads.snapshot().has(MAC)).toBe(false);
  });
});
