import type { ProjectCopyOptionsPlan } from "@ryco/client-runtime/projectCopy";
import type { Project } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  changedFilesLabel,
  copyMembersOf,
  copyModeRows,
  copyStartLabel,
} from "./copyProjectScreenModel";

const MINI = "env-mini" as EnvironmentId;
const LAPTOP = "env-laptop" as EnvironmentId;

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

describe("copyMembersOf", () => {
  it("collects the project's checkouts on every machine, by repository", () => {
    const mini = project({ repositoryIdentity: identity("/Users/ada/code/notes") });
    const laptop = project({
      id: "project-notes-laptop" as ProjectId,
      environmentId: LAPTOP,
      cwd: "/home/ada/notes",
      repositoryIdentity: identity("/home/ada/notes"),
    });
    const other = project({ id: "project-other" as ProjectId, cwd: "/Users/ada/code/other" });
    expect(
      copyMembersOf([mini, laptop, other], { environmentId: MINI, projectId: mini.id }),
    ).toEqual([mini, laptop]);
  });

  it("is empty for an unknown project and for a chat's folder", () => {
    expect(copyMembersOf([], { environmentId: MINI, projectId: "x" as ProjectId })).toEqual([]);
    const chat = project({ kind: "chat" });
    expect(copyMembersOf([chat], { environmentId: MINI, projectId: chat.id })).toEqual([]);
  });
});

describe("copyModeRows", () => {
  const options = (overrides: Partial<ProjectCopyOptionsPlan["modes"]>) =>
    ({
      modes: {
        clone: {
          available: true,
          reason: null,
          remoteUrl: "https://github.com/ada/notes.git",
          reachable: null,
          reachabilityDetail: null,
        },
        sendFiles: { available: true, reason: null, estimatedBytes: 0 },
        link: { available: false, reason: null },
        ...overrides,
      },
      choices: { mode: "clone" },
    }) as unknown as ProjectCopyOptionsPlan;

  it("offers clone and send-files, with link only where a checkout is", () => {
    expect(copyModeRows(options({})).map((row) => row.mode)).toEqual(["clone", "send-files"]);
    expect(
      copyModeRows(options({ link: { available: true, reason: null } })).map((row) => row.mode),
    ).toEqual(["clone", "send-files", "link"]);
  });

  it("says why clone can't run", () => {
    const [clone] = copyModeRows(
      options({
        clone: {
          available: false,
          reason: "No remote to clone from.",
          remoteUrl: null,
          reachable: null,
          reachabilityDetail: null,
        },
      }),
    );
    expect(clone).toMatchObject({ available: false, detail: "No remote to clone from." });
  });
});

describe("labels", () => {
  it("words the start button and changed files", () => {
    expect(copyStartLabel("clone", "Laptop")).toBe("Copy to Laptop");
    expect(copyStartLabel("link", "Laptop")).toBe("Link on Laptop");
    expect(changedFilesLabel(0)).toBe("No changes");
    expect(changedFilesLabel(1)).toBe("1 changed file");
    expect(changedFilesLabel(3)).toBe("3 changed files");
  });
});
