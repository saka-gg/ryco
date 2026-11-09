import {
  type AgentControlActionPlan,
  type AgentControlDevicePlanTarget,
  type AgentControlPrincipal,
  AgentControlIntegrationId,
  DeviceUdid,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { isRoutineAgentControlAction } from "./routineActions.ts";

const threadId = ThreadId.make("thread-caller");
const projectId = ProjectId.make("project-1");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");

const target: AgentControlDevicePlanTarget = {
  threadId,
  projectId,
  expectedProjectUpdatedAt: IsoDateTime.make("2026-11-09T00:00:00.000Z"),
  providerInstanceId,
  udid: DeviceUdid.make("SIM-1"),
  expectedThreadDeviceVersion: 0,
  expectedAttachedDeviceUdid: null,
  expectedDeviceState: "shutdown",
  expectedDeviceBootSource: "ryco",
  expectedRecording: false,
  executionSummary: "Boot simulator or emulator SIM-1",
  riskClass: "device-lifecycle",
};

const session = (originRuntimeMode?: RuntimeMode): AgentControlPrincipal => ({
  kind: "provider-session",
  threadId,
  providerInstanceId,
  originProjectId: projectId,
  ...(originRuntimeMode === undefined ? {} : { originRuntimeMode }),
  originEnvMode: "worktree",
});

const plan = (kind: AgentControlActionPlan["kind"]) =>
  ({ kind, ...target }) as AgentControlActionPlan;

describe("routine device lifecycle", () => {
  it("boots and attaches without approval only for a full-access chat", () => {
    for (const kind of ["deviceBoot", "deviceAttach"] as const) {
      expect(isRoutineAgentControlAction(session("full-access"), plan(kind))).toBe(true);
      for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
        expect(isRoutineAgentControlAction(session(mode), plan(kind))).toBe(false);
      }
      // A principal without recorded privilege evidence never runs unattended.
      expect(isRoutineAgentControlAction(session(), plan(kind))).toBe(false);
    }
  });

  it("keeps every other device change for the user, even in full access", () => {
    for (const kind of ["deviceDetach", "deviceShutdown"] as const) {
      expect(isRoutineAgentControlAction(session("full-access"), plan(kind))).toBe(false);
    }
    expect(
      isRoutineAgentControlAction(session("full-access"), {
        ...target,
        kind: "deviceInstall",
        artifactPath: "build/App.app",
      } as AgentControlActionPlan),
    ).toBe(false);
  });

  it("never auto-approves for a separately paired integration", () => {
    expect(
      isRoutineAgentControlAction(
        {
          kind: "external-integration",
          integrationId: AgentControlIntegrationId.make("integration-1"),
          projectId,
          runtimeMode: "full-access",
          envMode: "worktree",
        },
        plan("deviceBoot"),
      ),
    ).toBe(false);
  });
});
