import { describe, expect, it } from "vite-plus/test";

import {
  alternateRemoteUrl,
  classifyRemoteUrl,
  isCloneableRemoteKind,
  isRecreatableRemoteKind,
  redactGitCredentials,
  remoteUrlHasPassword,
  repositoryFolderName,
  sanitizeRemoteUrl,
  sshHostOfRemoteUrl,
} from "./gitRemoteUrl.ts";

describe("classifyRemoteUrl", () => {
  it("tells the transports apart", () => {
    expect(classifyRemoteUrl("https://github.com/octocat/ryco.git")).toBe("https");
    expect(classifyRemoteUrl("HTTP://example.com/o/r.git")).toBe("http");
    expect(classifyRemoteUrl("ssh://git@github.com/octocat/ryco.git")).toBe("ssh");
    expect(classifyRemoteUrl("git@github.com:octocat/ryco.git")).toBe("scp");
    expect(classifyRemoteUrl("file:///srv/git/ryco.git")).toBe("file");
    expect(classifyRemoteUrl("/srv/git/ryco.git")).toBe("local");
    expect(classifyRemoteUrl("../ryco")).toBe("local");
    expect(classifyRemoteUrl("C:\\repos\\ryco")).toBe("local");
    expect(classifyRemoteUrl("\\\\server\\share\\ryco")).toBe("local");
    expect(classifyRemoteUrl("git://example.com/ryco.git")).toBe("other");
    expect(classifyRemoteUrl("ext::sh -c touch% /tmp/pwned")).toBe("other");
    expect(classifyRemoteUrl("github.com:octocat/ryco.git")).toBe("other");
    expect(classifyRemoteUrl("   ")).toBe("other");
  });
});

describe("sanitizeRemoteUrl", () => {
  it("strips http(s) user info but keeps ssh user names", () => {
    expect(sanitizeRemoteUrl("https://x-token:ghp_secret@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
    expect(sanitizeRemoteUrl("http://octocat@example.com/o/r.git")).toBe(
      "http://example.com/o/r.git",
    );
    expect(sanitizeRemoteUrl("ssh://git@github.com/o/r.git")).toBe("ssh://git@github.com/o/r.git");
    expect(sanitizeRemoteUrl("ssh://git:hunter2@github.com/o/r.git")).toBe(
      "ssh://git@github.com/o/r.git",
    );
    expect(sanitizeRemoteUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(sanitizeRemoteUrl("git:hunter2@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });

  it("leaves URLs without credentials byte for byte", () => {
    for (const url of [
      "https://github.com/o/r",
      "https://GitHub.com/o/r.git/",
      "file:///srv/r.git",
      "/srv/r.git",
    ]) {
      expect(sanitizeRemoteUrl(url)).toBe(url);
    }
  });

  it("treats the last @ of the authority as the end of the user info", () => {
    expect(sanitizeRemoteUrl("https://user:p@ss@example.com/o/r.git")).toBe(
      "https://example.com/o/r.git",
    );
  });
});

describe("remoteUrlHasPassword", () => {
  it("finds passwords in URL and scp syntax only", () => {
    expect(remoteUrlHasPassword("https://user:token@github.com/o/r.git")).toBe(true);
    expect(remoteUrlHasPassword("git:secret@github.com:o/r.git")).toBe(true);
    expect(remoteUrlHasPassword("https://user@github.com/o/r.git")).toBe(false);
    expect(remoteUrlHasPassword("ssh://git@github.com:22/o/r.git")).toBe(false);
    expect(remoteUrlHasPassword("git@github.com:o/r.git")).toBe(false);
  });
});

describe("alternateRemoteUrl", () => {
  it("maps https to scp-ssh and back from host, owner and repository", () => {
    expect(alternateRemoteUrl("https://github.com/octocat/ryco.git")).toBe(
      "git@github.com:octocat/ryco.git",
    );
    expect(alternateRemoteUrl("https://token@github.com/octocat/ryco")).toBe(
      "git@github.com:octocat/ryco",
    );
    expect(alternateRemoteUrl("git@github.com:octocat/ryco.git")).toBe(
      "https://github.com/octocat/ryco.git",
    );
    expect(alternateRemoteUrl("ssh://git@GitLab.com/group/sub/ryco.git")).toBe(
      "https://gitlab.com/group/sub/ryco.git",
    );
  });

  it("has no counterpart for ports, server paths and host-specific layouts", () => {
    expect(alternateRemoteUrl("https://git.example.com:8443/o/r.git")).toBeNull();
    expect(alternateRemoteUrl("ssh://git@example.com:7999/o/r.git")).toBeNull();
    expect(alternateRemoteUrl("git@example.com:/srv/git/r.git")).toBeNull();
    expect(alternateRemoteUrl("git@example.com:~user/r.git")).toBeNull();
    expect(alternateRemoteUrl("https://dev.azure.com/org/project/_git/repo")).toBeNull();
    expect(alternateRemoteUrl("git@ssh.dev.azure.com:v3/org/project/repo")).toBeNull();
    expect(alternateRemoteUrl("https://github.com/octocat")).toBeNull();
    expect(alternateRemoteUrl("http://github.com/octocat/ryco.git")).toBeNull();
    expect(alternateRemoteUrl("file:///srv/r.git")).toBeNull();
  });
});

describe("sshHostOfRemoteUrl", () => {
  it("names the host as known_hosts does", () => {
    expect(sshHostOfRemoteUrl("git@github.com:o/r.git")).toBe("github.com");
    expect(sshHostOfRemoteUrl("ssh://git@github.com/o/r.git")).toBe("github.com");
    expect(sshHostOfRemoteUrl("ssh://git@example.com:2222/o/r.git")).toBe("[example.com]:2222");
    expect(sshHostOfRemoteUrl("https://github.com/o/r.git")).toBeNull();
  });
});

describe("redactGitCredentials", () => {
  it("hides http(s) user info and other URLs' passwords in free text", () => {
    expect(
      redactGitCredentials(
        "fatal: unable to access 'https://x-token:ghp_secret@github.com/o/r.git/': 403",
      ),
    ).toBe("fatal: unable to access 'https://***@github.com/o/r.git/': 403");
    expect(redactGitCredentials("cloning https://ghp_token@github.com/o/r")).toBe(
      "cloning https://***@github.com/o/r",
    );
    expect(redactGitCredentials("ssh://git:hunter2@example.com/o/r.git")).toBe(
      "ssh://git:***@example.com/o/r.git",
    );
    expect(redactGitCredentials("ssh://git@example.com/o/r.git and git@github.com:o/r")).toBe(
      "ssh://git@example.com/o/r.git and git@github.com:o/r",
    );
  });

  it("returns text without credentials unchanged", () => {
    const text = "Receiving objects: 100% (3/3), done.\n";
    expect(redactGitCredentials(text)).toBe(text);
  });
});

describe("isCloneableRemoteKind / isRecreatableRemoteKind", () => {
  it("clones over https, ssh and scp, and recreates plain http too", () => {
    const kinds = ["https", "http", "ssh", "scp", "file", "local", "other"] as const;
    expect(kinds.filter(isCloneableRemoteKind)).toEqual(["https", "ssh", "scp"]);
    expect(kinds.filter(isRecreatableRemoteKind)).toEqual(["https", "http", "ssh", "scp"]);
  });
});

describe("repositoryFolderName", () => {
  it("is the last path segment without .git", () => {
    expect(repositoryFolderName("git@github.com:ada/app.git")).toBe("app");
    expect(repositoryFolderName("https://github.com/ada/app/")).toBe("app");
    expect(repositoryFolderName("https://example.com/x/repo.git?ref=main")).toBe("repo");
    expect(repositoryFolderName("git@host:repo")).toBe("repo");
    expect(repositoryFolderName("https://github.com/.git")).toBeNull();
  });
});
