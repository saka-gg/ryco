import { SourceControlProviderError, WS_METHODS } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  describeExplorerChangeError,
  describeExplorerProblem,
  EXPLORER_NOT_READY,
  explorerChangeOffer,
  explorerScopeFromParams,
  firstRouteParam,
  parseProjectExplorerTab,
  parseRunIdParam,
  parseWorkItemKeyParam,
  splitVisible,
} from "./projectExplorerModel";

function offline(): Error {
  const error = new Error("This node is not connected. Reconnect to it and pull to refresh.");
  error.name = "PullRequestNodeOfflineError";
  return error;
}

describe("route params", () => {
  it("takes the first of a repeated param and drops blanks", () => {
    expect(firstRouteParam(["a", "b"])).toBe("a");
    expect(firstRouteParam("  ")).toBeNull();
    expect(firstRouteParam(undefined)).toBeNull();
    expect(firstRouteParam(42)).toBe("42");
  });

  it("opens Issues unless a known tab is asked for", () => {
    expect(parseProjectExplorerTab("actions")).toBe("actions");
    expect(parseProjectExplorerTab("jira")).toBe("jira");
    expect(parseProjectExplorerTab("pulls")).toBe("issues");
    expect(parseProjectExplorerTab(undefined)).toBe("issues");
  });

  it("reads a Jira key in the host's spelling", () => {
    expect(parseWorkItemKeyParam("abc-12")).toBe("ABC-12");
    expect(parseWorkItemKeyParam("ABC")).toBeNull();
    expect(parseWorkItemKeyParam("12-ABC")).toBeNull();
  });

  it("accepts a host run id and refuses a path", () => {
    expect(parseRunIdParam("123456789")).toBe("123456789");
    expect(parseRunIdParam("../x")).toBeNull();
  });

  it("names the node and project, or null for each that is missing", () => {
    expect(explorerScopeFromParams({ environmentId: "env", projectId: "proj" })).toEqual({
      environmentId: "env",
      projectId: "proj",
    });
    expect(explorerScopeFromParams({ environmentId: "env" })).toEqual({
      environmentId: "env",
      projectId: null,
    });
  });
});

describe("describeExplorerProblem", () => {
  it("says quietly that the node is offline", () => {
    expect(describeExplorerProblem(offline(), "issues")).toEqual({
      kind: "offline",
      title: "Node offline",
      detail: "Reconnect to this node to read its issues.",
    });
  });

  it("reads a checkout without a recognised host as no remote", () => {
    const error = new SourceControlProviderError({
      provider: "unknown",
      operation: "listIssues",
      detail:
        "This repository has no recognized source control host: it has no remote yet, or its remote is on an unsupported host.",
    });
    expect(describeExplorerProblem(error, "issues").kind).toBe("no-remote");
  });

  it("reads a failed host detection as no remote", () => {
    expect(
      describeExplorerProblem(
        new Error("Failed to detect source control provider for /work/app."),
        "issues",
      ).kind,
    ).toBe("no-remote");
  });

  it("reads a host without workflow runs as not available", () => {
    const error = new SourceControlProviderError({
      provider: "bitbucket",
      operation: "listWorkflowRuns",
      detail: "Workflow status is not available for bitbucket repositories.",
    });
    expect(describeExplorerProblem(error, "workflow runs")).toEqual({
      kind: "unsupported",
      title: "Not available",
      detail: "Workflow status is not available for bitbucket repositories.",
    });
  });

  it("states any other failure in the host's words, without the server's prefix", () => {
    const error = new SourceControlProviderError({
      provider: "github",
      operation: "listIssues",
      detail: "HTTP 502",
    });
    expect(describeExplorerProblem(error, "issues")).toEqual({
      kind: "error",
      title: "The issues could not be read",
      detail: "HTTP 502",
    });
  });

  it("explains a signed-out GitHub CLI", () => {
    expect(
      describeExplorerProblem(new Error("gh: not logged into any hosts"), "issues").detail,
    ).toContain("gh auth login");
  });
});

describe("changes", () => {
  it("offers a change to an operator and blocks it while the node is not ready", () => {
    expect(
      explorerChangeOffer({
        mutationReady: false,
        role: "owner",
        method: WS_METHODS.sourceControlCreateIssue,
      }),
    ).toEqual({ offered: true, blockedReason: EXPLORER_NOT_READY });
    expect(
      explorerChangeOffer({
        mutationReady: true,
        role: undefined,
        method: WS_METHODS.sourceControlCreateIssue,
      }),
    ).toEqual({ offered: true, blockedReason: null });
  });

  it("offers a viewer no change at all", () => {
    expect(
      explorerChangeOffer({
        mutationReady: true,
        role: "viewer",
        method: WS_METHODS.sourceControlAddIssueComment,
      }).offered,
    ).toBe(false);
  });

  it("puts a failed change in the host's words", () => {
    expect(describeExplorerChangeError(offline(), "x")).toBe(
      "Reconnect to this node, then try again.",
    );
    expect(describeExplorerChangeError("nope", "The comment was not posted.")).toBe(
      "The comment was not posted.",
    );
  });
});

describe("splitVisible", () => {
  it("shows the first few and counts the rest", () => {
    expect(splitVisible(["a", "b", "c", "d"], 3)).toEqual({ shown: ["a", "b", "c"], more: 1 });
    expect(splitVisible(["a"], 3)).toEqual({ shown: ["a"], more: 0 });
  });
});
