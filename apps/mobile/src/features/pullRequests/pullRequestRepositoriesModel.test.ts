import type { EnvironmentId, ProjectId, RepositoryIdentity } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  derivePullRequestRepositoryChoices,
  pullRequestMachineIds,
  pullRequestRepositoryMachineNote,
  resolvePullRequestRepositoryChoice,
  type PullRequestRepositoryProject,
} from "./pullRequestRepositoriesModel";

const MAC = "env-mac" as EnvironmentId;
const MINI = "env-mini" as EnvironmentId;

function identity(key: string, rootPath?: string): RepositoryIdentity {
  const [, owner, name] = key.split("/");
  return {
    canonicalKey: key,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${key}.git` },
    ...(rootPath !== undefined ? { rootPath } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(name !== undefined ? { name } : {}),
    provider: "github",
    remotes: [],
  };
}

function project(
  id: string,
  environmentId: EnvironmentId,
  cwd: string,
  repository: RepositoryIdentity | null,
  extra: Partial<PullRequestRepositoryProject> = {},
): PullRequestRepositoryProject {
  return {
    id: id as ProjectId,
    environmentId,
    name: id,
    cwd,
    repositoryIdentity: repository,
    ...extra,
  };
}

describe("derivePullRequestRepositoryChoices", () => {
  const labels = new Map([
    [MAC, "MacBook"],
    [MINI, "Mac mini"],
  ]);

  it("lists each repository once, read through the best checkout", () => {
    const choices = derivePullRequestRepositoryChoices({
      projects: [
        project("worktree", MAC, "/w/app-feature", identity("github.com/acme/app", "/w/app")),
        project("root", MAC, "/w/app", identity("github.com/acme/app", "/w/app")),
        project("mini", MINI, "/x/app", identity("github.com/acme/app", "/x/app")),
        project("tools", MINI, "/x/tools", identity("github.com/acme/tools")),
        project("plain", MAC, "/w/notes", null),
        project("chat", MAC, "/w/chat", identity("github.com/acme/chat"), { kind: "chat" }),
      ],
      connected: new Set([MAC]),
      acting: new Set([MAC]),
      environmentLabels: labels,
    });
    expect(choices.map((choice) => [choice.label, choice.projectId, choice.checkouts])).toEqual([
      ["acme/app", "root", 3],
      ["acme/tools", "tools", 1],
    ]);
    expect(choices[0]).toMatchObject({ environmentLabel: "MacBook", connected: true });
    expect(choices[1]).toMatchObject({ environmentLabel: "Mac mini", connected: false });
  });

  it("prefers a connected machine's checkout over the repository root", () => {
    const [choice] = derivePullRequestRepositoryChoices({
      projects: [
        project("root", MAC, "/w/app", identity("github.com/acme/app", "/w/app")),
        project("mini", MINI, "/x/app-worktree", identity("github.com/acme/app", "/x/app")),
      ],
      connected: new Set([MINI]),
      acting: new Set([MINI]),
      environmentLabels: labels,
    });
    expect(choice?.projectId).toBe("mini");
  });

  it("prefers a machine that can act over a read-only one", () => {
    const [choice] = derivePullRequestRepositoryChoices({
      projects: [
        project("root", MAC, "/w/app", identity("github.com/acme/app", "/w/app")),
        project("mini", MINI, "/x/app-worktree", identity("github.com/acme/app", "/x/app")),
      ],
      connected: new Set([MAC, MINI]),
      acting: new Set([MINI]),
      environmentLabels: labels,
    });
    expect(choice).toMatchObject({ projectId: "mini", canAct: true, machines: 2 });
    expect(choice && pullRequestRepositoryMachineNote(choice, 2)).toBe("Mac mini");
  });
});

describe("pullRequestMachineIds", () => {
  it("lists the machines with a checkout of a repository that has a remote", () => {
    const ids = pullRequestMachineIds([
      project("plain", MAC, "/w/notes", null),
      project("chat", MAC, "/w/chat", identity("github.com/acme/chat"), { kind: "chat" }),
      project("tools", MINI, "/x/tools", identity("github.com/acme/tools")),
    ]);
    expect([...ids]).toEqual([MINI]);
  });
});

describe("pullRequestRepositoryMachineNote", () => {
  const labels = new Map([[MAC, "MacBook"]]);
  const read = (acting: ReadonlySet<EnvironmentId>) =>
    derivePullRequestRepositoryChoices({
      projects: [project("root", MAC, "/w/app", identity("github.com/acme/app", "/w/app"))],
      connected: new Set([MAC]),
      acting,
      environmentLabels: labels,
    })[0]!;

  it("names the machine only when another could be meant, and says read only", () => {
    expect(pullRequestRepositoryMachineNote(read(new Set([MAC])), 1)).toBeNull();
    expect(pullRequestRepositoryMachineNote(read(new Set([MAC])), 2)).toBe("MacBook");
    expect(pullRequestRepositoryMachineNote(read(new Set()), 1)).toBe("MacBook · read only");
  });
});

describe("resolvePullRequestRepositoryChoice", () => {
  const choices = derivePullRequestRepositoryChoices({
    projects: [
      project("a", MAC, "/a", identity("github.com/acme/a")),
      project("b", MINI, "/b", identity("github.com/acme/b")),
    ],
    connected: new Set([MINI]),
    acting: new Set(),
    environmentLabels: new Map(),
  });

  it("keeps the saved repository, else the first connected one", () => {
    expect(resolvePullRequestRepositoryChoice(choices, "github.com/acme/a")?.projectId).toBe("a");
    expect(resolvePullRequestRepositoryChoice(choices, "github.com/gone/x")?.projectId).toBe("b");
    expect(resolvePullRequestRepositoryChoice(choices, null)?.projectId).toBe("b");
    expect(resolvePullRequestRepositoryChoice([], null)).toBeNull();
  });

  it("prefers a repository whose machine can act", () => {
    const both = derivePullRequestRepositoryChoices({
      projects: [
        project("a", MAC, "/a", identity("github.com/acme/a")),
        project("b", MINI, "/b", identity("github.com/acme/b")),
      ],
      connected: new Set([MAC, MINI]),
      acting: new Set([MINI]),
      environmentLabels: new Map(),
    });
    expect(resolvePullRequestRepositoryChoice(both, null)?.projectId).toBe("b");
  });
});
