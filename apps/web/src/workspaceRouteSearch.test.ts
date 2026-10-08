import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCloseWorkspacePanelSearch,
  buildOpenPullRequestSearch,
  buildOpenRenderSearch,
  buildOpenReviewSearch,
  carryWorkspaceSearchToThread,
  formatWorkspaceRenderKey,
  parseWorkspaceRenderKey,
  parseWorkspaceRouteSearch,
  stripThreadScopedWorkspaceSearch,
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
    const carried = stripThreadScopedWorkspaceSearch({
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      workspacePr: 42,
      messageId: "m-1",
    });
    expect(carried).toEqual({ workspaceOpen: "1", workspaceTab: "pullRequest", messageId: "m-1" });
  });

  it("leaves a page tab behind for the launcher when the search follows to another thread", () => {
    const carried = stripThreadScopedWorkspaceSearch(
      buildOpenRenderSearch({ messageId: "m-1" }, "render-message:thread-chart-html"),
    );
    expect(carried).toMatchObject({ workspaceOpen: "1", messageId: "m-1" });
    expect(carried.workspaceTab).toBeUndefined();
    expect("workspaceRender" in carried).toBe(false);
  });

  it("keeps the page tab and pin within the thread, and drops them for any other", () => {
    const here = {
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("thread-1"),
    };
    const search = {
      ...buildOpenRenderSearch({ other: "kept" }, "render-message:thread-chart-html"),
      workspacePr: 42,
    };
    // A message hit in the thread the panel shows leaves the panel alone.
    expect(carryWorkspaceSearchToThread(search, { from: here, to: { ...here } })).toBe(search);
    for (const to of [
      { ...here, threadId: ThreadId.make("thread-2") },
      // The same thread id in another environment is another thread.
      { ...here, environmentId: EnvironmentId.make("environment-remote") },
    ]) {
      const carried = carryWorkspaceSearchToThread(search, { from: here, to });
      expect(carried).toMatchObject({ other: "kept", workspaceOpen: "1" });
      expect(carried.workspaceTab).toBeUndefined();
      expect("workspaceRender" in carried || "workspacePr" in carried).toBe(false);
    }
    // From a draft (no thread yet), nothing is known to belong to the target.
    expect(
      "workspaceRender" in carryWorkspaceSearchToThread(search, { from: null, to: here }),
    ).toBe(false);
  });
});

describe("page tab search", () => {
  it("round-trips a render key, splitting at the attachment id's colon", () => {
    const target = {
      messageId: MessageId.make("assistant:turn:7"),
      attachmentId: "t-1_chart-html",
    };
    const key = formatWorkspaceRenderKey(target);
    expect(key).toBe("assistant:turn:7:t-1_chart-html");
    expect(parseWorkspaceRenderKey(key)).toEqual(target);
  });

  it.each([
    ["no separator", "message"],
    ["no message", ":attachment"],
    ["a blank message", "  :attachment"],
    ["no attachment", "message:"],
    ["an attachment id outside the id alphabet", "message:../attachment"],
    ["an overlong attachment id", `message:${"a".repeat(129)}`],
  ])("names no render with %s", (_label, key) => {
    expect(parseWorkspaceRenderKey(key)).toBeNull();
  });

  it("opens the page tab and clears every other panel key", () => {
    const search = buildOpenRenderSearch(
      { other: "kept", diff: "1", workspaceTab: "review", workspacePr: 3 },
      "message:attachment",
    );
    expect(search).toMatchObject({
      other: "kept",
      workspaceOpen: "1",
      workspaceTab: "render",
      workspaceRender: "message:attachment",
      diff: undefined,
      workspacePr: undefined,
    });
    expect(buildCloseWorkspacePanelSearch(search)).toMatchObject({
      workspaceTab: undefined,
      workspaceRender: undefined,
    });
    // Another tab drops the page key.
    expect(buildOpenReviewSearch(search).workspaceRender).toBeUndefined();
  });

  it("parses a page tab only with a render it can name", () => {
    expect(
      parseWorkspaceRouteSearch({
        workspaceTab: "render",
        workspaceRender: " message:attachment ",
      }),
    ).toEqual({
      workspaceOpen: "1",
      workspaceTab: "render",
      workspaceRender: "message:attachment",
    });
    expect(parseWorkspaceRouteSearch({ workspaceTab: "render" })).toEqual({});
    expect(
      parseWorkspaceRouteSearch({ workspaceTab: "render", workspaceRender: "message:a/b" }),
    ).toEqual({});
    // Other tabs never carry a page key.
    expect(
      parseWorkspaceRouteSearch({ workspaceTab: "files", workspaceRender: "message:attachment" }),
    ).toEqual({ workspaceOpen: "1", workspaceTab: "files" });
  });
});
