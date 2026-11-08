import type { EnvironmentId, ProjectId, RepositoryIdentity } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  derivePullRequestRepositoryChoices,
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
      environmentLabels: labels,
    });
    expect(choice?.projectId).toBe("mini");
  });
});

describe("resolvePullRequestRepositoryChoice", () => {
  const choices = derivePullRequestRepositoryChoices({
    projects: [
      project("a", MAC, "/a", identity("github.com/acme/a")),
      project("b", MINI, "/b", identity("github.com/acme/b")),
    ],
    connected: new Set([MINI]),
    environmentLabels: new Map(),
  });

  it("keeps the saved repository, else the first connected one", () => {
    expect(resolvePullRequestRepositoryChoice(choices, "github.com/acme/a")?.projectId).toBe("a");
    expect(resolvePullRequestRepositoryChoice(choices, "github.com/gone/x")?.projectId).toBe("b");
    expect(resolvePullRequestRepositoryChoice(choices, null)?.projectId).toBe("b");
    expect(resolvePullRequestRepositoryChoice([], null)).toBeNull();
  });
});
