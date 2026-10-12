import { EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterAgentControlSyncEnvironmentIds,
  readAgentControlEnabled,
} from "./agentControlSyncGate";

const primary = EnvironmentId.make("primary");
const saved = EnvironmentId.make("saved");
const unknown = EnvironmentId.make("unknown");

function configWithAgentControl(enabled: boolean): ServerConfig {
  return { settings: { agentControl: { enabled } } } as unknown as ServerConfig;
}

describe("Agent Control sync gate", () => {
  it("reads the flag only from a known config", () => {
    expect(readAgentControlEnabled(null)).toBeNull();
    expect(readAgentControlEnabled(undefined)).toBeNull();
    expect(readAgentControlEnabled(configWithAgentControl(false))).toBe(false);
    expect(readAgentControlEnabled(configWithAgentControl(true))).toBe(true);
  });

  it("skips only environments whose own config disables the feature", () => {
    const disabled = new Set<EnvironmentId>([saved]);
    expect(
      filterAgentControlSyncEnvironmentIds({
        environmentIds: [primary, saved, unknown],
        isDisabled: (environmentId) => disabled.has(environmentId),
      }),
    ).toEqual([primary, unknown]);
  });
});
