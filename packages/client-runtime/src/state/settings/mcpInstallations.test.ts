import type { AgentControlMcpInstallation } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyMcpInstallationList,
  applyMcpInstallationMutation,
  automaticAgentControlStatus,
  emptyMcpInstallationSettingsState,
  installableAgentControlWorkspaces,
  latestMcpInstallation,
  mcpInstallationStatus,
} from "./mcpInstallations.ts";

const installation = (
  revision: number,
  state: AgentControlMcpInstallation["state"],
): AgentControlMcpInstallation => ({
  installationId: "installation-1" as AgentControlMcpInstallation["installationId"],
  integrationId: "integration-1" as AgentControlMcpInstallation["integrationId"],
  workspaceId: "codex:dGVzdA" as AgentControlMcpInstallation["workspaceId"],
  driver: "codex" as AgentControlMcpInstallation["driver"],
  serverName: "ryco" as AgentControlMcpInstallation["serverName"],
  state,
  revision,
  lastError: null,
  ownsNativeConfig: state === "connected",
  preservedUserChanges: false,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: `2026-08-19T00:00:0${revision}.000Z`,
  connectedAt: state === "connected" ? "2026-08-19T00:00:01.000Z" : null,
});

describe("MCP installation settings state", () => {
  it("hydrates a list and applies newer mutation revisions", () => {
    const hydrated = applyMcpInstallationList(emptyMcpInstallationSettingsState(), {
      installations: [installation(1, "verifying")],
    });
    const connected = applyMcpInstallationMutation(hydrated, {
      installation: installation(2, "connected"),
    });
    expect(connected.installations[0]?.state).toBe("connected");
  });

  it("does not regress state from a stale reconnect response", () => {
    const current = applyMcpInstallationList(emptyMcpInstallationSettingsState(), {
      installations: [installation(3, "connected")],
    });
    expect(
      applyMcpInstallationMutation(current, {
        installation: installation(2, "verifying"),
      }),
    ).toBe(current);
  });
});

describe("Agent Control installation presentation", () => {
  it("picks the workspace's most recently updated installation", () => {
    const older = installation(1, "disconnected");
    const newer = {
      ...installation(2, "connected"),
      installationId: "installation-2" as AgentControlMcpInstallation["installationId"],
    };
    expect(latestMcpInstallation([older, newer], older.workspaceId)).toBe(newer);
    expect(
      latestMcpInstallation([older], "other" as AgentControlMcpInstallation["workspaceId"]),
    ).toBeUndefined();
  });

  it("names each installation state", () => {
    expect(mcpInstallationStatus(undefined)).toEqual({ label: "Not connected", tone: "outline" });
    expect(mcpInstallationStatus(installation(1, "connected")).label).toBe("Connected");
    expect(mcpInstallationStatus(installation(1, "repair-needed")).tone).toBe("error");
    expect(mcpInstallationStatus(installation(1, "verifying")).label).toBe("Connecting");
  });

  it("lists installable workspaces and automatic providers", () => {
    const workspace = (externalAgentControl: string) =>
      ({ capabilities: { externalAgentControl } }) as never;
    expect(
      installableAgentControlWorkspaces([workspace("available"), workspace("unavailable")]),
    ).toHaveLength(1);
    const provider = (enabled: boolean, automaticAgentControl: string) =>
      ({ enabled, capabilities: { automaticAgentControl } }) as never;
    expect(automaticAgentControlStatus(provider(true, "available")).automatic).toBe(true);
    expect(automaticAgentControlStatus(provider(true, "unavailable")).label).toBe("Unavailable");
    expect(automaticAgentControlStatus(provider(false, "available")).label).toBe("Disabled");
  });
});
