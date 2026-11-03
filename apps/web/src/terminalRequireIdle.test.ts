import {
  forgetEnvironmentServerConfig,
  writeEnvironmentServerConfig,
} from "@ryco/client-runtime/rpc";
import { EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const PRIMARY = EnvironmentId.make("primary-node");
const HOSTED = EnvironmentId.make("hosted-node");

function config(environmentId: EnvironmentId, terminalWriteRequireIdle: boolean): ServerConfig {
  return {
    environment: {
      environmentId,
      label: "Node",
      capabilities: terminalWriteRequireIdle ? { terminalWriteRequireIdle } : {},
    },
  } as unknown as ServerConfig;
}

const state = vi.hoisted(() => ({ projected: null as ServerConfig | null }));

vi.mock("./environments/primary", () => ({
  getPrimaryKnownEnvironment: () => ({ environmentId: "primary-node" }),
}));
vi.mock("./environments/runtime", () => ({
  useSavedEnvironmentRuntimeStore: { getState: () => ({ byId: {} }) },
}));
vi.mock("./rpc/serverState", () => ({ getServerConfig: () => state.projected }));

import { readTerminalWriteRequireIdleSupported } from "./terminalRequireIdle";

afterEach(() => {
  forgetEnvironmentServerConfig(PRIMARY);
  forgetEnvironmentServerConfig(HOSTED);
  state.projected = null;
});

describe("readTerminalWriteRequireIdleSupported", () => {
  it("reads a node that is not the primary from its own config", () => {
    state.projected = config(PRIMARY, false);
    writeEnvironmentServerConfig(HOSTED, config(HOSTED, true));

    expect(readTerminalWriteRequireIdleSupported(HOSTED)).toBe(true);
  });

  it("trusts the node's own config over the primary's projected one", () => {
    // Mid node switch: the projection still shows the previous node, which verified idle shells.
    state.projected = config(HOSTED, true);
    writeEnvironmentServerConfig(PRIMARY, config(PRIMARY, false));

    expect(readTerminalWriteRequireIdleSupported(PRIMARY)).toBe(false);
  });

  it("reads no support for a node whose config is unknown", () => {
    expect(readTerminalWriteRequireIdleSupported(HOSTED)).toBe(false);
  });
});
