import type { RepositoryIdentity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectRemoteChoices, resolveRemoteUrlToBrowserUrl } from "./remotes.ts";

const identity = (remotes: RepositoryIdentity["remotes"]): RepositoryIdentity =>
  ({
    canonicalKey: "github.com/acme/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/app.git",
    },
    remotes,
  }) as RepositoryIdentity;

describe("resolveRemoteUrlToBrowserUrl", () => {
  it("turns git remotes into browser addresses", () => {
    expect(resolveRemoteUrlToBrowserUrl("git@github.com:acme/app.git")).toBe(
      "https://github.com/acme/app",
    );
    expect(resolveRemoteUrlToBrowserUrl("https://gitlab.com/acme/app.git")).toBe(
      "https://gitlab.com/acme/app",
    );
    expect(resolveRemoteUrlToBrowserUrl("git@ssh.dev.azure.com:v3/org/proj/repo")).toBe(
      "https://dev.azure.com/org/proj/_git/repo",
    );
    expect(resolveRemoteUrlToBrowserUrl("/srv/git/app")).toBeNull();
  });
});

describe("projectRemoteChoices", () => {
  const remotes = [
    { name: "origin", url: "git@github.com:me/app.git", ownerRepo: "me/app", provider: "github" },
    { name: "upstream", url: "https://github.com/acme/app.git", provider: "github" },
  ] as unknown as RepositoryIdentity["remotes"];

  it("follows auto-detect until the reader picks a remote", () => {
    const choices = projectRemoteChoices({ repositoryIdentity: identity(remotes) });
    expect(choices.preferred).toBeNull();
    expect(choices.autoRemoteName).toBe("origin");
    expect(choices.choosable).toBe(true);
    expect(
      choices.remotes.map((remote) => [remote.name, remote.location, remote.selected]),
    ).toEqual([
      ["origin", "me/app", false],
      ["upstream", "https://github.com/acme/app.git", false],
    ]);
    expect(choices.remotes[1]?.browserUrl).toBe("https://github.com/acme/app");
  });

  it("marks the saved choice, and drops one that names no remote", () => {
    expect(
      projectRemoteChoices({
        repositoryIdentity: identity(remotes),
        preferredRemoteName: "upstream",
      }).remotes.map((remote) => remote.selected),
    ).toEqual([false, true]);
    expect(
      projectRemoteChoices({ repositoryIdentity: identity(remotes), preferredRemoteName: "gone" })
        .preferred,
    ).toBeNull();
  });

  it("has nothing to choose without remotes", () => {
    expect(projectRemoteChoices({ repositoryIdentity: null })).toEqual({
      remotes: [],
      preferred: null,
      autoRemoteName: null,
      choosable: false,
    });
  });
});
