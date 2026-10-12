import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { changeRequestListBinding } from "../../rpc/sourceControlAtoms";
import { projectCheckoutKey } from "../../projectCheckouts.logic";
import {
  pullRequestListPrefetchInputs,
  resolvePullRequestListPrefetchTarget,
} from "./prefetchPullRequestLists";
import { PULL_REQUESTS_LIST_LIMIT } from "./pullRequestsModel.logic";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;
const projects = [
  { id: "p1", environmentId: local, cwd: "/repo/one" },
  { id: "p1", environmentId: remote, cwd: "/srv/one" },
  { id: "p2", environmentId: local, cwd: "/repo/two" },
  { id: "chat", environmentId: local, cwd: "/chats", kind: "chat" as const },
];

describe("resolvePullRequestListPrefetchTarget", () => {
  it("uses the URL's project, narrowed by its environment", () => {
    expect(
      resolvePullRequestListPrefetchTarget({
        search: { env: remote, project: "p1" },
        projects,
        lastRepositoryKey: null,
      }),
    ).toEqual({ environmentId: remote, cwd: "/srv/one" });
    expect(
      resolvePullRequestListPrefetchTarget({
        search: { project: "p2" },
        projects,
        lastRepositoryKey: projectCheckoutKey(local, "p1"),
      }),
    ).toEqual({ environmentId: local, cwd: "/repo/two" });
  });

  it("falls back to the last chosen repository only without a URL project", () => {
    expect(
      resolvePullRequestListPrefetchTarget({
        search: {},
        projects,
        lastRepositoryKey: projectCheckoutKey(remote, "p1"),
      }),
    ).toEqual({ environmentId: remote, cwd: "/srv/one" });
    // A named project that has not synced is the page's to wait for.
    expect(
      resolvePullRequestListPrefetchTarget({
        search: { project: "missing" },
        projects,
        lastRepositoryKey: projectCheckoutKey(remote, "p1"),
      }),
    ).toBeNull();
    expect(
      resolvePullRequestListPrefetchTarget({ search: {}, projects, lastRepositoryKey: null }),
    ).toBeNull();
  });

  it("never prefetches a chat folder", () => {
    expect(
      resolvePullRequestListPrefetchTarget({
        search: { project: "chat" },
        projects,
        lastRepositoryKey: null,
      }),
    ).toBeNull();
  });
});

describe("pullRequestListPrefetchInputs", () => {
  const target = { environmentId: local, cwd: "/repo/one" };

  it("warms the exact keys the page watches", () => {
    const inputs = pullRequestListPrefetchInputs({
      target,
      search: {},
      readInvolvement: true,
    });
    expect(inputs).toEqual([
      { environmentId: local, cwd: "/repo/one", state: "open", limit: PULL_REQUESTS_LIST_LIMIT },
      {
        environmentId: local,
        cwd: "/repo/one",
        state: "open",
        limit: PULL_REQUESTS_LIST_LIMIT,
        involvement: "authored",
      },
      {
        environmentId: local,
        cwd: "/repo/one",
        state: "open",
        limit: PULL_REQUESTS_LIST_LIMIT,
        involvement: "review-requested",
      },
    ]);
    // Same cache entries as the page's (and every other surface's) list reads.
    const pageKey = changeRequestListBinding.targetKey({
      environmentId: local,
      cwd: "/repo/one",
      state: "open",
      limit: PULL_REQUESTS_LIST_LIMIT,
      involvement: "authored",
      enabled: true,
    });
    expect(changeRequestListBinding.targetKey(inputs[1]!)).toBe(pageKey);
  });

  it("skips the involvement lists for a host known not to filter by them", () => {
    expect(
      pullRequestListPrefetchInputs({
        target,
        search: { state: "merged" },
        readInvolvement: false,
      }),
    ).toEqual([
      { environmentId: local, cwd: "/repo/one", state: "merged", limit: PULL_REQUESTS_LIST_LIMIT },
    ]);
  });
});
