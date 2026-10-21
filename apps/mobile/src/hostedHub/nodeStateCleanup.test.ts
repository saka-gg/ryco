import { describe, expect, it, vi } from "vite-plus/test";

const demoted = vi.hoisted(() => vi.fn());
vi.mock("../rpc/checkpointDiffAtoms", () => ({ clearCheckpointDiffState: () => undefined }));
vi.mock("../state/threadsRuntime", () => ({
  useStore: { getState: () => ({ demoteEnvironmentStateToCachedSnapshot: demoted }) },
}));

import {
  readEnvironmentServerConfig,
  recordEnvironmentShellSettlementPolicy,
  resetEnvironmentServerConfigsForTests,
  resolveEnvironmentThreadCapabilities,
  writeEnvironmentServerConfig,
} from "@ryco/client-runtime/rpc";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";

import { demoteMobileHostedEnvironmentState } from "./nodeStateCleanup";

const NODE = EnvironmentId.make("released-node");

describe("demoteMobileHostedEnvironmentState", () => {
  it("lets a released node's newer cached rule replace the one its last config stated", () => {
    resetEnvironmentServerConfigsForTests();
    writeEnvironmentServerConfig(NODE, {
      environment: {
        label: "Studio",
        capabilities: { threadSettlement: true, nodeAutoSettlement: true },
      },
      settings: { ...DEFAULT_SERVER_SETTINGS, threadAutoSettleAfterDays: 3 },
    } as unknown as ServerConfig);
    // While its config is live, a snapshot does not replace the rule it states.
    recordEnvironmentShellSettlementPolicy(NODE, { autoSettleAfterDays: 30 });
    expect(resolveEnvironmentThreadCapabilities(NODE).autoSettleAfterDays).toBe(3);

    demoteMobileHostedEnvironmentState(NODE);
    expect(demoted).toHaveBeenCalledWith(NODE, expect.any(Number));
    expect(readEnvironmentServerConfig(NODE)).toBeNull();
    // The last known answer still classifies its threads until a newer one arrives.
    expect(resolveEnvironmentThreadCapabilities(NODE)).toMatchObject({
      threadSettlement: true,
      autoSettleAfterDays: 3,
    });
    recordEnvironmentShellSettlementPolicy(NODE, { autoSettleAfterDays: 30 });
    expect(resolveEnvironmentThreadCapabilities(NODE).autoSettleAfterDays).toBe(30);
    resetEnvironmentServerConfigsForTests();
  });
});
