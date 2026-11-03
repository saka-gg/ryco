import { describe, expect, it } from "vite-plus/test";

import {
  changeRequestCommitUrl,
  classifySourceControlCommentAuthorRole,
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
  parseGitHubRepositoryIdentityFromUrl,
  parseGitHubRepositoryOwnerFromUrl,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";

describe("source control presentation", () => {
  it("uses merge request terminology for GitLab", () => {
    expect(getChangeRequestTerminologyForKind("gitlab")).toEqual({
      shortLabel: "MR",
      singular: "merge request",
    });
  });

  it("uses pull request terminology for GitHub-compatible providers", () => {
    expect(getChangeRequestTerminologyForKind("github")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("azure-devops")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("bitbucket")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("forgejo")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({ kind: "unknown", name: "forge", baseUrl: "" }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("detects common source control hosts", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com/group/repo.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://dev.azure.com/org/project/_git/repo")?.kind,
    ).toBe("azure-devops");
    expect(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
    ).toBe("bitbucket");
    expect(detectSourceControlProviderFromRemoteUrl("git@codeberg.org:owner/repo.git")?.kind).toBe(
      "forgejo",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("https://code.forgejo.org/forgejo/forgejo.git")
        ?.kind,
    ).toBe("forgejo");
  });

  it("preserves URL ports while classifying by hostname", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl(
        "https://gitlab.example.test:8443/group/project.git",
      ),
    ).toEqual({
      kind: "gitlab",
      name: "GitLab Self-Hosted",
      baseUrl: "https://gitlab.example.test:8443",
    });
  });
});

describe("classifySourceControlCommentAuthorRole", () => {
  it("marks a comment from the original author as author", () => {
    expect(
      classifySourceControlCommentAuthorRole({
        commentAuthor: "alice",
        itemAuthor: "Alice",
        repositoryOwner: "owner",
        authorAssociation: "CONTRIBUTOR",
      }),
    ).toEqual({
      primary: "author",
      isOriginalAuthor: true,
      isRepositoryOwner: false,
      isRepositoryMaintainer: false,
    });
  });

  it("marks repository owner and maintainer comments distinctly", () => {
    expect(
      classifySourceControlCommentAuthorRole({
        commentAuthor: "owner",
        itemAuthor: "alice",
        repositoryOwner: "owner",
        authorAssociation: "OWNER",
      }),
    ).toEqual({
      primary: "owner",
      isOriginalAuthor: false,
      isRepositoryOwner: true,
      isRepositoryMaintainer: false,
    });

    expect(
      classifySourceControlCommentAuthorRole({
        commentAuthor: "maintainer",
        itemAuthor: "alice",
        repositoryOwner: "owner",
        authorAssociation: "COLLABORATOR",
      }),
    ).toEqual({
      primary: "maintainer",
      isOriginalAuthor: false,
      isRepositoryOwner: false,
      isRepositoryMaintainer: true,
    });
  });

  it("keeps author primary when the author is also the repository owner", () => {
    expect(
      classifySourceControlCommentAuthorRole({
        commentAuthor: "owner",
        itemAuthor: "owner",
        repositoryOwner: "owner",
        authorAssociation: "OWNER",
      }),
    ).toEqual({
      primary: "author",
      isOriginalAuthor: true,
      isRepositoryOwner: true,
      isRepositoryMaintainer: false,
    });
  });

  it("preserves ordinary participant comments", () => {
    expect(
      classifySourceControlCommentAuthorRole({
        commentAuthor: "bob",
        itemAuthor: "alice",
        repositoryOwner: "owner",
        authorAssociation: "NONE",
      }),
    ).toEqual({
      primary: "participant",
      isOriginalAuthor: false,
      isRepositoryOwner: false,
      isRepositoryMaintainer: false,
    });
  });
});

describe("parseGitHubRepositoryOwnerFromUrl", () => {
  it("parses repository owner from issue and pull request URLs", () => {
    expect(parseGitHubRepositoryOwnerFromUrl("https://github.com/owner/repo/issues/42")).toBe(
      "owner",
    );
    expect(parseGitHubRepositoryOwnerFromUrl("https://github.com/Owner/repo/pull/9")).toBe("Owner");
  });

  it("returns null for invalid or incomplete URLs", () => {
    expect(parseGitHubRepositoryOwnerFromUrl("not a url")).toBeNull();
    expect(parseGitHubRepositoryOwnerFromUrl("https://github.com/owner")).toBeNull();
  });
});

describe("parseGitHubRepositoryIdentityFromUrl", () => {
  it("extracts the authoritative base repository from GitHub PR and repository URLs", () => {
    expect(
      parseGitHubRepositoryIdentityFromUrl("https://github.com/Acme/Ryco/pull/42/files"),
    ).toEqual({
      host: "github.com",
      owner: "Acme",
      repository: "Ryco",
      nameWithOwner: "Acme/Ryco",
    });
    expect(
      parseGitHubRepositoryIdentityFromUrl("https://github.com/acme/ryco.git/commits"),
    ).toEqual({
      host: "github.com",
      owner: "acme",
      repository: "ryco",
      nameWithOwner: "acme/ryco",
    });
  });

  it("supports enterprise-style hosts and preserves their port", () => {
    expect(
      parseGitHubRepositoryIdentityFromUrl(
        "https://github.enterprise.test:8443/Platform/Ryco/pull/9",
      ),
    ).toEqual({
      host: "github.enterprise.test:8443",
      owner: "Platform",
      repository: "Ryco",
      nameWithOwner: "Platform/Ryco",
    });
  });

  it("rejects malformed, credentialed, and incomplete URLs", () => {
    expect(parseGitHubRepositoryIdentityFromUrl("not a url")).toBeNull();
    expect(parseGitHubRepositoryIdentityFromUrl("https://github.com/acme")).toBeNull();
    expect(parseGitHubRepositoryIdentityFromUrl("git@github.com:acme/ryco.git")).toBeNull();
    expect(parseGitHubRepositoryIdentityFromUrl("https://token@github.com/acme/ryco")).toBeNull();
  });
});

describe("changeRequestCommitUrl", () => {
  it("links GitHub commits under the pull request and nothing elsewhere", () => {
    expect(changeRequestCommitUrl("github", "https://github.com/a/b/pull/7/", "abc")).toBe(
      "https://github.com/a/b/pull/7/commits/abc",
    );
    expect(changeRequestCommitUrl("github", null, "abc")).toBeNull();
    expect(
      changeRequestCommitUrl("gitlab", "https://gitlab.com/g/p/-/merge_requests/7", "abc"),
    ).toBeNull();
  });
});
