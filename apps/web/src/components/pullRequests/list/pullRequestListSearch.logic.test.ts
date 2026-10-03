import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import type { PullRequestRepositoryOption } from "../pullRequestRepositories.logic";
import { parsePullRequestLinkTarget, resolvePullRequestLink } from "./pullRequestListSearch.logic";

function option(
  key: string,
  repositoryKey: string,
  isRepresentative = true,
): PullRequestRepositoryOption {
  return {
    key,
    environmentId: EnvironmentId.make(`env-${key}`),
    projectId: ProjectId.make(`project-${key}`),
    cwd: `/code/${key}`,
    name: key,
    environmentLabel: null,
    repositoryKey,
    isRepresentative,
  };
}

describe("parsePullRequestLinkTarget", () => {
  it("reads numbers with or without #", () => {
    expect(parsePullRequestLinkTarget("#123")).toEqual({ kind: "number", number: 123 });
    expect(parsePullRequestLinkTarget(" 42 ")).toEqual({ kind: "number", number: 42 });
  });

  it("reads host links with their repository", () => {
    expect(
      parsePullRequestLinkTarget("https://github.com/Ryco-Labs/ryco/pull/703/files#diff-1"),
    ).toEqual({
      kind: "url",
      number: 703,
      url: "https://github.com/Ryco-Labs/ryco/pull/703/files#diff-1",
      repositoryKey: "github.com/ryco-labs/ryco",
    });
    expect(
      parsePullRequestLinkTarget("https://gitlab.com/group/sub/app/-/merge_requests/9"),
    ).toMatchObject({ kind: "url", number: 9, repositoryKey: "gitlab.com/group/sub/app" });
  });

  it("leaves search text alone", () => {
    expect(parsePullRequestLinkTarget("stack rail")).toBeNull();
    expect(parsePullRequestLinkTarget("#12a")).toBeNull();
    expect(parsePullRequestLinkTarget("")).toBeNull();
  });
});

describe("resolvePullRequestLink", () => {
  const current = option("ryco", "github.com/ryco-labs/ryco");
  const other = option("hub", "github.com/ryco-labs/hub");
  const otherCheckout = option("hub-remote", "github.com/ryco-labs/hub", false);
  const repositories = [current, otherCheckout, other];
  const link = (url: string) => {
    const target = parsePullRequestLinkTarget(url);
    if (target === null) throw new Error(`not a link: ${url}`);
    return target;
  };

  it("opens numbers in the current repository", () => {
    expect(
      resolvePullRequestLink({
        target: { kind: "number", number: 5 },
        current,
        repositories,
        knownUrls: [],
      }),
    ).toEqual({ kind: "current", number: 5 });
  });

  it("opens links to the current repository in place", () => {
    expect(
      resolvePullRequestLink({
        target: link("https://github.com/ryco-labs/ryco/pull/703"),
        current,
        repositories,
        knownUrls: [],
      }),
    ).toEqual({ kind: "current", number: 703 });
  });

  it("matches checkouts grouped separately through loaded rows", () => {
    expect(
      resolvePullRequestLink({
        target: link("https://github.com/ryco-labs/ryco/pull/9"),
        current: option("local", "env-local:/code/ryco"),
        repositories: [],
        knownUrls: ["https://github.com/ryco-labs/ryco/pull/703"],
      }),
    ).toEqual({ kind: "current", number: 9 });
  });

  it("switches to another known repository, preferring its representative checkout", () => {
    expect(
      resolvePullRequestLink({
        target: link("https://github.com/ryco-labs/hub/pull/96"),
        current,
        repositories,
        knownUrls: [],
      }),
    ).toEqual({ kind: "switch", number: 96, repository: other });
  });

  it("matches a repository grouped by subdirectory", () => {
    const monorepo = option("web", "github.com/ryco-labs/mono::apps/web");
    expect(
      resolvePullRequestLink({
        target: link("https://github.com/ryco-labs/mono/pull/3"),
        current,
        repositories: [current, monorepo],
        knownUrls: [],
      }),
    ).toEqual({ kind: "switch", number: 3, repository: monorepo });
  });

  it("hands unknown repositories to the host", () => {
    expect(
      resolvePullRequestLink({
        target: link("https://github.com/elsewhere/app/pull/1"),
        current,
        repositories,
        knownUrls: [],
      }),
    ).toEqual({ kind: "external", number: 1, url: "https://github.com/elsewhere/app/pull/1" });
  });
});
