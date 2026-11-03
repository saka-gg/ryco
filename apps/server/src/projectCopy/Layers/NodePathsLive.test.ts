import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type OrchestrationProjectShell,
  type RepositoryIdentity,
} from "@ryco/contracts";
import type { ProjectCopyError } from "@ryco/contracts/project-copy";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { StoragePathBlocker } from "../../storage/lifecycle.ts";
import {
  WorkspaceAccessPolicyLayer,
  makeWorkspaceAccessPolicy,
} from "../../workspace/Layers/WorkspaceAccessPolicy.ts";
import { projectDestinationReservationKey } from "../destinationReservation.ts";
import { NodePaths } from "../Services/NodePaths.ts";
import { type NodePathsProject, NodePathsLive, makeNodePaths } from "./NodePathsLive.ts";

const NOW = "2026-10-22T08:00:00.000Z";

let scratch: string;
let home: string;
let chatsRoot: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-node-paths-")));
  home = path.join(scratch, "home");
  chatsRoot = path.join(scratch, "chats");
  await mkdir(path.join(home, "Code"), { recursive: true });
  await mkdir(chatsRoot);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const identity = (canonicalKey: string): RepositoryIdentity => ({
  canonicalKey,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
  remotes: [],
});

const project = (
  id: string,
  workspaceRoot: string,
  overrides: Partial<NodePathsProject> = {},
): NodePathsProject => ({
  id: ProjectId.make(id),
  kind: "project",
  workspaceRoot,
  repositoryIdentity: null,
  ...overrides,
});

const repository = async (folder: string) => {
  await mkdir(path.join(folder, ".git"), { recursive: true });
  await writeFile(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
};

const makePaths = async (
  options: {
    readonly accessRoot?: string;
    readonly addProjectBaseDirectory?: string;
    readonly projects?: ReadonlyArray<NodePathsProject>;
    readonly fenced?: (canonical: string) => StoragePathBlocker | null;
    readonly identities?: Readonly<Record<string, RepositoryIdentity>>;
    readonly platform?: NodeJS.Platform;
  } = {},
) => {
  const policy = await Effect.runPromise(
    makeWorkspaceAccessPolicy(options.accessRoot).pipe(Effect.provide(NodeServices.layer)),
  );
  return makeNodePaths({
    policy,
    workspaceAccessRoot: options.accessRoot,
    settings: {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        addProjectBaseDirectory: options.addProjectBaseDirectory ?? "",
      }),
    },
    projects: Effect.succeed(options.projects ?? []),
    chatsRoot: Effect.succeed(chatsRoot),
    storageAdmission: (canonical) => Effect.succeed(options.fenced?.(canonical) ?? null),
    repositoryIdentity: (cwd) => Effect.succeed(options.identities?.[cwd] ?? null),
    homeDir: () => home,
    platform: options.platform ?? "linux",
    // The scratch folder is itself in the OS temporary directory.
    temporaryDirectories: [],
  });
};

const run = <A>(effect: Effect.Effect<A, ProjectCopyError>) => Effect.runPromise(effect);

describe("pathHints", () => {
  it("reports home, the separator, the code roots and the default directory", async () => {
    const paths = await makePaths({
      projects: [
        project("a", path.join(home, "Code", "a")),
        project("b", path.join(home, "Code", "b")),
        // Chats never count as projects.
        project("chat", path.join(chatsRoot, "c"), { kind: "chat" }),
        project("chat-2", path.join(chatsRoot, "d"), { kind: "chat" }),
      ],
    });
    expect(await run(paths.pathHints({}))).toEqual({
      homeDirectory: home,
      pathSeparator: "/",
      defaultProjectDirectory: path.join(home, "Code"),
      defaultProjectDirectorySource: "existing-projects",
      codeRoots: [
        { path: path.join(home, "Code"), source: "existing-projects", projectCount: 2 },
        { path: home, source: "home", projectCount: 2 },
      ],
      workspaceAccessRoot: null,
    });
    const windows = await makePaths({ platform: "win32" });
    expect((await run(windows.pathHints({}))).pathSeparator).toBe("\\");
  });

  it("reports the access root as the default when restricted", async () => {
    const allowed = path.join(scratch, "allowed");
    await mkdir(allowed);
    const hints = await run((await makePaths({ accessRoot: allowed })).pathHints({}));
    expect(hints).toMatchObject({
      defaultProjectDirectory: allowed,
      defaultProjectDirectorySource: "access-root",
      codeRoots: [{ path: allowed, source: "access-root", projectCount: 0 }],
      workspaceAccessRoot: allowed,
    });
  });
});

describe("previewDestination", () => {
  const preview = async (
    raw: string,
    options: Parameters<typeof makePaths>[0] = {},
  ): Promise<Record<string, unknown>> =>
    run((await makePaths(options)).previewDestination({ path: raw }));

  it("judges a missing folder in a writable parent available", async () => {
    expect(await preview("~/Code/new-app")).toEqual({
      resolvedPath: path.join(home, "Code", "new-app"),
      state: "available",
      existingProjectId: null,
      existingRepositoryCanonicalKey: null,
      suggestedPath: null,
      detail: null,
    });
  });

  it("judges an empty folder usable and a full one taken, with a free sibling", async () => {
    await mkdir(path.join(home, "Code", "empty"));
    expect(await preview(path.join(home, "Code", "empty"))).toMatchObject({
      state: "exists-empty",
      suggestedPath: null,
    });
    await mkdir(path.join(home, "Code", "full", "src"), { recursive: true });
    await mkdir(path.join(home, "Code", "full-2"));
    expect(await preview(path.join(home, "Code", "full"))).toMatchObject({
      state: "exists-not-empty",
      suggestedPath: path.join(home, "Code", "full-3"),
    });
    await writeFile(path.join(home, "Code", "notes.txt"), "x");
    expect(await preview(path.join(home, "Code", "notes.txt"))).toMatchObject({
      state: "exists-not-empty",
      detail: "A file is at that location.",
    });
    await symlink(path.join(home, "Code", "empty"), path.join(home, "Code", "linked"));
    expect(await preview(path.join(home, "Code", "linked"))).toMatchObject({
      state: "exists-not-empty",
      detail: "A symbolic link is at that location.",
    });
  });

  it("reports a repository, its identity and the project rooted there", async () => {
    const repo = path.join(home, "Code", "ryco");
    await repository(repo);
    await writeFile(path.join(repo, "README.md"), "x");
    expect(
      await preview(repo, {
        projects: [project("ryco", `${repo}/`)],
        identities: { [repo]: identity("github.com/sak0a/ryco") },
      }),
    ).toEqual({
      resolvedPath: repo,
      state: "is-git-repository",
      existingProjectId: "ryco",
      existingRepositoryCanonicalKey: "github.com/sak0a/ryco",
      suggestedPath: path.join(home, "Code", "ryco-2"),
      detail: "A project on this node already uses this folder.",
    });
  });

  it("refuses paths it must not guess at", async () => {
    for (const raw of ["Code/app", "~ada/Code", "", "C:\\Code\\app", "/"]) {
      expect(await preview(raw), raw).toMatchObject({ state: "invalid", suggestedPath: null });
    }
    expect(await preview("~/missing/app")).toMatchObject({
      state: "invalid",
      detail: `The folder it would go in, ${path.join(home, "missing")}, does not exist.`,
    });
    expect(await preview(path.join(chatsRoot, "x"))).toMatchObject({
      state: "invalid",
      detail: "Choose a location outside the chats folder.",
    });
  });

  it("never opens a folder macOS guards for a place nobody chose (A34)", async () => {
    const documents = path.join(home, "Documents");
    await mkdir(path.join(documents, "site"), { recursive: true });
    const suggested = async (raw: string, options: Parameters<typeof makePaths>[0] = {}) =>
      run(
        (await makePaths({ platform: "darwin", ...options })).previewDestination({
          path: raw,
          suggested: true,
        }),
      );
    // An unreadable Documents shows that nothing inside it is read: only a refusal by name.
    await chmod(documents, 0o000);
    try {
      for (const raw of ["~/Documents", "~/Documents/site", "~/documents/new", documents]) {
        expect(await suggested(raw), raw).toEqual({
          resolvedPath: path.resolve(raw.replace(/^~/u, home)),
          state: "access-denied",
          existingProjectId: null,
          existingRepositoryCanonicalKey: null,
          suggestedPath: null,
          detail:
            "macOS guards Documents with a privacy prompt, so Ryco only looks inside it when you choose a folder there.",
        });
      }
      // The user chose it: judged as usual.
      expect(
        await run(
          (await makePaths({ platform: "darwin" })).previewDestination({ path: documents }),
        ),
      ).toMatchObject({ state: "exists-not-empty", detail: "That folder cannot be read." });
      // Other platforms guard nothing; other home folders are not guarded.
      expect(await suggested("~/Documents", { platform: "linux" })).toMatchObject({
        state: "exists-not-empty",
      });
      expect(await suggested("~/Code/new")).toMatchObject({ state: "available" });
    } finally {
      await chmod(documents, 0o755);
    }
    // A code root inside it (or the default directory there) is where the node keeps projects.
    const work = path.join(documents, "work");
    await mkdir(work);
    const projects = [project("a", path.join(work, "a")), project("b", path.join(work, "b"))];
    expect(await suggested("~/Documents/work/new", { projects })).toMatchObject({
      state: "available",
    });
    expect(await suggested("~/Documents/new", { projects })).toMatchObject({
      state: "access-denied",
    });
    expect(
      await suggested("~/Documents/later/new", {
        addProjectBaseDirectory: path.join(documents, "later"),
      }),
    ).toMatchObject({ state: "invalid" });
  });

  it("refuses what the access policy and storage admission refuse", async () => {
    const allowed = path.join(scratch, "allowed");
    await mkdir(allowed);
    expect(await preview("~/Code/app", { accessRoot: allowed })).toMatchObject({
      state: "access-denied",
      detail: "This node's workspace access policy does not allow that location.",
    });
    const removed = path.join(home, "Code", "old-worktree");
    const fenced = (canonical: string) =>
      canonical === removed || canonical.startsWith(`${removed}/`) ? "checkout" : null;
    expect(await preview(removed, { fenced })).toMatchObject({
      state: "retired-checkout",
      suggestedPath: `${removed}-2`,
    });
    expect(await preview(path.join(removed, "app"), { fenced })).toMatchObject({
      state: "retired-checkout",
    });
    expect(
      await preview(path.join(home, "Code", "moving"), {
        fenced: (canonical) => (canonical.endsWith("moving") ? "project-relocation" : null),
      }),
    ).toMatchObject({ state: "exists-not-empty" });
  });
});

describe("judgeProjectDestination", () => {
  it("gives a usable create destination its canonical path and reservation key", async () => {
    await mkdir(path.join(scratch, "Real"));
    await symlink(path.join(scratch, "Real"), path.join(home, "Code", "Alias"));
    const paths = await makePaths({ platform: "darwin" });
    const judged = await run(
      paths.judgeProjectDestination({
        path: path.join(home, "Code", "Alias", "App"),
        intent: "create",
        relativeRootInRepository: "packages/web",
      }),
    );
    expect(judged).toMatchObject({
      usable: true,
      canonicalPath: path.join(scratch, "Real", "App"),
      projectRoot: path.join(scratch, "Real", "App", "packages", "web"),
      reservationKey: await Effect.runPromise(
        projectDestinationReservationKey(path.join(home, "Code", "Alias", "App")),
      ),
    });
    expect(judged.preview.resolvedPath).toBe(path.join(home, "Code", "Alias", "App"));
  });

  it("links an unregistered repository but never a registered one", async () => {
    const repo = path.join(home, "Code", "app");
    await repository(repo);
    await mkdir(path.join(repo, "web"));
    const paths = await makePaths();
    const link = (relativeRootInRepository: string) =>
      run(paths.judgeProjectDestination({ path: repo, intent: "link", relativeRootInRepository }));
    expect(await link("")).toMatchObject({
      usable: true,
      reservationKey: await Effect.runPromise(projectDestinationReservationKey(repo)),
    });
    expect(await link("web")).toMatchObject({ usable: true, projectRoot: path.join(repo, "web") });
    // The subfolder the project would be rooted at must exist, inside the repository.
    expect(await link("api")).toMatchObject({ usable: false, reservationKey: null });
    await mkdir(path.join(scratch, "outside", "web"), { recursive: true });
    await symlink(path.join(scratch, "outside"), path.join(repo, "escape"));
    expect(await link("escape/web")).toMatchObject({ usable: false });
    expect(
      await run(paths.judgeProjectDestination({ path: repo, intent: "create" })),
    ).toMatchObject({ usable: false });

    const registered = await makePaths({ projects: [project("app", repo)] });
    expect(
      await run(registered.judgeProjectDestination({ path: repo, intent: "link" })),
    ).toMatchObject({ usable: false, preview: { existingProjectId: "app" } });
    // A project registered at a subfolder blocks only that root.
    const subfolder = await makePaths({ projects: [project("web", path.join(repo, "web"))] });
    expect(
      await run(
        subfolder.judgeProjectDestination({
          path: repo,
          intent: "link",
          relativeRootInRepository: "web",
        }),
      ),
    ).toMatchObject({ usable: false, preview: { existingProjectId: "web" } });
  });

  it("refuses a missing folder whose project is still registered", async () => {
    const gone = path.join(home, "Code", "gone");
    const judged = await run(
      (await makePaths({ projects: [project("gone", gone)] })).judgeProjectDestination({
        path: gone,
        intent: "create",
      }),
    );
    expect(judged).toMatchObject({
      usable: false,
      preview: { state: "available", existingProjectId: "gone", suggestedPath: `${gone}-2` },
    });
  });
});

describe("searchDirectories", () => {
  it("searches the code roots and marks the node's projects", async () => {
    const repo = path.join(home, "Code", "ryco");
    await repository(repo);
    await mkdir(path.join(home, "Code", "ryco-site"));
    const paths = await makePaths({
      projects: [project("ryco", repo, { repositoryIdentity: identity("github.com/sak0a/ryco") })],
    });
    const result = await run(paths.searchDirectories({ query: "ryco" }));
    expect(result.roots).toEqual([path.join(home, "Code"), home]);
    expect(result.matches.map((match) => match.path)).toEqual([
      repo,
      path.join(home, "Code", "ryco-site"),
    ]);
    expect(result.matches[0]).toMatchObject({
      isGitRepository: true,
      gitBranch: "main",
      projectId: "ryco",
      repositoryCanonicalKey: "github.com/sak0a/ryco",
      depth: 1,
    });
    expect(result.matches[1]).toMatchObject({ projectId: null, repositoryCanonicalKey: null });
    // Every match fit, nothing was cut short.
    expect(result).toMatchObject({ truncated: false, limitReached: false });
  });

  it("checks named roots: refused fails, missing is left out, foreign forms are invalid", async () => {
    const allowed = path.join(scratch, "allowed");
    await mkdir(path.join(allowed, "app"), { recursive: true });
    const paths = await makePaths({ accessRoot: allowed });
    const denied = await Effect.runPromise(
      Effect.flip(paths.searchDirectories({ query: "x", roots: [home] })),
    );
    expect(denied.code).toBe("access-denied");
    const result = await run(
      paths.searchDirectories({
        query: "",
        roots: [allowed, path.join(allowed, "missing"), `${allowed}/`],
      }),
    );
    expect(result.roots).toEqual([allowed]);
    expect(result.matches.map((match) => match.name)).toEqual(["app"]);
    const invalid = await Effect.runPromise(
      Effect.flip(paths.searchDirectories({ query: "x", roots: ["C:\\Code"] })),
    );
    expect(invalid.code).toBe("invalid");
  });
});

describe("NodePathsLive", () => {
  it("judges with storage admission's records and the node's projects", async () => {
    const removed = path.join(home, "Code", "old-worktree");
    const repo = path.join(home, "Code", "app");
    await repository(repo);
    const shells: ReadonlyArray<OrchestrationProjectShell> = [
      {
        id: ProjectId.make("app"),
        kind: "project",
        title: "App",
        workspaceRoot: repo,
        projectMetadataDir: ".ryco",
        repositoryIdentity: null,
        defaultModelSelection: null,
        customAvatarContentHash: null,
        preferredRemoteName: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const layer = NodePathsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(scratch, { prefix: "ryco-node-paths-config-" }),
          WorkspaceAccessPolicyLayer(undefined),
          ServerSettingsService.layerTest(),
          Layer.succeed(ProjectionSnapshotQuery, {
            listProjectShells: () => Effect.succeed(shells),
          } as unknown as ProjectionSnapshotQuery["Service"]),
          Layer.succeed(RepositoryIdentityResolver, {
            resolve: (cwd: string) =>
              Effect.succeed(cwd === repo ? identity("github.com/sak0a/app") : null),
          }),
        ),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(NodeServices.layer),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state)
          VALUES ('removed-checkout', ${removed}, 'worktree', '{}', ${NOW}, 'removed')`;
        const paths = yield* NodePaths;
        return {
          removed: yield* paths.previewDestination({ path: path.join(removed, "app") }),
          repo: yield* paths.previewDestination({ path: repo }),
        };
      }).pipe(Effect.provide(layer)),
    );
    expect(result.removed.state).toBe("retired-checkout");
    expect(result.repo).toMatchObject({
      state: "is-git-repository",
      existingProjectId: "app",
      existingRepositoryCanonicalKey: "github.com/sak0a/app",
    });
  });
});
