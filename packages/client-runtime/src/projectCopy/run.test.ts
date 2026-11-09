import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_COPY_DIRECT_CHUNK_BYTES,
  PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES,
  PROJECT_EXPORT_INSECURE_CHANNEL_REASON,
  PROJECT_IMPORT_LIST_MAX,
  type ProjectExportArtifactKind,
  type ProjectExportResult,
  type ProjectExportStartInput,
  type ProjectImportErrorCode,
  type ProjectImportSnapshot,
  type ProjectImportStartInput,
  type ProjectImportStatus,
  type ProjectTransferPurpose,
} from "@ryco/contracts/project-copy";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectCopyLeaseLostError,
  ProjectCopyNodeUnavailableError,
  type ProjectCopyIo,
  type ProjectCopyNodeApi,
  type ProjectCopyNodePurpose,
  type ProjectCopyTransport,
} from "./io.ts";
import type { ProjectCopyJobRecord } from "./jobRecord.ts";
import { projectCopyPlanWithSendFiles, type ProjectCopyRunPlan } from "./plan.ts";
import { PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE, projectCopyPipelineLimits } from "./pipeline.ts";
import {
  PROJECT_COPY_IMPORT_LOOKUP_TIMEOUT_MS,
  startProjectCopy,
  type ProjectCopyOutcome,
  type ProjectCopyProgress,
} from "./run.ts";

const SOURCE = "env-source" as EnvironmentId;
const TARGET = "env-target" as EnvironmentId;
const HEAD = "b".repeat(40);
const KIB = 1024;

// ── Deterministic artifact bytes ──

interface ArtifactSpec {
  readonly kind: ProjectExportArtifactKind;
  readonly byteLength: number;
  readonly seed: number;
  readonly sha256: string;
}

const spec = (kind: ProjectExportArtifactKind, byteLength: number, seed: number): ArtifactSpec => ({
  kind,
  byteLength,
  seed,
  sha256: seed.toString(16).padStart(64, "0"),
});

const allBytes = new Map<string, Uint8Array>();
const bytesOf = (artifact: ArtifactSpec, offset: number, length: number): Uint8Array => {
  const key = `${artifact.sha256}:${artifact.byteLength}`;
  let bytes = allBytes.get(key);
  if (bytes === undefined) {
    bytes = new Uint8Array(artifact.byteLength);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 7 + artifact.seed) % 251;
    }
    allBytes.set(key, bytes);
  }
  return bytes.subarray(offset, offset + length);
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rpcError = (code: string, message: string, receivedBytes?: number) =>
  Object.assign(new Error(message), {
    _tag: "ProjectCopyError" as const,
    code,
    ...(receivedBytes === undefined ? {} : { receivedBytes }),
  });

// ── A fake node: export side, transfer side and import jobs ──

type ImportBehaviour = (
  input: ProjectImportStartInput,
) => "complete" | "hold" | ProjectImportErrorCode;

interface FakeTransfer {
  readonly purpose: ProjectTransferPurpose;
  readonly byteLength: number;
  readonly sha256: string;
  readonly data: Uint8Array;
  received: number;
  committed: boolean;
}

class FakeNode {
  readonly calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  /** Throws before the node handles the call (the call never arrived). */
  before: (method: string, input: unknown) => void = () => undefined;
  /** Throws after the node handled the call (the answer was lost). */
  after: (method: string, input: unknown) => void = () => undefined;
  importBehaviour: ImportBehaviour = () => "complete";
  /** Fails the commit's check of the bytes (as if they arrived damaged). */
  failCommit: (transferId: string) => boolean = () => false;
  readonly artifacts: Map<ProjectExportArtifactKind, ArtifactSpec>;
  readonly exports = new Map<string, ProjectExportResult>();
  readonly disposed: string[] = [];
  readonly transfers = new Map<string, FakeTransfer>();
  readonly aborted: string[] = [];
  readonly imports = new Map<
    string,
    { input: ProjectImportStartInput; snapshot: ProjectImportSnapshot }
  >();
  /** The `maxChunkBytes` its export and transfer begins announce; none, as an older node. */
  announcedChunkBytes: number | undefined = undefined;
  /** Refuses reads longer than this (`invalid`), as a node whose caller's connection changed. */
  refuseReadsOver: number | undefined = undefined;
  private readonly listeners = new Map<string, Set<(snapshot: ProjectImportSnapshot) => void>>();
  private clock = 0;
  chunkCallsInFlight = 0;
  maxChunkCallsInFlight = 0;

  constructor(artifacts: ReadonlyArray<ArtifactSpec> = []) {
    this.artifacts = new Map(artifacts.map((artifact) => [artifact.kind, artifact]));
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  inputs<T>(method: string): T[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.input as T);
  }

  private now(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 22, 10, 0, 0, this.clock)).toISOString();
  }

  private async handle<T>(method: string, input: unknown, run: () => T | Promise<T>): Promise<T> {
    this.calls.push({ method, input });
    const chunkCall = method === "exportReadChunk" || method === "transferAppend";
    if (chunkCall) {
      this.chunkCallsInFlight += 1;
      this.maxChunkCallsInFlight = Math.max(this.maxChunkCallsInFlight, this.chunkCallsInFlight);
    }
    try {
      await tick();
      this.before(method, input);
      const result = await run();
      this.after(method, input);
      return result;
    } finally {
      if (chunkCall) this.chunkCallsInFlight -= 1;
    }
  }

  private emit(importId: string, status: ProjectImportStatus, code?: ProjectImportErrorCode) {
    const entry = this.imports.get(importId);
    if (!entry) return;
    entry.snapshot = {
      ...entry.snapshot,
      status,
      updatedAt: this.now(),
      error: code ? { step: "preflight", code, message: `failed: ${code}` } : null,
      warnings: status === "completed" ? ["setup skipped"] : [],
    };
    for (const listener of this.listeners.get(importId) ?? []) listener(entry.snapshot);
  }

  finishImport(importId: string, status: ProjectImportStatus, code?: ProjectImportErrorCode) {
    this.emit(importId, status, code);
  }

  readonly api: ProjectCopyNodeApi = {
    orchestration: { dispatchCommand: async () => ({ sequence: 1 }) },
    projects: {
      exportStart: (input) =>
        this.handle("exportStart", input, () => {
          const announced =
            this.announcedChunkBytes === undefined
              ? {}
              : { maxChunkBytes: this.announcedChunkBytes };
          const known = this.exports.get(input.exportId);
          if (known) return { ...known, ...announced };
          const kinds: ProjectExportArtifactKind[] = [];
          if (input.include.commits) kinds.push("commits-bundle");
          if (input.include.wholeRepository) kinds.push("repository-bundle");
          if (input.include.workingTreeChanges) kinds.push("changes-patch");
          if (input.include.avatar) kinds.push("avatar");
          const result: ProjectExportResult = {
            exportId: input.exportId,
            repository: {
              rootPath: "/Users/ada/Code/app",
              isGitRepository: true,
              branch: "feature",
              headOid: HEAD,
              isDetached: false,
              remotes: [{ name: "origin", url: "git@github.com:ada/app.git" }],
              primaryRemoteName: "origin",
              cloneRemoteName: "origin",
              canonicalKey: "github.com/ada/app",
              isShallow: false,
              hasSubmodules: false,
              usesLfs: false,
            },
            pushedState: { headOnRemote: false, upstreamBranch: null, unpushedCommitCount: 1 },
            workingTree: {
              trackedChangeCount: 1,
              untrackedCount: 0,
              hasConflicts: false,
              ignoredCandidates: [],
            },
            settings: {
              title: "App",
              scripts: [],
              customSystemPrompt: null,
              preferredRemoteName: null,
              projectMetadataDir: ".ryco",
              hasCustomAvatar: true,
              overrides: { worktreeBranchPrefix: "ada", runSetupScript: false },
              relativeRootInRepository: "",
            },
            artifacts: kinds.flatMap((kind) => {
              const artifact = this.artifacts.get(kind);
              return artifact
                ? [
                    {
                      artifactId: `artifact-${kind}`,
                      kind,
                      byteLength: artifact.byteLength,
                      sha256: artifact.sha256,
                      ...(kind === "changes-patch" && input.include.ignoredPaths.length > 0
                        ? { carriesIgnoredFiles: true }
                        : {}),
                    },
                  ]
                : [];
            }),
            skipped: [],
            expiresAt: "2026-10-22T11:00:00.000Z",
          };
          this.exports.set(input.exportId, result);
          return { ...result, ...announced };
        }),
      exportReadChunk: (input) =>
        this.handle("exportReadChunk", input, () => {
          const result = this.exports.get(input.exportId);
          if (!result || this.disposed.includes(input.exportId)) {
            throw rpcError("not-found", "No such export.");
          }
          if (this.refuseReadsOver !== undefined && input.length > this.refuseReadsOver) {
            throw rpcError("invalid", "Too large a chunk for this connection.");
          }
          const kind = input.artifactId.replace("artifact-", "") as ProjectExportArtifactKind;
          const artifact = this.artifacts.get(kind)!;
          const length = Math.min(input.length, artifact.byteLength - input.offset);
          return {
            dataBase64: toBase64(bytesOf(artifact, input.offset, length)),
            offset: input.offset,
            length,
            eof: input.offset + length === artifact.byteLength,
          };
        }),
      exportDispose: (input) =>
        this.handle("exportDispose", input, () => {
          this.disposed.push(input.exportId);
          return {};
        }),
      transferBegin: (input) =>
        this.handle("transferBegin", input, () => {
          const announced =
            this.announcedChunkBytes === undefined
              ? {}
              : { maxChunkBytes: this.announcedChunkBytes };
          const existing = this.transfers.get(input.transferId);
          if (existing) {
            if (existing.sha256 !== input.sha256 || existing.byteLength !== input.byteLength) {
              throw rpcError("conflict", "Begun with other bytes.");
            }
            return { transferId: input.transferId, receivedBytes: existing.received, ...announced };
          }
          this.transfers.set(input.transferId, {
            purpose: input.purpose,
            byteLength: input.byteLength,
            sha256: input.sha256,
            data: new Uint8Array(input.byteLength),
            received: 0,
            committed: false,
          });
          return { transferId: input.transferId, receivedBytes: 0, ...announced };
        }),
      transferAppend: (input) =>
        this.handle("transferAppend", input, () => {
          const transfer = this.transfers.get(input.transferId);
          if (!transfer) throw rpcError("not-found", "No such transfer.");
          if (input.offset > transfer.received) {
            throw rpcError("invalid", "Gap.", transfer.received);
          }
          const bytes = fromBase64(input.dataBase64);
          transfer.data.set(bytes, input.offset);
          transfer.received = Math.max(transfer.received, input.offset + bytes.length);
          return { transferId: input.transferId, receivedBytes: transfer.received };
        }),
      transferCommit: (input) =>
        this.handle("transferCommit", input, () => {
          const transfer = this.transfers.get(input.transferId)!;
          const artifact = KNOWN_ARTIFACTS.find(
            (candidate) =>
              candidate.sha256 === transfer.sha256 && candidate.byteLength === transfer.byteLength,
          )!;
          const expected = bytesOf(artifact, 0, artifact.byteLength);
          if (
            this.failCommit(input.transferId) ||
            transfer.received !== transfer.byteLength ||
            expected.some((byte, index) => transfer.data[index] !== byte)
          ) {
            throw rpcError("conflict", "The bytes do not verify.");
          }
          transfer.committed = true;
          return {
            transferId: input.transferId,
            byteLength: transfer.byteLength,
            sha256: transfer.sha256,
          };
        }),
      transferAbort: (input) =>
        this.handle("transferAbort", input, () => {
          this.aborted.push(input.transferId);
          this.transfers.delete(input.transferId);
          return {};
        }),
      importStart: (input) =>
        this.handle("importStart", input, () => {
          const existing = this.imports.get(input.importId);
          if (existing) {
            if (JSON.stringify(existing.input) !== JSON.stringify(input)) {
              throw rpcError("conflict", "Another input.");
            }
            return existing.snapshot;
          }
          for (const transferId of [
            input.commits?.transferId,
            input.changes?.transferId,
            input.avatarTransferId,
            input.source.kind === "repository-bundle" ? input.source.transferId : null,
          ]) {
            if (transferId && !this.transfers.get(transferId)?.committed) {
              throw rpcError("invalid", `Transfer ${transferId} is not committed.`);
            }
          }
          const at = this.now();
          const snapshot: ProjectImportSnapshot = {
            importId: input.importId,
            projectId: input.projectId,
            title: input.title,
            destinationPath: input.destinationPath,
            status: "running",
            steps: [],
            outputTail: "",
            error: null,
            warnings: [],
            preflight: null,
            leftoverPath: null,
            followUpThreadId: null,
            origin: input.origin,
            createdAt: at,
            updatedAt: at,
          };
          this.imports.set(input.importId, { input, snapshot });
          const behaviour = this.importBehaviour(input);
          if (behaviour !== "hold") {
            setTimeout(() => {
              if (behaviour === "complete") this.emit(input.importId, "completed");
              else this.emit(input.importId, "failed", behaviour);
            }, 0);
          }
          return snapshot;
        }),
      subscribeImport: (input, callback, options) => {
        this.calls.push({ method: "subscribeImport", input });
        const entry = this.imports.get(input.importId);
        let active = true;
        if (!entry) {
          setTimeout(() => {
            if (!active) return;
            options?.classifyFailure?.(
              rpcError("not-found", "This node does not know that import."),
            );
            options?.onError?.();
          }, 0);
          return () => {
            active = false;
          };
        }
        const listener = (snapshot: ProjectImportSnapshot) => active && callback(snapshot);
        const listeners = this.listeners.get(input.importId) ?? new Set();
        listeners.add(listener);
        this.listeners.set(input.importId, listeners);
        setTimeout(() => listener(this.imports.get(input.importId)!.snapshot), 0);
        return () => {
          active = false;
          listeners.delete(listener);
        };
      },
      cancelImport: (input) =>
        this.handle("cancelImport", input, () => {
          const entry = this.imports.get(input.importId)!;
          if (entry.snapshot.status === "running") this.emit(input.importId, "cancelled");
          return entry.snapshot;
        }),
      listImports: (input) =>
        this.handle("listImports", input, () => ({
          imports: Array.from(this.imports.values())
            .map((entry) => entry.snapshot)
            .toReversed()
            .slice(0, PROJECT_IMPORT_LIST_MAX),
        })),
    },
  };
}

const TEST_ARTIFACTS = new Map<ProjectExportArtifactKind, ArtifactSpec>([
  ["commits-bundle", spec("commits-bundle", 400 * KIB, 11)],
  ["changes-patch", spec("changes-patch", 200 * KIB, 23)],
  ["avatar", spec("avatar", 10 * KIB, 37)],
  ["repository-bundle", spec("repository-bundle", 500 * KIB, 41)],
]);
/** Every artifact a fake node may be asked to verify; tests add their own. */
const KNOWN_ARTIFACTS: ArtifactSpec[] = Array.from(TEST_ARTIFACTS.values());
const known = (artifact: ArtifactSpec): ArtifactSpec => {
  KNOWN_ARTIFACTS.push(artifact);
  return artifact;
};

// ── A fake IO over two fake nodes ──

class FakeIo implements ProjectCopyIo {
  readonly acquired: Array<{ environmentId: EnvironmentId; purpose: ProjectCopyNodePurpose }> = [];
  readonly held = new Map<EnvironmentId, number>();
  readonly transports = new Map<EnvironmentId, ProjectCopyTransport>();
  /** Throws a lost lease (before calling) when it returns true. */
  loseLease: (environmentId: EnvironmentId) => boolean = () => false;
  failAcquire: (environmentId: EnvironmentId) => boolean = () => false;
  /** Chunks read from the source and not yet appended to the target. */
  chunksHeld = 0;
  maxChunksHeld = 0;
  private ids = 0;
  private clock = 1_000;

  readonly nodes: ReadonlyMap<EnvironmentId, FakeNode>;
  /** Each node's current connection: replacing it ends its subscriptions without a word. */
  private readonly connections = new Map<EnvironmentId, AbortController>();

  constructor(nodes: ReadonlyMap<EnvironmentId, FakeNode>) {
    this.nodes = nodes;
  }

  private connection(environmentId: EnvironmentId): AbortController {
    let connection = this.connections.get(environmentId);
    if (connection === undefined) {
      connection = new AbortController();
      this.connections.set(environmentId, connection);
    }
    return connection;
  }

  /**
   * The node's connection is replaced (a relay renewal, a hidden tab in hosted mode): its
   * transport is disposed, so its subscriptions stop without calling `onError`.
   */
  replaceConnection(environmentId: EnvironmentId) {
    this.connection(environmentId).abort();
    this.connections.set(environmentId, new AbortController());
  }

  node(environmentId: EnvironmentId): FakeNode {
    const node = this.nodes.get(environmentId);
    if (!node) throw new ProjectCopyNodeUnavailableError(environmentId, "Unknown node.");
    return node;
  }

  readonly acquireNode: ProjectCopyIo["acquireNode"] = async (request) => {
    await tick();
    if (this.failAcquire(request.environmentId)) {
      throw new ProjectCopyNodeUnavailableError(
        request.environmentId,
        "All connections are in use.",
      );
    }
    this.acquired.push({ environmentId: request.environmentId, purpose: request.purpose });
    this.held.set(request.environmentId, (this.held.get(request.environmentId) ?? 0) + 1);
    let released = false;
    return {
      environmentId: request.environmentId,
      transport: this.transports.get(request.environmentId) ?? "direct",
      release: () => {
        if (released) return;
        released = true;
        this.held.set(request.environmentId, (this.held.get(request.environmentId) ?? 0) - 1);
      },
    };
  };

  private wrap(api: ProjectCopyNodeApi, connection: AbortSignal): ProjectCopyNodeApi {
    const projects = api.projects;
    return {
      ...api,
      projects: {
        ...projects,
        subscribeImport: (input, callback, options) =>
          projects.subscribeImport!(
            input,
            (snapshot) => {
              if (!connection.aborted) callback(snapshot);
            },
            {
              ...options,
              onError: () => {
                if (!connection.aborted) options?.onError?.();
              },
            },
          ),
        exportReadChunk: async (input) => {
          const result = await projects.exportReadChunk!(input);
          this.chunksHeld += 1;
          this.maxChunksHeld = Math.max(this.maxChunksHeld, this.chunksHeld);
          return result;
        },
        transferAppend: async (input) => {
          try {
            return await projects.transferAppend!(input);
          } finally {
            this.chunksHeld -= 1;
          }
        },
      },
    };
  }

  readonly withLease: ProjectCopyIo["withLease"] = async (environmentId, call) => {
    if (this.loseLease(environmentId)) {
      throw new ProjectCopyLeaseLostError(environmentId);
    }
    const { signal } = this.connection(environmentId);
    return call(this.wrap(this.node(environmentId).api, signal));
  };

  readonly withNode: ProjectCopyIo["withNode"] = async (environmentId, call) => {
    const { signal } = this.connection(environmentId);
    return call(this.wrap(this.node(environmentId).api, signal), signal);
  };

  readonly now = () => (this.clock += 1);
  readonly uuid = () => `00000000-0000-4000-8000-${(this.ids += 1).toString(16).padStart(12, "0")}`;
  /** Delays pass at once, except a lookup's timeout: that one waits for its signal. */
  readonly sleep = async (ms: number, signal: AbortSignal) => {
    if (ms === PROJECT_COPY_IMPORT_LOOKUP_TIMEOUT_MS && !signal.aborted) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return;
    }
    await tick();
  };
}

function setup(options: { readonly artifacts?: ReadonlyArray<ArtifactSpec> } = {}) {
  const source = new FakeNode(options.artifacts ?? Array.from(TEST_ARTIFACTS.values()));
  const target = new FakeNode();
  const io = new FakeIo(
    new Map([
      [SOURCE, source],
      [TARGET, target],
    ]),
  );
  return { source, target, io };
}

const plan = (overrides: Partial<ProjectCopyRunPlan> = {}): ProjectCopyRunPlan => ({
  title: "App",
  source: {
    kind: "export",
    environmentId: SOURCE,
    label: "MacBook",
    projectId: "project-src" as ProjectId,
    checkoutPath: null,
  },
  target: { environmentId: TARGET, label: "Mac mini", pathSeparator: "/" },
  destinationPath: "/home/ada/Code/app",
  choices: {
    mode: "clone",
    bringCommits: true,
    bringChanges: true,
    ignoredPaths: [],
    copySettings: true,
    copyAvatar: true,
  },
  expectedCanonicalKey: null,
  setup: null,
  followUpThread: null,
  origin: { kind: "user", sourceLabel: "MacBook", proposalId: null },
  sendFilesFallback: true,
  ...overrides,
});

const phasesOf = (progress: ReadonlyArray<ProjectCopyProgress>) =>
  progress.map((entry) => entry.phase).filter((phase, index, all) => phase !== all[index - 1]);

function track() {
  const progress: ProjectCopyProgress[] = [];
  const records: ProjectCopyJobRecord[] = [];
  return {
    progress,
    records,
    onProgress: (entry: ProjectCopyProgress) => progress.push(entry),
    onRecord: (record: ProjectCopyJobRecord) => records.push(record),
  };
}

const expectReleased = (io: FakeIo) => {
  for (const count of io.held.values()) expect(count).toBe(0);
};

/** Resolves once `condition` holds, polling on the macrotask queue. */
const until = (condition: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const poll = () => {
      if (condition()) resolve();
      else setTimeout(poll, 0);
    };
    poll();
  });

/**
 * The copy's outcome, or `"pending"` when it did not settle within `turns` macrotasks (it hangs).
 * The fake I/O never waits on the clock, so a copy that can finish does so in a few turns.
 */
const settleWithin = async (
  done: Promise<ProjectCopyOutcome>,
  turns = 200,
): Promise<ProjectCopyOutcome | "pending"> => {
  const result: { outcome: ProjectCopyOutcome | "pending" } = { outcome: "pending" };
  void done.then((outcome) => {
    result.outcome = outcome;
  });
  for (let turn = 0; turn < turns && result.outcome === "pending"; turn += 1) await tick();
  return result.outcome;
};

describe("startProjectCopy", () => {
  it("exports, uploads in bounded chunks, starts the import and follows it", async () => {
    const { source, target, io } = setup();
    const seen = track();
    const run = startProjectCopy({ io, plan: plan(), ...seen });
    const outcome = await run.done;

    expect(outcome.progress).toMatchObject({ phase: "done", error: null, canCloseClient: true });
    expect(phasesOf(seen.progress)).toEqual(["acquire", "export", "upload", "import", "done"]);
    expect(outcome.record).toMatchObject({ stage: "finished", outcome: "completed" });
    expect(outcome.project).toEqual({
      environmentId: TARGET,
      projectId: outcome.record.projectId,
      workspaceRoot: "/home/ada/Code/app",
      warnings: ["setup skipped"],
    });

    // Every artifact arrived intact (the fake commit verifies the bytes).
    expect(Array.from(target.transfers.values()).map((transfer) => transfer.purpose)).toEqual([
      "commits-bundle",
      "changes-patch",
      "avatar",
    ]);
    expect(Array.from(target.transfers.values()).every((transfer) => transfer.committed)).toBe(
      true,
    );
    const totalBytes = (400 + 200 + 10) * KIB;
    expect(seen.progress.at(-1)).toMatchObject({ uploadedBytes: totalBytes, totalBytes });

    // A22/A7: bounded memory and calls in flight.
    expect(io.maxChunksHeld).toBeLessThanOrEqual(
      projectCopyPipelineLimits(PROJECT_COPY_CHUNK_BYTES).maxChunksInMemory,
    );
    expect(source.maxChunkCallsInFlight).toBeLessThanOrEqual(PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE);
    expect(target.maxChunkCallsInFlight).toBeLessThanOrEqual(PROJECT_COPY_MAX_CHUNK_RPCS_PER_NODE);
    // Appends do not wait for the one before to answer.
    expect(target.maxChunkCallsInFlight).toBeGreaterThan(1);
    // Neither node announced bigger chunks: 160 KiB, which every node takes.
    expect(
      Math.max(
        ...target
          .inputs<{ readonly dataBase64: string }>("transferAppend")
          .map((input) => atob(input.dataBase64).length),
      ),
    ).toBe(PROJECT_COPY_CHUNK_BYTES);

    // The client may close only once the target accepted the import.
    const firstClosable = seen.progress.findIndex((entry) => entry.canCloseClient);
    expect(seen.progress[firstClosable]?.phase).toBe("import");
    expect(seen.progress.slice(0, firstClosable).some((entry) => entry.phase === "import")).toBe(
      true,
    );
    const [startInput] = target.inputs<ProjectImportStartInput>("importStart");
    const transferOf = (purpose: ProjectTransferPurpose) =>
      outcome.record.transfers.find((transfer) => transfer.purpose === purpose)?.transferId;
    expect(startInput).toMatchObject({
      importId: outcome.record.importId,
      source: { kind: "clone", remoteUrl: "git@github.com:ada/app.git", remoteName: "origin" },
      commits: { transferId: transferOf("commits-bundle") },
      checkout: { branch: "feature", headOid: HEAD },
      changes: { transferId: transferOf("changes-patch"), baseOid: HEAD },
      avatarTransferId: transferOf("avatar"),
      // The project's overrides as the source exported them.
      settings: { overrides: { worktreeBranchPrefix: "ada", runSetupScript: false } },
    });
    expect(source.disposed).toEqual([outcome.record.exportId]);
    expect(io.acquired).toEqual([
      { environmentId: TARGET, purpose: "copy" },
      { environmentId: SOURCE, purpose: "copy" },
      { environmentId: TARGET, purpose: "follow" },
    ]);
    expectReleased(io);
    expect(seen.records.at(-1)).toEqual(outcome.record);
  });

  it("sends 1 MiB chunks only while both nodes are direct and announce them", async () => {
    const bundle = known(spec("commits-bundle", 3 * KIB * KIB + 5, 61));
    const largest = (node: FakeNode) =>
      Math.max(
        ...node
          .inputs<{ readonly dataBase64: string }>("transferAppend")
          .map((input) => atob(input.dataBase64).length),
      );

    const direct = setup({ artifacts: [bundle] });
    direct.source.announcedChunkBytes = PROJECT_COPY_DIRECT_CHUNK_BYTES;
    direct.target.announcedChunkBytes = PROJECT_COPY_DIRECT_CHUNK_BYTES;
    expect((await startProjectCopy({ io: direct.io, plan: plan() }).done).progress.phase).toBe(
      "done",
    );
    expect(largest(direct.target)).toBe(PROJECT_COPY_DIRECT_CHUNK_BYTES);
    expect(direct.target.count("transferAppend")).toBe(4);
    expect(direct.io.maxChunksHeld).toBeLessThanOrEqual(
      projectCopyPipelineLimits(PROJECT_COPY_DIRECT_CHUNK_BYTES).maxChunksInMemory,
    );

    // Through the relay the chunk stays at what one relay frame holds.
    const relayed = setup({ artifacts: [bundle] });
    relayed.source.announcedChunkBytes = PROJECT_COPY_DIRECT_CHUNK_BYTES;
    relayed.target.announcedChunkBytes = PROJECT_COPY_DIRECT_CHUNK_BYTES;
    relayed.io.transports.set(TARGET, "relay");
    expect((await startProjectCopy({ io: relayed.io, plan: plan() }).done).progress.phase).toBe(
      "done",
    );
    expect(largest(relayed.target)).toBe(PROJECT_COPY_CHUNK_BYTES);

    // An older target announces nothing.
    const older = setup({ artifacts: [bundle] });
    older.source.announcedChunkBytes = PROJECT_COPY_DIRECT_CHUNK_BYTES;
    expect((await startProjectCopy({ io: older.io, plan: plan() }).done).progress.phase).toBe(
      "done",
    );
    expect(largest(older.target)).toBe(PROJECT_COPY_CHUNK_BYTES);
  });

  it("falls back to 160 KiB chunks when the source refuses a larger one", async () => {
    const bundle = known(spec("commits-bundle", 2 * KIB * KIB, 67));
    const { source, target, io } = setup({ artifacts: [bundle] });
    source.announcedChunkBytes = PROJECT_COPY_DIRECT_CHUNK_BYTES;
    target.announcedChunkBytes = PROJECT_COPY_DIRECT_CHUNK_BYTES;
    source.refuseReadsOver = PROJECT_COPY_CHUNK_BYTES;
    const outcome = await startProjectCopy({ io, plan: plan() }).done;
    expect(outcome.progress.phase).toBe("done");
    const lengths = source
      .inputs<{ readonly length: number }>("exportReadChunk")
      .map((input) => input.length);
    expect(lengths[0]).toBe(PROJECT_COPY_DIRECT_CHUNK_BYTES);
    expect(lengths.at(-1)).toBeLessThanOrEqual(PROJECT_COPY_CHUNK_BYTES);
    expect(target.transfers.size).toBe(1);
  });

  it("publishes a new copy under the id the app claimed for it", async () => {
    const { io } = setup();
    const seen = track();
    const run = startProjectCopy({ io, plan: plan(), copyId: "copy-claimed", ...seen });
    expect(run.copyId).toBe("copy-claimed");
    // The first record the app stores already carries it, and the folder it goes into
    // (a stopped copy resumes only there).
    expect(seen.records[0]?.copyId).toBe("copy-claimed");
    expect(seen.records[0]?.destinationPath).toBe("/home/ada/Code/app");
    await run.done;
  });

  it("resumes a half-finished upload from the target's receivedBytes", async () => {
    const { target, io, source } = setup();
    let gone = false;
    // The target goes away as the third chunk reaches it; the first two are written.
    target.before = (method, input) => {
      if (
        method === "transferAppend" &&
        (input as { offset: number }).offset === 2 * PROJECT_COPY_CHUNK_BYTES
      ) {
        gone = true;
      }
      if (gone && method === "transferAppend") {
        throw new Error("SocketCloseError: the connection closed");
      }
    };
    io.loseLease = (environmentId) => gone && environmentId === TARGET;
    io.failAcquire = (environmentId) => gone && environmentId === TARGET;
    const first = await startProjectCopy({ io, plan: plan() }).done;
    expect(first.progress).toMatchObject({
      phase: "failed",
      error: { code: "node-unavailable", retry: "resume" },
    });
    expect(first.record.stage).toBe("upload");
    expect(target.count("importStart")).toBe(0);
    expectReleased(io);

    // A reload: the same ids, the target already holds two chunks.
    gone = false;
    target.before = () => undefined;
    const appendsBefore = target.count("transferAppend");
    const resumed = await startProjectCopy({ io, plan: plan(), resume: first.record }).done;
    expect(resumed.progress.phase).toBe("done");
    expect(resumed.record.copyId).toBe(first.record.copyId);
    expect(resumed.record.importId).toBe(first.record.importId);
    expect(
      new Set(source.inputs<ProjectExportStartInput>("exportStart").map((input) => input.exportId)),
    ).toEqual(new Set([first.record.exportId]));
    const commitsTransfer = first.record.transfers[0]!.transferId;
    const resumedAppends = target
      .inputs<{ transferId: string; offset: number }>("transferAppend")
      .slice(appendsBefore)
      .filter((input) => input.transferId === commitsTransfer);
    expect(resumedAppends.map((input) => input.offset)).toEqual([2 * PROJECT_COPY_CHUNK_BYTES]);
    expect(target.transfers.size).toBe(3);
  });

  it("pauses on a lost lease and resumes with the same ids", async () => {
    const { target, io } = setup();
    let targetCalls = 0;
    io.loseLease = (environmentId) => environmentId === TARGET && ++targetCalls === 4;
    const seen = track();
    const outcome = await startProjectCopy({ io, plan: plan(), ...seen }).done;
    expect(outcome.progress.phase).toBe("done");
    expect(phasesOf(seen.progress)).toEqual([
      "acquire",
      "export",
      "upload",
      "acquire",
      "upload",
      "import",
      "done",
    ]);
    expect(io.acquired.filter((entry) => entry.environmentId === TARGET)).toEqual([
      { environmentId: TARGET, purpose: "copy" },
      { environmentId: TARGET, purpose: "copy" },
      { environmentId: TARGET, purpose: "follow" },
    ]);
    expect(target.transfers.size).toBe(3);
    expect(outcome.record.transfers).toHaveLength(3);
    expectReleased(io);
  });

  it("does not resend an importStart the target received (A3)", async () => {
    const { target, io } = setup();
    let dropped = false;
    target.after = (method) => {
      if (method === "importStart" && !dropped) {
        dropped = true;
        throw new Error("SocketCloseError: the connection closed");
      }
    };
    const outcome = await startProjectCopy({ io, plan: plan() }).done;
    expect(outcome.progress.phase).toBe("done");
    expect(target.count("importStart")).toBe(1);
    // Looked up by its id (A3), not in the node's list of recent imports.
    expect(target.count("listImports")).toBe(0);
    expect(target.count("subscribeImport")).toBeGreaterThanOrEqual(1);
  });

  it("resends the same importStart when the target never got it (A3)", async () => {
    const { target, io } = setup();
    let dropped = false;
    target.before = (method) => {
      if (method === "importStart" && !dropped) {
        dropped = true;
        throw new Error("SocketReadError: ping timeout");
      }
    };
    const outcome = await startProjectCopy({ io, plan: plan() }).done;
    expect(outcome.progress.phase).toBe("done");
    const inputs = target.inputs<ProjectImportStartInput>("importStart");
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(target.imports.size).toBe(1);
  });

  it("offers Send files after the target can't reach the remote, then sends a bundle", async () => {
    const { source, target, io } = setup();
    target.importBehaviour = (input) =>
      input.source.kind === "clone" ? "remote-unreachable" : "complete";
    const first = await startProjectCopy({ io, plan: plan() }).done;
    expect(first.progress).toMatchObject({
      phase: "failed",
      error: { code: "remote-unreachable", retry: "send-files" },
    });
    expect(first.record).toMatchObject({ stage: "finished", outcome: "failed" });

    const retryPlan = projectCopyPlanWithSendFiles(plan());
    if (retryPlan === null) throw new Error("expected a Send files plan");
    const retried = await startProjectCopy({ io, plan: retryPlan, restartOf: first.record }).done;
    expect(retried.progress.phase).toBe("done");
    expect(retried.record.copyId).toBe(first.record.copyId);
    expect(retried.record.importId).not.toBe(first.record.importId);
    expect(retried.record.exportId).not.toBe(first.record.exportId);
    expect(source.inputs<ProjectExportStartInput>("exportStart").at(-1)?.include).toMatchObject({
      commits: false,
      wholeRepository: true,
    });
    const startInput = target.inputs<ProjectImportStartInput>("importStart").at(-1);
    expect(startInput?.source).toEqual({
      kind: "repository-bundle",
      transferId: retried.record.transfers.find(
        (transfer) => transfer.purpose === "repository-bundle",
      )?.transferId,
    });
    expect(startInput?.commits).toBeNull();
  });

  it("leaves the ignored files out when a node refuses them over a plaintext relay (A33)", async () => {
    const refusal = () =>
      rpcError(
        "access-denied",
        "This transfer carries ignored files, which never travel over an unencrypted relay.",
      );
    const carries = (input: unknown) =>
      (input as { readonly carriesIgnoredFiles?: boolean }).carriesIgnoredFiles === true;
    const withEnv = plan({ choices: { ...plan().choices, ignoredPaths: [".env"] } });
    for (const refusing of ["target", "source"] as const) {
      const { source, target, io } = setup();
      if (refusing === "target") {
        target.before = (method, input) => {
          if (method === "transferBegin" && carries(input)) throw refusal();
        };
      } else {
        source.before = (method, input) => {
          const exportId = (input as { readonly exportId?: string }).exportId ?? "";
          const exported = source.exports.get(exportId);
          if (
            method === "exportReadChunk" &&
            exported?.artifacts.some((artifact) => artifact.carriesIgnoredFiles === true) &&
            (input as { readonly artifactId: string }).artifactId === "artifact-changes-patch"
          ) {
            throw refusal();
          }
        };
      }
      const outcome = await startProjectCopy({ io, plan: withEnv }).done;

      expect(outcome.progress, refusing).toMatchObject({ phase: "done", error: null });
      const exports = source.inputs<ProjectExportStartInput>("exportStart");
      // Made again without them, under a new id; the export holding them is disposed at once.
      expect(exports.map((input) => input.include.ignoredPaths)).toEqual([[".env"], []]);
      expect(exports[1]!.exportId).not.toBe(exports[0]!.exportId);
      expect(source.disposed).toContain(exports[0]!.exportId);
      // The patch was declared as carrying them, then sent without them.
      const patchBegins = target
        .inputs<{ readonly purpose: string }>("transferBegin")
        .filter((input) => input.purpose === "changes-patch");
      expect(patchBegins.map(carries)).toEqual([true, false]);
      expect(outcome.project?.warnings).toContain(
        `The ignored files were not copied: they are only sent over an encrypted connection, and the one to ${refusing === "target" ? "Mac mini" : "MacBook"} is not.`,
      );
      expectReleased(io);
    }
  });

  it("says only the ignored files stayed behind when the source left them out of the patch (A33)", async () => {
    const { source, target, io } = setup();
    // A source on a plaintext channel builds the patch without them and says so in `skipped`.
    const exportStart = source.api.projects.exportStart!;
    (source.api.projects as { exportStart: typeof exportStart }).exportStart = async (input) => {
      const result = await exportStart({
        ...input,
        include: { ...input.include, ignoredPaths: [] },
      });
      return input.include.ignoredPaths.length === 0
        ? result
        : {
            ...result,
            skipped: [
              ...result.skipped,
              { kind: "changes-patch", reason: PROJECT_EXPORT_INSECURE_CHANNEL_REASON },
            ],
          };
    };
    const outcome = await startProjectCopy({
      io,
      plan: plan({ choices: { ...plan().choices, ignoredPaths: [".env"] } }),
    }).done;

    expect(outcome.progress).toMatchObject({ phase: "done", error: null });
    // The changes still came along, from the one export.
    expect(source.inputs("exportStart")).toHaveLength(1);
    expect(target.inputs<ProjectImportStartInput>("importStart")[0]?.changes).not.toBeNull();
    expect(outcome.project?.warnings).toContain(
      "The ignored files were not copied: they are only sent over an encrypted connection, and the one to MacBook is not.",
    );
    expect(outcome.project?.warnings.join("\n")).not.toContain("Uncommitted changes");
    expectReleased(io);
  });

  it("drops the refused patch's transfer when the export made without the ignored files has no patch", async () => {
    const { source, target, io } = setup();
    target.before = (method, input) => {
      if (
        method === "transferBegin" &&
        (input as { readonly carriesIgnoredFiles?: boolean }).carriesIgnoredFiles === true
      ) {
        // Only the ignored files differ from the commit: without them there is no patch.
        source.artifacts.delete("changes-patch");
        throw rpcError("access-denied", "Ignored files never travel over an unencrypted relay.");
      }
    };
    const outcome = await startProjectCopy({
      io,
      plan: plan({ choices: { ...plan().choices, ignoredPaths: [".env"] } }),
    }).done;

    expect(outcome.progress).toMatchObject({ phase: "done", error: null });
    const refusedPatch = target
      .inputs<{ readonly purpose: string; readonly transferId: string }>("transferBegin")
      .find((input) => input.purpose === "changes-patch");
    // The refused patch's transfer left the record and the target; the import carries no patch.
    expect(outcome.record.transfers.map((transfer) => transfer.purpose)).toEqual([
      "commits-bundle",
      "avatar",
    ]);
    expect(target.aborted).toEqual([refusedPatch!.transferId]);
    expect(target.inputs<ProjectImportStartInput>("importStart")[0]).toMatchObject({
      changes: null,
    });
    expect(outcome.project?.warnings).toContain(
      "The ignored files were not copied: they are only sent over an encrypted connection, and the one to Mac mini is not.",
    );
    expectReleased(io);
  });

  it("stops before uploading more than a relayed node may carry (A7)", async () => {
    const { source, target, io } = setup({
      artifacts: [spec("commits-bundle", 30 * KIB * KIB, 5)],
    });
    io.transports.set(SOURCE, "relay");
    const outcome = await startProjectCopy({ io, plan: plan() }).done;
    expect(outcome.progress).toMatchObject({
      phase: "failed",
      error: {
        code: "too-large",
        message:
          "Too large to send through the Hub (30 MB). Push the branch, or connect both devices directly.",
        retry: null,
      },
    });
    expect(target.count("transferBegin")).toBe(0);
    expect(source.inputs<ProjectExportStartInput>("exportStart")[0]?.patchLimitBytes).toBe(
      24 * KIB * KIB,
    );
    expect(source.disposed).toEqual([outcome.record.exportId]);
    expect(outcome.record).toMatchObject({ stage: "finished", outcome: "failed" });
  });

  it("clones from the remote alone for a source without project copy (A23)", async () => {
    const { source, target, io } = setup();
    const outcome = await startProjectCopy({
      io,
      plan: plan({
        source: {
          kind: "clone-only",
          label: "Old laptop",
          remoteUrl: "https://github.com/ada/mono.git",
          remoteName: "origin",
          remotes: [{ name: "upstream", url: "git@github.com:org/mono.git" }],
          relativeRootInRepository: "apps/web",
          settings: null,
        },
        sendFilesFallback: false,
      }),
    }).done;
    expect(outcome.progress.phase).toBe("done");
    expect(source.calls).toEqual([]);
    expect(io.acquired.map((entry) => entry.environmentId)).toEqual([TARGET, TARGET]);
    expect(target.inputs<ProjectImportStartInput>("importStart")[0]).toMatchObject({
      source: { kind: "clone", remoteUrl: "https://github.com/ada/mono.git", remoteName: "origin" },
      remotes: [{ name: "upstream", url: "git@github.com:org/mono.git" }],
      commits: null,
      changes: null,
      relativeRootInRepository: "apps/web",
    });
    expect(outcome.project?.workspaceRoot).toBe("/home/ada/Code/app/apps/web");
  });

  it("cancels during the upload and cleans up", async () => {
    const { source, target, io } = setup();
    let appends = 0;
    let cancel = () => undefined as void;
    target.before = (method) => {
      if (method === "transferAppend" && ++appends === 2) cancel();
    };
    const run = startProjectCopy({ io, plan: plan() });
    cancel = run.cancel;
    const outcome = await run.done;
    expect(outcome.progress).toMatchObject({ phase: "cancelled", error: null });
    expect(outcome.record).toMatchObject({ stage: "finished", outcome: "cancelled" });
    expect(target.count("importStart")).toBe(0);
    expect(target.aborted).toEqual(outcome.record.transfers.map((transfer) => transfer.transferId));
    expect(source.disposed).toEqual([outcome.record.exportId]);
    expectReleased(io);
  });

  it("cancels a running import on the target", async () => {
    const { target, io } = setup();
    target.importBehaviour = () => "hold";
    const run = startProjectCopy({
      io,
      plan: plan(),
      onProgress: (entry) => {
        if (entry.importSnapshot?.status === "running") run.cancel();
      },
    });
    const outcome = await run.done;
    expect(target.count("cancelImport")).toBe(1);
    expect(outcome.progress).toMatchObject({ phase: "cancelled", canCloseClient: true });
    expect(outcome.record).toMatchObject({ stage: "finished", outcome: "cancelled" });
    expect(target.aborted).toEqual([]);
  });

  it("follows an import that started before a reload, without its plan", async () => {
    const { target, io } = setup();
    target.importBehaviour = () => "hold";
    const first = startProjectCopy({ io, plan: plan() });
    let record: ProjectCopyJobRecord | null = null;
    await new Promise<void>((resolve) => {
      const poll = () => {
        if (first.getProgress().canCloseClient) resolve();
        else setTimeout(poll, 0);
      };
      poll();
    });
    first.detach();
    const detached = await first.done;
    expect(detached.progress).toMatchObject({ phase: "import", canCloseClient: true });
    record = detached.record;
    expect(record.stage).toBe("importing");
    expectReleased(io);

    io.acquired.length = 0;
    const resumed = startProjectCopy({ io, plan: null, resume: record });
    setTimeout(() => target.finishImport(record.importId, "completed"), 5);
    const outcome = await resumed.done;
    expect(outcome.progress.phase).toBe("done");
    expect(outcome.project?.workspaceRoot).toBeNull();
    expect(io.acquired).toEqual([{ environmentId: TARGET, purpose: "follow" }]);
    expect(target.count("importStart")).toBe(1);
  });

  it("follows the import on the target's next connection when its connection is replaced", async () => {
    const { target, io } = setup();
    target.importBehaviour = () => "hold";
    const run = startProjectCopy({ io, plan: plan() });
    await until(
      () =>
        run.getProgress().importSnapshot?.status === "running" &&
        target.count("subscribeImport") > 0,
    );
    const { importId } = run.getProgress().importSnapshot!;

    // A relay renewal (or a hidden tab in hosted mode) disposes the transport: the subscription
    // ends without an error, and the import completes meanwhile.
    io.replaceConnection(TARGET);
    target.finishImport(importId, "completed");

    const outcome = await settleWithin(run.done);
    expect(outcome).not.toBe("pending");
    expect(outcome).toMatchObject({
      progress: { phase: "done" },
      record: { stage: "finished", outcome: "completed" },
    });
    expectReleased(io);
  });

  it("looks a resumed import up by its id, however many imports the target got since (A3)", async () => {
    const { target, io } = setup();
    target.importBehaviour = () => "hold";
    const first = startProjectCopy({ io, plan: plan() });
    await until(() => first.getProgress().canCloseClient);
    first.detach();
    const { record } = await first.done;

    // More imports than the node lists ran there since (other copies, agent imports).
    const ours = target.imports.get(record.importId)!;
    for (let index = 0; index < PROJECT_IMPORT_LIST_MAX + 5; index += 1) {
      const importId = `00000000-0000-4000-8000-${(900 + index).toString().padStart(12, "0")}`;
      target.imports.set(importId, {
        input: ours.input,
        snapshot: { ...ours.snapshot, importId: importId as typeof record.importId },
      });
    }

    const resumed = startProjectCopy({ io, plan: null, resume: record });
    setTimeout(() => target.finishImport(record.importId, "completed"), 5);
    const outcome = await resumed.done;
    expect(outcome.progress).toMatchObject({ phase: "done", error: null });
    expect(target.count("listImports")).toBe(0);
  });

  it("fails as lost only when the target says it does not know the import", async () => {
    const { target, io } = setup();
    target.importBehaviour = () => "hold";
    const first = startProjectCopy({ io, plan: plan() });
    await until(() => first.getProgress().canCloseClient);
    first.detach();
    const { record } = await first.done;
    target.imports.delete(record.importId);

    const outcome = await startProjectCopy({ io, plan: null, resume: record }).done;
    expect(outcome.progress).toMatchObject({
      phase: "failed",
      error: { code: "import-lost", retry: null },
    });
    expect(outcome.record).toMatchObject({ stage: "finished", outcome: "failed" });
  });

  it("cancels the import a resumed copy already started on the target", async () => {
    const { target, io } = setup();
    target.importBehaviour = () => "hold";
    const first = startProjectCopy({ io, plan: plan() });
    await until(() => first.getProgress().canCloseClient);
    first.detach();
    const detached = await first.done;
    // Both answers to importStart were lost: the record never got past `import-requested`.
    const record: ProjectCopyJobRecord = { ...detached.record, stage: "import-requested" };

    const resumed = startProjectCopy({ io, plan: plan(), resume: record });
    resumed.cancel();
    const outcome = await settleWithin(resumed.done);
    expect(outcome).not.toBe("pending");
    expect(target.count("cancelImport")).toBe(1);
    expect(target.imports.get(record.importId)?.snapshot.status).toBe("cancelled");
    expect(target.count("importStart")).toBe(1);
    expect(outcome).toMatchObject({
      progress: { phase: "cancelled", canCloseClient: true },
      record: { stage: "finished", outcome: "cancelled" },
    });
  });

  it("stops a resumed copy the target never got without sending it again", async () => {
    const { source, target, io } = setup();
    // importStart never arrives, and its answer never comes back.
    target.before = (method) => {
      if (method === "importStart") throw new Error("SocketReadError: ping timeout");
    };
    const first = await startProjectCopy({ io, plan: plan() }).done;
    expect(first.progress.error).toMatchObject({ code: "node-unavailable", retry: "resume" });
    expect(first.record.stage).toBe("import-requested");
    expect(target.imports.size).toBe(0);
    target.before = () => undefined;
    const sent = target.count("importStart");

    const resumed = startProjectCopy({ io, plan: plan(), resume: first.record });
    resumed.cancel();
    const outcome = await resumed.done;
    expect(outcome).toMatchObject({
      progress: { phase: "cancelled" },
      record: { stage: "finished", outcome: "cancelled" },
    });
    expect(target.count("importStart")).toBe(sent);
    expect(target.imports.size).toBe(0);
    expect(target.aborted).toEqual(first.record.transfers.map((transfer) => transfer.transferId));
    expect(source.count("exportStart")).toBe(1);
  });

  it("asks the target again when Cancel is pressed after a cancel that did not get through", async () => {
    const { target, io } = setup();
    target.importBehaviour = () => "hold";
    let refused = false;
    target.before = (method) => {
      if (method === "cancelImport" && !refused) {
        refused = true;
        throw rpcError("internal", "The node is busy.");
      }
    };
    const run = startProjectCopy({ io, plan: plan() });
    await until(() => run.getProgress().importSnapshot?.status === "running");
    run.cancel();
    await until(() => refused);
    for (let index = 0; index < 5; index += 1) await tick();
    expect(target.imports.get(run.getProgress().importSnapshot!.importId)?.snapshot.status).toBe(
      "running",
    );

    run.cancel();
    const outcome = await settleWithin(run.done);
    expect(outcome).not.toBe("pending");
    expect(target.count("cancelImport")).toBe(2);
    expect(outcome).toMatchObject({
      progress: { phase: "cancelled" },
      record: { stage: "finished", outcome: "cancelled" },
    });
  });

  it("never carries a transfer of an earlier export with a new export's commit", async () => {
    const { source, target, io } = setup();
    let restarted = false;
    source.before = (method, input) => {
      const { artifactId } = input as { readonly artifactId?: string };
      if (method === "exportReadChunk" && artifactId === "artifact-avatar" && !restarted) {
        restarted = true;
        // The source restarts (its exports are gone); the changes were discarded meanwhile.
        source.exports.clear();
        source.artifacts.delete("changes-patch");
      }
    };
    const outcome = await startProjectCopy({ io, plan: plan() }).done;
    expect(outcome.progress.phase).toBe("done");
    expect(
      new Set(source.inputs<ProjectExportStartInput>("exportStart").map((input) => input.exportId))
        .size,
    ).toBe(2);

    const [startInput] = target.inputs<ProjectImportStartInput>("importStart");
    const transferOf = (purpose: ProjectTransferPurpose) =>
      outcome.record.transfers.find((transfer) => transfer.purpose === purpose)?.transferId;
    expect(startInput).toMatchObject({
      commits: { transferId: transferOf("commits-bundle") },
      changes: null,
      avatarTransferId: transferOf("avatar"),
    });
    // The first export's patch left the record and the target.
    expect(outcome.record.transfers.map((transfer) => transfer.purpose)).toEqual([
      "commits-bundle",
      "avatar",
    ]);
    expect(target.aborted).toHaveLength(1);
    expect(Array.from(target.transfers.values()).map((transfer) => transfer.purpose)).toEqual([
      "commits-bundle",
      "avatar",
    ]);
  });

  it("counts what it sends again through a relayed node against the Hub's budget (A7)", async () => {
    const bundle = known(spec("commits-bundle", 13 * KIB * KIB, 53));
    const { target, io } = setup({ artifacts: [bundle] });
    io.transports.set(TARGET, "relay");
    // The first upload does not verify, so the bundle is sent again from the start.
    let commits = 0;
    target.failCommit = () => ++commits === 1;
    const outcome = await startProjectCopy({ io, plan: plan() }).done;
    expect(outcome.progress).toMatchObject({
      phase: "failed",
      error: { code: "too-large", retry: null },
    });
    expect(outcome.progress.error?.message).toMatch(/^Too large to send through the Hub/u);
    const appended = target
      .inputs<{ readonly dataBase64: string }>("transferAppend")
      .reduce((sum, input) => sum + atob(input.dataBase64).length, 0);
    expect(appended).toBeGreaterThan(bundle.byteLength);
    expect(appended).toBeLessThanOrEqual(PROJECT_COPY_RELAY_MAX_ARTIFACT_BYTES);
    expect(target.count("importStart")).toBe(0);
    expect(outcome.record).toMatchObject({ stage: "finished", outcome: "failed" });
  });

  it("cleans up an upload a reload interrupted when the plan is gone", async () => {
    const { source, target, io } = setup();
    let appends = 0;
    target.after = (method) => {
      if (method === "transferAppend" && ++appends === 1) {
        io.failAcquire = () => true;
        io.loseLease = () => true;
      }
    };
    const first = await startProjectCopy({ io, plan: plan() }).done;
    expect(first.progress.error?.retry).toBe("resume");
    io.failAcquire = () => false;
    io.loseLease = () => false;
    const cleaned = await startProjectCopy({ io, plan: null, resume: first.record }).done;
    expect(cleaned.progress.error).toMatchObject({ code: "upload-interrupted", retry: null });
    expect(target.aborted).toEqual(first.record.transfers.map((transfer) => transfer.transferId));
    expect(source.disposed).toEqual([first.record.exportId]);
    expect(cleaned.record).toMatchObject({ stage: "finished", outcome: "failed" });
  });
});
