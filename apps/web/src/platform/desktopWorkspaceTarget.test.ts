import { EnvironmentId, ProjectId, type DesktopWorkspaceStateProjection } from "@ryco/contracts";
import type { Project } from "@ryco/client-runtime/state/threads";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveDesktopDefaultProjectRef,
  resolveWorkspaceDefaultProjectRef,
  withDirectDesktopExecutionMachine,
} from "./desktopWorkspaceTarget";

function project(environment: string): Project {
  return {
    id: ProjectId.make(`project-${environment}`),
    environmentId: EnvironmentId.make(environment),
    name: "Ryco",
    cwd: "/ryco",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
  };
}

function state(): DesktopWorkspaceStateProjection {
  return {
    status: "ready",
    accountId: "account-a",
    localEnvironmentId: EnvironmentId.make("local"),
    machines: [
      {
        environmentId: EnvironmentId.make("remote"),
        nodeId: "node_remote",
        effectiveRole: "operator",
        label: "Remote",
        online: true,
        nativeTrust: "verified",
        connectionState: "connected",
        canReadMetadata: true,
        canConnect: true,
        canMutate: true,
        threadSettlementSupported: true,
        accessReasons: [],
      },
      {
        environmentId: EnvironmentId.make("local"),
        nodeId: "node_local",
        effectiveRole: "owner",
        label: "Local",
        online: true,
        nativeTrust: "verified",
        connectionState: "connected",
        canReadMetadata: true,
        canConnect: true,
        canMutate: true,
        threadSettlementSupported: true,
        accessReasons: [],
      },
    ],
    snapshots: [],
    queuedEnvironmentIds: [],
    activeConnectionCount: 2,
  };
}

describe("Desktop new-work target", () => {
  it("uses the direct primary environment for This device instead of the local Hub alias", () => {
    const primaryEnvironmentId = EnvironmentId.make("primary-direct");
    const localHubEnvironmentId = EnvironmentId.make("local-hub-alias");
    const machines = withDirectDesktopExecutionMachine({
      primaryLabel: "System Mac name",
      machines: [
        {
          environmentId: localHubEnvironmentId,
          label: "Laurin’s MacBook Pro",
          online: true,
          canMutate: false,
          nativeTrust: "unverified",
        },
        {
          environmentId: EnvironmentId.make("remote"),
          label: "Remote",
          online: true,
          canMutate: true,
          nativeTrust: "verified",
        },
      ],
      ready: true,
      primaryEnvironmentId,
      localHubEnvironmentId,
    });

    expect(machines).toEqual([
      {
        environmentId: primaryEnvironmentId,
        label: "Laurin’s MacBook Pro",
        online: true,
        canMutate: true,
        nativeTrust: "not-required",
      },
      expect.objectContaining({ environmentId: EnvironmentId.make("remote") }),
    ]);
    const directProject = project(primaryEnvironmentId);
    expect(
      resolveWorkspaceDefaultProjectRef({
        orderedProjects: [directProject],
        machines,
        ready: true,
        localEnvironmentId: primaryEnvironmentId,
        logicalKey: () => "logical-ryco",
      }),
    ).toEqual({
      environmentId: primaryEnvironmentId,
      projectId: directProject.id,
    });
  });

  it("uses the shared resolver and local tie-break", () => {
    const remote = project("remote");
    const local = project("local");
    expect(
      resolveDesktopDefaultProjectRef({
        orderedProjects: [remote, local],
        workspace: state(),
        logicalKey: () => "logical-ryco",
      }),
    ).toEqual({ environmentId: local.environmentId, projectId: local.id });
  });

  it("returns no target when every physical copy is unavailable", () => {
    const remote = project("remote");
    const unavailable = {
      ...state(),
      localEnvironmentId: null,
      machines: state().machines.map((machine) =>
        Object.assign({}, machine, {
          online: false,
          canConnect: false,
          canMutate: false,
        }),
      ),
    } satisfies DesktopWorkspaceStateProjection;
    expect(
      resolveDesktopDefaultProjectRef({
        orderedProjects: [remote],
        workspace: unavailable,
        logicalKey: () => "logical-ryco",
      }),
    ).toBeNull();
  });
});

describe("Hosted Web new-work target", () => {
  it("uses the newly selected environment and never the previous node's cached project", () => {
    const previous = project("previous");
    const selected = project("selected");
    const machines = [
      {
        environmentId: previous.environmentId,
        label: "Previous",
        online: true,
        canMutate: true,
        nativeTrust: "not-required" as const,
      },
      {
        environmentId: selected.environmentId,
        label: "Selected",
        online: true,
        canMutate: true,
        nativeTrust: "not-required" as const,
      },
    ];
    expect(
      resolveWorkspaceDefaultProjectRef({
        orderedProjects: [previous, selected],
        machines,
        ready: true,
        localEnvironmentId: null,
        preferredEnvironmentId: selected.environmentId,
        logicalKey: () => "logical-ryco",
      }),
    ).toEqual({ environmentId: selected.environmentId, projectId: selected.id });
    expect(
      resolveWorkspaceDefaultProjectRef({
        orderedProjects: [previous, selected],
        machines,
        ready: false,
        localEnvironmentId: null,
        preferredEnvironmentId: selected.environmentId,
        logicalKey: () => "logical-ryco",
      }),
    ).toBeNull();
  });

  it("selects only the eligible variant and never a locked, offline, or unrelated machine", () => {
    const eligible = project("eligible");
    const locked = project("locked");
    const offline = project("offline");
    expect(
      resolveWorkspaceDefaultProjectRef({
        orderedProjects: [locked, offline, eligible],
        ready: true,
        localEnvironmentId: null,
        logicalKey: () => "logical-ryco",
        machines: [
          {
            environmentId: locked.environmentId,
            label: "Native only",
            online: true,
            canMutate: false,
            nativeTrust: "not-required",
          },
          {
            environmentId: offline.environmentId,
            label: "Offline",
            online: false,
            canMutate: false,
            nativeTrust: "not-required",
          },
          {
            environmentId: eligible.environmentId,
            label: "Browser eligible",
            online: true,
            canMutate: true,
            nativeTrust: "not-required",
          },
          {
            environmentId: EnvironmentId.make("unrelated"),
            label: "Unrelated",
            online: true,
            canMutate: true,
            nativeTrust: "not-required",
          },
        ],
      }),
    ).toEqual({ environmentId: eligible.environmentId, projectId: eligible.id });
  });
});
