import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { ProjectImportId, type ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "../../types";
import {
  addedProjectLead,
  addProjectPrimaryLabel,
  addProjectStepLabels,
  buildAddedProjectNodeRows,
  buildCloneImportInput,
  buildCloneSourceChips,
  buildCopySources,
  buildLinkImportInput,
  buildRepositorySuggestions,
  cloneFolderName,
  describeCloneDestination,
  describeFolderJoin,
  detectCloneSourceFromUrl,
  findRepositoryJoin,
  importOverallPercent,
  importProgressSteps,
  isGitRemoteUrlInput,
  resolveAddProjectStart,
  splitRepositoryLabel,
} from "./addProjectDialog.logic";
import type { AddProjectRemoteSourceReadiness } from "./addProjectSources";
import { describeFolderSelection, type FolderSelectionStatus } from "./folderPicker.logic";
import { fakeNodeEntry } from "./projectNodesTestFixtures";

const LAPTOP = EnvironmentId.make("env-laptop");
const MINI = EnvironmentId.make("env-mini");
const BUILD = EnvironmentId.make("env-build");
const PC = EnvironmentId.make("env-pc");

const NODES = [
  fakeNodeEntry({ environmentId: LAPTOP, label: "MacBook Pro", isPrimary: true }),
  fakeNodeEntry({ environmentId: MINI, label: "Mac mini" }),
  fakeNodeEntry({
    environmentId: BUILD,
    label: "hetzner-build",
    canMutate: false,
    mutateBlockedReason: "Pair hetzner-build again as its owner",
  }),
  fakeNodeEntry({ environmentId: PC, label: "Gaming PC", presence: "offline" }),
];

function project(overrides: Partial<Project> & Pick<Project, "id" | "environmentId">): Project {
  return {
    name: "ryco",
    cwd: "/Users/me/Code/ryco",
    defaultModelSelection: null,
    scripts: [],
    ...overrides,
  };
}

function identity(canonicalKey: string, remoteUrl: string, owner = "sak0a", name = "ryco") {
  return {
    canonicalKey,
    locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl },
    owner,
    name,
    remotes: [],
  };
}

const RYCO_LAPTOP = project({
  id: ProjectId.make("p-ryco-laptop"),
  environmentId: LAPTOP,
  repositoryIdentity: identity("github.com/sak0a/ryco", "git@github.com:sak0a/ryco.git"),
});
const RYCO_MINI = project({
  id: ProjectId.make("p-ryco-mini"),
  environmentId: MINI,
  cwd: "/Users/me/dev/ryco",
  repositoryIdentity: identity("github.com/sak0a/ryco", "https://github.com/sak0a/ryco.git"),
});
const HUB_LAPTOP = project({
  id: ProjectId.make("p-hub"),
  environmentId: LAPTOP,
  name: "ryco-hub",
  cwd: "/Users/me/Code/ryco-hub",
  repositoryIdentity: identity(
    "github.com/sak0a/ryco-hub",
    "https://token@github.com/sak0a/ryco-hub.git",
    "sak0a",
    "ryco-hub",
  ),
});
const LOCAL_ONLY = project({
  id: ProjectId.make("p-local"),
  environmentId: LAPTOP,
  name: "scratch",
  cwd: "/Users/me/scratch",
  repositoryIdentity: identity("/users/me/scratch", "/Users/me/scratch", "me", "scratch"),
});
const CHAT = project({
  id: ProjectId.make("p-chat"),
  environmentId: MINI,
  kind: "chat",
  name: "chat",
  cwd: "/Users/me/Chats/chat",
  repositoryIdentity: identity("github.com/sak0a/ryco-hub", "git@github.com:sak0a/ryco-hub.git"),
});

function folderStatus(
  overrides: Partial<Parameters<typeof describeFolderSelection>[0]>,
): FolderSelectionStatus {
  return describeFolderSelection({
    mode: "parent",
    nodeLabel: "Mac mini",
    homeDirectory: "/Users/me",
    selectedPath: "/Users/me/Code",
    destinationPath: "/Users/me/Code/ryco-hub",
    supportsPreview: true,
    preview: {
      resolvedPath: "/Users/me/Code/ryco-hub",
      state: "available",
      existingProjectId: null,
      existingRepositoryCanonicalKey: null,
      suggestedPath: null,
      detail: null,
    },
    previewError: null,
    existingProject: null,
    isGitRepository: null,
    gitBranch: null,
    ...overrides,
  });
}

describe("resolveAddProjectStart", () => {
  it("starts on the node step when several nodes can take projects", () => {
    expect(resolveAddProjectStart({ request: null, nodes: NODES, linkAvailable: false })).toEqual({
      nodeId: null,
      step: 0,
      kind: null,
    });
  });

  it("skips the node step for a given node, keeping the requested source", () => {
    expect(
      resolveAddProjectStart({
        request: { environmentId: MINI, mode: "clone", projectRef: null },
        nodes: NODES,
        linkAvailable: false,
      }),
    ).toEqual({ nodeId: MINI, step: 1, kind: "clone" });
    expect(
      resolveAddProjectStart({
        request: { environmentId: MINI, mode: "folder", projectRef: null },
        nodes: NODES,
        linkAvailable: false,
      }),
    ).toEqual({ nodeId: MINI, step: 2, kind: "folder" });
  });

  it("preselects the node on screen, else the last used one, and opens on the sources", () => {
    expect(
      resolveAddProjectStart({
        request: null,
        nodes: NODES,
        linkAvailable: false,
        contextNodeId: MINI,
        lastUsed: { nodeId: LAPTOP, kind: "clone" },
      }),
    ).toEqual({ nodeId: MINI, step: 1, kind: "clone" });
    expect(
      resolveAddProjectStart({
        request: null,
        nodes: NODES,
        linkAvailable: false,
        contextNodeId: null,
        lastUsed: { nodeId: LAPTOP, kind: "folder" },
      }),
    ).toEqual({ nodeId: LAPTOP, step: 1, kind: "folder" });
    // A remembered source never skips the Source step; a requested one still does.
    expect(
      resolveAddProjectStart({
        request: { environmentId: null, mode: "folder", projectRef: null },
        nodes: NODES,
        linkAvailable: false,
        contextNodeId: MINI,
        lastUsed: { nodeId: LAPTOP, kind: "clone" },
      }),
    ).toEqual({ nodeId: MINI, step: 2, kind: "folder" });
  });

  it("skips context and memory that can't take projects", () => {
    expect(
      resolveAddProjectStart({
        request: null,
        nodes: NODES,
        linkAvailable: false,
        contextNodeId: PC,
        lastUsed: { nodeId: BUILD, kind: "copy" },
      }),
    ).toEqual({ nodeId: null, step: 0, kind: null });
    expect(
      resolveAddProjectStart({
        request: null,
        nodes: NODES,
        linkAvailable: false,
        contextNodeId: BUILD,
        lastUsed: { nodeId: MINI, kind: null },
      }),
    ).toEqual({ nodeId: MINI, step: 1, kind: null });
  });

  it("keeps a named node over context and memory, and picks no node for a link", () => {
    expect(
      resolveAddProjectStart({
        request: { environmentId: BUILD, mode: null, projectRef: null },
        nodes: NODES,
        linkAvailable: false,
        contextNodeId: MINI,
        lastUsed: { nodeId: LAPTOP, kind: "clone" },
      }),
    ).toEqual({ nodeId: null, step: 0, kind: null });
    expect(
      resolveAddProjectStart({
        request: {
          environmentId: null,
          mode: "link",
          projectRef: { environmentId: LAPTOP, projectId: RYCO_LAPTOP.id },
        },
        nodes: NODES,
        linkAvailable: true,
        contextNodeId: LAPTOP,
        lastUsed: { nodeId: MINI, kind: "clone" },
      }),
    ).toEqual({ nodeId: null, step: 0, kind: "link" });
  });

  it("skips the node step when only one node can take projects", () => {
    const nodes = NODES.filter((node) => node.environmentId !== MINI);
    expect(resolveAddProjectStart({ request: null, nodes, linkAvailable: false })).toEqual({
      nodeId: LAPTOP,
      step: 1,
      kind: null,
    });
  });

  it("does not skip to a node that is offline or can't take projects", () => {
    expect(
      resolveAddProjectStart({
        request: { environmentId: BUILD, mode: null, projectRef: null },
        nodes: NODES,
        linkAvailable: false,
      }),
    ).toMatchObject({ nodeId: null, step: 0 });
  });

  it("links only when the project to link is known", () => {
    const request = {
      environmentId: MINI,
      mode: "link" as const,
      projectRef: { environmentId: LAPTOP, projectId: RYCO_LAPTOP.id },
    };
    expect(resolveAddProjectStart({ request, nodes: NODES, linkAvailable: true })).toEqual({
      nodeId: MINI,
      step: 2,
      kind: "link",
    });
    expect(resolveAddProjectStart({ request, nodes: NODES, linkAvailable: false })).toEqual({
      nodeId: MINI,
      step: 1,
      kind: null,
    });
  });
});

describe("labels", () => {
  it("names the steps after the node and the source once they are chosen", () => {
    expect(addProjectStepLabels({ nodeLabel: null, kind: null, step: 0 })).toEqual([
      "Node",
      "Source",
      "Folder",
    ]);
    expect(addProjectStepLabels({ nodeLabel: "Mac mini", kind: "clone", step: 2 })).toEqual([
      "Mac mini",
      "Clone",
      "Where to clone",
    ]);
    expect(addProjectStepLabels({ nodeLabel: "Mac mini", kind: "folder", step: 2 })).toEqual([
      "Mac mini",
      "Open folder",
      "Folder",
    ]);
  });

  it("words the primary button by source and selection", () => {
    const existing = describeFolderSelection({
      mode: "folder",
      nodeLabel: "Mac mini",
      homeDirectory: null,
      selectedPath: "/Users/me/Code/ryco",
      destinationPath: "/Users/me/Code/ryco",
      supportsPreview: false,
      preview: null,
      previewError: null,
      existingProject: { name: "ryco" },
      isGitRepository: true,
      gitBranch: "main",
    });
    expect(addProjectPrimaryLabel({ kind: "folder", nodeLabel: "Mac mini", status: null })).toBe(
      "Add project",
    );
    expect(
      addProjectPrimaryLabel({ kind: "folder", nodeLabel: "Mac mini", status: existing }),
    ).toBe("Already a project");
    expect(addProjectPrimaryLabel({ kind: "clone", nodeLabel: "Mac mini", status: null })).toBe(
      "Clone",
    );
    expect(
      addProjectPrimaryLabel({ kind: "clone", nodeLabel: "Mac mini", status: folderStatus({}) }),
    ).toBe("Clone to Mac mini");
  });
});

describe("status lines", () => {
  it("says where a clone goes, and refuses a folder that exists", () => {
    const available = describeCloneDestination(folderStatus({}), {
      remoteUrl: "git@github.com:sak0a/ryco-hub.git",
    });
    expect(available).toMatchObject({
      kind: "clone-destination",
      usable: true,
      text: "Clones github.com/sak0a/ryco-hub here",
    });

    const occupied = describeCloneDestination(
      folderStatus({
        preview: {
          resolvedPath: "/Users/me/Code/ryco-hub",
          state: "exists-not-empty",
          existingProjectId: null,
          existingRepositoryCanonicalKey: null,
          suggestedPath: "/Users/me/Code/ryco-hub-2",
          detail: null,
        },
      }),
      { remoteUrl: "https://github.com/sak0a/ryco-hub" },
    );
    expect(occupied).toMatchObject({
      tone: "caution",
      usable: false,
      suggestedPath: "/Users/me/Code/ryco-hub-2",
      text: "Clones github.com/sak0a/ryco-hub here, but that folder already exists",
    });
    expect(
      describeCloneDestination(folderStatus({ existingProject: { name: "ryco-hub" } }), {
        remoteUrl: "https://github.com/sak0a/ryco-hub",
      }),
    ).toMatchObject({ kind: "clone-destination", usable: false });
  });

  it("names the project a folder joins on other nodes", () => {
    const join = findRepositoryJoin({
      canonicalKey: "github.com/sak0a/ryco",
      nodeId: PC,
      projects: [RYCO_LAPTOP, RYCO_MINI],
      nodes: NODES,
    });
    expect(join).toEqual({ name: "ryco", nodeLabels: ["MacBook Pro", "Mac mini"] });
    const status = describeFolderSelection({
      mode: "folder",
      nodeLabel: "Gaming PC",
      homeDirectory: null,
      selectedPath: "C:\\Code\\ryco",
      destinationPath: "C:\\Code\\ryco",
      supportsPreview: false,
      preview: null,
      previewError: null,
      existingProject: null,
      isGitRepository: true,
      gitBranch: "main",
    });
    expect(describeFolderJoin(status, join).text).toBe(
      "Git repository on main · joins ryco from MacBook Pro, Mac mini",
    );
    expect(
      findRepositoryJoin({
        canonicalKey: "github.com/sak0a/ryco",
        nodeId: MINI,
        projects: [RYCO_MINI],
        nodes: NODES,
      }),
    ).toBeNull();
  });
});

describe("sources", () => {
  it("offers the user's cloneable repositories once each, marking the ones already here", () => {
    const suggestions = buildRepositorySuggestions({
      projects: [RYCO_LAPTOP, RYCO_MINI, HUB_LAPTOP, LOCAL_ONLY, CHAT],
      nodeId: MINI,
      nodes: NODES,
      query: "",
    });
    expect(suggestions).toEqual([
      {
        canonicalKey: "github.com/sak0a/ryco",
        label: "sak0a/ryco",
        remoteUrl: "git@github.com:sak0a/ryco.git",
        onThisNode: true,
        otherNodeIds: [LAPTOP],
      },
      {
        canonicalKey: "github.com/sak0a/ryco-hub",
        label: "sak0a/ryco-hub",
        // Credentials never travel to another node.
        remoteUrl: "https://github.com/sak0a/ryco-hub.git",
        onThisNode: false,
        otherNodeIds: [LAPTOP],
      },
    ]);
    expect(
      buildRepositorySuggestions({
        projects: [RYCO_LAPTOP, HUB_LAPTOP],
        nodeId: MINI,
        nodes: NODES,
        query: "HUB",
      }).map((suggestion) => suggestion.label),
    ).toEqual(["sak0a/ryco-hub"]);
  });

  it("tells URLs from owner/repo and names the clone's folder", () => {
    expect(isGitRemoteUrlInput("https://github.com/openai/codex")).toBe(true);
    expect(isGitRemoteUrlInput("git@github.com:openai/codex.git")).toBe(true);
    expect(isGitRemoteUrlInput("openai/codex")).toBe(false);
    expect(cloneFolderName("git@github.com:openai/codex.git", "openai/codex")).toBe("codex");
  });

  it("lists projects another online node has and this one lacks", () => {
    const groups = [
      { key: "ryco", name: "ryco", members: [RYCO_LAPTOP, RYCO_MINI] },
      { key: "hub", name: "ryco-hub", members: [HUB_LAPTOP] },
      {
        key: "pc-only",
        name: "homelab",
        members: [project({ id: ProjectId.make("p-lab"), environmentId: PC, name: "homelab" })],
      },
    ];
    expect(
      buildCopySources({
        groups,
        nodeId: MINI,
        isOnline: (environmentId) => environmentId !== PC,
      }).map((entry) => [entry.name, entry.source.environmentId]),
    ).toEqual([["ryco-hub", LAPTOP]]);
  });
});

describe("done", () => {
  it("lists every node the new checkout's repository is on, in node order", () => {
    const added = {
      ref: { environmentId: MINI, projectId: ProjectId.make("p-new") },
      name: "ryco-hub",
      cwd: "/Users/me/dev/ryco-hub",
      canonicalKey: "github.com/sak0a/ryco-hub",
    };
    expect(
      buildAddedProjectNodeRows({ added, projects: [HUB_LAPTOP, RYCO_MINI, CHAT], nodes: NODES }),
    ).toEqual([
      { environmentId: LAPTOP, cwd: "/Users/me/Code/ryco-hub", isNew: false },
      { environmentId: MINI, cwd: "/Users/me/dev/ryco-hub", isNew: true },
    ]);
    expect(addedProjectLead(["MacBook Pro"])).toBe(
      "Same repository as on MacBook Pro, so it shows up as one project on 2 nodes.",
    );
    expect(addedProjectLead([])).toBe("Ready for threads.");
  });
});

describe("imports", () => {
  const importId = ProjectImportId.make("4b8f8b4e-1f7a-4c1e-9a43-0c7d9a1b2c3d");
  const projectId = ProjectId.make("6a4c2d10-5b3e-4f7a-8c9d-0e1f2a3b4c5d");

  it("builds a plain clone import and refuses what the node would", () => {
    expect(
      buildCloneImportInput({
        importId,
        projectId,
        destinationPath: "/Users/me/Code/codex",
        remoteUrl: "git@github.com:openai/codex.git",
      }),
    ).toMatchObject({
      title: "codex",
      destinationPath: "/Users/me/Code/codex",
      source: { kind: "clone", remoteUrl: "git@github.com:openai/codex.git", remoteName: "origin" },
      // Nobody inspected the repository: the node checks for submodules and LFS files (A14).
      recurseSubmodules: true,
      usesLfs: true,
      settings: null,
      setup: null,
      followUpThread: null,
      origin: { kind: "user" },
    });
    expect(
      buildCloneImportInput({
        importId,
        projectId,
        destinationPath: "~/Code/codex",
        remoteUrl: "git@github.com:openai/codex.git",
      }),
    ).toBeNull();
    expect(
      buildCloneImportInput({
        importId,
        projectId,
        destinationPath: "/Users/me/Code/codex",
        remoteUrl: "https://me:secret@github.com/openai/codex.git",
      }),
    ).toBeNull();
  });

  it("links a checkout with the source's title, subfolder and settings", () => {
    const source = project({
      id: ProjectId.make("p-web"),
      environmentId: LAPTOP,
      name: "web",
      cwd: "/Users/me/Code/ryco/apps/web",
      projectMetadataDir: ".ryco",
      customSystemPrompt: "Be brief.",
      repositoryIdentity: {
        ...identity("github.com/sak0a/ryco", "git@github.com:sak0a/ryco.git"),
        rootPath: "/Users/me/Code/ryco",
      },
    });
    expect(
      buildLinkImportInput({ importId, projectId, destinationPath: "/home/me/ryco", source }),
    ).toMatchObject({
      title: "web",
      destinationPath: "/home/me/ryco",
      source: { kind: "existing-checkout", expectedCanonicalKey: "github.com/sak0a/ryco" },
      relativeRootInRepository: "apps/web",
      settings: { customSystemPrompt: "Be brief.", projectMetadataDir: ".ryco", scripts: [] },
    });
  });

  it("shows an import's steps and how far it got", () => {
    const snapshot: ProjectImportSnapshot = {
      importId,
      projectId,
      title: "codex",
      destinationPath: "/Users/me/Code/codex",
      status: "running",
      steps: [
        { id: "preflight", status: "done", progressPercent: null, detail: null },
        { id: "clone", status: "running", progressPercent: 50, detail: null },
        { id: "commits", status: "skipped", progressPercent: null, detail: null },
        { id: "register", status: "pending", progressPercent: null, detail: null },
      ],
      outputTail: "Cloning into 'codex'...\nReceiving objects:  50% (920/1840)\n",
      error: null,
      warnings: [],
      preflight: null,
      leftoverPath: null,
      followUpThreadId: null,
      origin: { kind: "user", sourceLabel: null, proposalId: null },
      createdAt: "2026-10-22T12:00:00.000Z",
      updatedAt: "2026-10-22T12:00:01.000Z",
    };
    expect(importProgressSteps(snapshot)).toEqual([
      {
        id: "preflight",
        label: [{ text: "Checking the destination" }],
        status: "done",
        percent: null,
        log: null,
        weight: 1,
      },
      {
        id: "clone",
        label: [{ text: "Cloning the repository" }],
        status: "running",
        percent: 50,
        log: "Receiving objects:  50% (920/1840)",
        weight: 1,
      },
      {
        id: "register",
        label: [{ text: "Adding the project" }],
        status: "pending",
        percent: null,
        log: null,
        weight: 1,
      },
    ]);
    expect(importOverallPercent(snapshot)).toBe(50);
    expect(importOverallPercent({ ...snapshot, status: "completed" })).toBe(100);
  });
});

describe("clone sources", () => {
  const READINESS: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: { ready: true, hint: null },
    gitlab: { ready: true, hint: null },
    forgejo: { ready: false, hint: "Install the Forgejo CLI." },
    bitbucket: { ready: false, hint: "Set Bitbucket API token environment variables." },
    "azure-devops": { ready: false, hint: "Install the Azure CLI." },
  };

  it("detects a URL's provider from its host", () => {
    expect(detectCloneSourceFromUrl("git@github.com:openai/codex.git")).toBe("github");
    expect(detectCloneSourceFromUrl("https://gitlab.example.com/team/app.git")).toBe("gitlab");
    expect(detectCloneSourceFromUrl("https://codeberg.org/forgejo/forgejo")).toBe("forgejo");
    expect(detectCloneSourceFromUrl("https://bitbucket.org/team/app.git")).toBe("bitbucket");
    expect(detectCloneSourceFromUrl("https://dev.azure.com/org/project/_git/app")).toBe(
      "azure-devops",
    );
    expect(detectCloneSourceFromUrl("ssh://git@git.internal:2222/app.git")).toBe("url");
  });

  it("lists every source in a fixed order and lights the one the field uses", () => {
    const chips = buildCloneSourceChips({
      readiness: READINESS,
      providerSource: "gitlab",
      typedUrl: null,
    });
    expect(chips.map((chip) => chip.source)).toEqual([
      "github",
      "gitlab",
      "forgejo",
      "bitbucket",
      "azure-devops",
      "url",
    ]);
    expect(chips.filter((chip) => chip.active).map((chip) => chip.source)).toEqual(["gitlab"]);
    // A provider the node can't use yet stays listed, with why.
    expect(chips.find((chip) => chip.source === "forgejo")).toMatchObject({
      label: "Forgejo",
      ready: false,
      hint: "Install the Forgejo CLI.",
      active: false,
    });
  });

  it("lights a typed URL's provider, ready or not, and Git URL for an unknown host", () => {
    const github = buildCloneSourceChips({
      readiness: READINESS,
      providerSource: "gitlab",
      typedUrl: "git@github.com:openai/codex.git",
    });
    expect(github.filter((chip) => chip.active)).toEqual([
      expect.objectContaining({ source: "github", detected: true }),
    ]);
    const bitbucket = buildCloneSourceChips({
      readiness: READINESS,
      providerSource: "github",
      typedUrl: "https://bitbucket.org/team/app.git",
    });
    expect(bitbucket.filter((chip) => chip.active)).toEqual([
      expect.objectContaining({ source: "bitbucket", detected: true, ready: false }),
    ]);
    const other = buildCloneSourceChips({
      readiness: READINESS,
      providerSource: "github",
      typedUrl: "ssh://git@git.internal/app.git",
    });
    expect(other.filter((chip) => chip.active)).toEqual([
      expect.objectContaining({ source: "url", detected: false }),
    ]);
  });

  it("splits a repository label into its owner and name", () => {
    expect(splitRepositoryLabel("sak0a/ryco")).toEqual({ owner: "sak0a", name: "ryco" });
    expect(splitRepositoryLabel("group/sub/app")).toEqual({ owner: "group/sub", name: "app" });
    expect(splitRepositoryLabel("ryco")).toEqual({ owner: null, name: "ryco" });
    expect(splitRepositoryLabel("ryco/")).toEqual({ owner: null, name: "ryco/" });
  });
});
