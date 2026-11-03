import { describe, expect, it } from "vite-plus/test";

import {
  azureRemoteRepositoryKey,
  changeRequestNumberFromUrl,
  changeRequestRepositoryKey,
  checkoutRepositoryKey,
  parseChangeRequestUrl,
  repositoryKeysMatch,
} from "./git.ts";

describe("changeRequestRepositoryKey", () => {
  it("keys a pull request URL by its repository on every host", () => {
    expect(changeRequestRepositoryKey("https://github.com/Acme/Repo/pull/5/files")).toBe(
      "github.com/acme/repo",
    );
    expect(
      changeRequestRepositoryKey(
        "https://gitlab.example.com:8443/group/sub/proj/-/merge_requests/12",
      ),
    ).toBe("gitlab.example.com:8443/group/sub/proj");
    expect(changeRequestRepositoryKey("https://codeberg.org/o/r/pulls/3")).toBe("codeberg.org/o/r");
    expect(changeRequestRepositoryKey("https://bitbucket.org/w/r/pull-requests/9")).toBe(
      "bitbucket.org/w/r",
    );
    expect(changeRequestRepositoryKey("https://github.com/o/r/issues/4")).toBeNull();
    expect(changeRequestRepositoryKey("not a url")).toBeNull();
  });

  it("knows an Azure DevOps repository by any of its URL forms", () => {
    const key = "azure:acme/shop app/shop";
    expect(
      changeRequestRepositoryKey("https://dev.azure.com/acme/Shop%20App/_git/shop/pullrequest/9"),
    ).toBe(key);
    expect(
      changeRequestRepositoryKey(
        "https://acme.visualstudio.com/DefaultCollection/Shop App/_git/shop/pullrequest/9",
      ),
    ).toBe(key);
    // The project defaults to the repository's name.
    expect(changeRequestRepositoryKey("https://dev.azure.com/acme/_git/shop/pullrequest/9")).toBe(
      "azure:acme/shop/shop",
    );
  });
});

describe("azureRemoteRepositoryKey", () => {
  it("reads the checkout's repository from HTTPS and SSH remotes", () => {
    const key = "azure:acme/shop/shop";
    expect(azureRemoteRepositoryKey("https://acme@dev.azure.com/acme/Shop/_git/shop")).toBe(key);
    expect(
      azureRemoteRepositoryKey("https://acme.visualstudio.com/DefaultCollection/Shop/_git/shop"),
    ).toBe(key);
    expect(azureRemoteRepositoryKey("git@ssh.dev.azure.com:v3/acme/Shop/shop")).toBe(key);
    expect(azureRemoteRepositoryKey("acme@vs-ssh.visualstudio.com:v3/acme/Shop/shop")).toBe(key);
    // SSH with a port, and the legacy `_ssh` paths.
    expect(azureRemoteRepositoryKey("ssh://git@ssh.dev.azure.com:22/v3/acme/Shop/shop")).toBe(key);
    expect(azureRemoteRepositoryKey("ssh://acme@vs-ssh.visualstudio.com:22/Shop/_ssh/shop")).toBe(
      key,
    );
    expect(
      azureRemoteRepositoryKey(
        "ssh://acme@acme.visualstudio.com:22/DefaultCollection/Shop/_ssh/shop",
      ),
    ).toBe(key);
    expect(azureRemoteRepositoryKey("https://acme@dev.azure.com/acme/Shop/_git/shop.git")).toBe(
      key,
    );
    expect(azureRemoteRepositoryKey("https://github.com/acme/shop.git")).toBeNull();
    expect(azureRemoteRepositoryKey("git@github.com:acme/shop.git")).toBeNull();
    expect(azureRemoteRepositoryKey(null)).toBeNull();
  });
});

describe("parseChangeRequestUrl", () => {
  it("reads a GitHub pull request with any trailing path or hash", () => {
    expect(parseChangeRequestUrl("https://github.com/Acme/App/pull/12/files#diff-1")).toEqual({
      number: 12,
      repositoryUrl: "https://github.com/Acme/App",
      repositoryKey: "github.com/acme/app",
      view: "files",
    });
    expect(parseChangeRequestUrl(" https://github.com/acme/app/pull/12 ")).toEqual({
      number: 12,
      repositoryUrl: "https://github.com/acme/app",
      repositoryKey: "github.com/acme/app",
    });
  });

  it("reads GitLab, Forgejo, Bitbucket and Azure DevOps links", () => {
    expect(
      parseChangeRequestUrl("https://gitlab.com/group/sub/app/-/merge_requests/9"),
    ).toMatchObject({
      number: 9,
      repositoryUrl: "https://gitlab.com/group/sub/app",
      repositoryKey: "gitlab.com/group/sub/app",
    });
    expect(parseChangeRequestUrl("https://codeberg.org/acme/app/pulls/3")).toMatchObject({
      number: 3,
      repositoryKey: "codeberg.org/acme/app",
    });
    expect(parseChangeRequestUrl("https://bitbucket.org/ws/repo/pull-requests/3")).toEqual({
      number: 3,
      repositoryUrl: "https://bitbucket.org/ws/repo",
      repositoryKey: "bitbucket.org/ws/repo",
    });
    expect(parseChangeRequestUrl("https://dev.azure.com/org/proj/_git/repo/pullrequest/5")).toEqual(
      {
        number: 5,
        repositoryUrl: "https://dev.azure.com/org/proj/_git/repo",
        repositoryKey: "azure:org/proj/repo",
      },
    );
    expect(
      parseChangeRequestUrl(
        "https://org.visualstudio.com/DefaultCollection/proj/_git/repo/pullrequest/5",
      ),
    ).toMatchObject({ number: 5, repositoryKey: "azure:org/proj/repo" });
  });

  it("names the files, checks and commits views", () => {
    expect(parseChangeRequestUrl("https://github.com/a/b/pull/1/checks")?.view).toBe("checks");
    expect(parseChangeRequestUrl("https://github.com/a/b/pull/1/commits/abc123")?.view).toBe(
      "commits",
    );
    expect(parseChangeRequestUrl("https://gitlab.com/a/b/-/merge_requests/1/diffs")?.view).toBe(
      "files",
    );
    expect(parseChangeRequestUrl("https://gitlab.com/a/b/-/merge_requests/1/pipelines")?.view).toBe(
      "checks",
    );
    expect(parseChangeRequestUrl("https://bitbucket.org/a/b/pull-requests/1/diff")?.view).toBe(
      "files",
    );
    expect(
      parseChangeRequestUrl("https://dev.azure.com/o/p/_git/r/pullrequest/1?_a=files")?.view,
    ).toBe("files");
    expect(parseChangeRequestUrl("https://github.com/a/b/pull/1/changes")?.view).toBe("files");
    expect(parseChangeRequestUrl("https://github.com/a/b/pull/1#top")?.view).toBeUndefined();
  });

  it("never reads an inherited name as a view", () => {
    for (const url of [
      "https://github.com/a/b/pull/1/constructor",
      "https://github.com/a/b/pull/1/__proto__",
      "https://github.com/a/b/pull/1/toString",
      "https://dev.azure.com/o/p/_git/r/pullrequest/1?_a=constructor",
      "https://dev.azure.com/o/p/_git/r/pullrequest/1?_a=hasOwnProperty",
    ]) {
      const link = parseChangeRequestUrl(url);
      expect(link?.number, url).toBe(1);
      expect(link?.view, url).toBeUndefined();
    }
  });

  it("marks links to one comment or review", () => {
    for (const url of [
      "https://github.com/a/b/pull/1#issuecomment-123",
      "https://github.com/a/b/pull/1/files#discussion_r456",
      "https://github.com/a/b/pull/1#pullrequestreview-789",
      "https://gitlab.com/a/b/-/merge_requests/1#note_42",
      "https://bitbucket.org/a/b/pull-requests/1#comment-7",
      "https://dev.azure.com/o/p/_git/r/pullrequest/1?discussionId=3",
      // GitHub's Files page and Bitbucket Data Center.
      "https://github.com/a/b/pull/1/files#r1271579671",
      "https://github.com/a/b/pull/1/changes#r42",
      "https://bitbucket.example.com/projects/P/repos/r/pull-requests/1/overview?commentId=9",
    ]) {
      expect(parseChangeRequestUrl(url)?.comment, url).toBe(true);
    }
    for (const url of [
      "https://github.com/a/b/pull/1/files#diff-abc",
      "https://github.com/a/b/pull/1#readme",
    ]) {
      expect(parseChangeRequestUrl(url)?.comment, url).toBeUndefined();
    }
  });

  it("refuses anything that is not one change request", () => {
    for (const value of [
      "https://github.com/acme/app/issues/3",
      "https://github.com/acme/app/commit/abc",
      "ftp://github.com/acme/app/pull/1",
      "https://github.com/acme/app/pull/abc",
      "https://github.com/acme/app/pull/0",
      "https://github.com/acme/app",
      "https://dev.azure.com/org/proj/_git/repo",
      "github.com/acme/app/pull/1",
      "not a url",
      "",
    ]) {
      expect(parseChangeRequestUrl(value), value).toBeNull();
    }
  });
});

describe("checkoutRepositoryKey", () => {
  it("keys GitHub remotes of every shape the same way", () => {
    for (const remote of [
      "git@github.com:Acme/App.git",
      "https://github.com/acme/app",
      "ssh://git@github.com/acme/app.git",
      "https://token@github.com/acme/app.git",
    ]) {
      expect(checkoutRepositoryKey(remote), remote).toBe("github.com/acme/app");
    }
  });

  it("reads scp-like remotes whatever their SSH user", () => {
    for (const remote of [
      "gitea@code.example.com:acme/app.git",
      "code.example.com:acme/app.git",
      "ssh://forgejo@code.example.com:2222/acme/app.git",
    ]) {
      const key = checkoutRepositoryKey(remote);
      expect(key, remote).toBe("code.example.com/acme/app");
      expect(
        repositoryKeysMatch(
          key ?? "",
          parseChangeRequestUrl("https://code.example.com/acme/app/pulls/4")?.repositoryKey ?? "",
        ),
        remote,
      ).toBe(true);
    }
  });

  it("matches an Azure DevOps SSH remote to its pull request links", () => {
    const remote = checkoutRepositoryKey("git@ssh.dev.azure.com:v3/org/proj/repo");
    expect(remote).toBe("azure:org/proj/repo");
    expect(remote).toBe(
      parseChangeRequestUrl("https://dev.azure.com/org/proj/_git/repo/pullrequest/5")
        ?.repositoryKey,
    );
  });

  it("is null without a remote", () => {
    expect(checkoutRepositoryKey(null)).toBeNull();
    expect(checkoutRepositoryKey("  ")).toBeNull();
  });
});

describe("repositoryKeysMatch", () => {
  it("ignores a port on the host only", () => {
    expect(repositoryKeysMatch("ghe.example.com:8443/a/b", "ghe.example.com/a/b")).toBe(true);
    expect(repositoryKeysMatch("GitHub.com/Acme/App", "github.com/acme/app")).toBe(true);
    expect(repositoryKeysMatch("ghe.example.com/a/b", "ghe.example.com/a/c")).toBe(false);
    expect(repositoryKeysMatch("azure:o/p/r", "azure:o/p/r")).toBe(true);
    expect(repositoryKeysMatch("azure:123/p/r", "azure/p/r")).toBe(false);
  });
});

describe("changeRequestNumberFromUrl", () => {
  it("reads the number from the same URL forms the repository key reads", () => {
    expect(changeRequestNumberFromUrl("https://github.com/Acme/Repo/pull/5/files")).toBe(5);
    expect(
      changeRequestNumberFromUrl("https://gitlab.example.com/group/proj/-/merge_requests/12?x=1"),
    ).toBe(12);
    expect(changeRequestNumberFromUrl("https://bitbucket.org/w/r/pull-requests/9#c")).toBe(9);
    expect(
      changeRequestNumberFromUrl("https://dev.azure.com/acme/Shop%20App/_git/shop/pullrequest/9"),
    ).toBe(9);
    expect(changeRequestNumberFromUrl("https://github.com/o/r/pull/0")).toBeNull();
    expect(changeRequestNumberFromUrl("https://github.com/o/r/issues/4")).toBeNull();
    expect(changeRequestNumberFromUrl("not a url")).toBeNull();
  });
});
