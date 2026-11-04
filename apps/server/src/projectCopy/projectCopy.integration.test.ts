/**
 * Cross-node project copy end to end, in one process: two nodes A and B, each with its own state
 * directory, SQLite database, orchestration engine and the real project copy services
 * (`ProjectCopyServicesLive`, composed as `server.ts` composes it). The test plays the client in
 * the middle, as the coordinator does: A exports, the client reads A's chunks and uploads them to
 * B, B imports and the client follows the job to its end.
 *
 * A's checkout is a fork: `origin` (`git@fakehost:o/r.git`) is the fork, with a commit the
 * repository it came from, `upstream` (`git@fakehost:u/r.git`), lacks. Both are bare repositories
 * served over a fake `ssh`, so the network git path (non-interactive env, batch ssh, ls-remote,
 * clone) is the production one. Only the source-control provider registry is a stub: these
 * remotes have no forge.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, type ProjectScript } from "@ryco/contracts";
import {
  projectCopyChunkBytes,
  projectCopyPipelineLimits,
  pumpProjectCopyChunks,
} from "@ryco/client-runtime/projectCopy";
import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_COPY_DIRECT_CHUNK_BYTES,
  ProjectExportId,
  ProjectImportId,
  ProjectTransferId,
  type ProjectExportArtifact,
  type ProjectExportResult,
  type ProjectExportStartInput,
  type ProjectImportSnapshot,
  type ProjectImportStartInput,
} from "@ryco/contracts/project-copy";
import { Effect, Option, Stream } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectCopyServicesLive } from "./Layers/ProjectCopyServices.ts";
import { PROJECT_IMPORTS_DIRECTORY, PROJECT_TRANSFERS_DIRECTORY } from "./projectCopyStartup.ts";
import {
  commitFiles,
  git,
  initRepository,
  tempRoots,
  withProcessEnv,
  withSimulatedLatency,
  writeFakeSsh,
} from "./projectCopyGit.fixtures.ts";
import { startProjectCopyNode } from "./projectCopyNodes.fixtures.ts";
import { ProjectExport } from "./Services/ProjectExport.ts";
import { ProjectImports } from "./Services/ProjectImports.ts";
import { ProjectTransfers } from "./Services/ProjectTransfers.ts";

const roots = tempRoots();
afterEach(() => roots.cleanup());

const ORIGIN_URL = "git@fakehost:o/r.git";
const UPSTREAM_URL = "git@fakehost:u/r.git";
/** B's view of the origin when it cannot reach it; no https counterpart (a port), no network. */
const UNREACHABLE_URL = "ssh://git@fakehost:2222/o/r.git";
const SETUP_SCRIPT: ProjectScript = {
  id: "setup",
  name: "Setup",
  command: "printf 'set up' > setup-ran.txt",
  icon: "configure",
  runOnWorktreeCreate: true,
};
const BINARY = new Uint8Array([0, 1, 2, 3, 255, 254, 0, 10, 13, 0, 0x80, 0x7f, 0xc3, 0x28]);
/** Every file of A's working tree a copy must reproduce byte for byte. */
const COPIED_FILES = [
  "README.md",
  "src/main.ts",
  "src/feature.ts",
  "assets/committed.bin",
  "assets/untracked.bin",
  ".env",
];

// ── Nodes ─────────────────────────────────────────────────────────────

type TestNode = Effect.Success<ReturnType<typeof startNode>>;

/** Builds a node in the test's scope; a second call builds a second, separate node. */
const startNode = (name: string) => startProjectCopyNode(roots, name, ProjectCopyServicesLive);

// ── Fixture ───────────────────────────────────────────────────────────

interface Fixture {
  readonly root: string;
  /** The user's checkout on A: branch `feature`, unpushed commits and uncommitted changes. */
  readonly source: string;
  readonly fakeSsh: string;
}

/**
 * Bare repositories at `git@fakehost:u/r.git` (upstream) and `git@fakehost:o/r.git` (its fork,
 * one commit ahead on main), and A's checkout of the fork with both remotes, ahead and dirty.
 */
const makeFixture = (): Fixture => {
  const root = realpathSync(roots.make("ryco-xnode-fixture-"));
  const work = initRepository(path.join(root, "work"));
  commitFiles(
    work,
    { "README.md": "# App\n", ".gitignore": ".env\nnode_modules/\n", "src/main.ts": "main\n" },
    "first",
  );
  git(root, "clone", "--quiet", "--bare", "--", work, path.join(root, "u", "r.git"));
  // The fork's own work on main: on origin, never on upstream.
  commitFiles(work, { "src/fork.ts": "fork\n" }, "fork only");
  const bare = path.join(root, "o", "r.git");
  git(root, "clone", "--quiet", "--bare", "--", work, bare);
  const { path: fakeSsh } = writeFakeSsh(root);

  const source = path.join(root, "a", "app");
  mkdirSync(path.dirname(source), { recursive: true });
  git(root, "clone", "--quiet", "--", bare, source);
  initRepository(source);
  git(source, "remote", "set-url", "origin", ORIGIN_URL);
  git(source, "remote", "add", "upstream", UPSTREAM_URL);
  // Two commits only A has, one of them binary.
  git(source, "checkout", "--quiet", "-b", "feature");
  commitFiles(source, { "src/feature.ts": "feature\n" }, "feature one");
  commitFiles(source, { "assets/committed.bin": BINARY }, "feature two");
  // Uncommitted: a modified file, an untracked binary and an ignored .env the user opts in.
  writeFileSync(path.join(source, "README.md"), "# App\n\nEdited on A.\n");
  writeFileSync(path.join(source, "assets", "untracked.bin"), BINARY.toReversed());
  writeFileSync(path.join(source, ".env"), "SECRET=on-a\n");
  return { root, source, fakeSsh };
};

/** The fake ssh serves `git@fakehost:<path>` from the fixture root (the env is process-wide). */
const servedBy = (fixture: Fixture) =>
  withProcessEnv({
    GIT_SSH_COMMAND: fixture.fakeSsh,
    FAKE_SSH_ROOT: fixture.root,
    FAKE_SSH_MODE: undefined,
  });

const statusOf = (repository: string) =>
  execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repository,
    encoding: "utf8",
  });

/** A fresh `Code` folder on B, as its default project directory. */
const codeFolderOnB = () => {
  const code = path.join(realpathSync(roots.make("ryco-xnode-b-home-")), "Code");
  mkdirSync(code);
  return code;
};

// ── The client in the middle ──────────────────────────────────────────

/** The overrides the source project sets for itself on A that a copy carries. */
const SOURCE_OVERRIDES = { defaultThreadEnvMode: "worktree", pullRequestTemplates: false } as const;

/** Registers the source project on A, with the settings a copy carries (and one it leaves). */
const registerSource = (fixture: Fixture) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projectId = ProjectId.make(`source-${randomUUID()}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`create-${projectId}`),
      projectId,
      title: "App",
      workspaceRoot: fixture.source,
      projectMetadataDir: ".ryco",
      createWorkspaceRootIfMissing: false,
      customSystemPrompt: "Be careful with the database.",
      createdAt: new Date().toISOString(),
    });
    yield* engine.dispatch({
      type: "project.meta.update",
      commandId: CommandId.make(`meta-${projectId}`),
      projectId,
      scripts: [SETUP_SCRIPT],
      preferredRemoteName: "origin",
    });
    const settings = yield* ServerSettingsService;
    yield* settings.updateSettings({
      projectPreferences: {
        [projectId]: {
          ...SOURCE_OVERRIDES,
          // Names one of A's provider instances: it stays on A.
          initialModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        },
      },
    });
    return projectId;
  });

const exportFromA = (
  a: TestNode,
  projectId: ProjectId,
  include: Partial<ProjectExportStartInput["include"]>,
) =>
  a.run(
    Effect.gen(function* () {
      const exporter = yield* ProjectExport;
      const exportId = ProjectExportId.make(randomUUID());
      const result = yield* exporter.start({
        input: {
          exportId,
          projectId,
          include: {
            commits: false,
            workingTreeChanges: false,
            ignoredPaths: [],
            wholeRepository: false,
            avatar: false,
            ...include,
          },
        },
        channel: "encrypted",
      });
      return { exportId, result };
    }),
  );

/** A's chunk of an artifact, read as the coordinator reads it. */
const readFromA = (
  a: TestNode,
  exportId: ProjectExportId,
  artifact: ProjectExportArtifact,
  offset: number,
  length: number,
) =>
  Effect.runPromise(
    a.run(
      Effect.gen(function* () {
        const exporter = yield* ProjectExport;
        const chunk = yield* exporter.readChunk(
          { exportId, artifactId: artifact.artifactId, offset, length },
          "encrypted",
        );
        assert.equal(chunk.offset, offset);
        assert.equal(chunk.length, length);
        return chunk.dataBase64;
      }),
    ),
  );

/** Appends a chunk to B's transfer; resolves with B's `receivedBytes`. */
const appendToB = (
  b: TestNode,
  transferId: ProjectTransferId,
  offset: number,
  dataBase64: string,
) =>
  Effect.runPromise(
    b.run(
      Effect.gen(function* () {
        const transfers = yield* ProjectTransfers;
        return (yield* transfers.append({ transferId, offset, dataBase64 }, "encrypted"))
          .receivedBytes;
      }),
    ),
  );

const beginOnB = (b: TestNode, transferId: ProjectTransferId, artifact: ProjectExportArtifact) =>
  b.run(
    Effect.gen(function* () {
      const transfers = yield* ProjectTransfers;
      return yield* transfers.begin(
        {
          transferId,
          purpose: artifact.kind,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256,
        },
        "encrypted",
      );
    }),
  );

const commitOnB = (b: TestNode, transferId: ProjectTransferId) =>
  b.run(
    Effect.gen(function* () {
      const transfers = yield* ProjectTransfers;
      return yield* transfers.commit({ transferId });
    }),
  );

/**
 * Reads each artifact from A and uploads it to B through the coordinator's chunk pipeline
 * (reads ahead, several appends in flight, at the chunk size both nodes announce); B's
 * transfer ids by kind.
 */
const transferArtifacts = (
  a: TestNode,
  b: TestNode,
  exportId: ProjectExportId,
  exported: ProjectExportResult,
) =>
  Effect.gen(function* () {
    const transferIds = new Map<ProjectExportArtifact["kind"], ProjectTransferId>();
    for (const artifact of exported.artifacts) {
      const transferId = ProjectTransferId.make(randomUUID());
      const begun = yield* beginOnB(b, transferId, artifact);
      assert.equal(begun.receivedBytes, 0);
      const chunkBytes = projectCopyChunkBytes({
        source: { transport: "direct", maxChunkBytes: exported.maxChunkBytes },
        target: { transport: "direct", maxChunkBytes: begun.maxChunkBytes },
      });
      assert.equal(chunkBytes, PROJECT_COPY_DIRECT_CHUNK_BYTES);
      let chunks = 0;
      const pumped = yield* Effect.promise(() =>
        pumpProjectCopyChunks({
          byteLength: artifact.byteLength,
          start: 0,
          limits: projectCopyPipelineLimits(chunkBytes),
          read: (offset, length) => readFromA(a, exportId, artifact, offset, length),
          append: (offset, dataBase64) => {
            chunks += 1;
            return appendToB(b, transferId, offset, dataBase64);
          },
        }),
      );
      assert.equal(pumped, "done");
      assert.isAtLeast(chunks, 1);
      const committed = yield* commitOnB(b, transferId);
      assert.equal(committed.sha256, artifact.sha256);
      assert.equal(committed.byteLength, artifact.byteLength);
      transferIds.set(artifact.kind, transferId);
    }
    return transferIds;
  });

const disposeOnA = (a: TestNode, exportId: ProjectExportId) =>
  a.run(
    Effect.gen(function* () {
      const exporter = yield* ProjectExport;
      yield* exporter.dispose({ exportId });
    }),
  );

/** The import input the coordinator builds from an export and the user's choices. */
const importInputFrom = (
  exported: ProjectExportResult,
  options: {
    readonly projectId: ProjectId;
    readonly destinationPath: string;
    readonly source: ProjectImportStartInput["source"];
    readonly transfers: ReadonlyMap<ProjectExportArtifact["kind"], ProjectTransferId>;
  },
): ProjectImportStartInput => {
  const commits = options.transfers.get("commits-bundle");
  const changes = options.transfers.get("changes-patch");
  const cloneRemoteName = options.source.kind === "clone" ? options.source.remoteName : null;
  const headOid = exported.repository.headOid as NonNullable<
    NonNullable<ProjectImportStartInput["checkout"]>["headOid"]
  >;
  return {
    importId: ProjectImportId.make(randomUUID()),
    projectId: options.projectId,
    title: exported.settings.title,
    destinationPath: options.destinationPath,
    source: options.source,
    // Every other remote is recreated (upstream too), so B's copy keeps A's identity.
    remotes: exported.repository.remotes
      .filter((remote) => remote.name !== cloneRemoteName)
      .map((remote) => ({ name: remote.name, url: remote.url })),
    commits: commits === undefined ? null : { transferId: commits },
    checkout: { branch: exported.repository.branch, headOid },
    changes:
      changes === undefined
        ? null
        : { transferId: changes, baseOid: headOid, ignoredPaths: [".env"] },
    relativeRootInRepository: exported.settings.relativeRootInRepository,
    recurseSubmodules: exported.repository.hasSubmodules,
    // As Agent Control's import asks: the destination finds out whether LFS is in use.
    usesLfs: true,
    settings: {
      scripts: exported.settings.scripts,
      customSystemPrompt: exported.settings.customSystemPrompt,
      preferredRemoteName: exported.settings.preferredRemoteName,
      projectMetadataDir: exported.settings.projectMetadataDir,
      overrides: exported.settings.overrides,
    },
    avatarTransferId: null,
    setup: { command: SETUP_SCRIPT.command, saveAsScript: false },
    followUpThread: null,
    origin: { kind: "user", sourceLabel: "Node A", proposalId: null },
  } as ProjectImportStartInput;
};

/** Starts the import on B and follows it to its terminal snapshot. */
const importOnB = (b: TestNode, input: ProjectImportStartInput) =>
  b.run(
    Effect.gen(function* () {
      const imports = yield* ProjectImports;
      const started = yield* imports.start(input);
      assert.equal(started.importId, input.importId);
      return yield* imports.subscribe({ importId: input.importId }).pipe(
        Stream.filter((snapshot) => snapshot.status !== "running"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.timeout("90 seconds"),
      );
    }),
  );

const stepStatuses = (snapshot: ProjectImportSnapshot) =>
  Object.fromEntries(snapshot.steps.map((step) => [step.id, step.status]));

const transferFilesOf = (stateDir: string) => {
  const directory = path.join(stateDir, PROJECT_TRANSFERS_DIRECTORY);
  return existsSync(directory) ? readdirSync(directory) : [];
};

/** B's checkout ends where A's is: its commit, branch, and every file byte for byte. */
const assertSameCheckout = (fixture: Fixture, destination: string) => {
  assert.equal(git(destination, "rev-parse", "HEAD"), git(fixture.source, "rev-parse", "HEAD"));
  assert.equal(git(destination, "symbolic-ref", "--short", "HEAD"), "feature");
  assert.equal(git(destination, "remote", "get-url", "origin"), ORIGIN_URL);
  assert.equal(git(destination, "remote", "get-url", "upstream"), UPSTREAM_URL);
  for (const relative of COPIED_FILES) {
    assert.deepEqual(
      readFileSync(path.join(destination, relative)),
      readFileSync(path.join(fixture.source, relative)),
      relative,
    );
  }
  // The changes stay uncommitted and unstaged, the .env stays ignored; only setup's file is new.
  assert.equal(statusOf(destination).replace("?? setup-ran.txt\n", ""), statusOf(fixture.source));
  // The setup command ran in the project root.
  assert.equal(readFileSync(path.join(destination, "setup-ran.txt"), "utf8"), "set up");
};

/** The repository identity's canonical key of a checkout on a node. */
const canonicalKeyOf = (node: TestNode, checkout: string) =>
  node.run(
    Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver;
      return (yield* resolver.resolve(checkout))?.canonicalKey ?? null;
    }),
  );

/**
 * B registered the project with A's title, root, prompt, preferred remote, scripts and
 * overrides, without A's initial model.
 */
const assertRegistered = (b: TestNode, input: ProjectImportStartInput, destination: string) =>
  b.run(
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const project = yield* query.getProjectShellById(input.projectId);
      assert.isTrue(Option.isSome(project));
      if (Option.isNone(project)) return;
      assert.equal(project.value.title, "App");
      assert.equal(project.value.workspaceRoot, destination);
      assert.equal(project.value.customSystemPrompt, "Be careful with the database.");
      assert.equal(project.value.preferredRemoteName, "origin");
      assert.deepEqual(project.value.scripts, [SETUP_SCRIPT]);
      const settings = yield* (yield* ServerSettingsService).getSettings;
      assert.deepEqual(settings.projectPreferences[input.projectId], SOURCE_OVERRIDES);
    }),
  );

// ── Tests ─────────────────────────────────────────────────────────────

describe("cross-node project copy", () => {
  it.live(
    "copies a project from A to B: clone, unpushed commits, changes, settings and setup",
    () => {
      const fixture = makeFixture();
      return Effect.gen(function* () {
        const a = yield* startNode("a");
        const b = yield* startNode("b");
        const projectId = yield* a.run(registerSource(fixture));

        // A: what a copy would carry, then the artifacts.
        const inspection = yield* a.run(
          Effect.gen(function* () {
            const exporter = yield* ProjectExport;
            return yield* exporter.inspect({ projectId });
          }),
        );
        assert.equal(inspection.repository.branch, "feature");
        assert.equal(inspection.repository.headOid, git(fixture.source, "rev-parse", "HEAD"));
        // The identity comes from upstream; the copy clones the fork and measures against it.
        assert.equal(inspection.repository.primaryRemoteName, "upstream");
        assert.equal(inspection.repository.cloneRemoteName, "origin");
        assert.equal(inspection.repository.canonicalKey, "fakehost/u/r");
        assert.isFalse(inspection.pushedState.headOnRemote);
        // The fork's commit is on origin: only A's two feature commits are unpushed.
        assert.equal(inspection.pushedState.unpushedCommitCount, 2);
        assert.include(
          inspection.workingTree.ignoredCandidates.map((candidate) => candidate.path),
          ".env",
        );

        const { exportId, result: exported } = yield* exportFromA(a, projectId, {
          commits: true,
          workingTreeChanges: true,
          ignoredPaths: [".env"],
        });
        assert.deepEqual(exported.artifacts.map((artifact) => artifact.kind).toSorted(), [
          "changes-patch",
          "commits-bundle",
        ]);
        assert.deepEqual(exported.repository.remotes, [
          { name: "origin", url: ORIGIN_URL },
          { name: "upstream", url: UPSTREAM_URL },
        ]);
        assert.equal(exported.repository.cloneRemoteName, "origin");
        assert.deepEqual(exported.settings.scripts, [SETUP_SCRIPT]);
        assert.deepEqual(exported.settings.overrides, SOURCE_OVERRIDES);

        // The client in the middle: A's chunks become B's transfers; then the export goes.
        const transfers = yield* transferArtifacts(a, b, exportId, exported);
        yield* disposeOnA(a, exportId);
        assert.isFalse(existsSync(path.join(a.stateDir, "project-exports", exportId)));

        // B: the import job, followed to its end.
        const destination = path.join(codeFolderOnB(), "app");
        const input = importInputFrom(exported, {
          projectId: ProjectId.make(`copy-${randomUUID()}`),
          destinationPath: destination,
          source: { kind: "clone", remoteUrl: ORIGIN_URL, remoteName: "origin" },
          transfers,
        });
        const terminal = yield* importOnB(b, input);
        assert.equal(terminal.status, "completed", JSON.stringify(terminal.error));
        assert.deepEqual(terminal.warnings, []);
        assert.deepEqual(stepStatuses(terminal), {
          preflight: "done",
          clone: "done",
          remotes: "done",
          commits: "done",
          checkout: "done",
          changes: "done",
          submodules: "skipped",
          // Asked for, but the checkout tracks no LFS files: skipped without a warning.
          lfs: "skipped",
          register: "done",
          settings: "done",
          avatar: "skipped",
          setup: "done",
          "follow-up": "skipped",
        });
        assert.deepEqual(terminal.preflight, { remoteReachable: true, alternateRemoteUrl: null });
        assert.isNull(terminal.leftoverPath);

        assertSameCheckout(fixture, destination);
        yield* assertRegistered(b, input, destination);
        // Same identity on both nodes: the copy groups with A's checkout.
        assert.equal(yield* canonicalKeyOf(b, destination), "fakehost/u/r");
        assert.equal(yield* canonicalKeyOf(a, fixture.source), "fakehost/u/r");

        // Every upload was claimed by the job and released with it.
        assert.deepEqual(transferFilesOf(b.stateDir), []);
        assert.isFalse(
          existsSync(path.join(b.stateDir, PROJECT_IMPORTS_DIRECTORY, input.importId)),
        );
      }).pipe(servedBy(fixture), Effect.scoped);
    },
    { timeout: 180_000 },
  );

  it.live(
    "a remote B cannot reach fails before anything is created, and Send files copies it instead",
    () => {
      const fixture = makeFixture();
      return Effect.gen(function* () {
        const a = yield* startNode("a");
        const b = yield* startNode("b");
        const projectId = yield* a.run(registerSource(fixture));
        const code = codeFolderOnB();
        const destination = path.join(code, "app");
        const copyProjectId = ProjectId.make(`copy-${randomUUID()}`);

        // First try: clone from the origin, which B cannot reach.
        const first = yield* exportFromA(a, projectId, {
          commits: true,
          workingTreeChanges: true,
          ignoredPaths: [".env"],
        });
        const firstTransfers = yield* transferArtifacts(a, b, first.exportId, first.result);
        yield* disposeOnA(a, first.exportId);
        const unreachable = importInputFrom(first.result, {
          projectId: copyProjectId,
          destinationPath: destination,
          source: { kind: "clone", remoteUrl: UNREACHABLE_URL, remoteName: "origin" },
          transfers: firstTransfers,
        });
        const failed = yield* importOnB(b, unreachable).pipe(
          withProcessEnv({ FAKE_SSH_MODE: "denied" }),
        );
        assert.equal(failed.status, "failed");
        assert.equal(failed.error?.code, "remote-unreachable");
        assert.equal(failed.error?.step, "preflight");
        assert.deepEqual(failed.preflight, { remoteReachable: false, alternateRemoteUrl: null });
        // Nothing was created on B, and the job let go of its uploads.
        assert.isNull(failed.leftoverPath);
        assert.deepEqual(readdirSync(code), []);
        assert.deepEqual(transferFilesOf(b.stateDir), []);

        // Send files: a new export with the whole repository, a new import id, same project.
        const retry = yield* exportFromA(a, projectId, {
          wholeRepository: true,
          workingTreeChanges: true,
          ignoredPaths: [".env"],
        });
        assert.deepEqual(retry.result.artifacts.map((artifact) => artifact.kind).toSorted(), [
          "changes-patch",
          "repository-bundle",
        ]);
        const retryTransfers = yield* transferArtifacts(a, b, retry.exportId, retry.result);
        yield* disposeOnA(a, retry.exportId);
        const bundleTransfer = retryTransfers.get("repository-bundle");
        assert.isDefined(bundleTransfer);
        const sent = importInputFrom(retry.result, {
          projectId: copyProjectId,
          destinationPath: destination,
          source: { kind: "repository-bundle", transferId: bundleTransfer! },
          transfers: retryTransfers,
        });
        const terminal = yield* importOnB(b, sent);
        assert.equal(terminal.status, "completed", JSON.stringify(terminal.error));
        assert.deepEqual(terminal.warnings, []);
        assert.equal(stepStatuses(terminal).commits, "skipped");
        assert.equal(stepStatuses(terminal).changes, "done");
        assert.equal(stepStatuses(terminal).remotes, "done");

        // The bundle brought A's branches and remote-tracking refs; origin is recreated.
        assertSameCheckout(fixture, destination);
        assert.equal(
          git(destination, "rev-parse", "refs/remotes/origin/main"),
          git(fixture.source, "rev-parse", "refs/remotes/origin/main"),
        );
        yield* assertRegistered(b, sent, destination);
        assert.deepEqual(transferFilesOf(b.stateDir), []);
      }).pipe(servedBy(fixture), Effect.scoped);
    },
    { timeout: 180_000 },
  );
});

// ── Throughput (opt in: RYCO_PROJECT_COPY_BENCH=1) ────────────────────

const BENCH_ARTIFACT_BYTES = Number(process.env.RYCO_PROJECT_COPY_BENCH_MIB ?? 64) * 1024 * 1024;
const BENCH_CALL_LATENCY_MS = Number(process.env.RYCO_PROJECT_COPY_BENCH_LATENCY_MS ?? 50);

const withLatency = <T>(call: () => Promise<T>) =>
  withSimulatedLatency(BENCH_CALL_LATENCY_MS, call);

describe.runIf(process.env.RYCO_PROJECT_COPY_BENCH === "1")("project copy throughput", () => {
  it.live(
    "moves a whole-repository bundle from A to B with a fixed latency per call",
    () =>
      Effect.gen(function* () {
        const a = yield* startNode("bench-a");
        const b = yield* startNode("bench-b");
        const work = initRepository(
          path.join(realpathSync(roots.make("ryco-xnode-bench-")), "app"),
        );
        commitFiles(work, { "blob.bin": randomBytes(BENCH_ARTIFACT_BYTES) }, "big");
        const projectId = ProjectId.make(`bench-${randomUUID()}`);
        yield* a.run(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make(`create-${projectId}`),
              projectId,
              title: "Bench",
              workspaceRoot: work,
              projectMetadataDir: ".ryco",
              createWorkspaceRootIfMissing: false,
              createdAt: new Date().toISOString(),
            });
          }),
        );
        const { exportId, result } = yield* exportFromA(a, projectId, { wholeRepository: true });
        const artifact = result.artifacts.find((entry) => entry.kind === "repository-bundle");
        assert.isDefined(artifact);
        const bundle = artifact!;

        const runs = [
          {
            // What the coordinator did before: one append at a time, one read ahead.
            name: "serial, 160 KiB",
            limits: {
              ...projectCopyPipelineLimits(PROJECT_COPY_CHUNK_BYTES),
              maxChunksInMemory: 2,
              maxAppendsInFlight: 1,
            },
          },
          {
            name: "pipelined, 160 KiB (relay)",
            limits: projectCopyPipelineLimits(PROJECT_COPY_CHUNK_BYTES),
          },
          {
            name: "pipelined, 1 MiB (direct)",
            limits: projectCopyPipelineLimits(PROJECT_COPY_DIRECT_CHUNK_BYTES),
          },
        ];
        const lines: string[] = [];
        for (const run of runs) {
          const transferId = ProjectTransferId.make(randomUUID());
          yield* beginOnB(b, transferId, bundle);
          const startedAt = performance.now();
          const pumped = yield* Effect.promise(() =>
            pumpProjectCopyChunks({
              byteLength: bundle.byteLength,
              start: 0,
              limits: run.limits,
              read: (offset, length) =>
                withLatency(() => readFromA(a, exportId, bundle, offset, length)),
              append: (offset, dataBase64) =>
                withLatency(() => appendToB(b, transferId, offset, dataBase64)),
            }),
          );
          const seconds = (performance.now() - startedAt) / 1000;
          assert.equal(pumped, "done");
          assert.equal((yield* commitOnB(b, transferId)).sha256, bundle.sha256);
          yield* b.run(
            Effect.gen(function* () {
              yield* (yield* ProjectTransfers).abort({ transferId });
            }),
          );
          const megabytes = bundle.byteLength / 1_000_000;
          lines.push(
            `${run.name}: ${seconds.toFixed(2)} s, ${(megabytes / seconds).toFixed(1)} MB/s`,
          );
        }
        yield* disposeOnA(a, exportId);
        console.log(
          `project copy throughput, ${(bundle.byteLength / 1_048_576).toFixed(1)} MiB bundle, ` +
            `${BENCH_CALL_LATENCY_MS} ms per call:\n  ${lines.join("\n  ")}`,
        );
      }).pipe(Effect.scoped),
    { timeout: 600_000 },
  );
});
