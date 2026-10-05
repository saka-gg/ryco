import { describe, expect, it } from "vite-plus/test";

import {
  buildCloseWorkspacePanelSearch,
  buildOpenPullRequestSearch,
  buildOpenReviewSearch,
  stripWorkspacePullRequestPin,
} from "./workspaceRouteSearch";

describe("workspace route search", () => {
  it("pins a change request only on the pull request tab and clears it everywhere else", () => {
    const pinned = buildOpenPullRequestSearch({ other: "kept" }, 42);
    expect(pinned).toMatchObject({
      other: "kept",
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      workspacePr: 42,
    });
    expect(buildOpenPullRequestSearch({}, -1).workspacePr).toBeUndefined();
    expect(buildOpenReviewSearch(pinned)).toMatchObject({
      workspaceTab: "review",
      diff: "1",
      workspacePr: undefined,
    });
    expect(buildCloseWorkspacePanelSearch(pinned)).toMatchObject({
      other: "kept",
      workspaceOpen: undefined,
      workspaceTab: undefined,
      workspacePr: undefined,
    });
  });

  it("drops a pin, and nothing else, when the search follows to another thread", () => {
    const carried = stripWorkspacePullRequestPin({
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      workspacePr: 42,
      messageId: "m-1",
    });
    expect(carried).toEqual({ workspaceOpen: "1", workspaceTab: "pullRequest", messageId: "m-1" });
  });
});
