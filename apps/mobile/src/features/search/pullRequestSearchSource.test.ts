import { describe, expect, it, vi } from "vite-plus/test";

import { pullRequestSearchGroup } from "./pullRequestSearchSource";

describe("pullRequestSearchGroup", () => {
  it("turns the PRs feature's answer into Search's PRs group, opening each route", () => {
    const route = { name: "ProjectPullRequest", params: { number: "12" } };
    const open = vi.fn();
    const group = pullRequestSearchGroup(
      {
        results: [{ key: "a", number: 12, title: "Fix login", subtitle: "acme/app · open", route }],
        loading: true,
        unavailable: null,
      },
      open,
    );
    expect(group).toMatchObject({ scope: "pullRequests", loading: true });
    expect(group.results[0]).toMatchObject({
      title: "Fix login",
      detail: "acme/app · open",
      trailing: "#12",
    });
    group.results[0]?.open();
    expect(open).toHaveBeenCalledWith(route);
  });
});
