import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import type { Project } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  addProjectActionLabel,
  addProjectMachines,
  cloneDestinationPath,
  initialAddProjectMachine,
  otherMachineProjects,
} from "./addProjectModel";

const MINI = "env-mini" as EnvironmentId;
const LAPTOP = "env-laptop" as EnvironmentId;

function node(overrides: Partial<NodeCatalogEntry>): NodeCatalogEntry {
  return {
    environmentId: MINI,
    label: "Mac mini",
    isPrimary: false,
    isThisDevice: false,
    presence: "online",
    platformOs: "darwin",
    iconKind: null,
    canMutate: true,
    mutateBlockedReason: null,
    projectCopySupport: "yes",
    transport: "direct",
    lastSeenAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project>): Project {
  return {
    id: "project-notes" as ProjectId,
    environmentId: MINI,
    name: "notes",
    cwd: "/Users/ada/code/notes",
    defaultModelSelection: null,
    scripts: [],
    ...overrides,
  };
}

const identity = (root: string) => ({
  canonicalKey: "github.com/ada/notes",
  locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: "x" },
  rootPath: root,
});

describe("machines", () => {
  it("offers online machines open to changes and starts on the one asked for", () => {
    const machines = addProjectMachines([
      node({}),
      node({ environmentId: LAPTOP, label: "Laptop", presence: "offline" }),
      node({ environmentId: "env-viewer" as EnvironmentId, canMutate: false }),
    ]);
    expect(machines.map((entry) => entry.environmentId)).toEqual([MINI]);
    expect(initialAddProjectMachine(machines, MINI)).toBe(MINI);
    expect(initialAddProjectMachine(machines, LAPTOP)).toBe(MINI);
    expect(initialAddProjectMachine([], null)).toBeNull();
  });
});

describe("otherMachineProjects", () => {
  it("lists projects the target lacks, once per repository, without chats", () => {
    const notesOnLaptop = project({
      id: "notes-laptop" as ProjectId,
      environmentId: LAPTOP,
      cwd: "/home/ada/notes",
      repositoryIdentity: identity("/home/ada/notes"),
    });
    const blogOnLaptop = project({
      id: "blog" as ProjectId,
      environmentId: LAPTOP,
      name: "blog",
      cwd: "/home/ada/blog",
    });
    const chat = project({ id: "chat" as ProjectId, environmentId: LAPTOP, kind: "chat" });
    const notesOnMini = project({ repositoryIdentity: identity("/Users/ada/code/notes") });
    const rows = otherMachineProjects({
      projects: [notesOnMini, notesOnLaptop, blogOnLaptop, chat],
      target: MINI,
      labelOf: (environmentId) => (environmentId === LAPTOP ? "Laptop" : null),
    });
    expect(rows.map((row) => row.project.id)).toEqual(["blog"]);
    expect(rows[0]?.machineLabel).toBe("Laptop");
  });
});

describe("cloneDestinationPath", () => {
  it("joins with the parent's separator", () => {
    expect(cloneDestinationPath("/Users/ada/Code", "notes")).toBe("/Users/ada/Code/notes");
    expect(cloneDestinationPath("/Users/ada/Code/", "notes")).toBe("/Users/ada/Code/notes");
    expect(cloneDestinationPath("C:\\Code", "notes")).toBe("C:\\Code\\notes");
  });

  it("words each source's action", () => {
    expect(addProjectActionLabel("clone", "Laptop")).toBe("Clone to Laptop");
    expect(addProjectActionLabel("link", "Laptop")).toBe("Link this folder");
  });
});
