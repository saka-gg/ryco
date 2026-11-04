/**
 * Cross-node project copy, end to end: node A from this checkout's source on
 * the host, node B in Docker (see harness.ts). Opt-in with
 * `RYCO_TEST_CROSS_NODE_E2E=1`, and outside every normal test run: the
 * `.e2e.ts` name is not in Vitest's default include, so only this directory's
 * vitest.config.ts picks it up. Commands are in README.md.
 *
 * The copy is driven RPC by RPC, the way a client holding both nodes does it,
 * so a failure names the node and the call. "[wave 1]" marks the tests of the
 * project-copy services (export, transfers, import, setup).
 */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationProjectShell,
  PROJECT_COPY_WS_METHODS,
  ProjectId,
  WS_METHODS,
} from "@ryco/contracts";
import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_COPY_DIRECT_CHUNK_BYTES,
  PROJECT_IMPORT_TERMINAL_STATUSES,
  type ProjectExportArtifact,
  type ProjectExportArtifactKind,
  ProjectExportId,
  type ProjectExportInclude,
  type ProjectExportResult,
  ProjectImportId,
  type ProjectImportSnapshot,
  type ProjectImportStartInput,
  type ProjectImportStatus,
  ProjectTransferId,
} from "@ryco/contracts/project-copy";
import { Effect, Option, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadRemoteShell } from "../../../apps/server/src/cliRemote/threads.ts";
import {
  buildProjectCopyRunPlan,
  planProjectCopyOptions,
  projectCopyPlanWithSendFiles,
  resolveCopyDestination,
  startProjectCopy,
  type ProjectCopyChoices,
  type ProjectCopyPhase,
  type ProjectCopySourceFacts,
  type ProjectCopyTargetFacts,
} from "../../../packages/client-runtime/src/projectCopy/index.ts";
import { directProjectCopyIo } from "./coordinatorIo.ts";
import {
  CONTAINER_CODE_DIRECTORY,
  CONTAINER_HOSTNAME,
  CONTAINER_STATE_DIR,
  type CrossNodeHarness,
  type FixtureFile,
  LAN_ONLY_HOST,
  SETUP_MARKER_PATH,
  STALLING_HOST,
  buildLanOnlyFixture,
  isolatedEnv,
  registerProjectOnA,
  runCommand,
  startCrossNodeHarness,
} from "./harness.ts";

const enabled = process.env.RYCO_TEST_CROSS_NODE_E2E === "1";

let harness: CrossNodeHarness;

beforeAll(async () => {
  if (!enabled) return;
  const image = process.env.RYCO_E2E_NODE_IMAGE;
  harness = await startCrossNodeHarness({
    ...(image === undefined ? {} : { image }),
    buildImage: process.env.RYCO_E2E_SKIP_BUILD !== "1",
    keepFiles: process.env.RYCO_E2E_KEEP === "1",
    log: (line) => console.log(`[cross-node] ${line}`),
  });
});

beforeEach(({ onTestFailed }) => {
  // Both nodes are gone after the run: keep what they said about the failure.
  onTestFailed(async () => {
    if (!enabled || harness === undefined) return;
    console.log(`[cross-node] node A output (tail):\n${harness.nodeA.output().slice(-8_000)}`);
    const logsB = await harness.nodeB.logs().catch((error: unknown) => String(error));
    console.log(`[cross-node] node B logs (tail):\n${logsB.slice(-8_000)}`);
  });
});

afterAll(async () => {
  // Never leaves a container or node process behind, even after a failed test.
  await harness?.teardown();
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Run one RPC. A failure names the node and the call, which Effect's stack does not. */
const call = async <A, E>(label: string, effect: Effect.Effect<A, E>): Promise<A> => {
  try {
    return await Effect.runPromise(effect);
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? ` [${String(cause.code)}]`
        : "";
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${label} failed${code}: ${message}`, { cause });
  }
};

/** A project a node reports in its shell snapshot, once the projection has it (and `ready`). */
const waitForProject = async (
  node: "A" | "B",
  projectId: string,
  ready: (project: OrchestrationProjectShell) => boolean = () => true,
): Promise<OrchestrationProjectShell> => {
  const client = node === "A" ? harness.nodeA.client : harness.nodeB.client;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const snapshot = await call(`node ${node} shell snapshot`, loadRemoteShell(client));
    const project = snapshot.projects.find((entry) => entry.id === projectId);
    if (project !== undefined && ready(project)) return project;
    if (Date.now() > deadline) {
      throw new Error(
        project === undefined
          ? `Project ${projectId} never appeared on ${node}.`
          : `Project ${projectId} on ${node} never got there: ${JSON.stringify(project)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

/**
 * The repository key a node groups a project by, once its background identity sync stored it.
 * A copy must have the source's, so both show as one project on two nodes.
 */
const canonicalKeyOn = async (node: "A" | "B", projectId: string) =>
  (await waitForProject(node, projectId, (project) => project.repositoryIdentity != null))
    .repositoryIdentity?.canonicalKey;

/** Raw `git` output on B (`docker exec`); status lines start with a space. */
const gitOutputOnB = async (repository: string, ...args: ReadonlyArray<string>) =>
  (await harness.nodeB.exec(["git", "-C", repository, ...args])).stdout;
const gitOnB = async (repository: string, ...args: ReadonlyArray<string>) =>
  (await gitOutputOnB(repository, ...args)).trim();
const gitOutputOnAIn = async (repository: string, ...args: ReadonlyArray<string>) =>
  (await runCommand("git", ["-C", repository, ...args], { env: isolatedEnv() })).stdout;
const gitOutputOnA = (...args: ReadonlyArray<string>) =>
  gitOutputOnAIn(harness.fixture.workspace, ...args);

const STATUS_ARGS = ["status", "--porcelain=v1", "--untracked-files=all"] as const;
/** `git status` as a comparable list, untracked files listed one by one. */
const statusLines = (porcelain: string) =>
  porcelain
    .split("\n")
    .filter((line) => line.length > 0)
    .toSorted();

const sha256OnB = async (absolutePath: string) =>
  (await harness.nodeB.exec(["sha256sum", "--", absolutePath])).stdout.split(" ")[0];

const existsOnB = (absolutePath: string) =>
  harness.nodeB.exec(["test", "-e", absolutePath]).then(
    () => true,
    () => false,
  );

/** The command lines of every process running on B. */
const processesOnB = async () =>
  (await harness.nodeB.exec(["ps", "-eo", "args="])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** A `git clone` from `STALLING_HOST` is connected: its fake ssh hangs (see fake-ssh). */
const stalledClone = (processes: ReadonlyArray<string>) =>
  processes.some((line) => line.startsWith("sleep 600"));
/** What is left of a clone on B: git itself and its hanging fake ssh. */
const cloneProcesses = (processes: ReadonlyArray<string>) =>
  processes.filter((line) => / clone |^sleep 600/.test(line));

/** Poll until `probe` holds; fails naming `what` after `timeoutMs`. */
const eventually = async (what: string, probe: () => Promise<boolean>, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms: ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

/** Where an import stages its checkout before it publishes it (a sibling of the destination). */
const stagingPathOf = (destinationPath: string, importId: ProjectImportId) =>
  path.posix.join(
    path.posix.dirname(destinationPath),
    `.${path.posix.basename(destinationPath)}.ryco-import-${importId}`,
  );

/** What is left of copies in the nodes' scratch folders: A's exports, B's transfers. */
const copyScratchLeft = async () => ({
  exportsOnA: await readdir(path.join(harness.nodeA.baseDir, "userdata", "project-exports")),
  transfersOnB: (
    await harness.nodeB.exec([
      "find",
      `${CONTAINER_STATE_DIR}/project-transfers`,
      `${CONTAINER_STATE_DIR}/project-imports`,
      "-mindepth",
      "1",
    ])
  ).stdout
    .split("\n")
    .filter((line) => line.length > 0),
});

/**
 * Neither node keeps a copy's files once it is over: A's export is disposed, and B deletes the
 * uploads with the import that claimed them (right after it published the terminal snapshot).
 */
const expectNoCopyScratch = async () => {
  const deadline = Date.now() + 10_000;
  let left = await copyScratchLeft();
  while (left.exportsOnA.length + left.transfersOnB.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    left = await copyScratchLeft();
  }
  expect(left).toEqual({ exportsOnA: [], transfersOnB: [] });
};

const stepStatuses = (snapshot: ProjectImportSnapshot) =>
  Object.fromEntries(snapshot.steps.map((step) => [step.id, step.status]));

const describeImport = (snapshot: ProjectImportSnapshot) =>
  JSON.stringify(
    {
      status: snapshot.status,
      error: snapshot.error,
      warnings: snapshot.warnings,
      steps: snapshot.steps,
      outputTail: snapshot.outputTail.slice(-4_000),
    },
    null,
    2,
  );

// ── The copy, RPC by RPC ──────────────────────────────────────────────

interface CopyOutcome {
  readonly exported: ProjectExportResult;
  readonly importInput: ProjectImportStartInput;
  readonly snapshot: ProjectImportSnapshot;
  /** Chunks each artifact's upload took. */
  readonly chunkCounts: ReadonlyMap<ProjectExportArtifactKind, number>;
}

/**
 * Read one export artifact from A and write it to a B transfer chunk by chunk,
 * then commit it. The last chunk goes out twice, as after a dropped reply: B
 * must take the repeat as a no-op.
 */
const transferArtifact = async (exportId: ProjectExportId, artifact: ProjectExportArtifact) => {
  const { nodeA, nodeB } = harness;
  const transferId = ProjectTransferId.make(randomUUID());
  const begun = await call(
    `node B transferBegin(${artifact.kind})`,
    nodeB.client[PROJECT_COPY_WS_METHODS.transferBegin]({
      transferId,
      purpose: artifact.kind,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    }),
  );
  // B takes 1 MiB chunks over this direct connection; the reads below stay at 160 KiB, which
  // every node takes.
  expect(begun).toEqual({
    transferId,
    receivedBytes: 0,
    maxChunkBytes: PROJECT_COPY_DIRECT_CHUNK_BYTES,
  });
  let offset = 0;
  let chunks = 0;
  let last: { readonly offset: number; readonly dataBase64: string } | null = null;
  while (offset < artifact.byteLength) {
    const chunk = await call(
      `node A exportReadChunk(${artifact.kind} @${offset})`,
      nodeA.client[PROJECT_COPY_WS_METHODS.exportReadChunk]({
        exportId,
        artifactId: artifact.artifactId,
        offset,
        length: Math.min(PROJECT_COPY_CHUNK_BYTES, artifact.byteLength - offset),
      }),
    );
    expect(chunk.offset).toBe(offset);
    expect(chunk.length).toBeGreaterThan(0);
    const progress = await call(
      `node B transferAppend(${artifact.kind} @${offset})`,
      nodeB.client[PROJECT_COPY_WS_METHODS.transferAppend]({
        transferId,
        offset,
        dataBase64: chunk.dataBase64,
      }),
    );
    expect(progress.receivedBytes).toBe(offset + chunk.length);
    last = { offset, dataBase64: chunk.dataBase64 };
    offset = progress.receivedBytes;
    chunks += 1;
  }
  if (last === null) throw new Error(`Artifact ${artifact.kind} is empty.`);
  const repeated = await call(
    `node B transferAppend(${artifact.kind} @${last.offset}, repeated)`,
    nodeB.client[PROJECT_COPY_WS_METHODS.transferAppend]({ transferId, ...last }),
  );
  expect(repeated.receivedBytes).toBe(artifact.byteLength);
  const committed = await call(
    `node B transferCommit(${artifact.kind})`,
    nodeB.client[PROJECT_COPY_WS_METHODS.transferCommit]({ transferId }),
  );
  expect(committed).toEqual({
    transferId,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
  });
  return { transferId, chunks };
};

/** Every artifact of an export uploaded to B: the transfer id and chunk count per kind. */
const uploadArtifacts = async (
  exportId: ProjectExportId,
  artifacts: ReadonlyArray<ProjectExportArtifact>,
) => {
  const transfers = new Map<ProjectExportArtifactKind, ProjectTransferId>();
  const chunkCounts = new Map<ProjectExportArtifactKind, number>();
  for (const artifact of artifacts) {
    const { transferId, chunks } = await transferArtifact(exportId, artifact);
    transfers.set(artifact.kind, transferId);
    chunkCounts.set(artifact.kind, chunks);
  }
  return { transfers, chunkCounts };
};

/** `projects.exportStart` on A, handed to `body`; the export is disposed either way. */
const withExportOnA = async <A>(
  projectId: ProjectId,
  include: ProjectExportInclude,
  body: (exportId: ProjectExportId, exported: ProjectExportResult) => Promise<A>,
): Promise<A> => {
  const { nodeA } = harness;
  const exportId = ProjectExportId.make(randomUUID());
  const exported = await call(
    "node A exportStart",
    nodeA.client[PROJECT_COPY_WS_METHODS.exportStart]({ exportId, projectId, include }),
  );
  try {
    return await body(exportId, exported);
  } finally {
    await call(
      "node A exportDispose",
      nodeA.client[PROJECT_COPY_WS_METHODS.exportDispose]({ exportId }),
    ).catch(() => undefined);
  }
};

/** B's snapshots of one import until `until` holds (or the import ends): the last one. */
const followImportOnB = async (
  importId: ProjectImportId,
  until: (snapshot: ProjectImportSnapshot) => boolean = () => false,
): Promise<ProjectImportSnapshot> => {
  const last = await call(
    "node B subscribeImport",
    harness.nodeB.client[PROJECT_COPY_WS_METHODS.subscribeImport]({ importId }).pipe(
      Stream.takeUntil(
        (snapshot) => until(snapshot) || PROJECT_IMPORT_TERMINAL_STATUSES.includes(snapshot.status),
      ),
      Stream.runLast,
      Effect.timeout("5 minutes"),
    ),
  );
  if (Option.isNone(last)) throw new Error("The import stream ended without a snapshot.");
  return last.value;
};

/**
 * `projects.importStart` on B, sent twice (idempotent by id: the repeat returns the same job),
 * then followed to its terminal snapshot.
 */
const importOnB = async (input: ProjectImportStartInput): Promise<ProjectImportSnapshot> => {
  const { nodeB } = harness;
  const started = await call(
    "node B importStart",
    nodeB.client[PROJECT_COPY_WS_METHODS.importStart](input),
  );
  expect(started.importId).toBe(input.importId);
  const repeated = await call(
    "node B importStart (repeated)",
    nodeB.client[PROJECT_COPY_WS_METHODS.importStart](input),
  );
  expect(repeated.importId).toBe(input.importId);
  return followImportOnB(input.importId);
};

/** The parts of an import input every test shares: ids, the title and nothing optional. */
const baseImportInput = (input: {
  readonly title: string;
  readonly destinationPath: string;
  readonly source: ProjectImportStartInput["source"];
}): ProjectImportStartInput => ({
  importId: ProjectImportId.make(randomUUID()),
  projectId: ProjectId.make(randomUUID()),
  title: input.title,
  destinationPath: input.destinationPath,
  source: input.source,
  remotes: [],
  commits: null,
  checkout: null,
  changes: null,
  relativeRootInRepository: "",
  recurseSubmodules: false,
  usesLfs: false,
  settings: null,
  avatarTransferId: null,
  setup: null,
  followUpThread: null,
  origin: { kind: "user", sourceLabel: harness.nodeA.remote.label, proposalId: null },
});

/** The export's settings as an import copies them. */
const importSettingsOf = (settings: ProjectExportResult["settings"]) => ({
  scripts: settings.scripts,
  customSystemPrompt: settings.customSystemPrompt,
  preferredRemoteName: settings.preferredRemoteName,
  projectMetadataDir: settings.projectMetadataDir,
  overrides: settings.overrides,
});

/**
 * Copy the fixture project from A to `<B's default project directory>/<name>`:
 * inspect and export on A, upload the artifacts to B, start the import on B
 * and follow it to the end. Disposes the export either way.
 *
 * Builds the import input by hand, independent of the client coordinator, so
 * it checks the nodes' side of the contract on its own.
 */
const copyProjectToB = async (input: {
  readonly name: string;
  readonly ignoredPaths: ReadonlyArray<string>;
}): Promise<CopyOutcome> => {
  const { nodeA, nodeB, fixture } = harness;

  const inspection = await call(
    "node A exportInspect",
    nodeA.client[PROJECT_COPY_WS_METHODS.exportInspect]({ projectId: fixture.projectId }),
  );
  expect(inspection.repository).toMatchObject({
    isGitRepository: true,
    branch: fixture.featureBranch,
    headOid: fixture.headOid,
    isDetached: false,
    // The identity's rule is `upstream` before `origin`, so A and B group by upstream. The copy
    // clones the fork's own `origin` (the project prefers no other) and recreates `upstream`.
    primaryRemoteName: "upstream",
    cloneRemoteName: "origin",
  });
  expect(inspection.repository.remotes).toContainEqual({ name: "origin", url: fixture.originUrl });
  expect(inspection.pushedState).toMatchObject({ headOnRemote: false, unpushedCommitCount: 1 });
  expect(inspection.workingTree).toMatchObject({
    trackedChangeCount: 1,
    untrackedCount: 1,
    hasConflicts: false,
  });
  expect(inspection.workingTree.ignoredCandidates).toContainEqual({
    path: fixture.ignoredEnv.path,
    byteLength: fixture.ignoredEnv.byteLength,
  });

  // Where the dialog would put it on B, and whether B can reach the origin itself.
  const hints = await call("node B pathHints", nodeB.client[PROJECT_COPY_WS_METHODS.pathHints]({}));
  expect(hints.defaultProjectDirectory).toBe(CONTAINER_CODE_DIRECTORY);
  const preview = await call(
    "node B previewDestination",
    nodeB.client[PROJECT_COPY_WS_METHODS.previewDestination]({
      path: `${hints.defaultProjectDirectory}/${input.name}`,
    }),
  );
  expect(preview.state).toBe("available");
  const access = await call(
    "node B checkRemoteAccess",
    nodeB.client[PROJECT_COPY_WS_METHODS.checkRemoteAccess]({ remoteUrl: fixture.originUrl }),
  );
  expect(access).toMatchObject({ reachable: true, alternateRemoteUrl: null });

  const include = {
    commits: true,
    workingTreeChanges: true,
    ignoredPaths: input.ignoredPaths,
    wholeRepository: false,
    avatar: false,
  };
  return withExportOnA(fixture.projectId, include, async (exportId, exported) => {
    expect(exported.skipped).toEqual([]);
    expect(exported.artifacts.map((artifact) => artifact.kind).toSorted()).toEqual([
      "changes-patch",
      "commits-bundle",
    ]);
    const { transfers, chunkCounts } = await uploadArtifacts(exportId, exported.artifacts);

    const { repository, settings } = exported;
    const cloneRemote = repository.remotes.find(
      (remote) => remote.name === repository.cloneRemoteName,
    );
    if (cloneRemote === undefined || repository.headOid === null) {
      throw new Error(`Export has no clone remote or HEAD: ${JSON.stringify(repository)}`);
    }
    const setupScript = settings.scripts.find((script) => script.runOnWorktreeCreate);
    const commitsTransfer = transfers.get("commits-bundle");
    const changesTransfer = transfers.get("changes-patch");
    const importInput: ProjectImportStartInput = {
      ...baseImportInput({
        title: settings.title,
        destinationPath: preview.resolvedPath,
        source: { kind: "clone", remoteUrl: cloneRemote.url, remoteName: cloneRemote.name },
      }),
      remotes: repository.remotes.filter((remote) => remote.name !== cloneRemote.name),
      commits: commitsTransfer === undefined ? null : { transferId: commitsTransfer },
      checkout: { branch: repository.branch, headOid: repository.headOid },
      changes:
        changesTransfer === undefined
          ? null
          : {
              transferId: changesTransfer,
              baseOid: repository.headOid,
              ignoredPaths: input.ignoredPaths,
            },
      relativeRootInRepository: settings.relativeRootInRepository,
      recurseSubmodules: repository.hasSubmodules,
      usesLfs: repository.usesLfs,
      settings: importSettingsOf(settings),
      setup:
        setupScript === undefined ? null : { command: setupScript.command, saveAsScript: false },
    };
    const snapshot = await importOnB(importInput);
    return { exported, importInput, snapshot, chunkCounts };
  });
};

/** Everything both copies must agree on, checked on B with `docker exec` and over RPC. */
const expectCopiedCheckout = async (outcome: CopyOutcome) => {
  const { fixture } = harness;
  const { snapshot, importInput } = outcome;
  const destination = importInput.destinationPath;
  expect(snapshot.status, describeImport(snapshot)).toBe("completed");
  expect(snapshot.error, describeImport(snapshot)).toBeNull();
  expect(stepStatuses(snapshot), describeImport(snapshot)).toMatchObject({
    preflight: "done",
    clone: "done",
    remotes: "done",
    commits: "done",
    checkout: "done",
    changes: "done",
    register: "done",
    settings: "done",
    setup: "done",
  });

  // The checkout: A's unpushed HEAD on A's branch, both remotes, A's working tree.
  expect(await gitOnB(destination, "rev-parse", "HEAD")).toBe(fixture.headOid);
  expect(await gitOnB(destination, "symbolic-ref", "--short", "HEAD")).toBe(fixture.featureBranch);
  expect(await gitOnB(destination, "remote", "get-url", "origin")).toBe(fixture.originUrl);
  expect(await gitOnB(destination, "remote", "get-url", "upstream")).toBe(fixture.upstreamUrl);
  const statusOnB = statusLines(await gitOutputOnB(destination, ...STATUS_ARGS));
  expect(statusOnB).toEqual([
    ` M ${fixture.trackedEdit.path}`,
    `?? ${fixture.untrackedBinary.path}`,
  ]);
  expect(statusOnB).toEqual(statusLines(await gitOutputOnA(...STATUS_ARGS)));
  const expectSameBytes = async (file: FixtureFile) =>
    expect(await sha256OnB(path.posix.join(destination, file.path)), file.path).toBe(file.sha256);
  await expectSameBytes(fixture.trackedEdit);
  await expectSameBytes(fixture.untrackedBinary);
  // The binary patch is larger than one chunk, so the upload really was chunked.
  expect(outcome.chunkCounts.get("changes-patch")).toBeGreaterThanOrEqual(2);

  // The project on B, with A's settings.
  const project = await waitForProject("B", importInput.projectId);
  expect(project).toMatchObject({
    title: fixture.title,
    workspaceRoot: destination,
    customSystemPrompt: fixture.customSystemPrompt,
  });
  expect(project.scripts).toEqual(fixture.scripts);
  expect(await canonicalKeyOn("B", importInput.projectId)).toBe(
    await canonicalKeyOn("A", fixture.projectId),
  );
  await expectListedOnB(importInput.importId, "completed");
  await expectSetupRanIn(destination);
  await expectNoCopyScratch();
};

/** B's list of recent imports has this one, with this status. */
const expectListedOnB = async (importId: ProjectImportId, status: ProjectImportStatus) => {
  const listed = await call(
    "node B listImports",
    harness.nodeB.client[PROJECT_COPY_WS_METHODS.listImports]({}),
  );
  expect(listed.imports.find((entry) => entry.importId === importId)?.status).toBe(status);
};

/**
 * The setup script ran in the project root and saw only the project script variables, none of
 * the server's RYCO_* ones.
 */
const expectSetupRanIn = async (projectRoot: string) => {
  const marker = await harness.nodeB.exec(["cat", path.posix.join(projectRoot, SETUP_MARKER_PATH)]);
  expect(marker.stdout.trim().split("\n")).toEqual([
    projectRoot,
    "RYCO_PROJECT_ROOT RYCO_WORKTREE_PATH",
  ]);
};

/** B's shell snapshot has no project with this id (the projection is current per call). */
const expectNoProjectOnB = async (projectId: string) => {
  const snapshot = await call("node B shell snapshot", loadRemoteShell(harness.nodeB.client));
  expect(snapshot.projects.map((project) => project.id)).not.toContain(projectId);
};

// ── The client coordinator ────────────────────────────────────────────

/**
 * The copy dialog's planning against the real nodes: A's inspection and path hints, B's path
 * hints, the suggested destination (previewed on B) and, unless `checkRemote` is false (a check
 * that has not answered yet), B's remote check; then the options for `requested` and the plan
 * the coordinator runs, with A's setup script prefilled.
 */
const planCopyWithCoordinator = async (input: {
  readonly projectId: ProjectId;
  readonly folderName: string;
  readonly checkRemote: boolean;
  readonly requested: Partial<ProjectCopyChoices>;
}) => {
  const { nodeA, nodeB } = harness;
  const inspection = await call(
    "node A exportInspect",
    nodeA.client[PROJECT_COPY_WS_METHODS.exportInspect]({ projectId: input.projectId }),
  );
  const hintsA = await call(
    "node A pathHints",
    nodeA.client[PROJECT_COPY_WS_METHODS.pathHints]({}),
  );
  const hintsB = await call(
    "node B pathHints",
    nodeB.client[PROJECT_COPY_WS_METHODS.pathHints]({}),
  );
  const source: ProjectCopySourceFacts = {
    kind: "inspected",
    environmentId: EnvironmentId.make(nodeA.remote.environmentId),
    label: nodeA.remote.label,
    platformOs: null,
    transport: "direct",
    checkoutPath: null,
    inspection,
  };
  const destination = await resolveCopyDestination(
    {
      sourceRoot: inspection.repository.rootPath,
      sourceHints: hintsA,
      destHints: hintsB,
      leafName: input.folderName,
      placement: "mirror",
    },
    {
      preview: (previewInput) =>
        call(
          "node B previewDestination",
          nodeB.client[PROJECT_COPY_WS_METHODS.previewDestination](previewInput),
        ),
      sourceCanonicalKey: inspection.repository.canonicalKey,
    },
  );
  const cloneRemote = inspection.repository.remotes.find(
    (remote) => remote.name === inspection.repository.cloneRemoteName,
  );
  const remoteAccess =
    input.checkRemote && cloneRemote !== undefined
      ? await call(
          "node B checkRemoteAccess",
          nodeB.client[PROJECT_COPY_WS_METHODS.checkRemoteAccess]({ remoteUrl: cloneRemote.url }),
        )
      : null;
  const target: ProjectCopyTargetFacts = {
    label: nodeB.remote.label,
    platformOs: null,
    projectCopySupport: "yes",
    transport: "direct",
    remoteAccess,
    destination,
  };
  const options = planProjectCopyOptions({ source, target }, input.requested);
  const built = buildProjectCopyRunPlan({
    planning: { source, target },
    options,
    target: {
      environmentId: EnvironmentId.make(nodeB.remote.environmentId),
      pathSeparator: hintsB.pathSeparator,
    },
    setup:
      options.setup.command === null
        ? null
        : { command: options.setup.command, saveAsScript: false },
    followUpThread: null,
    origin: { kind: "user", sourceLabel: nodeA.remote.label, proposalId: null },
  });
  if (!built.ok) throw new Error(`The copy can't be planned: ${built.reason}`);
  return { inspection, options, plan: built.plan };
};

/** Runs the coordinator to its end; the phases it went through, in order and once each. */
const runCoordinator = async (input: Parameters<typeof startProjectCopy>[0]) => {
  const phases: ProjectCopyPhase[] = [];
  const run = startProjectCopy({
    ...input,
    onProgress: (progress) => {
      if (phases.at(-1) !== progress.phase) phases.push(progress.phase);
    },
  });
  const outcome = await run.done;
  return { outcome, phases };
};

const coordinatorIo = () =>
  directProjectCopyIo(
    new Map([
      [EnvironmentId.make(harness.nodeA.remote.environmentId), harness.nodeA.client],
      [EnvironmentId.make(harness.nodeB.remote.environmentId), harness.nodeB.client],
    ]),
  );

// ── Tests ─────────────────────────────────────────────────────────────

describe("cross-node project copy (node A on this machine, node B in Docker)", () => {
  it.runIf(enabled)(
    "smoke: pairs both nodes as owner, clones the origin on B and adds it as a project",
    async () => {
      const { nodeA, nodeB, fixture } = harness;
      expect(nodeA.remote.role).toBe("owner");
      expect(nodeB.remote.role).toBe("owner");
      expect(nodeB.remote.label).toBe(CONTAINER_HOSTNAME);
      expect(nodeB.remote.environmentId).not.toBe(nodeA.remote.environmentId);

      // The fixture project on A, with the settings the fixture set over RPC.
      const source = await waitForProject("A", fixture.projectId);
      expect(source).toMatchObject({
        workspaceRoot: fixture.workspace,
        customSystemPrompt: fixture.customSystemPrompt,
      });
      expect(source.scripts).toEqual(fixture.scripts);
      expect(statusLines(await gitOutputOnA(...STATUS_ARGS))).toEqual([
        ` M ${fixture.trackedEdit.path}`,
        `?? ${fixture.untrackedBinary.path}`,
      ]);

      // Today's path on B: the legacy clone through the fake ssh, then project.create.
      const destination = `${CONTAINER_CODE_DIRECTORY}/smoke-${randomUUID().slice(0, 8)}`;
      const cloned = await call(
        "node B cloneRepository",
        nodeB.client[WS_METHODS.sourceControlCloneRepository]({
          remoteUrl: fixture.originUrl,
          destinationPath: destination,
        }),
      );
      expect(cloned.cwd).toBe(destination);
      expect(await gitOnB(destination, "rev-parse", "HEAD")).toBe(fixture.mainOid);
      expect(await gitOnB(destination, "remote", "get-url", "origin")).toBe(fixture.originUrl);

      const projectId = ProjectId.make(`e2e-smoke-${randomUUID()}`);
      await call(
        "node B project.create",
        nodeB.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "project.create",
          commandId: CommandId.make(`e2e:${randomUUID()}`),
          projectId,
          title: "Smoke clone",
          workspaceRoot: cloned.cwd,
          createdAt: new Date().toISOString(),
        }),
      );
      const project = await waitForProject("B", projectId);
      expect(project.workspaceRoot).toBe(destination);
    },
  );

  // [wave 1] Needs the live NodePaths, GitNetwork, ProjectExport, ProjectTransfers,
  // ProjectImportGit, ProjectSetupCommand and ProjectImports services on both nodes.
  it.runIf(enabled)(
    "[wave 1] copies unpushed commits, uncommitted changes, an opted-in .env and the settings",
    async () => {
      const { fixture } = harness;
      const outcome = await copyProjectToB({
        name: `copy-${randomUUID().slice(0, 8)}`,
        ignoredPaths: [fixture.ignoredEnv.path],
      });
      await expectCopiedCheckout(outcome);
      const destination = outcome.importInput.destinationPath;
      expect(await sha256OnB(path.posix.join(destination, fixture.ignoredEnv.path))).toBe(
        fixture.ignoredEnv.sha256,
      );
      // Still ignored on B, so it can never be committed there.
      await gitOnB(destination, "check-ignore", "--quiet", "--", fixture.ignoredEnv.path);
    },
  );

  it.runIf(enabled)("[wave 1] leaves ignored files behind unless they are opted in", async () => {
    const { fixture } = harness;
    const outcome = await copyProjectToB({
      name: `copy-plain-${randomUUID().slice(0, 8)}`,
      ignoredPaths: [],
    });
    await expectCopiedCheckout(outcome);
    const envOnB = path.posix.join(outcome.importInput.destinationPath, fixture.ignoredEnv.path);
    expect(await existsOnB(envOnB)).toBe(false);
  });

  it.runIf(enabled)(
    "[wave 1] copies a project rooted in a subfolder of its repository, root-level changes included",
    async () => {
      const { nodeA, fixture } = harness;
      const projectId = ProjectId.make(`e2e-subfolder-${randomUUID()}`);
      const projectRootOnA = path.join(fixture.workspace, "src");
      await registerProjectOnA({
        nodeA: nodeA.client,
        projectId,
        title: "Cross-node fixture (src)",
        workspaceRoot: projectRootOnA,
        scripts: [],
        customSystemPrompt: null,
      });
      const inspection = await call(
        "node A exportInspect",
        nodeA.client[PROJECT_COPY_WS_METHODS.exportInspect]({ projectId }),
      );
      expect(inspection.settings.relativeRootInRepository).toBe("src");
      expect(inspection.repository).toMatchObject({
        rootPath: fixture.workspace,
        headOid: fixture.headOid,
      });
      // The repository's whole working tree, not only the subfolder's.
      expect(inspection.workingTree).toMatchObject({ trackedChangeCount: 1, untrackedCount: 1 });

      const destination = `${CONTAINER_CODE_DIRECTORY}/subfolder-${randomUUID().slice(0, 8)}`;
      const include = {
        commits: true,
        workingTreeChanges: true,
        ignoredPaths: [],
        wholeRepository: false,
        avatar: false,
      };
      const snapshot = await withExportOnA(projectId, include, async (exportId, exported) => {
        expect(exported.skipped).toEqual([]);
        const { transfers } = await uploadArtifacts(exportId, exported.artifacts);
        const commits = transfers.get("commits-bundle");
        const changes = transfers.get("changes-patch");
        if (commits === undefined || changes === undefined) {
          throw new Error("A transfer is missing.");
        }
        const { repository } = exported;
        const cloneRemote = repository.remotes.find(
          (remote) => remote.name === repository.cloneRemoteName,
        );
        if (cloneRemote === undefined) throw new Error("The export has no clone remote.");
        return importOnB({
          ...baseImportInput({
            title: exported.settings.title,
            destinationPath: destination,
            source: { kind: "clone", remoteUrl: cloneRemote.url, remoteName: cloneRemote.name },
          }),
          remotes: repository.remotes.filter((remote) => remote.name !== cloneRemote.name),
          commits: { transferId: commits },
          checkout: { branch: repository.branch, headOid: fixture.headOid },
          changes: { transferId: changes, baseOid: fixture.headOid, ignoredPaths: [] },
          relativeRootInRepository: exported.settings.relativeRootInRepository,
          settings: importSettingsOf(exported.settings),
        });
      });
      expect(snapshot.status, describeImport(snapshot)).toBe("completed");
      expect(snapshot.warnings, describeImport(snapshot)).toEqual([]);
      expect(stepStatuses(snapshot), describeImport(snapshot)).toMatchObject({
        commits: "done",
        checkout: "done",
        changes: "done",
        register: "done",
      });

      // The whole repository arrives with every change, the root-level ones too (A28), and the
      // project is registered at the subfolder.
      expect(await gitOnB(destination, "rev-parse", "HEAD")).toBe(fixture.headOid);
      expect(statusLines(await gitOutputOnB(destination, ...STATUS_ARGS))).toEqual(
        statusLines(await gitOutputOnA(...STATUS_ARGS)),
      );
      for (const file of [fixture.trackedEdit, fixture.untrackedBinary]) {
        expect(await sha256OnB(path.posix.join(destination, file.path)), file.path).toBe(
          file.sha256,
        );
      }
      const project = await waitForProject("B", snapshot.projectId);
      expect(project.workspaceRoot).toBe(`${destination}/src`);
      expect(await canonicalKeyOn("B", snapshot.projectId)).toBe(
        await canonicalKeyOn("A", projectId),
      );
      await expectNoCopyScratch();
    },
  );

  it.runIf(enabled)("[wave 1] sends the repository when B cannot reach the origin", async () => {
    const { nodeA, nodeB } = harness;
    const lan = await buildLanOnlyFixture({ fixture: harness.fixture, nodeA: nodeA.client });

    // The dialog's remote check: B cannot resolve the origin's host, and no other form works.
    const access = await call(
      "node B checkRemoteAccess",
      nodeB.client[PROJECT_COPY_WS_METHODS.checkRemoteAccess]({ remoteUrl: lan.originUrl }),
    );
    expect(access).toMatchObject({ reachable: false, alternateRemoteUrl: null });
    expect(access.detail).toContain(`Could not resolve hostname ${LAN_ONLY_HOST}`);

    const inspection = await call(
      "node A exportInspect",
      nodeA.client[PROJECT_COPY_WS_METHODS.exportInspect]({ projectId: lan.projectId }),
    );
    expect(inspection.repository).toMatchObject({
      branch: lan.branch,
      headOid: lan.headOid,
      primaryRemoteName: "origin",
      cloneRemoteName: "origin",
      remotes: [{ name: "origin", url: lan.originUrl }],
    });
    // A reaches the origin itself, so it knows exactly what is unpushed.
    expect(inspection.pushedState).toMatchObject({ headOnRemote: false, unpushedCommitCount: 1 });

    // A clone that is started anyway fails in preflight and leaves nothing behind.
    const destination = `${CONTAINER_CODE_DIRECTORY}/lan-${randomUUID().slice(0, 8)}`;
    const cloneAttempt = baseImportInput({
      title: lan.title,
      destinationPath: destination,
      source: { kind: "clone", remoteUrl: lan.originUrl, remoteName: "origin" },
    });
    const refused = await importOnB(cloneAttempt);
    expect(refused.status, describeImport(refused)).toBe("failed");
    expect(refused.error).toMatchObject({ step: "preflight", code: "remote-unreachable" });
    expect(refused.error?.message).toContain(LAN_ONLY_HOST);
    expect(refused.preflight).toEqual({ remoteReachable: false, alternateRemoteUrl: null });
    expect(refused.leftoverPath).toBeNull();
    expect(await existsOnB(destination)).toBe(false);
    expect(await existsOnB(stagingPathOf(destination, cloneAttempt.importId))).toBe(false);
    await expectNoProjectOnB(cloneAttempt.projectId);

    // "Send files": the whole repository and the uncommitted changes, as a new import of the
    // same project to the same folder (the failed one held neither).
    const include = {
      commits: false,
      workingTreeChanges: true,
      ignoredPaths: [],
      wholeRepository: true,
      avatar: false,
    };
    const snapshot = await withExportOnA(lan.projectId, include, async (exportId, exported) => {
      expect(exported.skipped).toEqual([]);
      expect(exported.artifacts.map((artifact) => artifact.kind).toSorted()).toEqual([
        "changes-patch",
        "repository-bundle",
      ]);
      const { transfers } = await uploadArtifacts(exportId, exported.artifacts);
      const bundle = transfers.get("repository-bundle");
      const changes = transfers.get("changes-patch");
      if (bundle === undefined || changes === undefined) throw new Error("A transfer is missing.");
      return importOnB({
        ...baseImportInput({
          title: exported.settings.title,
          destinationPath: destination,
          source: { kind: "repository-bundle", transferId: bundle },
        }),
        projectId: cloneAttempt.projectId,
        // No remote was cloned, so every one of A's is recreated.
        remotes: exported.repository.remotes,
        checkout: { branch: exported.repository.branch, headOid: lan.headOid },
        changes: { transferId: changes, baseOid: lan.headOid, ignoredPaths: [] },
        settings: importSettingsOf(exported.settings),
      });
    });
    expect(snapshot.status, describeImport(snapshot)).toBe("completed");
    expect(snapshot.warnings, describeImport(snapshot)).toEqual([]);
    expect(stepStatuses(snapshot), describeImport(snapshot)).toMatchObject({
      preflight: "done",
      clone: "done",
      remotes: "done",
      commits: "skipped",
      checkout: "done",
      changes: "done",
      register: "done",
      settings: "done",
    });
    expect(snapshot.preflight).toEqual({ remoteReachable: null, alternateRemoteUrl: null });

    // A's branch and HEAD, its remote with the URL B cannot reach, the remote-tracking refs the
    // bundle carried, and A's working tree byte for byte.
    expect(await gitOnB(destination, "rev-parse", "HEAD")).toBe(lan.headOid);
    expect(await gitOnB(destination, "symbolic-ref", "--short", "HEAD")).toBe(lan.branch);
    expect(await gitOnB(destination, "remote")).toBe("origin");
    expect(await gitOnB(destination, "remote", "get-url", "origin")).toBe(lan.originUrl);
    expect(await gitOnB(destination, "rev-parse", "refs/remotes/origin/main")).toBe(lan.mainOid);
    const statusOnB = statusLines(await gitOutputOnB(destination, ...STATUS_ARGS));
    expect(statusOnB).toEqual([` M ${lan.trackedEdit.path}`, `?? ${lan.untrackedFile.path}`]);
    expect(statusOnB).toEqual(statusLines(await gitOutputOnAIn(lan.workspace, ...STATUS_ARGS)));
    for (const file of [lan.trackedEdit, lan.untrackedFile]) {
      expect(await sha256OnB(path.posix.join(destination, file.path)), file.path).toBe(file.sha256);
    }
    expect(await existsOnB(stagingPathOf(destination, cloneAttempt.importId))).toBe(false);

    const project = await waitForProject("B", cloneAttempt.projectId);
    expect(project).toMatchObject({ title: lan.title, workspaceRoot: destination });
    expect(await canonicalKeyOn("B", cloneAttempt.projectId)).toBe(
      await canonicalKeyOn("A", lan.projectId),
    );
    await expectListedOnB(cloneAttempt.importId, "failed");
    await expectListedOnB(snapshot.importId, "completed");
    await expectNoCopyScratch();
  });

  it.runIf(enabled)(
    "[wave 1] links a checkout that is already on B, and refuses one of another repository",
    async () => {
      const { nodeA, nodeB, fixture } = harness;
      const inspection = await call(
        "node A exportInspect",
        nodeA.client[PROJECT_COPY_WS_METHODS.exportInspect]({ projectId: fixture.projectId }),
      );
      const canonicalKey = inspection.repository.canonicalKey;
      expect(canonicalKey).not.toBeNull();

      // A checkout of another repository at the suggested folder is refused, and kept as it is.
      const other = `${CONTAINER_CODE_DIRECTORY}/other-${randomUUID().slice(0, 8)}`;
      await nodeB.exec(["git", "init", "--quiet", other]);
      await nodeB.exec([
        "git",
        "-C",
        other,
        "remote",
        "add",
        "origin",
        "git@fixture.test:/elsewhere/another.git",
      ]);
      const wrongLink = baseImportInput({
        title: inspection.settings.title,
        destinationPath: other,
        source: { kind: "existing-checkout", expectedCanonicalKey: canonicalKey },
      });
      const refused = await importOnB(wrongLink);
      expect(refused.status, describeImport(refused)).toBe("failed");
      expect(refused.error).toMatchObject({ step: "preflight", code: "destination-unavailable" });
      expect(refused.leftoverPath).toBeNull();
      expect(await existsOnB(`${other}/.git`)).toBe(true);
      await expectNoProjectOnB(wrongLink.projectId);

      // The same repository, cloned on B by hand with both of A's remotes.
      const destination = `${CONTAINER_CODE_DIRECTORY}/linked-${randomUUID().slice(0, 8)}`;
      await nodeB.exec(["git", "clone", "--quiet", "--", fixture.originUrl, destination]);
      await nodeB.exec([
        "git",
        "-C",
        destination,
        "remote",
        "add",
        "upstream",
        fixture.upstreamUrl,
      ]);
      const preview = await call(
        "node B previewDestination",
        nodeB.client[PROJECT_COPY_WS_METHODS.previewDestination]({ path: destination }),
      );
      expect(preview).toMatchObject({
        state: "is-git-repository",
        existingProjectId: null,
        existingRepositoryCanonicalKey: canonicalKey,
      });

      const link: ProjectImportStartInput = {
        ...baseImportInput({
          title: inspection.settings.title,
          destinationPath: destination,
          source: { kind: "existing-checkout", expectedCanonicalKey: canonicalKey },
        }),
        settings: importSettingsOf(inspection.settings),
        setup: { command: fixture.setupCommand, saveAsScript: false },
      };
      const snapshot = await importOnB(link);
      expect(snapshot.status, describeImport(snapshot)).toBe("completed");
      expect(snapshot.warnings, describeImport(snapshot)).toEqual([]);
      expect(stepStatuses(snapshot), describeImport(snapshot)).toMatchObject({
        preflight: "done",
        clone: "skipped",
        remotes: "skipped",
        commits: "skipped",
        checkout: "skipped",
        changes: "skipped",
        submodules: "skipped",
        lfs: "skipped",
        register: "done",
        settings: "done",
        setup: "done",
      });

      // The checkout is untouched: still on the origin's main, clean (the setup marker is in .git).
      expect(await gitOnB(destination, "rev-parse", "HEAD")).toBe(fixture.mainOid);
      expect(await gitOnB(destination, "symbolic-ref", "--short", "HEAD")).toBe(fixture.mainBranch);
      expect(await gitOutputOnB(destination, ...STATUS_ARGS)).toBe("");
      const project = await waitForProject("B", link.projectId);
      expect(project).toMatchObject({
        title: fixture.title,
        workspaceRoot: destination,
        customSystemPrompt: fixture.customSystemPrompt,
      });
      expect(project.scripts).toEqual(fixture.scripts);
      expect(await canonicalKeyOn("B", link.projectId)).toBe(canonicalKey);
      expect(await canonicalKeyOn("A", fixture.projectId)).toBe(canonicalKey);
      await expectSetupRanIn(destination);
      await expectListedOnB(link.importId, "completed");

      // Linked once: the folder is now that project's.
      const again = await call(
        "node B previewDestination (after link)",
        nodeB.client[PROJECT_COPY_WS_METHODS.previewDestination]({ path: destination }),
      );
      expect(again.existingProjectId).toBe(link.projectId);
    },
  );

  it.runIf(enabled)("[wave 1] cancelling during the clone leaves no folder behind", async () => {
    const { nodeB, fixture } = harness;
    const destination = `${CONTAINER_CODE_DIRECTORY}/cancel-${randomUUID().slice(0, 8)}`;
    const input = baseImportInput({
      title: fixture.title,
      destinationPath: destination,
      // The preflight check answers; the clone's connection hangs until it is killed.
      source: {
        kind: "clone",
        remoteUrl: `git@${STALLING_HOST}:${fixture.originPath}`,
        remoteName: "origin",
      },
    });
    const staging = stagingPathOf(destination, input.importId);
    const started = await call(
      "node B importStart",
      nodeB.client[PROJECT_COPY_WS_METHODS.importStart](input),
    );
    expect(started.importId).toBe(input.importId);
    const cloning = await followImportOnB(
      input.importId,
      (snapshot) => stepStatuses(snapshot).clone === "running",
    );
    expect(cloning.status, describeImport(cloning)).toBe("running");
    // git clone is connected (its fake ssh hangs) and writing into the staging folder.
    await eventually("the clone to connect on B", async () => stalledClone(await processesOnB()));
    expect(await existsOnB(staging)).toBe(true);

    const cancelled = await call(
      "node B cancelImport",
      nodeB.client[PROJECT_COPY_WS_METHODS.cancelImport]({ importId: input.importId }),
    );
    expect(cancelled.status, describeImport(cancelled)).toBe("cancelled");
    expect(cancelled.error).toMatchObject({ step: "clone", code: "cancelled" });
    expect(cancelled.leftoverPath).toBeNull();
    expect(stepStatuses(cancelled)).toMatchObject({ clone: "skipped", register: "skipped" });

    // cancelImport returns once the job settled: the clone's processes are gone, and so is
    // every folder it made.
    expect(cloneProcesses(await processesOnB())).toEqual([]);
    expect(await existsOnB(staging)).toBe(false);
    expect(await existsOnB(destination)).toBe(false);
    await expectNoProjectOnB(input.projectId);
    await expectListedOnB(input.importId, "cancelled");
    await expectNoCopyScratch();
    // The stream of a settled import is its final snapshot.
    expect((await followImportOnB(input.importId)).status).toBe("cancelled");
  });

  it.runIf(enabled)(
    "[wave 1] the client coordinator copies a project, and sends the files when the clone can't reach the origin",
    async () => {
      const { nodeA, nodeB, fixture } = harness;
      const io = coordinatorIo();
      const nodeBId = nodeB.remote.environmentId;

      // Clone from the origin with everything A has: the dialog's choices after "bring changes".
      const copy = await planCopyWithCoordinator({
        projectId: fixture.projectId,
        folderName: `coordinated-${randomUUID().slice(0, 8)}`,
        checkRemote: true,
        requested: { bringChanges: true, ignoredPaths: [fixture.ignoredEnv.path] },
      });
      expect(copy.options.blockedReason).toBeNull();
      expect(copy.options.defaultMode).toBe("clone");
      expect(copy.options.modes.clone.reachable).toBe(true);
      // The fork's own remote, not the upstream A's identity comes from.
      expect(copy.options.modes.clone.remoteUrl).toBe(fixture.originUrl);
      // The changes sit on an unpushed commit, so the commits must come too (A8).
      expect(copy.options.bringCommits.forced).toBe(true);
      expect(copy.options.choices).toMatchObject({
        mode: "clone",
        bringCommits: true,
        bringChanges: true,
        ignoredPaths: [fixture.ignoredEnv.path],
        copySettings: true,
      });
      expect(copy.plan.destinationPath).toMatch(new RegExp(`^${CONTAINER_CODE_DIRECTORY}/`));
      expect(copy.plan.setup).toEqual({ command: fixture.setupCommand, saveAsScript: false });

      const cloned = await runCoordinator({ io, plan: copy.plan });
      const clonedSnapshot = cloned.outcome.progress.importSnapshot;
      expect(cloned.outcome.progress.error).toBeNull();
      expect(cloned.outcome.progress.phase).toBe("done");
      // B sees this connection come from Docker's bridge: a plain one that is neither this
      // computer, HTTPS nor Tailscale. B refuses the opted-in ignored files over it, so the copy
      // exports and uploads once more without them and says so (A33, #1085).
      expect(cloned.phases).toEqual([
        "acquire",
        "export",
        "upload",
        "export",
        "upload",
        "import",
        "done",
      ]);
      expect(clonedSnapshot?.status).toBe("completed");
      expect(clonedSnapshot?.warnings).toEqual([]);
      expect(cloned.outcome.record).toMatchObject({ stage: "finished", outcome: "completed" });
      expect(cloned.outcome.project).toMatchObject({
        environmentId: nodeBId,
        workspaceRoot: copy.plan.destinationPath,
        warnings: [
          `The ignored files were not copied: they are only sent over an encrypted connection, and the one to ${nodeB.remote.label} is not.`,
        ],
      });
      const destination = copy.plan.destinationPath;
      expect(await gitOnB(destination, "rev-parse", "HEAD")).toBe(fixture.headOid);
      expect(await gitOnB(destination, "symbolic-ref", "--short", "HEAD")).toBe(
        fixture.featureBranch,
      );
      expect(await gitOnB(destination, "remote", "get-url", "origin")).toBe(fixture.originUrl);
      expect(await gitOnB(destination, "remote", "get-url", "upstream")).toBe(fixture.upstreamUrl);
      expect(statusLines(await gitOutputOnB(destination, ...STATUS_ARGS))).toEqual(
        statusLines(await gitOutputOnA(...STATUS_ARGS)),
      );
      for (const file of [fixture.trackedEdit, fixture.untrackedBinary]) {
        expect(await sha256OnB(path.posix.join(destination, file.path)), file.path).toBe(
          file.sha256,
        );
      }
      expect(await existsOnB(path.posix.join(destination, fixture.ignoredEnv.path))).toBe(false);
      const project = await waitForProject("B", cloned.outcome.record.projectId);
      expect(project).toMatchObject({ title: fixture.title, workspaceRoot: destination });
      expect(project.scripts).toEqual(fixture.scripts);
      expect(await canonicalKeyOn("B", cloned.outcome.record.projectId)).toBe(
        await canonicalKeyOn("A", fixture.projectId),
      );
      await expectSetupRanIn(destination);
      await expectNoCopyScratch();

      // The LAN-only project: with B's remote check answered, the dialog preselects Send files.
      const lan = await buildLanOnlyFixture({ fixture, nodeA: nodeA.client });
      const folderName = `coordinated-lan-${randomUUID().slice(0, 8)}`;
      const checked = await planCopyWithCoordinator({
        projectId: lan.projectId,
        folderName,
        checkRemote: true,
        requested: { bringChanges: true },
      });
      expect(checked.options.modes.clone).toMatchObject({ available: true, reachable: false });
      expect(checked.options.modes.clone.reachabilityDetail).toContain(LAN_ONLY_HOST);
      expect(checked.options.defaultMode).toBe("send-files");

      // Before the check answered, it clones: B's preflight refuses, and the copy offers the retry.
      const unchecked = await planCopyWithCoordinator({
        projectId: lan.projectId,
        folderName,
        checkRemote: false,
        requested: { bringChanges: true },
      });
      expect(unchecked.options.defaultMode).toBe("clone");
      expect(unchecked.plan.sendFilesFallback).toBe(true);
      const refused = await runCoordinator({ io, plan: unchecked.plan });
      expect(refused.outcome.progress.phase).toBe("failed");
      expect(refused.outcome.progress.error).toMatchObject({
        code: "remote-unreachable",
        retry: "send-files",
      });
      expect(refused.outcome.project).toBeNull();
      expect(await existsOnB(unchecked.plan.destinationPath)).toBe(false);

      // "Send from <source> instead": a new export and import, the same destination.
      const sendFilesPlan = projectCopyPlanWithSendFiles(unchecked.plan);
      if (sendFilesPlan === null) throw new Error("The plan has no Send files fallback.");
      const sent = await runCoordinator({
        io,
        plan: sendFilesPlan,
        restartOf: refused.outcome.record,
      });
      const sentSnapshot = sent.outcome.progress.importSnapshot;
      expect(sent.outcome.progress.error).toBeNull();
      expect(sent.outcome.progress.phase).toBe("done");
      expect(sentSnapshot?.status).toBe("completed");
      expect(sentSnapshot?.warnings).toEqual([]);
      expect(sentSnapshot?.importId).not.toBe(refused.outcome.record.importId);
      expect(sent.outcome.project).toMatchObject({
        environmentId: nodeBId,
        workspaceRoot: unchecked.plan.destinationPath,
      });
      const lanDestination = unchecked.plan.destinationPath;
      expect(await gitOnB(lanDestination, "rev-parse", "HEAD")).toBe(lan.headOid);
      expect(await gitOnB(lanDestination, "symbolic-ref", "--short", "HEAD")).toBe(lan.branch);
      expect(await gitOnB(lanDestination, "remote", "get-url", "origin")).toBe(lan.originUrl);
      expect(statusLines(await gitOutputOnB(lanDestination, ...STATUS_ARGS))).toEqual(
        statusLines(await gitOutputOnAIn(lan.workspace, ...STATUS_ARGS)),
      );
      expect((await waitForProject("B", sent.outcome.record.projectId)).workspaceRoot).toBe(
        lanDestination,
      );
      await expectNoCopyScratch();
    },
  );

  // Last: it crashes node B's server, and the tests after it would run against the next one.
  it.runIf(enabled)(
    "[wave 1] after a crash during the clone, the next server stops the clone and deletes its folder",
    async () => {
      const { nodeB, fixture } = harness;
      const destination = `${CONTAINER_CODE_DIRECTORY}/crash-${randomUUID().slice(0, 8)}`;
      const input = baseImportInput({
        title: fixture.title,
        destinationPath: destination,
        source: {
          kind: "clone",
          remoteUrl: `git@${STALLING_HOST}:${fixture.originPath}`,
          remoteName: "origin",
        },
      });
      const staging = stagingPathOf(destination, input.importId);
      await call("node B importStart", nodeB.client[PROJECT_COPY_WS_METHODS.importStart](input));
      await followImportOnB(
        input.importId,
        (snapshot) => stepStatuses(snapshot).clone === "running",
      );
      await eventually("the clone to connect on B", async () => stalledClone(await processesOnB()));
      expect(await existsOnB(staging)).toBe(true);

      await nodeB.crashServer();
      // The server is gone; the clone it started is not, and still has the staging folder.
      expect(cloneProcesses(await processesOnB()).length).toBeGreaterThan(0);
      expect(await existsOnB(staging)).toBe(true);

      await nodeB.reconnect();
      // The next server marks the job interrupted, stops the clone (provably the recorded
      // child) and deletes the folder the job owned.
      await eventually(
        "node B to settle the interrupted import",
        async () => {
          const listed = await call(
            "node B listImports",
            nodeB.client[PROJECT_COPY_WS_METHODS.listImports]({}),
          );
          const entry = listed.imports.find((item) => item.importId === input.importId);
          return (
            entry?.status === "interrupted" &&
            entry.leftoverPath === null &&
            !(await existsOnB(staging))
          );
        },
        60_000,
      );
      const settled = await followImportOnB(input.importId);
      expect(settled, describeImport(settled)).toMatchObject({
        status: "interrupted",
        leftoverPath: null,
        error: { step: "clone", code: "interrupted" },
      });
      expect(cloneProcesses(await processesOnB())).toEqual([]);
      expect(await existsOnB(destination)).toBe(false);
      await expectNoProjectOnB(input.projectId);
      // Nothing is left for "Discard leftover".
      const discarded = await call(
        "node B discardImport",
        nodeB.client[PROJECT_COPY_WS_METHODS.discardImport]({ importId: input.importId }),
      );
      expect(discarded.deleted).toBe(false);
      await expectNoCopyScratch();
    },
  );
});
