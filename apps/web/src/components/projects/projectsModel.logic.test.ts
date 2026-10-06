import type { EnvironmentId, ProjectId, RepositoryIdentity } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  buildProjectListRows,
  deriveProjectDevices,
  devicesWithoutProject,
  filterProjectListRows,
  findProjectCheckout,
  formatProjectPath,
  inferHomeDirectory,
  projectMotionDirection,
  projectPathTail,
  projectRepositoryLabel,
} from "./projectsModel.logic";

const LOCAL = "env-local" as EnvironmentId;
const STUDIO = "env-studio" as EnvironmentId;

const IDENTITY: RepositoryIdentity = {
  canonicalKey: "github.com/sak0a/ryco",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:sak0a/ryco" },
  provider: "github",
  owner: "sak0a",
  name: "ryco",
  remotes: [{ name: "origin", url: "git@github.com:sak0a/ryco", ownerRepo: "sak0a/ryco" }],
};

function member(
  environmentId: EnvironmentId,
  id: string,
  cwd: string,
  label: string | null,
): SidebarProjectGroupMember {
  return {
    id: id as ProjectId,
    environmentId,
    name: "ryco",
    cwd,
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: IDENTITY,
    physicalProjectKey: `${environmentId}:${cwd}`,
    environmentLabel: label,
  };
}

function snapshot(
  key: string,
  members: SidebarProjectGroupMember[],
  overrides: Partial<SidebarProjectSnapshot> = {},
): SidebarProjectSnapshot {
  const representative = members[0]!;
  return {
    ...representative,
    projectKey: key,
    displayName: representative.name,
    groupedProjectCount: members.length,
    environmentPresence: "local-only",
    memberProjects: members,
    memberProjectRefs: members.map((entry) => ({
      environmentId: entry.environmentId,
      projectId: entry.id,
    })),
    remoteEnvironmentLabels: [],
    ...overrides,
  };
}

function thread(input: {
  environmentId: EnvironmentId;
  projectId: string;
  updatedAt?: string;
  archivedAt?: string | null;
  running?: boolean;
}) {
  return {
    environmentId: input.environmentId,
    projectId: input.projectId as ProjectId,
    archivedAt: input.archivedAt ?? null,
    updatedAt: input.updatedAt,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestTurn: null,
    session: input.running
      ? {
          provider: "codex" as never,
          status: "running" as never,
          activeTurnId: "turn-1" as never,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          orchestrationStatus: "running" as never,
        }
      : null,
    backgroundLiveness: null,
  };
}

describe("projectRepositoryLabel", () => {
  it("prefers owner/name", () => {
    expect(projectRepositoryLabel(IDENTITY)).toBe("sak0a/ryco");
  });
  it("falls back to the primary remote's ownerRepo", () => {
    const { owner: _owner, name: _name, ...withoutOwner } = IDENTITY;
    expect(projectRepositoryLabel(withoutOwner)).toBe("sak0a/ryco");
  });
  it("is null without an identity", () => {
    expect(projectRepositoryLabel(null)).toBeNull();
  });
});

describe("paths", () => {
  it("shortens the home directory", () => {
    expect(formatProjectPath("/Users/me/Code/ryco", "/Users/me")).toBe("~/Code/ryco");
    expect(formatProjectPath("/Users/me", "/Users/me/")).toBe("~");
    expect(formatProjectPath("/Users/meow/x", "/Users/me")).toBe("/Users/meow/x");
    expect(formatProjectPath("C:\\Users\\me\\src", "C:\\Users\\me")).toBe("~\\src");
  });
  it("infers the home directory from common layouts", () => {
    expect(inferHomeDirectory("/Users/me/Code/ryco")).toBe("/Users/me");
    expect(inferHomeDirectory("/home/me")).toBe("/home/me");
    expect(inferHomeDirectory("C:\\Users\\me\\src")).toBe("C:\\Users\\me");
    expect(inferHomeDirectory("/srv/ryco")).toBeNull();
  });
  it("takes the last two segments", () => {
    expect(projectPathTail("/Users/me/Code/ryco")).toBe("Code/ryco");
    expect(projectPathTail("/ryco")).toBe("ryco");
  });
});

describe("deriveProjectDevices", () => {
  it("dedupes by environment and leads with the primary", () => {
    const members = [
      member(STUDIO, "a", "/s/ryco", "Studio"),
      member(LOCAL, "b", "/l/ryco", null),
      member(STUDIO, "c", "/s/ryco-2", "Studio"),
    ];
    expect(deriveProjectDevices(members, LOCAL)).toEqual([
      { environmentId: LOCAL, label: null },
      { environmentId: STUDIO, label: "Studio" },
    ]);
  });
});

describe("buildProjectListRows", () => {
  const ryco = snapshot("github.com/sak0a/ryco", [
    member(LOCAL, "p1", "/Users/me/Code/ryco", null),
    member(STUDIO, "p2", "/src/ryco", "Studio"),
  ]);
  const scratch = snapshot(
    "env-local:/tmp/scratch",
    [{ ...member(LOCAL, "p3", "/tmp/scratch", null), repositoryIdentity: null, name: "scratch" }],
    { displayName: "scratch", repositoryIdentity: null, cwd: "/tmp/scratch" },
  );

  it("folds activity across checkouts and ignores archived threads", () => {
    const rows = buildProjectListRows({
      snapshots: [ryco, scratch],
      primaryEnvironmentId: LOCAL,
      threads: [
        thread({ environmentId: LOCAL, projectId: "p1", updatedAt: "2026-10-01T10:00:00.000Z" }),
        thread({ environmentId: STUDIO, projectId: "p2", updatedAt: "2026-10-02T10:00:00.000Z" }),
        thread({
          environmentId: LOCAL,
          projectId: "p3",
          updatedAt: "2026-10-03T10:00:00.000Z",
          archivedAt: "2026-10-03T11:00:00.000Z",
        }),
      ],
    });
    expect(rows.map((row) => row.key)).toEqual(["github.com/sak0a/ryco", "env-local:/tmp/scratch"]);
    expect(rows[0]!.lastActivityAt).toBe(Date.parse("2026-10-02T10:00:00.000Z"));
    expect(rows[0]!.subtitle).toBe("sak0a/ryco");
    const named = buildProjectListRows({
      snapshots: [{ ...ryco, displayName: "sak0a/ryco" }],
      primaryEnvironmentId: LOCAL,
      threads: [],
    });
    expect(named[0]!.subtitle).toBe("Code/ryco");
    expect(rows[0]!.devices).toHaveLength(2);
    expect(rows[1]!.lastActivityAt).toBeNull();
    expect(rows[1]!.subtitle).toBe("tmp/scratch");
  });

  it("marks a project running when any checkout has a working thread", () => {
    const rows = buildProjectListRows({
      snapshots: [ryco],
      primaryEnvironmentId: LOCAL,
      threads: [thread({ environmentId: STUDIO, projectId: "p2", running: true })],
    });
    expect(rows[0]!.running).toBe(true);
  });

  it("filters on name, repository, path and device", () => {
    const rows = buildProjectListRows({
      snapshots: [ryco, scratch],
      primaryEnvironmentId: LOCAL,
      threads: [],
    });
    expect(filterProjectListRows(rows, "sak0a").map((row) => row.name)).toEqual(["ryco"]);
    expect(filterProjectListRows(rows, "studio").map((row) => row.name)).toEqual(["ryco"]);
    expect(filterProjectListRows(rows, "tmp scr").map((row) => row.name)).toEqual(["scratch"]);
    expect(filterProjectListRows(rows, "  ")).toBe(rows);
  });
});

describe("findProjectCheckout", () => {
  it("finds the member and its logical project", () => {
    const ryco = snapshot("k", [member(LOCAL, "p1", "/a", null), member(STUDIO, "p2", "/b", "S")]);
    const found = findProjectCheckout([ryco], STUDIO, "p2");
    expect(found?.snapshot).toBe(ryco);
    expect(found?.member.cwd).toBe("/b");
    expect(findProjectCheckout([ryco], LOCAL, "p2")).toBeNull();
  });
});

describe("devicesWithoutProject", () => {
  it("lists known devices that lack the project, once each", () => {
    expect(
      devicesWithoutProject({
        knownDevices: [
          { environmentId: "a", label: "This device" },
          { environmentId: "b", label: "Studio" },
          { environmentId: "c", label: "Linux box" },
          { environmentId: "c", label: "Linux box" },
        ],
        projectEnvironmentIds: new Set(["a"]),
      }),
    ).toEqual(["Studio", "Linux box"]);
  });
});

describe("motion direction", () => {
  it("follows list order", () => {
    expect(projectMotionDirection(1, 3)).toBe(1);
    expect(projectMotionDirection(3, 1)).toBe(-1);
    expect(projectMotionDirection(2, 2)).toBe(0);
    expect(projectMotionDirection(-1, 2)).toBe(0);
  });
});
