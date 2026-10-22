import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectCheckoutOption } from "../projectCheckouts.logic";
import {
  buildProjectSelectorProjects,
  buildProjectSelectorRows,
  checkoutStatusMeta,
  checkoutUnavailableReason,
  countProjectsByNode,
  NO_PROJECT_ITEM,
  parseProjectSelectorQuery,
  projectRowSubline,
  stripNodeTokens,
  type ProjectSelectorNode,
  type ProjectSelectorRow,
} from "./ProjectSwitcher.logic";

const MAC = EnvironmentId.make("env-mac");
const MINI = EnvironmentId.make("env-mini");
const PC = EnvironmentId.make("env-pc");

const NODES: Record<string, ProjectSelectorNode> = {
  [MAC]: {
    environmentId: MAC,
    label: "MacBook Pro",
    isThisDevice: true,
    iconKind: null,
    platformOs: "darwin",
    presence: "online",
  },
  [MINI]: {
    environmentId: MINI,
    label: "Mac mini",
    isThisDevice: false,
    iconKind: null,
    platformOs: "darwin",
    presence: "online",
  },
  [PC]: {
    environmentId: PC,
    label: "Gaming PC",
    isThisDevice: false,
    iconKind: null,
    platformOs: "windows",
    presence: "offline",
  },
};

function option(
  environmentId: EnvironmentId,
  projectId: string,
  repositoryKey: string,
  cwd: string,
  isRepresentative = false,
): ProjectCheckoutOption {
  return {
    key: `${environmentId}\0${projectId}`,
    environmentId,
    projectId: ProjectId.make(projectId),
    cwd,
    name: repositoryKey.split("/").pop() ?? repositoryKey,
    environmentLabel: NODES[environmentId]?.label ?? null,
    customAvatarContentHash: null,
    repositoryKey,
    isRepresentative,
  };
}

const OPTIONS = [
  option(MAC, "ryco-mac", "github.com/sak0a/ryco", "/Users/me/Code/ryco", true),
  option(MINI, "ryco-mini", "github.com/sak0a/ryco", "/Users/me/dev/ryco"),
  option(MAC, "hub-mac", "github.com/sak0a/ryco-hub", "/Users/me/Code/ryco-hub", true),
  option(MINI, "homelab-mini", "homelab", "/opt/homelab", true),
  option(PC, "homelab-pc", "homelab", "C:\\Code\\homelab"),
];

function buildProjects() {
  return buildProjectSelectorProjects({
    options: OPTIONS,
    resolveNode: (entry) => NODES[entry.environmentId] ?? null,
    unavailableReason: (node) => checkoutUnavailableReason({ node, canMutate: undefined }),
  });
}

function itemsOf(rows: ReadonlyArray<ProjectSelectorRow>): string[] {
  return rows.map((row) =>
    row.kind === "no-project"
      ? "no-project"
      : row.kind === "project"
        ? `project:${row.project.name}`
        : `checkout:${row.checkout.node.label}`,
  );
}

const ACTIVE = { environmentId: MAC, projectId: ProjectId.make("ryco-mac") };

describe("buildProjectSelectorProjects", () => {
  it("groups checkouts of one repository into one project, keeping their order", () => {
    const projects = buildProjects();
    expect(projects.map((project) => project.name)).toEqual(["ryco", "ryco-hub", "homelab"]);
    expect(projects[0]?.checkouts.map((checkout) => checkout.node.label)).toEqual([
      "MacBook Pro",
      "Mac mini",
    ]);
    expect(projects[0]?.checkouts[0]?.path).toBe("~/Code/ryco");
    expect(projects[2]?.checkouts[1]).toMatchObject({
      path: "C:\\Code\\homelab",
      unavailableReason: "Gaming PC is offline",
    });
  });

  it("leaves out checkouts on nodes the caller does not list", () => {
    const projects = buildProjectSelectorProjects({
      options: OPTIONS,
      resolveNode: (entry) => (entry.environmentId === PC ? null : NODES[entry.environmentId]!),
      unavailableReason: () => null,
    });
    expect(projects[2]?.checkouts.map((checkout) => checkout.environmentId)).toEqual([MINI]);
  });
});

describe("parseProjectSelectorQuery", () => {
  const nodes = Object.values(NODES);

  it("splits an @node token from the text by id or compacted label prefix", () => {
    expect(parseProjectSelectorQuery("@macm ryco", nodes)).toEqual({ text: "ryco", node: MINI });
    expect(parseProjectSelectorQuery("ryco @env-pc", nodes)).toEqual({ text: "ryco", node: PC });
    expect(parseProjectSelectorQuery("@gamingpc", nodes)).toEqual({ text: "", node: PC });
  });

  it("names no node for an unknown token and ignores a lone @", () => {
    expect(parseProjectSelectorQuery("@nowhere", nodes)).toEqual({ text: "", node: "none" });
    expect(parseProjectSelectorQuery("@ /srv", nodes)).toEqual({ text: "/srv", node: null });
  });

  it("drops tokens when a chip replaces them", () => {
    expect(stripNodeTokens("@mini ryco")).toBe("ryco");
  });
});

describe("buildProjectSelectorRows", () => {
  const projects = buildProjects();

  it("leads with No project and expands the projects it is told to", () => {
    const rows = buildProjectSelectorRows({
      projects,
      text: "",
      nodeFilter: null,
      expanded: new Set(["github.com/sak0a/ryco"]),
      active: ACTIVE,
      showNoProject: true,
    });
    expect(itemsOf(rows)).toEqual([
      "no-project",
      "project:ryco",
      "checkout:MacBook Pro",
      "checkout:Mac mini",
      "project:ryco-hub",
      "project:homelab",
    ]);
    expect(rows[0]?.item).toBe(NO_PROJECT_ITEM);
    const ryco = rows[1] as Extract<ProjectSelectorRow, { kind: "project" }>;
    expect(ryco).toMatchObject({ current: true, expandable: true, nodeCount: 2 });
    expect(projectRowSubline(ryco)).toEqual({ lead: "2 nodes · ", path: "~/Code/ryco" });
    expect(rows[2]).toMatchObject({ kind: "checkout", current: true });
    expect(rows[3]).toMatchObject({ kind: "checkout", current: false });
    const hub = rows[4] as Extract<ProjectSelectorRow, { kind: "project" }>;
    expect(projectRowSubline(hub)).toEqual({ lead: "MacBook Pro · ", path: "~/Code/ryco-hub" });
  });

  it("matches paths, expanding the project so the matching checkout shows", () => {
    const rows = buildProjectSelectorRows({
      projects,
      text: "/opt",
      nodeFilter: null,
      expanded: new Set(),
      active: ACTIVE,
      showNoProject: true,
    });
    expect(itemsOf(rows)).toEqual(["project:homelab", "checkout:Mac mini", "checkout:Gaming PC"]);
  });

  it("matches names case-insensitively without expanding", () => {
    const rows = buildProjectSelectorRows({
      projects,
      text: "HUB",
      nodeFilter: null,
      expanded: new Set(),
      active: ACTIVE,
      showNoProject: true,
    });
    expect(itemsOf(rows)).toEqual(["project:ryco-hub"]);
  });

  it("narrows to one node's checkouts and hides No project", () => {
    const rows = buildProjectSelectorRows({
      projects,
      text: "",
      nodeFilter: MINI,
      expanded: new Set(["github.com/sak0a/ryco"]),
      active: ACTIVE,
      showNoProject: true,
    });
    expect(itemsOf(rows)).toEqual(["project:ryco", "project:homelab"]);
    const ryco = rows[0] as Extract<ProjectSelectorRow, { kind: "project" }>;
    // Filtered to one checkout: nothing to expand, and the row moves to the Mac mini.
    expect(ryco).toMatchObject({ expandable: false, expanded: false });
    expect(ryco.preferred.environmentId).toBe(MINI);
    expect(projectRowSubline(ryco)).toEqual({ lead: "Mac mini · ", path: "~/dev/ryco" });
    expect(
      buildProjectSelectorRows({
        projects,
        text: "",
        nodeFilter: "none",
        expanded: new Set(),
        active: ACTIVE,
        showNoProject: true,
      }),
    ).toEqual([]);
  });

  it("prefers a reachable checkout when the draft is elsewhere", () => {
    const rows = buildProjectSelectorRows({
      projects,
      text: "homelab",
      nodeFilter: null,
      expanded: new Set(),
      active: ACTIVE,
      showNoProject: false,
    });
    const homelab = rows[0] as Extract<ProjectSelectorRow, { kind: "project" }>;
    expect(homelab.preferred.environmentId).toBe(MINI);
    expect(homelab.current).toBe(false);
  });

  it("keeps the No project row searchable by its own words", () => {
    const rows = buildProjectSelectorRows({
      projects,
      text: "chat",
      nodeFilter: null,
      expanded: new Set(),
      active: null,
      showNoProject: true,
    });
    expect(itemsOf(rows)).toEqual(["no-project"]);
  });
});

describe("countProjectsByNode", () => {
  it("counts projects per node once each", () => {
    const counts = countProjectsByNode(buildProjects());
    expect(Object.fromEntries(counts)).toEqual({ [MAC]: 2, [MINI]: 2, [PC]: 1 });
  });
});

describe("checkoutUnavailableReason", () => {
  it("blocks offline nodes and nodes the Hub will not let this client use", () => {
    expect(checkoutUnavailableReason({ node: NODES[PC]!, canMutate: undefined })).toBe(
      "Gaming PC is offline",
    );
    expect(
      checkoutUnavailableReason({
        node: NODES[MINI]!,
        canMutate: false,
        mutateBlockedReason: "Verify Mac mini first",
      }),
    ).toBe("Verify Mac mini first");
    expect(checkoutUnavailableReason({ node: NODES[MINI]!, canMutate: false })).toBe(
      "You can't start threads on Mac mini",
    );
    expect(checkoutUnavailableReason({ node: NODES[MINI]!, canMutate: true })).toBeNull();
  });
});

describe("checkoutStatusMeta", () => {
  const status = {
    refName: "task/copy",
    workingTree: { files: [{}, {}] },
    behindCount: 3,
  };

  it("shows branch, changes and commits behind from a full status", () => {
    expect(checkoutStatusMeta(status, { view: "full", remoteKnown: true })).toEqual({
      branch: "task/copy",
      changed: 2,
      behind: 3,
    });
  });

  it("shows only the branch from a summary or before the remote is known", () => {
    expect(checkoutStatusMeta(status, { view: "summary", remoteKnown: false })).toEqual({
      branch: "task/copy",
      changed: null,
      behind: null,
    });
    expect(checkoutStatusMeta(status, { view: "full", remoteKnown: false })).toMatchObject({
      behind: null,
    });
    expect(checkoutStatusMeta(null, { view: "full", remoteKnown: true })).toBeNull();
  });
});
