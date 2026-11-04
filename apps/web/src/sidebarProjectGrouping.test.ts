import { EnvironmentId, ProjectId, ProviderInstanceId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");
const defaultSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

describe("buildSidebarProjectSnapshots", () => {
  it("hides generic local environment labels on primary project members", () => {
    const [project] = buildSnapshots({
      projects: [
        makeProject({
          id: ProjectId.make("project-local"),
          environmentId: primaryEnvironmentId,
          name: "Ryco",
        }),
      ],
      labelByEnvironmentId: {
        [primaryEnvironmentId]: "Local",
      },
    });

    expect(project?.memberProjects[0]?.environmentLabel).toBeNull();
  });

  it("keeps custom primary environment labels", () => {
    const [project] = buildSnapshots({
      projects: [
        makeProject({
          id: ProjectId.make("project-local"),
          environmentId: primaryEnvironmentId,
          name: "Ryco",
        }),
      ],
      labelByEnvironmentId: {
        [primaryEnvironmentId]: "Julius's Mac mini",
      },
    });

    expect(project?.memberProjects[0]?.environmentLabel).toBe("Julius's Mac mini");
  });

  it("keeps remote labels while omitting generic local labels in mixed project groups", () => {
    const [project] = buildSnapshots({
      projects: [
        makeProject({
          id: ProjectId.make("project-local"),
          environmentId: primaryEnvironmentId,
          name: "Ryco",
          repositoryIdentity: sharedRepositoryIdentity(),
        }),
        makeProject({
          id: ProjectId.make("project-remote"),
          environmentId: remoteEnvironmentId,
          name: "Ryco",
          repositoryIdentity: sharedRepositoryIdentity(),
        }),
      ],
      labelByEnvironmentId: {
        [primaryEnvironmentId]: "Local environment",
        [remoteEnvironmentId]: "Build box",
      },
    });

    expect(project?.environmentPresence).toBe("mixed");
    expect(project?.memberProjects.map((member) => member.environmentLabel)).toEqual([
      null,
      "Build box",
    ]);
    expect(project?.remoteEnvironmentLabels).toEqual(["Build box"]);
  });

  it("names a project copied to another node by its title, not its remote's disk path", () => {
    // What a node before `canonicalRepositoryPath` sent for `linux-box:/private/tmp/git/demo.git`.
    const repositoryIdentity: NonNullable<Project["repositoryIdentity"]> = {
      canonicalKey: "linux-box:/private/tmp/git/demo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "linux-box:/private/tmp/git/demo.git",
      },
      displayName: "private/tmp/git/demo",
      owner: "private",
      name: "demo",
      remotes: [],
    };
    const [project] = buildSnapshots({
      projects: [
        makeProject({
          id: ProjectId.make("demo-local"),
          environmentId: primaryEnvironmentId,
          name: "demo",
          repositoryIdentity,
        }),
        makeProject({
          id: ProjectId.make("demo-remote"),
          environmentId: remoteEnvironmentId,
          name: "demo",
          repositoryIdentity,
        }),
      ],
      labelByEnvironmentId: { [remoteEnvironmentId]: "linux-box" },
    });

    expect(project?.groupedProjectCount).toBe(2);
    expect(project?.displayName).toBe("demo");
  });
});

function buildSnapshots(input: {
  projects: ReadonlyArray<Project>;
  labelByEnvironmentId: Readonly<Record<string, string | null>>;
}): SidebarProjectSnapshot[] {
  return buildSidebarProjectSnapshots({
    projects: input.projects,
    settings: defaultSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => input.labelByEnvironmentId[environmentId] ?? null,
  });
}

function makeProject(
  overrides: Partial<Project> & Pick<Project, "id" | "environmentId" | "name">,
): Project {
  return {
    cwd: `/repo/${overrides.name.toLowerCase()}`,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    repositoryIdentity: null,
    scripts: [],
    ...overrides,
  };
}

function sharedRepositoryIdentity(): NonNullable<Project["repositoryIdentity"]> {
  return {
    canonicalKey: "github.com/example/ryco",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/example/ryco.git",
    },
  };
}
