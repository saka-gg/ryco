import { describe, expect, it } from "vite-plus/test";

import { parsePullRequestReference, parsePullRequestReferenceNumber } from "./pullRequestReference";

describe("parsePullRequestReference", () => {
  it("accepts GitHub pull request URLs", () => {
    expect(parsePullRequestReference("https://github.com/pingdotgg/ryco/pull/42")).toBe(
      "https://github.com/pingdotgg/ryco/pull/42",
    );
  });

  it("accepts Azure DevOps pull request URLs", () => {
    expect(
      parsePullRequestReference("https://dev.azure.com/acme/project/_git/ryco/pullrequest/42"),
    ).toBe("https://dev.azure.com/acme/project/_git/ryco/pullrequest/42");
  });

  it("accepts GitLab merge request URLs", () => {
    expect(parsePullRequestReference("https://gitlab.com/group/project/-/merge_requests/42")).toBe(
      "https://gitlab.com/group/project/-/merge_requests/42",
    );
  });

  it("accepts Forgejo pull request URLs", () => {
    expect(parsePullRequestReference("https://codeberg.org/owner/repo/pulls/42")).toBe(
      "https://codeberg.org/owner/repo/pulls/42",
    );
  });

  it("accepts legacy Azure DevOps pull request URLs", () => {
    expect(
      parsePullRequestReference("https://acme.visualstudio.com/project/_git/ryco/pullrequest/42"),
    ).toBe("https://acme.visualstudio.com/project/_git/ryco/pullrequest/42");
  });

  it("accepts raw numbers", () => {
    expect(parsePullRequestReference("42")).toBe("42");
  });

  it("accepts #number references", () => {
    expect(parsePullRequestReference("#42")).toBe("42");
  });

  it("accepts gh pr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("gh pr checkout 42")).toBe("42");
  });

  it("accepts gh pr checkout commands with #number references", () => {
    expect(parsePullRequestReference("gh pr checkout #42")).toBe("42");
  });

  it("accepts gh pr checkout commands with GitHub pull request URLs", () => {
    expect(
      parsePullRequestReference("gh pr checkout https://github.com/pingdotgg/ryco/pull/42"),
    ).toBe("https://github.com/pingdotgg/ryco/pull/42");
  });

  it("accepts glab mr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("glab mr checkout 42")).toBe("42");
  });

  it("accepts az repos pr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("az repos pr checkout --id 42")).toBe("42");
  });

  it("accepts az repos pr checkout commands with equals-style ids", () => {
    expect(parsePullRequestReference("az repos pr checkout --id=42")).toBe("42");
  });

  it("accepts az repos pr checkout commands with extra flags", () => {
    expect(parsePullRequestReference("az repos pr checkout --id 42 --remote-name origin")).toBe(
      "42",
    );
  });

  it("rejects non-pull-request input", () => {
    expect(parsePullRequestReference("feature/my-branch")).toBeNull();
  });
});

describe("parsePullRequestReferenceNumber", () => {
  it("reads the number from numbers, URLs and checkout commands", () => {
    expect(parsePullRequestReferenceNumber("#677")).toBe(677);
    expect(parsePullRequestReferenceNumber("677")).toBe(677);
    expect(parsePullRequestReferenceNumber("https://github.com/sak0a/ryco/pull/677/files")).toBe(
      677,
    );
    expect(
      parsePullRequestReferenceNumber("https://gitlab.com/group/project/-/merge_requests/42"),
    ).toBe(42);
    expect(parsePullRequestReferenceNumber("gh pr checkout 12")).toBe(12);
  });

  it("names nothing for titles, branches and zero", () => {
    expect(parsePullRequestReferenceNumber("projects map")).toBeNull();
    expect(parsePullRequestReferenceNumber("feature/my-branch")).toBeNull();
    expect(parsePullRequestReferenceNumber("#0")).toBeNull();
  });
});
