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
  projectSelectorParentIndex,
  projectSelectorValue,
  scoreProjectSelectorMatch,
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

  it("shows paths under a node's known home directory", () => {
    const projects = buildProjectSelectorProjects({
      options: [option(PC, "notes-pc", "notes", "/root/code/notes", true)],
      resolveNode: (entry) => NODES[entry.environmentId] ?? null,
      unavailableReason: () => null,
      homeDirectoryOf: (environmentId) => (environmentId === PC ? "/root" : null),
    });
    expect(projects[0]?.checkouts[0]?.path).toBe("~/code/notes");
    const unknown = buildProjectSelectorProjects({
      options: [option(PC, "notes-pc", "notes", "/root/code/notes", true)],
      resolveNode: (entry) => NODES[entry.environmentId] ?? null,
      unavailableReason: () => null,
    });
    expect(unknown[0]?.checkouts[0]?.path).toBe("/root/code/notes");
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

  it("ranks the best match first and finds names by their letters", () => {
    const rank = (text: string, active: typeof ACTIVE | null = null) =>
      itemsOf(
        buildProjectSelectorRows({
          projects,
          text,
          nodeFilter: null,
          expanded: new Set(),
          active,
          showNoProject: false,
        }),
      );
    // "hub" starts a word of ryco-hub's name.
    expect(rank("hub")).toEqual(["project:ryco-hub"]);
    // An exact name beats a prefix of a longer one, whatever the sidebar's order.
    expect(rank("homelab")).toEqual(["project:homelab"]);
    expect(rank("ryco")).toEqual(["project:ryco", "project:ryco-hub"]);
    // Letters in order, with gaps: "rhub" finds ryco-hub.
    expect(rank("rhub")).toEqual(["project:ryco-hub"]);
    // Every word must match: the name or a path.
    expect(rank("ryco hub")).toEqual(["project:ryco-hub"]);
    expect(rank("ryco dev")).toEqual(["project:ryco", "checkout:MacBook Pro", "checkout:Mac mini"]);
  });

  it("boosts the draft's own project over an equally good match", () => {
    const hubDraft = { environmentId: MAC, projectId: ProjectId.make("hub-mac") };
    const rows = buildProjectSelectorRows({
      projects,
      text: "ryco",
      nodeFilter: null,
      expanded: new Set(),
      active: hubDraft,
      showNoProject: false,
    });
    // ryco-hub only starts with "ryco"; the boost puts the draft's project first.
    expect(itemsOf(rows)).toEqual(["project:ryco-hub", "project:ryco"]);
    expect(rows[0]).toMatchObject({ current: true });
  });

  it("scores names, paths and misses", () => {
    const [ryco] = projects;
    expect(scoreProjectSelectorMatch(ryco!, ryco!.checkouts, "")).toEqual({
      score: 0,
      pathHit: false,
    });
    expect(scoreProjectSelectorMatch(ryco!, ryco!.checkouts, "RYCO")).toMatchObject({
      score: 0,
      pathHit: false,
    });
    expect(scoreProjectSelectorMatch(ryco!, ryco!.checkouts, "~/dev")).toMatchObject({
      pathHit: true,
    });
    expect(scoreProjectSelectorMatch(ryco!, ryco!.checkouts, "zzz")).toBeNull();
  });
});

describe("projectSelectorValue", () => {
  const projects = buildProjects();
  const rowsFor = (input: {
    readonly expanded: ReadonlyArray<string>;
    readonly active: typeof ACTIVE | null;
    readonly text?: string;
  }) =>
    buildProjectSelectorRows({
      projects,
      text: input.text ?? "",
      nodeFilter: null,
      expanded: new Set(input.expanded),
      active: input.active,
      showNoProject: true,
    });

  it("is the draft's checkout row while its project is expanded, else its project row", () => {
    const expanded = rowsFor({ expanded: ["github.com/sak0a/ryco"], active: ACTIVE });
    expect(projectSelectorValue(expanded, false)).toBe(expanded[2]?.item);
    expect(expanded[2]).toMatchObject({ kind: "checkout", current: true });

    const folded = rowsFor({ expanded: [], active: ACTIVE });
    expect(projectSelectorValue(folded, false)).toBe(folded[1]?.item);
    expect(folded[1]).toMatchObject({ kind: "project", current: true });

    // A project with one checkout is never expanded: its row stands for the draft.
    const hub = { environmentId: MAC, projectId: ProjectId.make("hub-mac") };
    const hubRows = rowsFor({ expanded: [], active: hub });
    expect(projectSelectorValue(hubRows, false)).toBe(
      hubRows.find((row) => row.kind === "project" && row.project.name === "ryco-hub")?.item,
    );
  });

  it("is No project for a chat draft and nothing when the draft's row is filtered out", () => {
    expect(projectSelectorValue(rowsFor({ expanded: [], active: null }), true)).toBe(
      NO_PROJECT_ITEM,
    );
    expect(
      projectSelectorValue(rowsFor({ expanded: [], active: ACTIVE, text: "hub" }), false),
    ).toBe(null);
  });
});

describe("projectSelectorParentIndex", () => {
  it("finds a checkout row's project row, and a project row itself", () => {
    const rows = buildProjectSelectorRows({
      projects: buildProjects(),
      text: "",
      nodeFilter: null,
      expanded: new Set(["github.com/sak0a/ryco", "homelab"]),
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
      "checkout:Mac mini",
      "checkout:Gaming PC",
    ]);
    expect(projectSelectorParentIndex(rows, 3)).toBe(1);
    expect(projectSelectorParentIndex(rows, 7)).toBe(5);
    expect(projectSelectorParentIndex(rows, 4)).toBe(4);
    expect(projectSelectorParentIndex(rows, 0)).toBeNull();
    expect(projectSelectorParentIndex(rows, 99)).toBeNull();
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
