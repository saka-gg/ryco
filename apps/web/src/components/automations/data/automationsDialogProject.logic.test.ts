import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import {
  automationsDialogDevice,
  rememberedAutomationsProject,
  resolveAutomationsDialogProject,
} from "./automationsDialogProject.logic";

const LOCAL = EnvironmentId.make("env-local");
const STUDIO = EnvironmentId.make("env-studio");

function member(environmentId: EnvironmentId, id: string): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    name: id,
    cwd: `/${id}`,
    defaultModelSelection: null,
    scripts: [],
    physicalProjectKey: `${environmentId}:/${id}`,
    environmentLabel: null,
  };
}

function project(key: string, members: readonly SidebarProjectGroupMember[]) {
  return {
    ...members[0]!,
    projectKey: key,
    displayName: key,
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    memberProjects: members,
    memberProjectRefs: members.map((entry) => ({
      environmentId: entry.environmentId,
      projectId: entry.id,
    })),
    remoteEnvironmentLabels: [],
  } as SidebarProjectSnapshot;
}

const ryco = project("ryco", [member(LOCAL, "ryco-local"), member(STUDIO, "ryco-studio")]);
const hub = project("hub", [member(LOCAL, "hub-local")]);
const snapshots = [ryco, hub];

describe("resolveAutomationsDialogProject", () => {
  it("finds a project by key or by any of its checkouts", () => {
    expect(
      resolveAutomationsDialogProject({
        snapshots,
        target: { kind: "key", projectKey: "hub" },
        last: null,
      }),
    ).toBe(hub);
    expect(
      resolveAutomationsDialogProject({
        snapshots,
        target: {
          kind: "checkout",
          environmentId: STUDIO,
          projectId: ProjectId.make("ryco-studio"),
        },
        last: null,
      }),
    ).toBe(ryco);
  });

  it("falls back to the last project, then to the first", () => {
    const last = rememberedAutomationsProject(hub);
    expect(resolveAutomationsDialogProject({ snapshots, target: { kind: "last" }, last })).toBe(
      hub,
    );
    // A project that is gone: the last one shown.
    expect(
      resolveAutomationsDialogProject({
        snapshots,
        target: { kind: "key", projectKey: "gone" },
        last,
      }),
    ).toBe(hub);
    expect(
      resolveAutomationsDialogProject({ snapshots, target: { kind: "last" }, last: null }),
    ).toBe(ryco);
    expect(
      resolveAutomationsDialogProject({ snapshots: [], target: { kind: "last" }, last }),
    ).toBeNull();
  });

  it("finds the last project by its checkout when its key changed", () => {
    const last = { ...rememberedAutomationsProject(hub), projectKey: "regrouped" };
    expect(resolveAutomationsDialogProject({ snapshots, target: { kind: "last" }, last })).toBe(
      hub,
    );
  });
});

describe("automationsDialogDevice", () => {
  it("uses the asked device, else the named checkout, only where the project lives", () => {
    expect(
      automationsDialogDevice(ryco, { project: { kind: "last" }, environmentId: STUDIO }),
    ).toBe(STUDIO);
    expect(
      automationsDialogDevice(ryco, {
        project: { kind: "checkout", environmentId: STUDIO, projectId: ProjectId.make("x") },
        environmentId: null,
      }),
    ).toBe(STUDIO);
    expect(automationsDialogDevice(hub, { project: { kind: "last" }, environmentId: STUDIO })).toBe(
      null,
    );
    expect(automationsDialogDevice(ryco, { project: { kind: "last" }, environmentId: null })).toBe(
      null,
    );
  });
});
