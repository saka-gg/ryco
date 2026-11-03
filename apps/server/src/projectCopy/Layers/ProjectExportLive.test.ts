import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  type OrchestrationWorktreeShell,
  ProjectId,
} from "@ryco/contracts";
import {
  type ProjectExportArtifact,
  ProjectExportId,
  type ProjectExportStartInput,
} from "@ryco/contracts/project-copy";
import { normalizeGitRemoteUrl } from "@ryco/shared/git";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../config.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectAvatarStore,
  type ProjectAvatarStoreShape,
} from "../../project/Services/ProjectAvatarStore.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { GitNetworkError } from "../Errors.ts";
import { PROJECT_EXPORT_SKIP_REASON } from "../exportGit.ts";
import { withProcessEnv, writeFakeSsh } from "../projectCopyGit.fixtures.ts";
import { GitNetwork, type GitNetworkShape, type GitRemoteRef } from "../Services/GitNetwork.ts";
import type { ProjectCopyCallerChannel } from "../callerChannel.ts";
import { ProjectExport } from "../Services/ProjectExport.ts";
import { GitNetworkLive } from "./GitNetworkLive.ts";
import { makeProjectExportLive } from "./ProjectExportLive.ts";

const execFileAsync = promisify(execFile);

// The machine's global config may sign commits; fixtures never sign, and never start a
// background gc that would still be writing while a test removes its fixtures.
const GIT_ENV = {
  ...process.env,
  LC_ALL: "C",
  LANG: "C",
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "tag.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "gc.auto",
  GIT_CONFIG_VALUE_2: "0",
  GIT_CONFIG_KEY_3: "maintenance.auto",
  GIT_CONFIG_VALUE_3: "false",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" }).trim();

const configureRepo = (cwd: string) => {
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "tag.gpgsign", "false");
  git(cwd, "config", "user.email", "test@test.com");
  git(cwd, "config", "user.name", "Test");
};

const write = (file: string, contents: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};

const commitFile = (cwd: string, name: string, contents: string, message = `edit ${name}`) => {
  write(path.join(cwd, name), contents);
  git(cwd, "add", "--", name);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

/** A bare origin and a clone of it with one pushed commit on main. */
const makeRemoteAndClone = (root: string, name = "source") => {
  const bare = path.join(root, `${name}-origin.git`);
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  configureRepo(bare);
  const source = path.join(root, name);
  git(root, "init", "-q", "-b", "main", source);
  configureRepo(source);
  const base = commitFile(source, "README.md", "# fixture\n", "base");
  const url = `file://${bare}`;
  git(source, "remote", "add", "origin", url);
  git(source, "push", "-q", "origin", "main");
  git(source, "branch", "--set-upstream-to=origin/main", "main");
  return { bare, source, url, base };
};

/** A fresh clone of `url` without a checkout: what the destination starts from. */
const freshClone = (root: string, url: string, name = `dest-${randomUUID()}`) => {
  const dest = path.join(root, name);
  git(root, "clone", "-q", "--no-checkout", url, dest);
  configureRepo(dest);
  return dest;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const makeProject = (
  workspaceRoot: string,
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell =>
  ({
    id: ProjectId.make(`project-${randomUUID()}`),
    kind: "project",
    title: "Fixture",
    workspaceRoot,
    projectMetadataDir: ".ryco",
    repositoryIdentity: null,
    defaultModelSelection: null,
    customSystemPrompt: null,
    customAvatarContentHash: null,
    preferredRemoteName: null,
    scripts: [],
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  }) as OrchestrationProjectShell;

const runLsRemote = async (url: string): Promise<ReadonlyArray<GitRemoteRef>> => {
  const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", "--tags", "--", url], {
    env: GIT_ENV,
  });
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [oid, ref] = line.split("\t");
      return { oid: oid!, ref: ref! } as GitRemoteRef;
    });
};

/**
 * Fakes for everything but git: projects, worktrees, avatars and (unless `realNetwork`) the
 * network service.
 */
const makeHarness = (options: { readonly realNetwork?: boolean } = {}) => {
  const projects = new Map<string, OrchestrationProjectShell>();
  const worktrees: OrchestrationWorktreeShell[] = [];
  const avatarBytes = new Map<string, Buffer>();
  const network: {
    failLsRemote: boolean;
    lsRemoteCalls: number;
    /**
     * Holds every `ls-remote` until `release` completes, to pin a build in flight; `reached`
     * completes once a build is held there.
     */
    hold: {
      readonly reached: Deferred.Deferred<void>;
      readonly release: Effect.Effect<void>;
    } | null;
  } = { failLsRemote: false, lsRemoteCalls: 0, hold: null };

  const projections = {
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(Option.fromNullishOr(projects.get(projectId))),
    getProjectWorkspaceRows: (projectId: ProjectId) =>
      Effect.succeed({
        worktrees: worktrees.filter((worktree) => worktree.projectId === projectId),
        threads: [],
      }),
  } as unknown as ProjectionSnapshotQueryShape;

  const avatars: ProjectAvatarStoreShape = {
    write: () => Effect.succeed({ contentHash: "unused" }),
    read: (projectId) =>
      Effect.sync(() => {
        const bytes = avatarBytes.get(projectId);
        return bytes ? { bytes, contentHash: sha256(bytes) } : null;
      }),
    remove: () => Effect.void,
  };

  const gitNetwork: GitNetworkShape = {
    env: {
      LC_ALL: "C",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS_REQUIRE: "never",
      GCM_INTERACTIVE: "never",
    },
    runGitNetworkCommand: () => Effect.die("unused"),
    lsRemote: (input) => {
      network.lsRemoteCalls += 1;
      const failure = new GitNetworkError({
        operation: "lsRemote",
        reason: "unreachable",
        detail: "remote unreachable in this test",
        host: null,
        exitCode: 128,
      });
      const run =
        network.failLsRemote || input.allowLocalRemote !== true
          ? Effect.fail(failure)
          : Effect.tryPromise({ try: () => runLsRemote(input.remoteUrl), catch: () => failure });
      const hold = network.hold;
      return hold
        ? Deferred.succeed(hold.reached, undefined).pipe(
            Effect.andThen(hold.release),
            Effect.andThen(run),
          )
        : run;
    },
    checkRemoteAccess: () => Effect.die("unused"),
    alternateRemoteUrl: () => null,
    sanitizeRemoteUrl: (url) => url.replace(/^(https?:\/\/)[^/@]*@/, "$1"),
    classifyRemoteUrl: () => "other",
  };

  const networkLayer = options.realNetwork
    ? GitNetworkLive.pipe(
        Layer.provide(
          Layer.mock(SourceControlProviderRegistry)({ detectProviderFromRemoteUrl: () => null }),
        ),
        Layer.provide(NodeServices.layer),
      )
    : Layer.succeed(GitNetwork, gitNetwork);
  const layer = makeProjectExportLive({ disablePeriodicSweep: true }).pipe(
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projections)),
    Layer.provide(Layer.succeed(ProjectAvatarStore, avatars)),
    Layer.provide(networkLayer),
    Layer.provide(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-export-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  const addProject = (
    workspaceRoot: string,
    overrides: Partial<OrchestrationProjectShell> = {},
  ) => {
    const project = makeProject(workspaceRoot, overrides);
    projects.set(project.id, project);
    return project;
  };

  return { layer, addProject, worktrees, avatarBytes, network };
};

const include = (overrides: Partial<ProjectExportStartInput["include"]> = {}) => ({
  commits: false,
  workingTreeChanges: false,
  ignoredPaths: [],
  wholeRepository: false,
  avatar: false,
  ...overrides,
});

const startInput = (
  projectId: ProjectId,
  overrides: Partial<Omit<ProjectExportStartInput, "include">> & {
    include?: Partial<ProjectExportStartInput["include"]>;
  } = {},
): ProjectExportStartInput => ({
  ...overrides,
  exportId: overrides.exportId ?? ProjectExportId.make(randomUUID()),
  projectId,
  include: include(overrides.include),
});

/** Reads a whole artifact back through `readChunk` and checks its digest. */
const readArtifact = (
  exportId: ProjectExportStartInput["exportId"],
  artifact: ProjectExportArtifact,
  chunkBytes = 160 * 1024,
  channel?: ProjectCopyCallerChannel,
) =>
  Effect.gen(function* () {
    const exporter = yield* ProjectExport;
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = yield* exporter.readChunk(
        { exportId, artifactId: artifact.artifactId, offset, length: chunkBytes },
        channel,
      );
      expect(chunk.offset).toBe(offset);
      chunks.push(Buffer.from(chunk.dataBase64, "base64"));
      offset += chunk.length;
      if (chunk.eof) break;
    }
    const bytes = Buffer.concat(chunks);
    expect(bytes.length).toBe(artifact.byteLength);
    expect(sha256(bytes)).toBe(artifact.sha256);
    return bytes;
  });

const artifactOf = (
  result: { readonly artifacts: ReadonlyArray<ProjectExportArtifact> },
  kind: ProjectExportArtifact["kind"],
) => {
  const artifact = result.artifacts.find((entry) => entry.kind === kind);
  expect(artifact, `artifact ${kind}`).toBeDefined();
  return artifact!;
};

/** Fetches a commits bundle like the destination's import does and returns the head it carried. */
const fetchCommitsBundle = (dest: string, bundleFile: string) => {
  git(dest, "bundle", "verify", bundleFile);
  git(dest, "fetch", "-q", "--no-tags", bundleFile, "+HEAD:refs/ryco-import/test/head");
  return git(dest, "rev-parse", "refs/ryco-import/test/head");
};

const withFixtureRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryco-export-")))),
    use,
    (root) =>
      Effect.sync(() =>
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );

describe("ProjectExportLive", () => {
  it.effect(
    "bundles unpushed commits on a pushed branch and the bundle fetches into a clone",
    () => {
      const harness = makeHarness();
      return withFixtureRoot((root) =>
        Effect.gen(function* () {
          const { source, url } = makeRemoteAndClone(root);
          commitFile(source, "a.txt", "a\n");
          const head = commitFile(source, "b.txt", "b\n");
          const project = harness.addProject(source);
          const exporter = yield* ProjectExport;

          const inspection = yield* exporter.inspect({ projectId: project.id });
          expect(inspection.repository).toMatchObject({
            isGitRepository: true,
            branch: "main",
            headOid: head,
            isDetached: false,
            primaryRemoteName: "origin",
            cloneRemoteName: "origin",
            remotes: [{ name: "origin", url }],
            isShallow: false,
          });
          expect(inspection.pushedState).toEqual({
            headOnRemote: false,
            upstreamBranch: "origin/main",
            unpushedCommitCount: 2,
          });
          const estimate = inspection.estimates.find((entry) => entry.kind === "commits-bundle");
          expect(estimate?.skippedReason).toBeNull();
          expect(estimate?.estimatedBytes).toBeGreaterThan(0);

          const input = startInput(project.id, { include: { commits: true } });
          const result = yield* exporter.start({ input, channel: "encrypted" });
          expect(result.skipped).toEqual([]);
          // Small chunks exercise offsets and eof.
          const bytes = yield* readArtifact(
            input.exportId,
            artifactOf(result, "commits-bundle"),
            97,
          );
          const bundleFile = path.join(root, "commits.bundle");
          fs.writeFileSync(bundleFile, bytes);
          const dest = freshClone(root, url);
          expect(fetchCommitsBundle(dest, bundleFile)).toBe(head);
          // Only the unpushed commits travel: the bundle needs the pushed base.
          expect(git(dest, "bundle", "list-heads", bundleFile)).toContain(head);
          expect(git(dest, "rev-list", "--count", "origin/main..refs/ryco-import/test/head")).toBe(
            "2",
          );
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("bundles a local-only branch on top of the pushed history", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source, url } = makeRemoteAndClone(root);
        git(source, "checkout", "-q", "-b", "feature/local");
        commitFile(source, "feature.txt", "one\n");
        const head = commitFile(source, "feature.txt", "two\n");
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;

        const input = startInput(project.id, { include: { commits: true } });
        const result = yield* exporter.start({ input, channel: "encrypted" });
        expect(result.repository.branch).toBe("feature/local");
        expect(result.pushedState).toEqual({
          headOnRemote: false,
          upstreamBranch: null,
          unpushedCommitCount: 2,
        });
        const bundleFile = path.join(root, "commits.bundle");
        fs.writeFileSync(
          bundleFile,
          yield* readArtifact(input.exportId, artifactOf(result, "commits-bundle")),
        );
        expect(fetchCommitsBundle(freshClone(root, url), bundleFile)).toBe(head);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("exports a detached HEAD", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source, url } = makeRemoteAndClone(root);
        const head = commitFile(source, "detached.txt", "x\n");
        git(source, "checkout", "-q", "--detach", head);
        // Only HEAD reaches the commit now.
        git(source, "branch", "-q", "-f", "main", "origin/main");
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;

        const input = startInput(project.id, { include: { commits: true } });
        const result = yield* exporter.start({ input, channel: "encrypted" });
        expect(result.repository).toMatchObject({ branch: null, headOid: head, isDetached: true });
        expect(result.pushedState).toEqual({
          headOnRemote: false,
          upstreamBranch: null,
          unpushedCommitCount: 1,
        });
        const bundleFile = path.join(root, "commits.bundle");
        fs.writeFileSync(
          bundleFile,
          yield* readArtifact(input.exportId, artifactOf(result, "commits-bundle")),
        );
        expect(fetchCommitsBundle(freshClone(root, url), bundleFile)).toBe(head);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("measures a source that is behind its remote against the remote itself", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source, url, base } = makeRemoteAndClone(root);
        // Another machine moves main ahead; the source never fetches it.
        const other = freshClone(root, url, "other");
        git(other, "checkout", "-q", "main");
        const ahead = commitFile(other, "ahead.txt", "ahead\n");
        git(other, "push", "-q", "origin", "main");
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;

        const behind = yield* exporter.start({
          input: startInput(project.id, { include: { commits: true } }),
          channel: "encrypted",
        });
        expect(behind.repository.headOid).toBe(base);
        expect(behind.pushedState.upstreamBranch).toBe("origin/main");
        // The remote's new tip is not here, so nothing it advertises excludes the base: the
        // bundle carries the base itself and never depends on a commit the clone may lack.
        expect(behind.pushedState.headOnRemote).toBe(false);

        // Behind and one local commit: the bundle still fetches into a clone of the remote, and
        // the destination ends on the source's commit, not the remote's newer tip.
        const local = commitFile(source, "local.txt", "local\n");
        const input = startInput(project.id, { include: { commits: true } });
        const result = yield* exporter.start({ input, channel: "encrypted" });
        const bundleFile = path.join(root, "commits.bundle");
        fs.writeFileSync(
          bundleFile,
          yield* readArtifact(input.exportId, artifactOf(result, "commits-bundle")),
        );
        const dest = freshClone(root, url);
        expect(git(dest, "rev-parse", "origin/main")).toBe(ahead);
        expect(fetchCommitsBundle(dest, bundleFile)).toBe(local);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  /**
   * A fork: `upstream` is the repository it came from, `origin` the fork with one more commit on
   * main, and one commit on top that is on neither.
   */
  const makeFork = (root: string) => {
    const { source, url: upstreamUrl } = makeRemoteAndClone(root);
    git(source, "remote", "rename", "origin", "upstream");
    const fork = path.join(root, "fork.git");
    git(root, "clone", "-q", "--bare", upstreamUrl, fork);
    const forkUrl = `file://${fork}`;
    git(source, "remote", "add", "origin", forkUrl);
    const pushedToFork = commitFile(source, "fork.txt", "fork\n");
    git(source, "push", "-q", "origin", "main");
    const local = commitFile(source, "local.txt", "local\n");
    return { source, upstreamUrl, forkUrl, pushedToFork, local };
  };

  it.effect("measures a fork against its own origin, not the upstream its identity names", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source, upstreamUrl, forkUrl, local } = makeFork(root);
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;

        const input = startInput(project.id, { include: { commits: true } });
        const result = yield* exporter.start({ input, channel: "encrypted" });
        // The identity (and the copy's grouping) still comes from upstream.
        expect(result.repository).toMatchObject({
          primaryRemoteName: "upstream",
          cloneRemoteName: "origin",
          canonicalKey: normalizeGitRemoteUrl(upstreamUrl),
        });
        // The commit the fork has is pushed; only the one on top is not.
        expect(result.pushedState).toEqual({
          headOnRemote: false,
          upstreamBranch: "origin/main",
          unpushedCommitCount: 1,
        });
        const bundleFile = path.join(root, "commits.bundle");
        fs.writeFileSync(
          bundleFile,
          yield* readArtifact(input.exportId, artifactOf(result, "commits-bundle")),
        );
        const dest = freshClone(root, forkUrl);
        expect(fetchCommitsBundle(dest, bundleFile)).toBe(local);
        expect(git(dest, "rev-list", "--count", "origin/main..refs/ryco-import/test/head")).toBe(
          "1",
        );
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("measures against the project's preferred remote when the checkout has it", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source, upstreamUrl, pushedToFork, local } = makeFork(root);
        const exporter = yield* ProjectExport;

        const preferred = harness.addProject(source, { preferredRemoteName: "upstream" });
        const input = startInput(preferred.id, { include: { commits: true } });
        const result = yield* exporter.start({ input, channel: "encrypted" });
        expect(result.repository).toMatchObject({
          primaryRemoteName: "upstream",
          cloneRemoteName: "upstream",
        });
        expect(result.settings.preferredRemoteName).toBe("upstream");
        // Upstream lacks the fork's commit too, so the bundle carries both.
        expect(result.pushedState).toEqual({
          headOnRemote: false,
          upstreamBranch: "upstream/main",
          unpushedCommitCount: 2,
        });
        const bundleFile = path.join(root, "commits.bundle");
        fs.writeFileSync(
          bundleFile,
          yield* readArtifact(input.exportId, artifactOf(result, "commits-bundle")),
        );
        const dest = freshClone(root, upstreamUrl);
        expect(fetchCommitsBundle(dest, bundleFile)).toBe(local);
        expect(git(dest, "rev-parse", "refs/ryco-import/test/head~1")).toBe(pushedToFork);

        // A preferred remote the checkout no longer has: origin, as without a preference.
        const stale = harness.addProject(source, { preferredRemoteName: "gone" });
        const inspection = yield* exporter.inspect({ projectId: stale.id });
        expect(inspection.repository.cloneRemoteName).toBe("origin");
        expect(inspection.pushedState.unpushedCommitCount).toBe(1);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("reads the clone remote with the repository's own ssh setup, not stale refs", () => {
    const harness = makeHarness({ realNetwork: true });
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source, bare } = makeRemoteAndClone(root);
        // The origin answers only through this repository's own `core.sshCommand` (a per-repo
        // key, as with `includeIf "gitdir:"`); the default ssh's key is refused.
        git(root, "clone", "-q", "--bare", bare, path.join(root, "o", "r.git"));
        const fakeSsh = writeFakeSsh(root);
        git(source, "remote", "set-url", "origin", "git@fakehost:o/r.git");
        git(source, "config", "core.sshCommand", fakeSsh.path);
        const denyBin = path.join(root, "deny-bin");
        write(
          path.join(denyBin, "ssh"),
          '#!/bin/sh\necho "git@fakehost: Permission denied (publickey)." >&2\nexit 255\n',
        );
        fs.chmodSync(path.join(denyBin, "ssh"), 0o755);
        const emptyGlobalConfig = path.join(root, "empty.gitconfig");
        write(emptyGlobalConfig, "");
        // `feature` was merged and deleted on the remote; its tracking ref was never pruned.
        git(source, "checkout", "-q", "-b", "feature");
        const head = commitFile(source, "feature.txt", "feature\n");
        git(source, "update-ref", "refs/remotes/origin/feature", head);
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;

        const inspection = yield* exporter.inspect({ projectId: project.id }).pipe(
          withProcessEnv({
            PATH: `${denyBin}${path.delimiter}${process.env.PATH ?? ""}`,
            GIT_SSH: undefined,
            GIT_SSH_COMMAND: undefined,
            GIT_CONFIG_GLOBAL: emptyGlobalConfig,
            GIT_CONFIG_NOSYSTEM: "1",
            FAKE_SSH_ROOT: root,
            FAKE_SSH_MODE: undefined,
          }),
        );
        // The remote has no `feature` and not its commit, whatever the tracking ref claims.
        expect(inspection.pushedState).toEqual({
          headOnRemote: false,
          upstreamBranch: null,
          unpushedCommitCount: 1,
        });
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("falls back to the clone remote's tracking refs when ls-remote fails", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source } = makeRemoteAndClone(root);
        commitFile(source, "a.txt", "a\n");
        harness.network.failLsRemote = true;
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;
        const inspection = yield* exporter.inspect({ projectId: project.id });
        expect(inspection.pushedState).toEqual({
          headOnRemote: false,
          upstreamBranch: "origin/main",
          unpushedCommitCount: 1,
        });
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("skips the commits bundle when nothing is unpushed", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source } = makeRemoteAndClone(root);
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;
        const result = yield* exporter.start({
          input: startInput(project.id, { include: { commits: true } }),
          channel: "encrypted",
        });
        expect(result.pushedState.headOnRemote).toBe(true);
        expect(result.artifacts).toEqual([]);
        expect(result.skipped).toEqual([
          { kind: "commits-bundle", reason: PROJECT_EXPORT_SKIP_REASON.nothingUnpushed },
        ]);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("round-trips untracked binary and Latin-1 files byte for byte", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source, url } = makeRemoteAndClone(root);
        commitFile(source, "tracked.txt", "one\ntwo\n");
        commitFile(source, "gone.txt", "bye\n");
        git(source, "push", "-q", "origin", "main");
        const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xfc, 0x62, 0x65, 0x72, 0x0a]);
        const binary = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256));
        write(path.join(source, "tracked.txt"), "one\nTWO\n");
        git(source, "add", "tracked.txt");
        write(path.join(source, "tracked.txt"), "one\nTWO\nthree\n");
        fs.rmSync(path.join(source, "gone.txt"));
        write(path.join(source, "notes", "latin1.txt"), latin1);
        write(path.join(source, "assets", "blob.bin"), binary);
        const indexBefore = fs.readFileSync(path.join(source, ".git", "index"));
        const objectsBefore = git(source, "count-objects", "-v");
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;

        const inspection = yield* exporter.inspect({ projectId: project.id });
        expect(inspection.workingTree).toMatchObject({
          trackedChangeCount: 2,
          untrackedCount: 2,
          hasConflicts: false,
        });

        const input = startInput(project.id, { include: { workingTreeChanges: true } });
        const result = yield* exporter.start({ input, channel: "encrypted" });
        expect(result.skipped).toEqual([]);
        const patchFile = path.join(root, "changes.patch");
        fs.writeFileSync(
          patchFile,
          yield* readArtifact(input.exportId, artifactOf(result, "changes-patch")),
        );

        // The checkout's own index and object store are untouched.
        expect(fs.readFileSync(path.join(source, ".git", "index")).equals(indexBefore)).toBe(true);
        expect(git(source, "count-objects", "-v")).toBe(objectsBefore);

        const dest = freshClone(root, url);
        git(dest, "checkout", "-q", "-f", "--detach", result.repository.headOid!);
        git(dest, "apply", "--binary", "--check", patchFile);
        git(dest, "apply", "--binary", patchFile);
        for (const name of ["tracked.txt", "notes/latin1.txt", "assets/blob.bin"]) {
          expect(
            fs.readFileSync(path.join(dest, name)).equals(fs.readFileSync(path.join(source, name))),
            name,
          ).toBe(true);
        }
        expect(fs.existsSync(path.join(dest, "gone.txt"))).toBe(false);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "carries an opted-in ignored .env only when asked and never over an unencrypted connection",
    () => {
      const harness = makeHarness();
      return withFixtureRoot((root) =>
        Effect.gen(function* () {
          const { source, url } = makeRemoteAndClone(root);
          commitFile(source, ".gitignore", ".env*\n*.local\nnode_modules/\n");
          git(source, "push", "-q", "origin", "main");
          write(path.join(source, ".env"), "SECRET=1\n");
          write(path.join(source, "apps", "web", ".env.local"), "LOCAL=1\n");
          write(path.join(source, "node_modules", "pkg", ".env"), "IGNORED_DIR=1\n");
          write(path.join(source, "big.local"), Buffer.alloc(1024 * 1024 + 1));
          write(path.join(source, "change.txt"), "untracked\n");
          const project = harness.addProject(source);
          const exporter = yield* ProjectExport;

          const inspection = yield* exporter.inspect({ projectId: project.id });
          expect(inspection.workingTree.ignoredCandidates).toEqual([
            { path: ".env", byteLength: 9 },
            { path: "apps/web/.env.local", byteLength: 8 },
          ]);

          const unknown = yield* exporter
            .start({
              input: startInput(project.id, {
                include: { workingTreeChanges: true, ignoredPaths: ["node_modules/pkg/.env"] },
              }),
              channel: "encrypted",
            })
            .pipe(Effect.flip);
          expect(unknown.code).toBe("invalid");

          const input = startInput(project.id, {
            include: { workingTreeChanges: true, ignoredPaths: [".env"] },
          });
          const result = yield* exporter.start({ input, channel: "encrypted" });
          const patch = artifactOf(result, "changes-patch");
          // The client declares it to the destination, which refuses it over an unencrypted connection.
          expect(patch.carriesIgnoredFiles).toBe(true);
          const patchFile = path.join(root, "changes.patch");
          fs.writeFileSync(patchFile, yield* readArtifact(input.exportId, patch));
          const dest = freshClone(root, url);
          git(dest, "checkout", "-q", "-f", "--detach", result.repository.headOid!);
          git(dest, "apply", "--binary", patchFile);
          expect(fs.readFileSync(path.join(dest, ".env"), "utf8")).toBe("SECRET=1\n");
          expect(fs.readFileSync(path.join(dest, "change.txt"), "utf8")).toBe("untracked\n");
          expect(fs.existsSync(path.join(dest, "apps", "web", ".env.local"))).toBe(false);

          // The same export is not readable, nor joinable, over an unencrypted connection.
          const denied = yield* exporter
            .readChunk(
              { exportId: input.exportId, artifactId: patch.artifactId, offset: 0, length: 1024 },
              "unencrypted",
            )
            .pipe(Effect.flip);
          expect(denied.code).toBe("access-denied");
          const joined = yield* exporter.start({ input, channel: "unencrypted" }).pipe(Effect.flip);
          expect(joined.code).toBe("access-denied");

          // Started over an unencrypted connection, the ignored file stays home.
          const plaintextInput = startInput(project.id, {
            include: { workingTreeChanges: true, ignoredPaths: [".env"] },
          });
          const plaintext = yield* exporter.start({
            input: plaintextInput,
            channel: "unencrypted",
          });
          expect(plaintext.skipped).toContainEqual({
            kind: "changes-patch",
            reason: PROJECT_EXPORT_SKIP_REASON.insecureChannel,
          });
          expect(artifactOf(plaintext, "changes-patch").carriesIgnoredFiles).toBeUndefined();
          const plainPatch = yield* readArtifact(
            plaintextInput.exportId,
            artifactOf(plaintext, "changes-patch"),
            160 * 1024,
            "unencrypted",
          );
          expect(plainPatch.toString("utf8")).toContain("change.txt");
          expect(plainPatch.toString("utf8")).not.toContain("SECRET");
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("skips a patch over its limit, before and after building it", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source } = makeRemoteAndClone(root);
        const noise = (length: number) =>
          Buffer.from(Array.from({ length }, () => Math.floor(Math.random() * 256)));
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;

        // 10 KiB untracked against a 1 KiB limit: refused before anything is hashed.
        write(path.join(source, "huge.bin"), noise(10 * 1024));
        const objectsBefore = git(source, "count-objects", "-v");
        const before = yield* exporter.start({
          input: startInput(project.id, {
            include: { workingTreeChanges: true },
            patchLimitBytes: 1024,
          }),
          channel: "encrypted",
        });
        expect(before.artifacts).toEqual([]);
        expect(before.skipped).toEqual([
          { kind: "changes-patch", reason: PROJECT_EXPORT_SKIP_REASON.overLimit },
        ]);
        expect(git(source, "count-objects", "-v")).toBe(objectsBefore);

        // 3 KiB passes the pre-check (4 × limit), the patch itself does not.
        fs.rmSync(path.join(source, "huge.bin"));
        write(path.join(source, "medium.bin"), noise(3 * 1024));
        const after = yield* exporter.start({
          input: startInput(project.id, {
            include: { workingTreeChanges: true },
            patchLimitBytes: 1024,
          }),
          channel: "encrypted",
        });
        expect(after.artifacts).toEqual([]);
        expect(after.skipped).toEqual([
          { kind: "changes-patch", reason: PROJECT_EXPORT_SKIP_REASON.overLimit },
        ]);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses a whole-repository bundle of a shallow clone", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source, url } = makeRemoteAndClone(root);
        commitFile(source, "second.txt", "2\n");
        git(source, "push", "-q", "origin", "main");
        const shallow = path.join(root, "shallow");
        git(root, "clone", "-q", "--depth", "1", url, shallow);
        configureRepo(shallow);
        const project = harness.addProject(shallow);
        const exporter = yield* ProjectExport;
        const result = yield* exporter.start({
          input: startInput(project.id, { include: { wholeRepository: true } }),
          channel: "encrypted",
        });
        expect(result.repository.isShallow).toBe(true);
        expect(result.artifacts).toEqual([]);
        expect(result.skipped).toEqual([
          { kind: "repository-bundle", reason: PROJECT_EXPORT_SKIP_REASON.shallow },
        ]);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("bundles branches, tags and remote refs, never checkpoints or stashes", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source } = makeRemoteAndClone(root);
        const head = commitFile(source, "a.txt", "a\n");
        git(source, "tag", "v1");
        git(source, "branch", "side");
        git(source, "update-ref", "refs/ryco/checkpoints/thread/turn/1", head);
        write(path.join(source, "a.txt"), "stashed\n");
        git(source, "stash", "-q");
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;

        const input = startInput(project.id, { include: { wholeRepository: true } });
        const result = yield* exporter.start({ input, channel: "encrypted" });
        const bundleFile = path.join(root, "repository.bundle");
        fs.writeFileSync(
          bundleFile,
          yield* readArtifact(input.exportId, artifactOf(result, "repository-bundle")),
        );
        const heads = git(root, "bundle", "list-heads", bundleFile);
        expect(heads).toContain("refs/heads/main");
        expect(heads).toContain("refs/heads/side");
        expect(heads).toContain("refs/tags/v1");
        expect(heads).toContain("refs/remotes/origin/main");
        expect(heads).not.toContain("refs/ryco");
        expect(heads).not.toContain("refs/stash");

        const dest = path.join(root, "from-bundle");
        git(root, "init", "-q", dest);
        configureRepo(dest);
        git(
          dest,
          "fetch",
          "-q",
          "--no-tags",
          bundleFile,
          "+refs/heads/*:refs/heads/*",
          "+refs/tags/*:refs/tags/*",
          "+refs/remotes/*:refs/remotes/*",
        );
        expect(git(dest, "rev-parse", "refs/heads/main")).toBe(head);
        expect(git(dest, "rev-parse", "refs/tags/v1")).toBe(head);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("skips commits and the patch of a repository without commits", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const source = path.join(root, "unborn");
        git(root, "init", "-q", "-b", "main", source);
        configureRepo(source);
        write(path.join(source, "file.txt"), "x\n");
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;
        const result = yield* exporter.start({
          input: startInput(project.id, {
            include: { commits: true, workingTreeChanges: true, wholeRepository: true },
          }),
          channel: "encrypted",
        });
        expect(result.repository).toMatchObject({
          branch: "main",
          headOid: null,
          isDetached: false,
        });
        expect(result.artifacts).toEqual([]);
        expect(result.skipped).toEqual([
          { kind: "commits-bundle", reason: PROJECT_EXPORT_SKIP_REASON.noCommits },
          { kind: "repository-bundle", reason: PROJECT_EXPORT_SKIP_REASON.noCommits },
          { kind: "changes-patch", reason: PROJECT_EXPORT_SKIP_REASON.noCommits },
        ]);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves nested repositories and LFS files out of the patch and lists them", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source, url } = makeRemoteAndClone(root);
        commitFile(source, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
        git(source, "push", "-q", "origin", "main");
        const nested = path.join(source, "vendor", "nested");
        git(source, "init", "-q", nested);
        write(path.join(nested, "inner.txt"), "inner\n");
        write(path.join(source, "model.bin"), Buffer.alloc(2048, 7));
        write(path.join(source, "kept.txt"), "kept\n");
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;

        const input = startInput(project.id, { include: { workingTreeChanges: true } });
        const result = yield* exporter.start({ input, channel: "encrypted" });
        expect(result.repository.usesLfs).toBe(true);
        expect(result.skipped).toEqual([
          { kind: "changes-patch", reason: "nested repository: vendor/nested" },
          { kind: "changes-patch", reason: "lfs: model.bin" },
        ]);
        const patchFile = path.join(root, "changes.patch");
        fs.writeFileSync(
          patchFile,
          yield* readArtifact(input.exportId, artifactOf(result, "changes-patch")),
        );
        const dest = freshClone(root, url);
        git(dest, "checkout", "-q", "-f", "--detach", result.repository.headOid!);
        git(dest, "apply", "--binary", patchFile);
        expect(fs.readFileSync(path.join(dest, "kept.txt"), "utf8")).toBe("kept\n");
        expect(fs.existsSync(path.join(dest, "model.bin"))).toBe(false);
        expect(fs.existsSync(path.join(dest, "vendor"))).toBe(false);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "exports a monorepo subfolder project, a registered worktree, and refuses others",
    () => {
      const harness = makeHarness();
      return withFixtureRoot((root) =>
        Effect.gen(function* () {
          const { source } = makeRemoteAndClone(root);
          commitFile(source, "apps/web/package.json", "{}\n");
          const project = harness.addProject(path.join(source, "apps", "web"));
          const exporter = yield* ProjectExport;

          const subfolder = yield* exporter.inspect({ projectId: project.id });
          expect(subfolder.repository.rootPath).toBe(source);
          expect(subfolder.settings.relativeRootInRepository).toBe("apps/web");

          const worktreePath = path.join(root, "wt");
          git(source, "worktree", "add", "-q", "-b", "wt-branch", worktreePath);
          const strayPath = path.join(root, "stray");
          git(source, "worktree", "add", "-q", "-b", "stray-branch", strayPath);
          harness.worktrees.push({
            worktreeId: "worktree-1",
            projectId: project.id,
            branch: "wt-branch",
            worktreePath,
            checkoutRemovedAt: null,
          } as unknown as OrchestrationWorktreeShell);
          const fromWorktree = yield* exporter.inspect({
            projectId: project.id,
            checkoutPath: worktreePath,
          });
          expect(fromWorktree.repository).toMatchObject({
            rootPath: worktreePath,
            branch: "wt-branch",
          });

          const refused = yield* exporter
            .inspect({ projectId: project.id, checkoutPath: strayPath })
            .pipe(Effect.flip);
          expect(refused.code).toBe("invalid");
          const missing = yield* exporter
            .inspect({ projectId: ProjectId.make("missing") })
            .pipe(Effect.flip);
          expect(missing.code).toBe("not-found");
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("exports settings and the custom avatar of a folder without git", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const folder = path.join(root, "plain");
        write(path.join(folder, "notes.md"), "notes\n");
        const project = harness.addProject(folder, {
          title: "Plain",
          customSystemPrompt: "Be brief.",
          customAvatarContentHash: "hash",
          preferredRemoteName: "origin",
          scripts: [
            {
              id: "setup",
              name: "Setup",
              command: "make",
              icon: "configure",
              runOnWorktreeCreate: true,
            },
          ],
        });
        const avatar = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        harness.avatarBytes.set(project.id, avatar);
        const exporter = yield* ProjectExport;

        const input = startInput(project.id, {
          include: { commits: true, workingTreeChanges: true, avatar: true },
        });
        const result = yield* exporter.start({ input, channel: "encrypted" });
        expect(result.repository).toMatchObject({ isGitRepository: false, rootPath: folder });
        expect(result.settings).toEqual({
          title: "Plain",
          scripts: project.scripts,
          customSystemPrompt: "Be brief.",
          preferredRemoteName: "origin",
          projectMetadataDir: ".ryco",
          hasCustomAvatar: true,
          relativeRootInRepository: "",
        });
        expect(result.skipped).toEqual([
          { kind: "commits-bundle", reason: PROJECT_EXPORT_SKIP_REASON.notGitRepository },
          { kind: "changes-patch", reason: PROJECT_EXPORT_SKIP_REASON.notGitRepository },
        ]);
        const bytes = yield* readArtifact(input.exportId, artifactOf(result, "avatar"));
        expect(bytes.equals(avatar)).toBe(true);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("builds once per export id, expires after the last read, and disposes", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source } = makeRemoteAndClone(root);
        commitFile(source, "a.txt", "a\n");
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;
        const config = yield* ServerConfig;
        const exportsRoot = path.join(config.stateDir, "project-exports");

        const input = startInput(project.id, { include: { commits: true } });
        const [first, second] = yield* Effect.all(
          [
            exporter.start({ input, channel: "encrypted" }),
            exporter.start({ input, channel: "encrypted" }),
          ],
          { concurrency: "unbounded" },
        );
        expect(second.artifacts).toEqual(first.artifacts);
        expect(harness.network.lsRemoteCalls).toBe(1);
        const conflict = yield* exporter
          .start({ input: { ...input, include: include({ avatar: true }) }, channel: "encrypted" })
          .pipe(Effect.flip);
        expect(conflict.code).toBe("conflict");

        const artifact = artifactOf(first, "commits-bundle");
        const unknown = yield* exporter
          .readChunk({ exportId: input.exportId, artifactId: "commits", offset: 0, length: 16 })
          .pipe(Effect.flip);
        expect(unknown.code).toBe("not-found");
        const past = yield* exporter
          .readChunk({
            exportId: input.exportId,
            artifactId: artifact.artifactId,
            offset: artifact.byteLength + 1,
            length: 16,
          })
          .pipe(Effect.flip);
        expect(past.code).toBe("invalid");

        // A read slides the TTL; 30 minutes without one expires the export.
        yield* TestClock.adjust("20 minutes");
        yield* exporter.readChunk({
          exportId: input.exportId,
          artifactId: artifact.artifactId,
          offset: 0,
          length: 16,
        });
        yield* TestClock.adjust("20 minutes");
        yield* exporter.sweep();
        expect(fs.existsSync(path.join(exportsRoot, input.exportId))).toBe(true);
        yield* TestClock.adjust("11 minutes");
        yield* exporter.sweep();
        expect(fs.existsSync(path.join(exportsRoot, input.exportId))).toBe(false);
        const expired = yield* exporter
          .readChunk({
            exportId: input.exportId,
            artifactId: artifact.artifactId,
            offset: 0,
            length: 16,
          })
          .pipe(Effect.flip);
        expect(expired.code).toBe("not-found");

        // Dispose deletes at once; a leftover directory of an earlier process goes on sweep.
        const other = startInput(project.id, { include: { commits: true } });
        yield* exporter.start({ input: other, channel: "encrypted" });
        expect(fs.existsSync(path.join(exportsRoot, other.exportId))).toBe(true);
        yield* exporter.dispose({ exportId: other.exportId });
        yield* exporter.dispose({ exportId: other.exportId });
        expect(fs.existsSync(path.join(exportsRoot, other.exportId))).toBe(false);
        const leftover = path.join(exportsRoot, randomUUID());
        write(path.join(leftover, "commits.bundle"), "old");
        yield* exporter.sweep();
        expect(fs.existsSync(leftover)).toBe(false);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps a build running for a retry when its caller leaves, and dispose stops it", () => {
    const harness = makeHarness();
    return withFixtureRoot((root) =>
      Effect.gen(function* () {
        const { source } = makeRemoteAndClone(root);
        commitFile(source, "a.txt", "a\n");
        const project = harness.addProject(source);
        const exporter = yield* ProjectExport;
        const config = yield* ServerConfig;
        const release = yield* Deferred.make<void>();
        const reached = yield* Deferred.make<void>();
        harness.network.hold = { reached, release: Deferred.await(release) };

        // The caller disconnects mid-build; its retry joins the same build.
        const input = startInput(project.id, { include: { commits: true } });
        const caller = yield* exporter
          .start({ input, channel: "encrypted" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(reached);
        yield* Fiber.interrupt(caller);
        const retry = yield* exporter.start({ input, channel: "encrypted" }).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(retry);
        expect(artifactOf(result, "commits-bundle").byteLength).toBeGreaterThan(0);
        expect(harness.network.lsRemoteCalls).toBe(1);

        // Disposed mid-build: waiters fail, nothing stays on disk.
        const held = yield* Deferred.make<void>();
        const heldReached = yield* Deferred.make<void>();
        harness.network.hold = { reached: heldReached, release: Deferred.await(held) };
        const disposed = startInput(project.id, { include: { commits: true } });
        const waiter = yield* exporter
          .start({ input: disposed, channel: "encrypted" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(heldReached);
        expect(harness.network.lsRemoteCalls).toBe(2);
        yield* exporter.dispose({ exportId: disposed.exportId });
        const failure = yield* Fiber.join(waiter);
        expect(failure.code).toBe("not-found");
        expect(
          fs.existsSync(path.join(config.stateDir, "project-exports", disposed.exportId)),
        ).toBe(false);
      }),
    ).pipe(Effect.provide(harness.layer));
  });
});
