import { describe, expect, it } from "@effect/vitest";

import {
  azureRemoteRepositoryKey,
  changeRequestRepositoryKey,
} from "./changeRequestRepositoryKey.ts";

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
