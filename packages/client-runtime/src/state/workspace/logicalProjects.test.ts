import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveLogicalProjectKey,
  deriveProjectGroupLabel,
  groupWorkspaceLogicalProjects,
  normalizeProjectPathForComparison,
} from "./logicalProjects.js";
import type { WorkspacePhysicalProjectVariant } from "./types.js";

function variant(
  environment: string,
  project: string,
  overrides: Partial<WorkspacePhysicalProjectVariant> = {},
): WorkspacePhysicalProjectVariant {
  const environmentId = EnvironmentId.make(environment);
  const projectId = ProjectId.make(project);
  return {
    environmentId,
    projectId,
    physicalKey: `${environmentId}:/${project}`,
    name: project,
    cwd: `/${project}`,
    repositoryIdentity: null,
    machineLabel: environment,
    online: true,
    canMutate: true,
    nativeTrust: "verified",
    effectiveRole: "operator",
    lastUsedAt: null,
    lastLiveAt: null,
    localDesktop: false,
    ...overrides,
  };
}

const repositoryIdentity = {
  canonicalKey: "github.com/example/ryco",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/ryco.git",
  },
  displayName: "example/ryco",
  remotes: [],
};

describe("logical workspace projects", () => {
  it("normalizes platform paths without treating path similarity as repository identity", () => {
    expect(normalizeProjectPathForComparison("C:/Code/Ryco/")).toBe("c:\\code\\ryco");
    const left = variant("a", "ryco-a", { cwd: "/code/ryco" });
    const right = variant("b", "ryco-b", { cwd: "/code/ryco" });
    expect(groupWorkspaceLogicalProjects([left, right])).toHaveLength(2);
  });

  it("groups canonical copies from distinct environments", () => {
    const projects = groupWorkspaceLogicalProjects([
      variant("a", "ryco-a", { repositoryIdentity, lastUsedAt: 10 }),
      variant("b", "ryco-b", { repositoryIdentity, lastUsedAt: 20 }),
    ]);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      key: repositoryIdentity.canonicalKey,
      label: "example/ryco",
      ambiguous: false,
    });
    expect(projects[0]?.variants.map((member) => member.environmentId)).toEqual([
      EnvironmentId.make("b"),
      EnvironmentId.make("a"),
    ]);
  });

  it("names a group by the title its checkouts share, else by the repository", () => {
    const member = (name: string, identity = repositoryIdentity) => ({
      name,
      repositoryIdentity: identity,
    });
    const shared = [member("ryco"), member("ryco")];
    expect(deriveProjectGroupLabel({ representative: shared[0]!, members: shared })).toBe("ryco");
    const renamed = [member("ryco"), member("Ryco app")];
    expect(deriveProjectGroupLabel({ representative: renamed[0]!, members: renamed })).toBe(
      "example/ryco",
    );
  });

  it("never names a group by the disk path of a path-addressed remote", () => {
    // What nodes before `canonicalRepositoryPath` sent for `linux-box:/private/tmp/git/demo.git`.
    const pathIdentity = {
      ...repositoryIdentity,
      canonicalKey: "linux-box:/private/tmp/git/demo",
      displayName: "private/tmp/git/demo",
      owner: "private",
      name: "demo",
    };
    const members = [
      { name: "demo", repositoryIdentity: pathIdentity },
      { name: "demo-copy", repositoryIdentity: pathIdentity },
    ];
    expect(deriveProjectGroupLabel({ representative: members[0]!, members })).toBe("demo");
  });

  it("fails open into physical projects when one environment has duplicate identities", () => {
    const projects = groupWorkspaceLogicalProjects([
      variant("a", "ryco-a1", { repositoryIdentity }),
      variant("a", "ryco-a2", { repositoryIdentity }),
      variant("b", "ryco-b", { repositoryIdentity }),
    ]);
    expect(projects).toHaveLength(3);
    expect(projects.every((project) => project.ambiguous)).toBe(true);
    expect(new Set(projects.map((project) => project.key)).size).toBe(3);
  });

  it("preserves repository-root relative grouping semantics", () => {
    const project = variant("a", "mobile", {
      cwd: "/repo/apps/mobile",
      repositoryIdentity: { ...repositoryIdentity, rootPath: "/repo" },
    });
    expect(
      deriveLogicalProjectKey(
        { ...project, id: project.projectId },
        { groupingMode: "repository_path" },
      ),
    ).toBe(`${repositoryIdentity.canonicalKey}::apps/mobile`);
  });
});
