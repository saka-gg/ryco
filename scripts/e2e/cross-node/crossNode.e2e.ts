/**
 * Cross-node project copy, end to end: node A from this checkout's source on
 * the host, node B in Docker (see harness.ts). Opt-in with
 * `RYCO_TEST_CROSS_NODE_E2E=1`, and outside every normal test run: the
 * `.e2e.ts` name is not in Vitest's default include, so only this directory's
 * vitest.config.ts picks it up. Commands are in README.md.
 *
 * The copy is driven RPC by RPC, the way a client holding both nodes does it,
 * so a failure names the node and the call. The tests marked "[wave 1]" fail
 * until the project-copy services replace their placeholders, which answer
 * every call with "not available yet".
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationProjectShell,
  ProjectId,
  WS_METHODS,
} from "@ryco/contracts";
import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_IMPORT_TERMINAL_STATUSES,
  type ProjectExportArtifact,
  type ProjectExportArtifactKind,
  ProjectExportId,
  type ProjectExportResult,
  ProjectImportId,
  type ProjectImportSnapshot,
  type ProjectImportStartInput,
  ProjectTransferId,
} from "@ryco/contracts/project-copy";
import { Effect, Option, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadRemoteShell } from "../../../apps/server/src/cliRemote/threads.ts";
import {
  CONTAINER_CODE_DIRECTORY,
  CONTAINER_HOSTNAME,
  type CrossNodeHarness,
  type FixtureFile,
  SETUP_MARKER_PATH,
  isolatedEnv,
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

/** A project a node reports in its shell snapshot, once the projection has it. */
const waitForProject = async (
  node: "A" | "B",
  projectId: string,
): Promise<OrchestrationProjectShell> => {
  const client = node === "A" ? harness.nodeA.client : harness.nodeB.client;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const snapshot = await call(`node ${node} shell snapshot`, loadRemoteShell(client));
    const project = snapshot.projects.find((entry) => entry.id === projectId);
    if (project !== undefined) return project;
    if (Date.now() > deadline) throw new Error(`Project ${projectId} never appeared on ${node}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

/** Raw `git` output on B (`docker exec`); status lines start with a space. */
const gitOutputOnB = async (repository: string, ...args: ReadonlyArray<string>) =>
  (await harness.nodeB.exec(["git", "-C", repository, ...args])).stdout;
const gitOnB = async (repository: string, ...args: ReadonlyArray<string>) =>
  (await gitOutputOnB(repository, ...args)).trim();
const gitOutputOnA = async (...args: ReadonlyArray<string>) =>
  (await runCommand("git", ["-C", harness.fixture.workspace, ...args], { env: isolatedEnv() }))
    .stdout;

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
    nodeB.client[WS_METHODS.projectsTransferBegin]({
      transferId,
      purpose: artifact.kind,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    }),
  );
  expect(begun).toEqual({ transferId, receivedBytes: 0 });
  let offset = 0;
  let chunks = 0;
  let last: { readonly offset: number; readonly dataBase64: string } | null = null;
  while (offset < artifact.byteLength) {
    const chunk = await call(
      `node A exportReadChunk(${artifact.kind} @${offset})`,
      nodeA.client[WS_METHODS.projectsExportReadChunk]({
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
      nodeB.client[WS_METHODS.projectsTransferAppend]({
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
    nodeB.client[WS_METHODS.projectsTransferAppend]({ transferId, ...last }),
  );
  expect(repeated.receivedBytes).toBe(artifact.byteLength);
  const committed = await call(
    `node B transferCommit(${artifact.kind})`,
    nodeB.client[WS_METHODS.projectsTransferCommit]({ transferId }),
  );
  expect(committed).toEqual({
    transferId,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
  });
  return { transferId, chunks };
};

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
    nodeA.client[WS_METHODS.projectsExportInspect]({ projectId: fixture.projectId }),
  );
  expect(inspection.repository).toMatchObject({
    isGitRepository: true,
    branch: fixture.featureBranch,
    headOid: fixture.headOid,
    isDetached: false,
    primaryRemoteName: "origin",
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
  const hints = await call("node B pathHints", nodeB.client[WS_METHODS.projectsPathHints]({}));
  expect(hints.defaultProjectDirectory).toBe(CONTAINER_CODE_DIRECTORY);
  const preview = await call(
    "node B previewDestination",
    nodeB.client[WS_METHODS.projectsPreviewDestination]({
      path: `${hints.defaultProjectDirectory}/${input.name}`,
    }),
  );
  expect(preview.state).toBe("available");
  const access = await call(
    "node B checkRemoteAccess",
    nodeB.client[WS_METHODS.projectsCheckRemoteAccess]({ remoteUrl: fixture.originUrl }),
  );
  expect(access).toMatchObject({ reachable: true, alternateRemoteUrl: null });

  const exportId = ProjectExportId.make(randomUUID());
  const exported = await call(
    "node A exportStart",
    nodeA.client[WS_METHODS.projectsExportStart]({
      exportId,
      projectId: fixture.projectId,
      include: {
        commits: true,
        workingTreeChanges: true,
        ignoredPaths: input.ignoredPaths,
        wholeRepository: false,
        avatar: false,
      },
    }),
  );
  try {
    expect(exported.skipped).toEqual([]);
    expect(exported.artifacts.map((artifact) => artifact.kind).toSorted()).toEqual([
      "changes-patch",
      "commits-bundle",
    ]);
    const transfers = new Map<ProjectExportArtifactKind, ProjectTransferId>();
    const chunkCounts = new Map<ProjectExportArtifactKind, number>();
    for (const artifact of exported.artifacts) {
      const { transferId, chunks } = await transferArtifact(exportId, artifact);
      transfers.set(artifact.kind, transferId);
      chunkCounts.set(artifact.kind, chunks);
    }

    const { repository, settings } = exported;
    const primaryRemoteName = repository.primaryRemoteName ?? "origin";
    const primaryRemote = repository.remotes.find((remote) => remote.name === primaryRemoteName);
    if (primaryRemote === undefined || repository.headOid === null) {
      throw new Error(`Export has no primary remote or HEAD: ${JSON.stringify(repository)}`);
    }
    const setupScript = settings.scripts.find((script) => script.runOnWorktreeCreate);
    const commitsTransfer = transfers.get("commits-bundle");
    const changesTransfer = transfers.get("changes-patch");
    const importInput: ProjectImportStartInput = {
      importId: ProjectImportId.make(randomUUID()),
      projectId: ProjectId.make(randomUUID()),
      title: settings.title,
      destinationPath: preview.resolvedPath,
      source: { kind: "clone", remoteUrl: primaryRemote.url, remoteName: primaryRemoteName },
      remotes: repository.remotes.filter((remote) => remote.name !== primaryRemoteName),
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
      settings: {
        scripts: settings.scripts,
        customSystemPrompt: settings.customSystemPrompt,
        preferredRemoteName: settings.preferredRemoteName,
        projectMetadataDir: settings.projectMetadataDir,
      },
      avatarTransferId: null,
      setup:
        setupScript === undefined ? null : { command: setupScript.command, saveAsScript: false },
      followUpThread: null,
      origin: { kind: "user", sourceLabel: nodeA.remote.label, proposalId: null },
    };
    const started = await call(
      "node B importStart",
      nodeB.client[WS_METHODS.projectsImportStart](importInput),
    );
    expect(started.importId).toBe(importInput.importId);
    // Idempotent by id: the same input again returns the same job.
    const repeated = await call(
      "node B importStart (repeated)",
      nodeB.client[WS_METHODS.projectsImportStart](importInput),
    );
    expect(repeated.importId).toBe(importInput.importId);

    const finished = await call(
      "node B subscribeImport",
      nodeB.client[WS_METHODS.projectsSubscribeImport]({ importId: importInput.importId }).pipe(
        Stream.takeUntil((snapshot) => PROJECT_IMPORT_TERMINAL_STATUSES.includes(snapshot.status)),
        Stream.runLast,
        Effect.timeout("5 minutes"),
      ),
    );
    if (Option.isNone(finished)) throw new Error("The import stream ended without a snapshot.");
    return { exported, importInput, snapshot: finished.value, chunkCounts };
  } finally {
    await call(
      "node A exportDispose",
      nodeA.client[WS_METHODS.projectsExportDispose]({ exportId }),
    ).catch(() => undefined);
  }
};

/** Everything both copies must agree on, checked on B with `docker exec` and over RPC. */
const expectCopiedCheckout = async (outcome: CopyOutcome) => {
  const { nodeB, fixture } = harness;
  const { snapshot, importInput } = outcome;
  const destination = importInput.destinationPath;
  expect(snapshot.status, describeImport(snapshot)).toBe("completed");
  expect(snapshot.error, describeImport(snapshot)).toBeNull();
  expect(
    Object.fromEntries(snapshot.steps.map((step) => [step.id, step.status])),
    describeImport(snapshot),
  ).toMatchObject({
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
  const listed = await call("node B listImports", nodeB.client[WS_METHODS.projectsListImports]({}));
  expect(listed.imports.find((entry) => entry.importId === importInput.importId)?.status).toBe(
    "completed",
  );

  // The setup script ran in the project root and saw none of the server's RYCO_* variables.
  const marker = await nodeB.exec(["cat", path.posix.join(destination, SETUP_MARKER_PATH)]);
  expect(marker.stdout.trim().split("\n")).toEqual([destination, "0"]);
};

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
});
