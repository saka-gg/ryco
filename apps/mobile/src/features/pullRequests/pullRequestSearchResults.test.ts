import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../state/threadsRuntime", () => ({
  selectProjectsAcrossEnvironments: () => [],
  useStore: () => [],
}));
vi.mock("../home/useHomeEnvironments", () => ({ useHomeEnvironments: () => [] }));
vi.mock("./usePullRequestData", () => ({
  usePullRequestList: () => null,
  useSourceControlProvider: () => null,
}));
vi.mock("./usePullRequestTabState", () => ({ usePullRequestTabState: () => null }));

const { pullRequestSearchResults } = await import("./usePullRequestSearch");

const row = (number: number, extra: Record<string, unknown> = {}) =>
  ({
    kind: "row",
    key: `k${number}`,
    spine: null,
    row: { number, title: `Change ${number}`, state: "open", isDraft: false, ...extra },
  }) as never;

describe("pullRequestSearchResults", () => {
  it("turns list rows into results that open the pull request, once each", () => {
    const results = pullRequestSearchResults(
      [
        { kind: "heading", key: "h", title: "Yours", count: 2 },
        row(5, { isDraft: true }),
        row(6, { state: "merged" }),
        row(5),
      ],
      { label: "acme/app", environmentId: "env" as EnvironmentId, projectId: "p" as ProjectId },
    );
    expect(results.map((result) => [result.number, result.subtitle])).toEqual([
      [5, "acme/app · draft"],
      [6, "acme/app · merged"],
    ]);
    expect(results[0]?.route).toEqual({
      name: "ProjectPullRequest",
      params: { environmentId: "env", projectId: "p", number: "5" },
    });
  });
});
