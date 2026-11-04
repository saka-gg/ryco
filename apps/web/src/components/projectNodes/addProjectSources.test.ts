import {
  EnvironmentId,
  type SourceControlDiscoveryResult,
  type SourceControlRepositoryInfo,
} from "@ryco/contracts";
import { Option } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildAddProjectEnvironmentOptions,
  buildAddProjectRemoteSourceReadiness,
  buildCloneRepositoryInput,
  cloneUrlForRemoteProjectSource,
  getEnvironmentBrowsePlatform,
  listAddProjectRemoteSources,
  lookupRemoteRepository,
  remoteRepositoryInputPlaceholder,
  resolveAddProjectBrowsePlatform,
  resolveAddProjectInitialPath,
  resolveRemoteRepositoryInput,
  validateAddProjectPath,
} from "./addProjectSources";

const PRIMARY = EnvironmentId.make("environment-primary");
const MINI = EnvironmentId.make("environment-mini");
const BUILD = EnvironmentId.make("environment-build");
const HUB_ALIAS = EnvironmentId.make("environment-hub-alias");

function repository(overrides: Partial<SourceControlRepositoryInfo> = {}) {
  return {
    provider: "github",
    nameWithOwner: "sak0a/ryco-hub",
    url: "https://github.com/sak0a/ryco-hub",
    sshUrl: "git@github.com:sak0a/ryco-hub.git",
    ...overrides,
  } as SourceControlRepositoryInfo;
}

describe("buildAddProjectEnvironmentOptions", () => {
  it("lists the primary first, then saved nodes by label, without the local Hub alias", () => {
    const options = buildAddProjectEnvironmentOptions({
      primaryEnvironmentId: PRIMARY,
      primaryEnvironmentLabel: "MacBook Pro",
      savedEnvironments: {
        [BUILD]: { environmentId: BUILD, label: "hetzner-build" },
        [MINI]: { environmentId: MINI, label: "saved mini" },
        [HUB_ALIAS]: { environmentId: HUB_ALIAS, label: "This Mac via Hub" },
      },
      savedEnvironmentRuntimeById: {},
      localHubEnvironmentId: HUB_ALIAS,
      machines: [{ environmentId: MINI, label: "Mac mini" }],
    });
    expect(options).toEqual([
      { environmentId: PRIMARY, label: "MacBook Pro", isPrimary: true },
      { environmentId: BUILD, label: "hetzner-build", isPrimary: false },
      { environmentId: MINI, label: "Mac mini", isPrimary: false },
    ]);
  });
});

describe("node paths", () => {
  it("maps a node OS to the platform the path helpers read", () => {
    expect(getEnvironmentBrowsePlatform("windows")).toBe("Win32");
    expect(getEnvironmentBrowsePlatform("darwin")).toBe("MacIntel");
    expect(getEnvironmentBrowsePlatform("linux")).toBe("Linux");
  });

  it("reads the platform from the primary's descriptor or a saved node's runtime", () => {
    const savedEnvironmentRuntimeById = {
      [MINI]: { descriptor: { platform: { os: "windows" } } },
    };
    expect(
      resolveAddProjectBrowsePlatform({
        environmentId: PRIMARY,
        primaryEnvironmentId: PRIMARY,
        readPrimaryPlatformOs: () => "darwin",
        savedEnvironmentRuntimeById,
      }),
    ).toBe("MacIntel");
    expect(
      resolveAddProjectBrowsePlatform({
        environmentId: MINI,
        primaryEnvironmentId: PRIMARY,
        readPrimaryPlatformOs: () => "darwin",
        savedEnvironmentRuntimeById,
      }),
    ).toBe("Win32");
  });

  it("starts browsing at the access root, then the configured base directory, then home", () => {
    const savedEnvironmentRuntimeById = {
      [MINI]: {
        serverConfig: {
          environment: { platform: { os: "darwin" } },
          settings: { addProjectBaseDirectory: "~/dev" },
        },
      },
    };
    const input = {
      primaryEnvironmentId: PRIMARY,
      primaryServerConfig: { workspaceAccessRoot: "/work/root" },
      primarySettings: { addProjectBaseDirectory: "~/Code" },
      savedEnvironmentRuntimeById,
    };
    expect(resolveAddProjectInitialPath({ ...input, environmentId: PRIMARY })).toBe("/work/root/");
    expect(resolveAddProjectInitialPath({ ...input, environmentId: MINI })).toBe("~/dev/");
    expect(resolveAddProjectInitialPath({ ...input, environmentId: BUILD })).toBe("~/");
  });

  it("validates typed project paths for the node", () => {
    expect(
      validateAddProjectPath("C:\\Code\\app", { platform: "MacIntel", currentProjectCwd: null }),
    ).toEqual({ ok: false, reason: "Windows-style paths are only supported on Windows." });
    expect(
      validateAddProjectPath("C:\\Code\\app\\", { platform: "Win32", currentProjectCwd: null }),
    ).toEqual({ ok: true, path: "C:\\Code\\app" });
    expect(
      validateAddProjectPath("../sibling", { platform: "MacIntel", currentProjectCwd: null }),
    ).toEqual({ ok: false, reason: "Relative paths require an active project." });
    expect(
      validateAddProjectPath("../sibling", {
        platform: "MacIntel",
        currentProjectCwd: "/Users/me/Code/ryco",
      }),
    ).toEqual({ ok: true, path: "/Users/me/Code/sibling" });
    expect(
      validateAddProjectPath("   ", { platform: "MacIntel", currentProjectCwd: null }),
    ).toEqual({
      ok: false,
      reason: null,
    });
  });
});

describe("clone sources", () => {
  it("is ready for a plain URL only until discovery reports the providers", () => {
    const readiness = buildAddProjectRemoteSourceReadiness(null);
    expect(readiness.url).toEqual({ ready: true, hint: null });
    expect(readiness.github.ready).toBe(false);
  });

  it("orders Git URL, ready providers, then providers needing setup with their hints", () => {
    const discovery = {
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          status: "available",
          installHint: "Install gh",
          auth: { status: "authenticated", detail: Option.none() },
        },
        {
          kind: "gitlab",
          label: "GitLab",
          status: "available",
          installHint: "Install glab",
          auth: { status: "unauthenticated", detail: Option.none() },
        },
        {
          kind: "bitbucket",
          label: "Bitbucket",
          status: "missing",
          installHint: "Set up a Bitbucket token",
          auth: { status: "unauthenticated", detail: Option.none() },
        },
      ],
    } as unknown as SourceControlDiscoveryResult;
    const sources = listAddProjectRemoteSources(buildAddProjectRemoteSourceReadiness(discovery));
    expect(sources.map((source) => [source.source, source.ready])).toEqual([
      ["url", true],
      ["github", true],
      ["azure-devops", false],
      ["bitbucket", false],
      ["forgejo", false],
      ["gitlab", false],
    ]);
    expect(sources.find((source) => source.source === "gitlab")?.hint).toBe(
      "GitLab is not authenticated. Open Settings -> Source Control for setup guidance.",
    );
    expect(sources.find((source) => source.source === "bitbucket")?.hint).toBe(
      "Set up a Bitbucket token",
    );
    expect(sources[1]).toMatchObject({
      title: "GitHub repository",
      description: "Clone GitHub owner/repo",
    });
    expect(remoteRepositoryInputPlaceholder("bitbucket")).toBe(
      "Enter Bitbucket repository (workspace/repository)",
    );
  });
});

describe("repositories", () => {
  it("clones Bitbucket over HTTPS and everything else over SSH", () => {
    expect(cloneUrlForRemoteProjectSource("github", repository())).toBe(
      "git@github.com:sak0a/ryco-hub.git",
    );
    expect(cloneUrlForRemoteProjectSource("bitbucket", repository())).toBe(
      "https://github.com/sak0a/ryco-hub",
    );
    expect(
      buildCloneRepositoryInput({
        source: "bitbucket",
        repository: repository(),
        remoteUrl: "https://github.com/sak0a/ryco-hub",
        destinationPath: "/Users/me/Code",
      }),
    ).toEqual({
      provider: "bitbucket",
      repository: "sak0a/ryco-hub",
      remoteUrl: "https://github.com/sak0a/ryco-hub",
      protocol: "https",
      destinationPath: "/Users/me/Code",
    });
    expect(
      buildCloneRepositoryInput({
        source: "url",
        repository: null,
        remoteUrl: "https://example.com/x.git",
        destinationPath: "/Users/me/Code",
      }),
    ).toEqual({ remoteUrl: "https://example.com/x.git", destinationPath: "/Users/me/Code" });
  });

  it("settles a URL or a single search hit without a lookup", () => {
    expect(
      resolveRemoteRepositoryInput({
        source: "url",
        rawRepository: "https://example.com/x.git",
        searchQuery: "",
        searchedRepositories: [],
      }),
    ).toEqual({
      kind: "resolved",
      resolved: {
        repositoryInput: "https://example.com/x.git",
        repository: null,
        remoteUrl: "https://example.com/x.git",
      },
    });
    const hit = repository({ provider: "bitbucket" } as Partial<SourceControlRepositoryInfo>);
    expect(
      resolveRemoteRepositoryInput({
        source: "bitbucket",
        rawRepository: "ryco-hub",
        searchQuery: "ryco-hub",
        searchedRepositories: [hit],
      }),
    ).toEqual({
      kind: "resolved",
      resolved: { repositoryInput: "sak0a/ryco-hub", repository: hit, remoteUrl: hit.url },
    });
    expect(
      resolveRemoteRepositoryInput({
        source: "github",
        rawRepository: "sak0a/ryco-hub",
        searchQuery: "sak0a/ryco-hub",
        searchedRepositories: [],
      }),
    ).toEqual({ kind: "lookup", provider: "github" });
  });

  it("looks a repository up with the node's provider", async () => {
    const lookupRepository = vi.fn(async () => repository());
    const resolved = await lookupRemoteRepository({
      api: { sourceControl: { lookupRepository } } as never,
      provider: "github",
      rawRepository: "sak0a/ryco-hub",
    });
    expect(lookupRepository).toHaveBeenCalledWith({
      provider: "github",
      repository: "sak0a/ryco-hub",
    });
    expect(resolved).toEqual({
      repositoryInput: "sak0a/ryco-hub",
      repository: repository(),
      remoteUrl: "git@github.com:sak0a/ryco-hub.git",
    });
  });
});
