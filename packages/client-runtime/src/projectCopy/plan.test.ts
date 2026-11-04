import type {
  EnvironmentId,
  ProjectId,
  ProjectScript,
  RepositoryIdentity,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import {
  PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES,
  ProjectImportId,
  ProjectTransferId,
  type NodePathHints,
  type ProjectDestinationPreview,
  type ProjectExportArtifactKind,
  type ProjectExportInspection,
  type ProjectExportResult,
} from "@ryco/contracts/project-copy";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectCopyRunPlan,
  buildProjectImportStartInput,
  copyDestinationCandidate,
  joinNodePath,
  judgeCopyDestination,
  planProjectCopyOptions,
  projectCopyExportInclude,
  projectCopyFollowUpDefaults,
  projectCopyPlanWithSendFiles,
  projectCopySetupPrefill,
  relativeNodePathSegments,
  resolveCopyDestination,
  resolveFollowUpModelSelection,
  suggestCopyDestination,
  type CopyDestinationRequest,
  type CopyDestinationSuggestion,
  type ProjectCopyPlanningInput,
  type ProjectCopySourceFacts,
  type ProjectCopyTargetFacts,
} from "./plan.ts";

const SOURCE = "env-source" as EnvironmentId;
const TARGET = "env-target" as EnvironmentId;
const OID = "a".repeat(40);
const MIB = 1024 * 1024;

const macHints: NodePathHints = {
  homeDirectory: "/Users/ada",
  pathSeparator: "/",
  defaultProjectDirectory: "/Users/ada/Developer",
  defaultProjectDirectorySource: "well-known",
  codeRoots: [],
  workspaceAccessRoot: null,
};
const linuxHints: NodePathHints = {
  ...macHints,
  homeDirectory: "/home/ada",
  defaultProjectDirectory: "/home/ada/src",
};
const windowsHints: NodePathHints = {
  ...macHints,
  homeDirectory: "C:\\Users\\Ada",
  pathSeparator: "\\",
  defaultProjectDirectory: "C:\\Users\\Ada\\source\\repos",
};

const preview = (
  resolvedPath: string,
  overrides: Partial<ProjectDestinationPreview> = {},
): ProjectDestinationPreview => ({
  resolvedPath,
  state: "available",
  existingProjectId: null,
  existingRepositoryCanonicalKey: null,
  suggestedPath: null,
  detail: null,
  ...overrides,
});

const setupScript: ProjectScript = {
  id: "setup",
  name: "Setup",
  command: "bun install",
  icon: "configure",
  runOnWorktreeCreate: true,
};

function inspection(overrides: {
  readonly estimates?: Partial<Record<ProjectExportArtifactKind, number | string>>;
  readonly headOnRemote?: boolean;
  readonly remotes?: ReadonlyArray<{ name: string; url: string }>;
  readonly primaryRemoteName?: string | null;
  readonly cloneRemoteName?: string | null;
  readonly unpushed?: number;
  readonly changes?: number;
}): ProjectExportInspection {
  const estimates = {
    "commits-bundle": 2 * MIB,
    "repository-bundle": 10 * MIB,
    "changes-patch": MIB,
    avatar: 20_000,
    ...overrides.estimates,
  };
  return {
    projectId: "project-src" as ProjectId,
    repository: {
      rootPath: "/Users/ada/Code/app",
      isGitRepository: true,
      branch: "feature",
      headOid: OID,
      isDetached: false,
      remotes: overrides.remotes ?? [{ name: "origin", url: "git@github.com:ada/app.git" }],
      primaryRemoteName: overrides.primaryRemoteName ?? "origin",
      cloneRemoteName: overrides.cloneRemoteName ?? "origin",
      canonicalKey: "github.com/ada/app",
      isShallow: false,
      hasSubmodules: false,
      usesLfs: false,
    },
    pushedState: {
      headOnRemote: overrides.headOnRemote ?? false,
      upstreamBranch: "origin/feature",
      unpushedCommitCount: overrides.unpushed ?? 2,
    },
    workingTree: {
      trackedChangeCount: overrides.changes ?? 1,
      untrackedCount: 0,
      hasConflicts: false,
      ignoredCandidates: [{ path: ".env", byteLength: 40 }],
    },
    settings: {
      title: "App",
      scripts: [setupScript],
      customSystemPrompt: null,
      preferredRemoteName: "origin",
      projectMetadataDir: ".ryco",
      hasCustomAvatar: true,
      overrides: { defaultThreadEnvMode: "worktree", pullRequestTemplates: false },
      relativeRootInRepository: "",
    },
    estimates: Object.entries(estimates).map(([kind, value]) => ({
      kind: kind as ProjectExportArtifactKind,
      estimatedBytes: typeof value === "number" ? value : 0,
      skippedReason: typeof value === "string" ? value : null,
    })),
  };
}

const inspectedSource = (
  value: ProjectExportInspection = inspection({}),
  transport: "direct" | "relay" = "direct",
): ProjectCopySourceFacts => ({
  kind: "inspected",
  environmentId: SOURCE,
  label: "MacBook",
  platformOs: "darwin",
  transport,
  checkoutPath: null,
  inspection: value,
});

const availableDestination: CopyDestinationSuggestion = judgeCopyDestination({
  preview: preview("/home/ada/Code/app"),
  sourceCanonicalKey: "github.com/ada/app",
  basis: "same-place",
});

const target = (overrides: Partial<ProjectCopyTargetFacts> = {}): ProjectCopyTargetFacts => ({
  label: "Mac mini",
  platformOs: "linux",
  projectCopySupport: "yes",
  transport: "direct",
  remoteAccess: { reachable: true, alternateRemoteUrl: null, detail: null },
  destination: availableDestination,
  ...overrides,
});

const planning = (
  source: ProjectCopySourceFacts,
  targetFacts: ProjectCopyTargetFacts = target(),
): ProjectCopyPlanningInput => ({ source, target: targetFacts });

describe("node paths", () => {
  it("joins with the parent's own separator when the node's is unknown", () => {
    expect(joinNodePath("/Users/me/Code", ["ryco"])).toBe("/Users/me/Code/ryco");
    expect(joinNodePath("/Users/me/Code/", ["ryco"])).toBe("/Users/me/Code/ryco");
    expect(joinNodePath("/", ["srv"])).toBe("/srv");
    expect(joinNodePath("~", ["Code"])).toBe("~/Code");
    expect(joinNodePath("C:\\Code", ["homelab"])).toBe("C:\\Code\\homelab");
    expect(joinNodePath("C:\\", ["Code"])).toBe("C:\\Code");
    expect(joinNodePath("\\\\nas\\share", ["app"])).toBe("\\\\nas\\share\\app");
  });

  it("joins with each node's separator and folds Windows case", () => {
    expect(joinNodePath("/Users/ada/", ["Code", "app"], "/")).toBe("/Users/ada/Code/app");
    expect(joinNodePath("C:/Users/Ada", ["Code"], "\\")).toBe("C:\\Users\\Ada\\Code");
    expect(joinNodePath("\\\\nas\\share\\code", ["app"], "\\")).toBe("\\\\nas\\share\\code\\app");
    expect(relativeNodePathSegments("c:\\users\\ada\\Code\\app", "C:\\Users\\Ada", "\\")).toEqual([
      "Code",
      "app",
    ]);
    expect(relativeNodePathSegments("/Users/Ada/Code", "/Users/ada", "/")).toBeNull();
    expect(relativeNodePathSegments("/srv/app", "/Users/ada", "/")).toBeNull();
  });
});

describe("suggestCopyDestination (A35)", () => {
  const request = (overrides: Partial<CopyDestinationRequest> = {}): CopyDestinationRequest => ({
    sourceRoot: "/Users/ada/Code/app",
    sourceHints: macHints,
    destHints: linuxHints,
    placement: "mirror",
    ...overrides,
  });

  it("uses the same place under the target's home when that folder exists", () => {
    expect(copyDestinationCandidate(request()).mirroredParent).toBe("/home/ada/Code");
    const suggestion = suggestCopyDestination(
      request(),
      preview("/home/ada/Code", { state: "exists-not-empty" }),
    );
    expect(suggestion).toEqual({
      path: "/home/ada/Code/app",
      basis: "same-place",
      missingMirroredParent: null,
    });
  });

  it("falls back to the default project directory when the parent is missing", () => {
    const suggestion = suggestCopyDestination(request(), preview("/home/ada/Code"));
    expect(suggestion).toEqual({
      path: "/home/ada/src/app",
      basis: "default-directory",
      missingMirroredParent: "/home/ada/Code",
    });
  });

  it("falls back without calling a refused parent missing (A34)", () => {
    const suggestion = suggestCopyDestination(
      request(),
      preview("/home/ada/Code", { state: "access-denied", detail: "macOS guards Code." }),
    );
    expect(suggestion).toEqual({
      path: "/home/ada/src/app",
      basis: "default-directory",
      missingMirroredParent: null,
    });
    // A missing grandparent is still missing.
    expect(
      suggestCopyDestination(request(), preview("/home/ada/Code", { state: "invalid" }))
        .missingMirroredParent,
    ).toBe("/home/ada/Code");
  });

  it("mirrors a macOS path onto a Windows node with its separator", () => {
    const suggestion = suggestCopyDestination(
      request({ destHints: windowsHints }),
      preview("C:\\Users\\Ada\\Code", { state: "exists-empty" }),
    );
    expect(suggestion.path).toBe("C:\\Users\\Ada\\Code\\app");
    const back = suggestCopyDestination(
      request({
        sourceRoot: "C:\\Users\\Ada\\work\\api",
        sourceHints: windowsHints,
        destHints: macHints,
      }),
      preview("/Users/ada/work", { state: "exists-not-empty" }),
    );
    expect(back.path).toBe("/Users/ada/work/api");
  });

  it("uses the default directory for a source outside home and for agent placements", () => {
    expect(copyDestinationCandidate(request({ sourceRoot: "/srv/app" })).mirroredParent).toBeNull();
    const agent = suggestCopyDestination(
      request({ placement: "default", leafName: "tools" }),
      null,
    );
    expect(agent.path).toBe("/home/ada/src/tools");
  });

  it("renames to the free sibling when the folder is taken", () => {
    const judged = judgeCopyDestination({
      preview: preview("/home/ada/Code/app", {
        state: "exists-not-empty",
        suggestedPath: "/home/ada/Code/app-2",
      }),
      sourceCanonicalKey: "github.com/ada/app",
    });
    expect(judged).toMatchObject({
      status: "renamed",
      path: "/home/ada/Code/app-2",
      takenPath: "/home/ada/Code/app",
    });
  });

  it("offers to link a checkout of the same repository (A27)", () => {
    const sameRepository = preview("/home/ada/Code/app", {
      state: "is-git-repository",
      existingRepositoryCanonicalKey: "github.com/ada/app",
      suggestedPath: "/home/ada/Code/app-2",
    });
    expect(
      judgeCopyDestination({ preview: sameRepository, sourceCanonicalKey: "github.com/ada/app" })
        .status,
    ).toBe("link");
    expect(
      judgeCopyDestination({
        preview: { ...sameRepository, existingProjectId: "p1" as ProjectId },
        sourceCanonicalKey: "github.com/ada/app",
      }).status,
    ).toBe("existing-project");
    expect(
      judgeCopyDestination({ preview: sameRepository, sourceCanonicalKey: "github.com/x/y" }),
    ).toMatchObject({ status: "renamed", path: "/home/ada/Code/app-2" });
    expect(
      judgeCopyDestination({
        preview: preview("/etc/app", { state: "access-denied", detail: "Outside the root." }),
        sourceCanonicalKey: null,
      }),
    ).toMatchObject({ status: "blocked", detail: "Outside the root." });
  });

  it("previews the parent, then the destination, both as suggestions", async () => {
    const asked: Array<{ readonly path: string; readonly suggested?: boolean | undefined }> = [];
    const suggestion = await resolveCopyDestination(request(), {
      sourceCanonicalKey: "github.com/ada/app",
      preview: async (input) => {
        asked.push(input);
        return input.path === "/home/ada/Code"
          ? preview(input.path, { state: "exists-not-empty" })
          : preview(input.path, { state: "exists-not-empty", suggestedPath: `${input.path}-2` });
      },
    });
    // Nobody chose these places: the target must not open a folder macOS guards for them.
    expect(asked).toEqual([
      { path: "/home/ada/Code", suggested: true },
      { path: "/home/ada/Code/app", suggested: true },
    ]);
    expect(suggestion).toMatchObject({ status: "renamed", path: "/home/ada/Code/app-2" });
  });
});

describe("planProjectCopyOptions", () => {
  it("offers everything on a direct copy and forces commits with changes (A8)", () => {
    const options = planProjectCopyOptions(planning(inspectedSource()), { bringChanges: true });
    expect(options.blockedReason).toBeNull();
    expect(options.defaultMode).toBe("clone");
    expect(options.choices).toMatchObject({
      mode: "clone",
      bringCommits: true,
      bringChanges: true,
      copySettings: true,
      copyAvatar: true,
    });
    expect(options.bringCommits.forced).toBe(true);
    const unforced = planProjectCopyOptions(planning(inspectedSource()), {
      bringChanges: true,
      bringCommits: false,
    });
    expect(unforced.choices.bringCommits).toBe(true);
    expect(options.setup).toEqual({
      command: "bun install",
      osNote: "This setup was written on macOS; it may need changes on Linux.",
    });
  });

  it("clones the remote the source names, not the identity remote", () => {
    const remotes = [
      { name: "origin", url: "git@github.com:ada/app.git" },
      { name: "upstream", url: "https://github.com/org/app.git" },
    ];
    // A fork: its identity comes from upstream, its branches live on origin.
    const fork = planProjectCopyOptions(
      planning(
        inspectedSource(
          inspection({ remotes, primaryRemoteName: "upstream", cloneRemoteName: "origin" }),
        ),
      ),
    );
    expect(fork.modes.clone).toMatchObject({
      available: true,
      remoteUrl: "git@github.com:ada/app.git",
    });
    const preferred = planProjectCopyOptions(
      planning(
        inspectedSource(
          inspection({ remotes, primaryRemoteName: "upstream", cloneRemoteName: "upstream" }),
        ),
      ),
    );
    expect(preferred.modes.clone.remoteUrl).toBe("https://github.com/org/app.git");
  });

  it("disables changes that need commits the copy can't bring", () => {
    const options = planProjectCopyOptions(
      planning(inspectedSource(inspection({ estimates: { "commits-bundle": "over limit" } }))),
      { bringChanges: true },
    );
    expect(options.bringCommits).toMatchObject({ available: false, reason: "Over limit" });
    expect(options.bringChanges).toMatchObject({
      available: false,
      reason: "Needs unpushed commits.",
    });
    expect(options.choices.bringChanges).toBe(false);
  });

  it("disables what does not fit through the Hub (A7)", () => {
    const relayed = planProjectCopyOptions(
      planning(
        inspectedSource(
          inspection({
            estimates: { "repository-bundle": 38 * MIB, "commits-bundle": 30 * MIB },
          }),
          "relay",
        ),
      ),
      { bringChanges: true },
    );
    expect(relayed.relayed).toBe(true);
    expect(relayed.modes.sendFiles).toMatchObject({
      available: false,
      reason:
        "Too large to send through the Hub (38 MB). Push the branch, or connect both devices directly.",
    });
    expect(relayed.bringCommits.available).toBe(false);
    expect(relayed.bringChanges.available).toBe(false);
    expect(relayed.choices).toMatchObject({ bringCommits: false, bringChanges: false });
    expect(relayed.blockedReason).toBeNull();
    expect(relayed.plannedBytes).toBeLessThanOrEqual(PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES);

    const total = planProjectCopyOptions(
      planning(
        inspectedSource(
          inspection({ estimates: { "commits-bundle": 15 * MIB, "changes-patch": 12 * MIB } }),
        ),
        target({ transport: "relay" }),
      ),
      { bringChanges: true },
    );
    expect(total.bringChanges.available).toBe(false);
    expect(total.choices.bringCommits).toBe(true);
  });

  it("allows only a clone from its remote for a source without project copy (A23)", () => {
    const legacy: ProjectCopySourceFacts = {
      kind: "legacy",
      environmentId: SOURCE,
      label: "Old laptop",
      platformOs: "darwin",
      projectId: "project-old" as ProjectId,
      project: {
        title: "Legacy",
        workspaceRoot: "/Users/ada/Code/mono/apps/web",
        repositoryIdentity: {
          canonicalKey: "github.com/ada/mono",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://ada:secret@github.com/ada/mono.git",
          },
          rootPath: "/Users/ada/Code/mono",
          remotes: [
            { name: "origin", url: "https://github.com/ada/mono.git" },
            { name: "upstream", url: "git@github.com:org/mono.git" },
            { name: "backup", url: "/Volumes/backup/mono.git" },
          ],
        },
        scripts: [setupScript],
        customSystemPrompt: "Be brief.",
        preferredRemoteName: "upstream",
        projectMetadataDir: ".ryco",
        hasCustomAvatar: true,
      },
    };
    const options = planProjectCopyOptions(planning(legacy), { bringChanges: true });
    expect(options.blockedReason).toBeNull();
    expect(options.defaultMode).toBe("clone");
    expect(options.modes.sendFiles.reason).toBe("Update Ryco on Old laptop to send files.");
    expect(options.bringCommits.reason).toBe(
      "Update Ryco on Old laptop to bring unpushed commits.",
    );
    expect(options.bringChanges.reason).toBe(
      "Update Ryco on Old laptop to bring uncommitted changes.",
    );
    expect(options.copyAvatar.reason).toBe("Update Ryco on Old laptop to copy the avatar.");
    expect(options.choices).toMatchObject({
      mode: "clone",
      bringCommits: false,
      bringChanges: false,
      copyAvatar: false,
      copySettings: true,
    });

    const built = buildProjectCopyRunPlan({
      planning: planning(legacy),
      options,
      target: { environmentId: TARGET, pathSeparator: "/" },
      setup: null,
      followUpThread: null,
      origin: { kind: "user", sourceLabel: "Old laptop", proposalId: null },
    });
    if (!built.ok) throw new Error(built.reason);
    // The project's preferred remote, not the identity's: it clones upstream, recreates origin.
    expect(built.plan.source).toEqual({
      kind: "clone-only",
      label: "Old laptop",
      remoteUrl: "git@github.com:org/mono.git",
      remoteName: "upstream",
      remotes: [{ name: "origin", url: "https://github.com/ada/mono.git" }],
      relativeRootInRepository: "apps/web",
      settings: {
        scripts: [setupScript],
        customSystemPrompt: "Be brief.",
        preferredRemoteName: "upstream",
        projectMetadataDir: ".ryco",
        // A legacy source cannot export its overrides: the copy keeps the destination's.
        overrides: {},
      },
    });
    expect(projectCopyExportInclude(built.plan)).toBeNull();
    const { input } = buildProjectImportStartInput({
      plan: built.plan,
      importId: ProjectImportId.make("00000000-0000-4000-8000-000000000001"),
      projectId: "new-project" as ProjectId,
      exportResult: null,
      transfers: {},
    });
    expect(input).toMatchObject({
      source: { kind: "clone", remoteUrl: "git@github.com:org/mono.git", remoteName: "upstream" },
      remotes: [{ name: "origin", url: "https://github.com/ada/mono.git" }],
      commits: null,
      checkout: null,
      changes: null,
      relativeRootInRepository: "apps/web",
      // Nobody knows whether it uses LFS or submodules: the destination checks and only warns (A14).
      recurseSubmodules: true,
      usesLfs: true,
      avatarTransferId: null,
    });
  });

  it("clones a legacy fork from origin, and from its only remote when the identity lists none", () => {
    const legacy = (repositoryIdentity: RepositoryIdentity): ProjectCopySourceFacts => ({
      kind: "legacy",
      environmentId: SOURCE,
      label: "Old laptop",
      platformOs: "darwin",
      projectId: "project-old" as ProjectId,
      project: {
        title: "Fork",
        workspaceRoot: "/Users/ada/Code/app",
        repositoryIdentity,
        scripts: [],
        customSystemPrompt: null,
        // Gone from the checkout: the rule falls back to origin.
        preferredRemoteName: "gone",
        projectMetadataDir: ".ryco",
        hasCustomAvatar: false,
      },
    });
    const planOf = (source: ProjectCopySourceFacts) => {
      const built = buildProjectCopyRunPlan({
        planning: planning(source),
        options: planProjectCopyOptions(planning(source)),
        target: { environmentId: TARGET, pathSeparator: "/" },
        setup: null,
        followUpThread: null,
        origin: { kind: "user", sourceLabel: "Old laptop", proposalId: null },
      });
      if (!built.ok) throw new Error(built.reason);
      return built.plan.source;
    };

    const fork = planOf(
      legacy({
        canonicalKey: "github.com/org/app",
        locator: {
          source: "git-remote",
          remoteName: "upstream",
          remoteUrl: "https://github.com/org/app.git",
        },
        remotes: [
          { name: "origin", url: "git@github.com:ada/app.git" },
          { name: "upstream", url: "https://github.com/org/app.git" },
        ],
      }),
    );
    expect(fork).toMatchObject({
      kind: "clone-only",
      remoteUrl: "git@github.com:ada/app.git",
      remoteName: "origin",
      remotes: [{ name: "upstream", url: "https://github.com/org/app.git" }],
    });

    const locatorOnly = planOf(
      legacy({
        canonicalKey: "github.com/org/app",
        locator: {
          source: "git-remote",
          remoteName: "upstream",
          remoteUrl: "https://github.com/org/app.git",
        },
        remotes: [],
      }),
    );
    expect(locatorOnly).toMatchObject({
      remoteUrl: "https://github.com/org/app.git",
      remoteName: "upstream",
      remotes: [],
    });
  });

  it("preselects Send files when the remote is unreachable or local only (A12)", () => {
    const unreachable = planProjectCopyOptions(
      planning(
        inspectedSource(),
        target({
          remoteAccess: {
            reachable: false,
            alternateRemoteUrl: null,
            detail: "host-key-unknown github.com",
          },
        }),
      ),
    );
    expect(unreachable.defaultMode).toBe("send-files");
    expect(unreachable.modes.clone).toMatchObject({
      available: true,
      reachable: false,
      reachabilityDetail: "host-key-unknown github.com",
    });
    expect(unreachable.choices).toMatchObject({ mode: "send-files", bringCommits: false });
    expect(unreachable.bringCommits.reason).toBe("Included in the files sent.");

    const local = planProjectCopyOptions(
      planning(
        inspectedSource(inspection({ remotes: [{ name: "origin", url: "/srv/git/app.git" }] })),
      ),
    );
    expect(local.modes.clone.available).toBe(false);
    expect(local.defaultMode).toBe("send-files");

    const http = planProjectCopyOptions(
      planning(
        inspectedSource(inspection({ remotes: [{ name: "origin", url: "http://git.lan/app" }] })),
      ),
    );
    expect(http.modes.clone.reason).toBe(
      "Plain http remotes are not cloned; send the files instead.",
    );

    const none = planProjectCopyOptions(planning(inspectedSource(inspection({ remotes: [] }))));
    expect(none.notes).toContain("App has no remote, so the copy shows as a separate project.");
    expect(none.defaultMode).toBe("send-files");
  });

  it("links an existing checkout of the same repository by default (A27)", () => {
    const destination = judgeCopyDestination({
      preview: preview("/home/ada/Code/app", {
        state: "is-git-repository",
        existingRepositoryCanonicalKey: "github.com/ada/app",
      }),
      sourceCanonicalKey: "github.com/ada/app",
    });
    const options = planProjectCopyOptions(planning(inspectedSource(), target({ destination })), {
      bringChanges: true,
    });
    expect(options.defaultMode).toBe("link");
    expect(options.choices).toMatchObject({
      mode: "link",
      bringCommits: false,
      bringChanges: false,
    });
    const built = buildProjectCopyRunPlan({
      planning: planning(inspectedSource(), target({ destination })),
      options,
      target: { environmentId: TARGET, pathSeparator: "/" },
      setup: null,
      followUpThread: null,
      origin: { kind: "user", sourceLabel: null, proposalId: null },
    });
    expect(built.ok && built.plan.expectedCanonicalKey).toBe("github.com/ada/app");
  });

  it("blocks targets without project copy and unusable destinations (A23)", () => {
    expect(
      planProjectCopyOptions(planning(inspectedSource(), target({ projectCopySupport: "no" })))
        .blockedReason,
    ).toBe("Update Ryco on Mac mini to copy projects here.");
    expect(
      planProjectCopyOptions(planning(inspectedSource(), target({ projectCopySupport: "unknown" })))
        .blockedReason,
    ).toBe("Checking Mac mini…");
    const blocked = judgeCopyDestination({
      preview: preview("/x", { state: "retired-checkout", detail: "A moved project used it." }),
      sourceCanonicalKey: null,
    });
    expect(
      planProjectCopyOptions(planning(inspectedSource(), target({ destination: blocked })))
        .blockedReason,
    ).toBe("A moved project used it.");
  });
});

describe("buildProjectImportStartInput", () => {
  const exportResult = (overrides: Partial<ProjectExportResult> = {}): ProjectExportResult => {
    // A fork: the identity comes from upstream, the source measured its pushed state on origin.
    const base = inspection({
      remotes: [
        { name: "origin", url: "git@github.com:ada/app.git" },
        { name: "upstream", url: "https://github.com/org/app.git" },
        { name: "nas", url: "file:///Volumes/nas/app.git" },
        { name: "bad name!", url: "https://github.com/x/y.git" },
      ],
      primaryRemoteName: "upstream",
    });
    return {
      exportId: "00000000-0000-4000-8000-0000000000e1" as ProjectExportResult["exportId"],
      repository: base.repository,
      pushedState: base.pushedState,
      workingTree: base.workingTree,
      settings: base.settings,
      artifacts: [],
      skipped: [],
      expiresAt: "2026-10-22T12:00:00.000Z",
      ...overrides,
    };
  };
  const transfer = (n: number) =>
    ProjectTransferId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  const runPlan = (requested: Parameters<typeof planProjectCopyOptions>[1]) => {
    const facts = planning(inspectedSource());
    const built = buildProjectCopyRunPlan({
      planning: facts,
      options: planProjectCopyOptions(facts, requested),
      target: { environmentId: TARGET, pathSeparator: "/" },
      setup: { command: "bun install", saveAsScript: false },
      followUpThread: null,
      origin: { kind: "user", sourceLabel: "MacBook", proposalId: null },
    });
    if (!built.ok) throw new Error(built.reason);
    return built.plan;
  };
  const importId = ProjectImportId.make("00000000-0000-4000-8000-000000000002");

  it("clones the source's clone remote and recreates the identity remote next to it", () => {
    const exported = exportResult();
    const { input } = buildProjectImportStartInput({
      plan: runPlan({}),
      importId,
      projectId: "new-project" as ProjectId,
      exportResult: {
        ...exported,
        repository: { ...exported.repository, cloneRemoteName: "upstream" },
      },
      transfers: { "commits-bundle": transfer(1) },
    });
    expect(input.source).toEqual({
      kind: "clone",
      remoteUrl: "https://github.com/org/app.git",
      remoteName: "upstream",
    });
    expect(input.remotes).toEqual([{ name: "origin", url: "git@github.com:ada/app.git" }]);
  });

  it("pins HEAD, brings commits and changes, and recreates network remotes", () => {
    const plan = runPlan({ bringChanges: true, ignoredPaths: [".env", "secret.txt"] });
    expect(projectCopyExportInclude(plan)).toEqual({
      commits: true,
      workingTreeChanges: true,
      ignoredPaths: [".env"],
      wholeRepository: false,
      avatar: true,
    });
    const { input, warnings } = buildProjectImportStartInput({
      plan,
      importId,
      projectId: "new-project" as ProjectId,
      exportResult: exportResult(),
      transfers: {
        "commits-bundle": transfer(1),
        "changes-patch": transfer(2),
        avatar: transfer(3),
      },
    });
    expect(warnings).toEqual([]);
    expect(input).toMatchObject({
      source: { kind: "clone", remoteUrl: "git@github.com:ada/app.git", remoteName: "origin" },
      remotes: [{ name: "upstream", url: "https://github.com/org/app.git" }],
      commits: { transferId: transfer(1) },
      checkout: { branch: "feature", headOid: OID },
      changes: { transferId: transfer(2), baseOid: OID, ignoredPaths: [".env"] },
      avatarTransferId: transfer(3),
      setup: { command: "bun install", saveAsScript: false },
      settings: {
        preferredRemoteName: "origin",
        projectMetadataDir: ".ryco",
        overrides: { defaultThreadEnvMode: "worktree", pullRequestTemplates: false },
      },
    });
  });

  it("carries the source's overrides only with the project settings", () => {
    const withSettings = buildProjectImportStartInput({
      plan: runPlan({}),
      importId,
      projectId: "new-project" as ProjectId,
      exportResult: exportResult(),
      transfers: {},
    });
    expect(withSettings.input.settings?.overrides).toEqual({
      defaultThreadEnvMode: "worktree",
      pullRequestTemplates: false,
    });
    const withoutSettings = buildProjectImportStartInput({
      plan: runPlan({ copySettings: false }),
      importId,
      projectId: "new-project" as ProjectId,
      exportResult: exportResult(),
      transfers: {},
    });
    expect(withoutSettings.input.settings).toBeNull();
  });

  it("checks out the remote branch when HEAD stays behind, and drops changes then", () => {
    const plan = runPlan({ bringCommits: false });
    const { input } = buildProjectImportStartInput({
      plan,
      importId,
      projectId: "new-project" as ProjectId,
      exportResult: exportResult(),
      transfers: {},
    });
    expect(input.checkout).toEqual({ branch: "feature", headOid: null });
    const withPatch = buildProjectImportStartInput({
      plan,
      importId,
      projectId: "new-project" as ProjectId,
      exportResult: exportResult(),
      transfers: { "changes-patch": transfer(2) },
    });
    expect(withPatch.input.changes).toBeNull();
    expect(withPatch.warnings).toHaveLength(1);
  });

  it("checks out another branch from the remote when asked, leaving the source's changes", () => {
    const plan = { ...runPlan({ bringChanges: true }), checkoutBranch: "release/1.2" };
    const { input, warnings } = buildProjectImportStartInput({
      plan,
      importId,
      projectId: "new-project" as ProjectId,
      exportResult: exportResult(),
      transfers: { "commits-bundle": transfer(1), "changes-patch": transfer(2) },
    });
    expect(input.checkout).toEqual({ branch: "release/1.2", headOid: null });
    expect(input.changes).toBeNull();
    expect(warnings).toEqual([
      "Uncommitted changes were not copied: they are on feature, not release/1.2.",
    ]);
    // The source's own branch named again changes nothing.
    const same = buildProjectImportStartInput({
      plan: { ...runPlan({}), checkoutBranch: "feature" },
      importId,
      projectId: "new-project" as ProjectId,
      exportResult: exportResult(),
      transfers: { "commits-bundle": transfer(1) },
    });
    expect(same.input.checkout).toEqual({ branch: "feature", headOid: OID });
  });

  it("passes an agent's branch through the run plan", () => {
    const facts = planning(inspectedSource());
    const built = buildProjectCopyRunPlan({
      planning: facts,
      options: planProjectCopyOptions(facts, {}),
      target: { environmentId: TARGET, pathSeparator: "/" },
      setup: null,
      followUpThread: null,
      origin: { kind: "user", sourceLabel: "MacBook", proposalId: null },
      checkoutBranch: "release/1.2",
    });
    expect(built.ok && built.plan.checkoutBranch).toBe("release/1.2");
    const without = buildProjectCopyRunPlan({
      planning: facts,
      options: planProjectCopyOptions(facts, {}),
      target: { environmentId: TARGET, pathSeparator: "/" },
      setup: null,
      followUpThread: null,
      origin: { kind: "user", sourceLabel: "MacBook", proposalId: null },
    });
    expect(without.ok && "checkoutBranch" in without.plan).toBe(false);
  });

  it("sends a repository bundle on the Send files retry", () => {
    const plan = projectCopyPlanWithSendFiles(runPlan({}));
    expect(plan?.choices).toMatchObject({ mode: "send-files", bringCommits: false });
    if (plan === null) throw new Error("expected a fallback");
    expect(projectCopyPlanWithSendFiles(plan)).toBeNull();
    const { input } = buildProjectImportStartInput({
      plan,
      importId,
      projectId: "new-project" as ProjectId,
      exportResult: exportResult(),
      transfers: { "repository-bundle": transfer(4) },
    });
    expect(input.source).toEqual({ kind: "repository-bundle", transferId: transfer(4) });
    expect(input.checkout).toEqual({ branch: "feature", headOid: OID });
    expect(input.remotes.map((remote) => remote.name)).toEqual(["origin", "upstream"]);
  });
});

describe("setup and follow-up defaults (A18, A19)", () => {
  it("prefills the worktree setup script and notes an OS change", () => {
    expect(
      projectCopySetupPrefill({ scripts: [setupScript], sourceOs: "darwin", targetOs: "darwin" }),
    ).toEqual({ command: "bun install", osNote: null });
    expect(
      projectCopySetupPrefill({ scripts: [], sourceOs: "darwin", targetOs: "windows" }),
    ).toEqual({ command: null, osNote: null });
  });

  it("takes the target's default model when its provider is ready", () => {
    const provider = (instanceId: string, status: "ready" | "error"): ServerProvider =>
      ({
        instanceId,
        driver: "codex",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status,
        auth: { status: "authenticated" },
        checkedAt: "2026-10-22T10:00:00.000Z",
        models: [{ slug: "gpt-5.6-terra", name: "GPT" }],
        slashCommands: [],
      }) as unknown as ServerProvider;
    const config = (
      providers: ReadonlyArray<ServerProvider>,
      initialModelSelection: ServerConfig["settings"]["initialModelSelection"] = null,
    ) =>
      ({
        providers,
        settings: { initialModelSelection },
      }) as unknown as Pick<ServerConfig, "providers" | "settings">;

    expect(resolveFollowUpModelSelection(config([provider("codex", "error")]))).toBeNull();
    expect(resolveFollowUpModelSelection(config([provider("codex", "ready")]))).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-terra",
    });
    const preferred = { instanceId: "codex", model: "gpt-custom" } as never;
    expect(resolveFollowUpModelSelection(config([provider("codex", "ready")], preferred))).toEqual(
      preferred,
    );
    const defaults = projectCopyFollowUpDefaults({
      title: "App",
      targetLabel: "Mac mini",
      targetConfig: config([]),
    });
    expect(defaults).toMatchObject({
      title: "Finish setting up App",
      modelSelection: null,
      unavailableReason: "No agent provider is ready on Mac mini.",
    });
  });
});
