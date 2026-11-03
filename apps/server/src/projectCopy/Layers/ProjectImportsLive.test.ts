import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type OrchestrationCommand,
  type ServerProvider,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@ryco/contracts";
import {
  ProjectCopyError,
  ProjectImportSnapshot,
  ProjectImportStartInput,
  type ProjectImportId,
  type ProjectImportStepId,
  type ProjectImportStepStatus,
} from "@ryco/contracts/project-copy";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceAccessPolicyLayer } from "../../workspace/Layers/WorkspaceAccessPolicy.ts";
import { withProjectDestinationReservation } from "../destinationReservation.ts";
import { ProjectImportStepError, ProjectSetupCommandError } from "../Errors.ts";
import {
  osProjectImportProcessControl,
  type ProjectImportProcessControl,
} from "../projectImportProcesses.ts";
import {
  initialProjectImportSnapshot,
  projectImportCommandId,
  projectImportInputDigest,
  projectImportStagingPath,
  projectImportThreadId,
  withImportStep,
} from "../projectImportSnapshot.ts";
import type { ProjectCopyChildProcess } from "../Services/ProjectCopyProcess.ts";
import { GitNetwork } from "../Services/GitNetwork.ts";
import { NodePaths } from "../Services/NodePaths.ts";
import { ProjectImportGit } from "../Services/ProjectImportGit.ts";
import { ProjectImports, type ProjectImportsShape } from "../Services/ProjectImports.ts";
import {
  ProjectSetupCommand,
  type ProjectSetupCommandResult,
} from "../Services/ProjectSetupCommand.ts";
import { ProjectTransfers } from "../Services/ProjectTransfers.ts";
import {
  makeRestartSensitiveWork,
  RestartSensitiveWork,
} from "../../updates/restartSensitiveWork.ts";
import { makeProjectImportsLive, newestAtMostEvery } from "./ProjectImportsLive.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000970485973000003e8000003e801b57b526b0000000d49444154789c636060" +
    "6060000000050001a5f645400000000049454e44ae426082",
  "hex",
);
const HEAD_OID = "a".repeat(40);
const CANONICAL_KEY = "github.com/acme/app";

const tempDir = (prefix: string) =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ryco-import-${prefix}-`)));

const identityOf = (target: string) => {
  const info = fs.lstatSync(target, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};

/** Realpath of the nearest existing ancestor plus the rest, as the live node paths judge. */
const canonicalize = (target: string): string => {
  const below: Array<string> = [];
  let ancestor = path.resolve(target);
  while (!fs.existsSync(ancestor)) {
    below.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync(ancestor), ...below);
};

const decodeInput = Schema.decodeUnknownSync(ProjectImportStartInput);

const makeInput = (overrides: Record<string, unknown> = {}): ProjectImportStartInput =>
  decodeInput({
    importId: randomUUID(),
    projectId: `project-${randomUUID()}`,
    title: "App",
    destinationPath: "/tmp/does-not-matter",
    source: { kind: "clone", remoteUrl: "https://github.com/acme/app.git", remoteName: "origin" },
    remotes: [],
    commits: null,
    checkout: { branch: "main", headOid: HEAD_OID },
    changes: null,
    relativeRootInRepository: "",
    recurseSubmodules: false,
    usesLfs: false,
    settings: null,
    avatarTransferId: null,
    setup: null,
    followUpThread: null,
    origin: { kind: "user", sourceLabel: "MacBook", proposalId: null },
    ...overrides,
  });

interface HarnessOptions {
  /** Blocks the clone until opened; recorded as interrupted when cancelled. */
  readonly cloneGate?: Deferred.Deferred<void>;
  readonly setupGate?: Deferred.Deferred<void>;
  readonly setupResult?: ProjectSetupCommandResult | "cannot-start";
  readonly providerReady?: boolean;
  readonly remoteReachable?: boolean;
  readonly failClaims?: boolean;
  /** Blocks every claim until opened (the node verifying a large upload); records an interrupt. */
  readonly claimGate?: Deferred.Deferred<void>;
  /** Blocks every release until opened (the transfers registry held by another claim). */
  readonly releaseGate?: Deferred.Deferred<void>;
  /** Blocks every avatar write until opened (a large image being re-encoded). */
  readonly avatarGate?: Deferred.Deferred<void>;
  readonly failDispatch?: ReadonlyArray<OrchestrationCommand["type"]>;
  /** The cloned repository has a `.gitmodules`, so the (failing) submodule step runs. */
  readonly withSubmodules?: boolean;
  readonly processes?: ProjectImportProcessControl;
  /** Every node settings write fails, as a full disk would. */
  readonly failSettingsWrites?: boolean;
}

interface HarnessState {
  readonly commands: Array<OrchestrationCommand>;
  readonly released: Array<string>;
  readonly avatarsWritten: Array<string>;
  readonly stoppedChildren: Array<ProjectCopyChildProcess>;
  readonly events: Array<string>;
  /** Called after every recorded event; `untilEvent` waits through these. */
  readonly eventListeners: Set<() => void>;
  readonly transfersDir: string;
  /** Every node settings patch, in order. */
  readonly settingsPatches: Array<ServerSettingsPatch>;
  settings: typeof DEFAULT_SERVER_SETTINGS;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const state: HarnessState = {
    commands: [],
    released: [],
    avatarsWritten: [],
    stoppedChildren: [],
    events: [],
    eventListeners: new Set(),
    transfersDir: tempDir("transfers"),
    settingsPatches: [],
    settings: DEFAULT_SERVER_SETTINGS,
  };
  const record = (event: string) => {
    state.events.push(event);
    for (const listener of state.eventListeners) listener();
  };
  /**
   * Records `<name>-waiting` and blocks until `gate` opens, recording `<name>-interrupted` when
   * interrupted. The record happens inside the interruptible wait, so a test that reacts to it at
   * once still reaches the wait.
   */
  const waitAt = (name: string, gate: Deferred.Deferred<void>) =>
    Effect.sync(() => record(`${name}-waiting`)).pipe(
      Effect.andThen(Deferred.await(gate)),
      Effect.onInterrupt(() => Effect.sync(() => record(`${name}-interrupted`))),
    );

  const nodePaths = Layer.effect(
    NodePaths,
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      return NodePaths.of({
        pathHints: () => Effect.die("unused"),
        searchDirectories: () => Effect.die("unused"),
        previewDestination: () => Effect.die("unused"),
        resolveCodeRoots: () => Effect.die("unused"),
        judgeProjectDestination: (input) =>
          Effect.gen(function* () {
            const canonical = canonicalize(input.path);
            const exists = fs.existsSync(canonical);
            const isGit = exists && fs.existsSync(path.join(canonical, ".git"));
            const empty = exists && fs.readdirSync(canonical).length === 0;
            const projectRoot = path.join(canonical, input.relativeRootInRepository ?? "");
            const rows = yield* projects.listAll().pipe(Effect.orDie);
            const existing = rows.find(
              (row) => row.deletedAt === null && row.workspaceRoot === projectRoot,
            );
            const state = !exists
              ? "available"
              : isGit
                ? "is-git-repository"
                : empty
                  ? "exists-empty"
                  : "exists-not-empty";
            const usable =
              existing === undefined &&
              (input.intent === "create"
                ? state === "available" || state === "exists-empty"
                : isGit);
            const keyFile = path.join(canonical, ".git", "ryco-test-key");
            return {
              preview: {
                resolvedPath: canonical,
                state,
                existingProjectId: existing?.projectId ?? null,
                existingRepositoryCanonicalKey:
                  isGit && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8") : null,
                suggestedPath: null,
                detail: null,
              },
              usable,
              canonicalPath: canonical,
              projectRoot,
              reservationKey: canonical,
            };
          }),
      });
    }),
  );

  const gitNetwork = Layer.succeed(
    GitNetwork,
    GitNetwork.of({
      env: {},
      runGitNetworkCommand: () => Effect.die("unused"),
      lsRemote: () => Effect.die("unused"),
      checkRemoteAccess: () =>
        Effect.succeed(
          options.remoteReachable === false
            ? { reachable: false, alternateRemoteUrl: null, detail: "Repository not found" }
            : { reachable: true, alternateRemoteUrl: null, detail: null },
        ),
      alternateRemoteUrl: () => null,
      sanitizeRemoteUrl: (url) => url,
      classifyRemoteUrl: () => "https",
    }),
  );

  const writeRepository = (root: string) => {
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "ryco-test-key"), CANONICAL_KEY);
    fs.writeFileSync(path.join(root, "README.md"), "# App\n");
    if (options.withSubmodules) fs.writeFileSync(path.join(root, ".gitmodules"), "");
  };

  const importGit = Layer.succeed(
    ProjectImportGit,
    ProjectImportGit.of({
      cloneNoCheckout: (input) =>
        Effect.gen(function* () {
          const child = { pid: 999_999, pgid: 999_999, startedAt: new Date().toISOString() };
          yield* input.observer?.onChild?.(child) ?? Effect.void;
          writeRepository(input.repositoryRoot);
          yield* input.observer?.onOutput?.("Receiving objects:  50% (5/10)\r") ?? Effect.void;
          yield* (
            input.onProgress?.({ percent: 50, detail: "Receiving objects: 50%" }) ?? Effect.void
          );
          if (options.cloneGate !== undefined) {
            yield* waitAt("clone", options.cloneGate);
          }
          yield* input.observer?.onChild?.(null) ?? Effect.void;
          record("cloned");
        }),
      initFromBundle: (input) => Effect.sync(() => writeRepository(input.repositoryRoot)),
      fetchCommitsBundle: () =>
        Effect.sync(() => {
          record("commits");
          return { headOid: HEAD_OID };
        }),
      checkout: (input) =>
        Effect.sync(() => {
          const root = path.join(input.repositoryRoot, input.relativeRootInRepository);
          fs.mkdirSync(root, { recursive: true });
          record(`checkout:${input.checkout?.branch ?? "default"}`);
          return { branch: input.checkout?.branch ?? "main", headOid: HEAD_OID, upstream: null };
        }),
      setRemotes: (input) =>
        Effect.sync(() => {
          record(`remotes:${input.remotes.map((remote) => remote.name).join(",")}`);
          return { warnings: [] };
        }),
      applyChanges: (input) =>
        Effect.sync(() => {
          record("changes");
          return input.baseOid === HEAD_OID
            ? ({ status: "applied" } as const)
            : ({
                status: "kept",
                reason: "base-mismatch",
                keptPatchPath: `.git/ryco-imports/${input.importId}.patch`,
                detail: "HEAD is not the patch's base",
              } as const);
        }),
      updateSubmodules: () =>
        Effect.fail(
          new ProjectImportStepError({
            code: "internal",
            message: "private submodule",
            detail: null,
          }),
        ),
      lfsPull: () => Effect.succeed({ status: "lfs-missing" as const }),
    }),
  );

  const transfers = Layer.succeed(
    ProjectTransfers,
    ProjectTransfers.of({
      begin: () => Effect.die("unused"),
      append: () => Effect.die("unused"),
      commit: () => Effect.die("unused"),
      abort: () => Effect.die("unused"),
      sweep: () => Effect.void,
      claimForImport: (input) =>
        Effect.gen(function* () {
          if (options.claimGate !== undefined) {
            yield* waitAt("claim", options.claimGate);
          }
          if (options.failClaims) {
            return yield* new ProjectCopyError({ code: "not-found", message: "Transfer expired." });
          }
          return input.transfers.map((claim) => {
            const directory = path.join(state.transfersDir, input.importId);
            fs.mkdirSync(directory, { recursive: true });
            const file = path.join(directory, claim.transferId);
            const bytes = claim.purpose === "avatar" ? PNG_1X1 : Buffer.from(claim.purpose);
            fs.writeFileSync(file, bytes);
            return {
              ...claim,
              path: file,
              byteLength: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
          });
        }),
      releaseImport: (importId) =>
        Effect.gen(function* () {
          if (options.releaseGate !== undefined) {
            record("release-waiting");
            yield* Deferred.await(options.releaseGate);
          }
          state.released.push(importId);
        }),
    }),
  );

  const setup = Layer.succeed(
    ProjectSetupCommand,
    ProjectSetupCommand.of({
      run: (input) =>
        Effect.gen(function* () {
          if (options.setupResult === "cannot-start") {
            return yield* new ProjectSetupCommandError({
              reason: "spawn-failed",
              message: "no shell",
            });
          }
          record(`setup:${input.command}@${input.projectRoot}`);
          yield* input.observer?.onOutput?.("installing dependencies\n") ?? Effect.void;
          if (options.setupGate !== undefined) {
            yield* waitAt("setup", options.setupGate);
          }
          return options.setupResult ?? { outcome: "succeeded", exitCode: 0, outputTail: "done" };
        }),
    }),
  );

  const engine = Layer.effect(
    OrchestrationEngineService,
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const receipts = new Map<string, number>();
      const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
        Effect.gen(function* () {
          const seen = receipts.get(command.commandId);
          if (seen !== undefined) return { sequence: seen };
          if (options.failDispatch?.includes(command.type)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "refused by the test",
            });
          }
          state.commands.push(command);
          if (command.type === "project.create") {
            yield* projects
              .upsert({
                projectId: command.projectId,
                kind: "project",
                title: command.title,
                workspaceRoot: command.workspaceRoot,
                projectMetadataDir: command.projectMetadataDir ?? ".ryco",
                defaultModelSelection: null,
                customSystemPrompt: command.customSystemPrompt ?? null,
                customAvatarContentHash: null,
                preferredRemoteName: null,
                scripts: [],
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
                deletedAt: null,
              })
              .pipe(Effect.orDie);
          }
          const sequence = receipts.size + 1;
          receipts.set(command.commandId, sequence);
          return { sequence };
        });
      return OrchestrationEngineService.of({ dispatch } as unknown as OrchestrationEngineShape);
    }),
  );

  const avatars = Layer.succeed(ProjectAvatarStore, {
    write: (input) =>
      Effect.gen(function* () {
        if (options.avatarGate !== undefined) {
          record("avatar-waiting");
          yield* Deferred.await(options.avatarGate);
        }
        state.avatarsWritten.push(`${input.projectId}:${input.contentType}`);
        return { contentHash: createHash("sha256").update(input.bytes).digest("hex") };
      }),
    read: () => Effect.succeed(null),
    remove: () => Effect.void,
  });

  const providers = Layer.succeed(ProviderRegistry, {
    getProviders: Effect.succeed([
      {
        instanceId: "codex",
        enabled: true,
        installed: true,
        status: options.providerReady === false ? "error" : "ready",
        availability: "available",
        models: [{ slug: "gpt-5" }],
      } as unknown as ServerProvider,
    ]),
  } as unknown as ProviderRegistryShape);

  const serverSettings = Layer.mock(ServerSettingsService)({
    getSettings: Effect.sync(() => state.settings),
    updateSettings: (patch) =>
      options.failSettingsWrites
        ? Effect.fail(new ServerSettingsError({ settingsPath: "<test>", detail: "disk full" }))
        : Effect.sync(() => {
            state.settingsPatches.push(patch);
            state.settings = applyServerSettingsPatch(state.settings, patch);
            return state.settings;
          }),
  });

  const processes: ProjectImportProcessControl = options.processes ?? {
    stopRecordedChild: (child) =>
      Effect.sync(() => {
        state.stoppedChildren.push(child);
        return "gone" as const;
      }),
  };

  const dependencies = Layer.mergeAll(
    nodePaths,
    gitNetwork,
    importGit,
    transfers,
    setup,
    engine,
    avatars,
    providers,
    serverSettings,
    WorkspaceAccessPolicyLayer(undefined),
  ).pipe(
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(NodeServices.layer),
  );

  // The tests run on the test clock: no throttle pauses, every change reaches subscribers.
  const layer = makeProjectImportsLive({ processes, snapshotThrottleMs: 0 }).pipe(
    Layer.provideMerge(dependencies),
  );
  return { state, layer };
};

type Harness = ReturnType<typeof makeHarness>;

/** Runs `body` against a fresh instance of the service (its own process, as it were). */
const withImports = <A, E>(
  harness: Harness,
  body: (
    imports: ProjectImportsShape,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | ProjectionProjectRepository>,
) =>
  Effect.gen(function* () {
    const imports = yield* ProjectImports;
    return yield* body(imports);
  }).pipe(Effect.provide(harness.layer));

const waitFor = (
  imports: ProjectImportsShape,
  importId: ProjectImportId,
  predicate: (snapshot: ProjectImportSnapshot) => boolean,
) =>
  imports
    .subscribe({ importId })
    .pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.timeout("10 seconds"),
    );

const settled = (imports: ProjectImportsShape, importId: ProjectImportId) =>
  waitFor(imports, importId, (snapshot) => snapshot.status !== "running");

const stepStatus = (snapshot: ProjectImportSnapshot, id: ProjectImportStepId) =>
  snapshot.steps.find((step) => step.id === id)?.status;

const stepStatuses = (snapshot: ProjectImportSnapshot) =>
  Object.fromEntries(snapshot.steps.map((step) => [step.id, step.status])) as Record<
    ProjectImportStepId,
    ProjectImportStepStatus
  >;

const rowOf = (importId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly status: string;
      readonly staging_path: string | null;
      readonly registered: number;
      readonly owned: number;
      readonly child_pid: number | null;
    }>`SELECT status, staging_path, registered, owned, child_pid FROM project_imports
      WHERE import_id = ${importId}`;
    return rows[0];
  });

/** Waits until the harness recorded `event` `count` times. */
const untilEvent = (harness: Harness, event: string, count = 1) =>
  Effect.callback<void>((resume) => {
    const listeners = harness.state.eventListeners;
    const check = () => {
      if (harness.state.events.filter((seen) => seen === event).length < count) return;
      listeners.delete(check);
      resume(Effect.void);
    };
    listeners.add(check);
    check();
    return Effect.sync(() => listeners.delete(check));
  });

/**
 * Lets a server stop go ahead and opens `gate` after it: the stop runs synchronously once the
 * body returns, so a macrotask flush later it is already waiting on the job.
 */
const openSoon = (gate: Deferred.Deferred<void>) =>
  Effect.promise(() => new Promise((resolve) => setImmediate(resolve))).pipe(
    Effect.andThen(Deferred.succeed(gate, undefined)),
    Effect.forkDetach,
  );

/**
 * A row an earlier process left when it crashed: the steps before `running` are done and
 * `running` is running. A `running` job crashed while it ran; an `interrupted` one crashed while
 * startup recovery replayed `running`, after its other steps were skipped.
 */
const insertLeftoverRow = (
  input: ProjectImportStartInput,
  options: {
    readonly running: ProjectImportStepId;
    readonly status?: "running" | "interrupted";
    readonly staging?: { readonly path: string; readonly dev: string; readonly ino: string };
    readonly child?: { readonly pid: number; readonly startedAt: string };
    readonly registered?: boolean;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-22T00:00:00.000Z";
    const status = options.status ?? "running";
    let snapshot = initialProjectImportSnapshot(input, now);
    let reached = false;
    for (const step of snapshot.steps) {
      if (step.id === options.running) {
        reached = true;
        continue;
      }
      if (!reached || status === "interrupted") {
        snapshot = withImportStep(snapshot, step.id, { status: reached ? "skipped" : "done" }, now);
      }
    }
    snapshot = withImportStep(snapshot, options.running, { status: "running" }, now);
    if (status === "interrupted") {
      snapshot = {
        ...snapshot,
        status,
        error: {
          step: options.running,
          code: "interrupted",
          message: "Ryco restarted while this import was running.",
        },
      };
    }
    const staging = options.staging ?? null;
    const child = options.child ?? null;
    yield* sql`INSERT INTO project_imports (import_id, project_id, destination_key,
        staging_path, staging_dev, staging_ino, status, input_json, input_digest,
        snapshot_json, owned, child_pid, child_pgid, child_started_at, registered,
        created_at, updated_at)
      VALUES (${input.importId}, ${input.projectId}, ${input.destinationPath},
        ${staging?.path ?? null}, ${staging?.dev ?? null}, ${staging?.ino ?? null}, ${status},
        ${JSON.stringify(Schema.encodeSync(ProjectImportStartInput)(input))},
        ${projectImportInputDigest(input)},
        ${JSON.stringify(Schema.encodeSync(ProjectImportSnapshot)(snapshot))},
        ${staging === null ? 0 : 1}, ${child?.pid ?? null}, ${child?.pid ?? null},
        ${child?.startedAt ?? null}, ${options.registered ? 1 : 0}, ${now}, ${now})`;
  });

const followUp = {
  title: "Finish setup",
  prompt: "Install the toolchain and run the tests.",
  runtimeMode: "approval-required",
  envMode: "local",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
};

const memoryDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistenceMemory));

// ── Tests ─────────────────────────────────────────────────────────────

describe("ProjectImportsLive", () => {
  it.effect("hands subscribers at most one snapshot per interval, always the newest", () =>
    Effect.gen(function* () {
      // A burst of 200 changes, one a millisecond at most, then a last one after a pause.
      const source = Stream.range(1, 200).pipe(
        Stream.rechunk(1),
        Stream.tap((value) => (value % 20 === 0 ? Effect.sleep("1 millis") : Effect.void)),
        Stream.concat(Stream.fromEffect(Effect.sleep("150 millis").pipe(Effect.as(201)))),
      );
      const collected = yield* Stream.runCollect(source.pipe(newestAtMostEvery(50))).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      const seen = Array.from(yield* Fiber.join(collected));
      // The newest of the burst, then the last change; never a backlog of the others.
      assert.include(seen, 200);
      assert.equal(seen.at(-1), 201);
      assert.isAtMost(seen.length, 6);
      assert.deepEqual(
        seen,
        seen.toSorted((left, right) => left - right),
      );
    }),
  );

  it.effect("runs every step, registers the project and copies its settings", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness({
          setupResult: { outcome: "failed", exitCode: 2, outputTail: "npm ERR! missing" },
          withSubmodules: true,
        });
        const parent = tempDir("happy");
        fs.writeFileSync(path.join(parent, "keep.txt"), "user file");
        const destination = path.join(parent, "app");
        const transferId = () => randomUUID();
        const input = makeInput({
          destinationPath: destination,
          remotes: [{ name: "upstream", url: "https://github.com/upstream/app.git" }],
          commits: { transferId: transferId() },
          changes: { transferId: transferId(), baseOid: HEAD_OID, ignoredPaths: [".env"] },
          relativeRootInRepository: "packages/web",
          recurseSubmodules: true,
          usesLfs: true,
          settings: {
            scripts: [
              {
                id: "dev",
                name: "Dev",
                command: "bun dev",
                icon: "play",
                runOnWorktreeCreate: false,
              },
            ],
            customSystemPrompt: "Be careful.",
            preferredRemoteName: "upstream",
            projectMetadataDir: ".ryco",
            overrides: { defaultThreadEnvMode: "worktree", worktreeBranchPrefix: "team" },
          },
          avatarTransferId: transferId(),
          setup: { command: "bun install", saveAsScript: true },
          followUpThread: followUp,
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const started = yield* imports.start(input);
            assert.equal(started.status, "running");
            const first = yield* imports
              .subscribe({ importId: input.importId })
              .pipe(Stream.runHead);
            assert.isTrue(Option.isSome(first));

            const done = yield* settled(imports, input.importId);
            assert.equal(done.status, "completed");
            assert.isNull(done.error);
            assert.deepEqual(stepStatuses(done), {
              preflight: "done",
              clone: "done",
              remotes: "done",
              commits: "done",
              checkout: "done",
              changes: "done",
              submodules: "failed",
              lfs: "skipped",
              register: "done",
              settings: "done",
              avatar: "done",
              setup: "failed",
              "follow-up": "done",
            });
            assert.deepEqual(done.preflight, { remoteReachable: true, alternateRemoteUrl: null });
            assert.isTrue(
              done.warnings.some((warning) => warning.includes("Git LFS is not installed")),
            );
            assert.isTrue(done.warnings.some((warning) => warning.includes("Submodules")));
            assert.isTrue(done.warnings.some((warning) => warning.includes("exited with code 2")));
            assert.include(done.outputTail, "installing dependencies");
            assert.equal(done.followUpThreadId, projectImportThreadId(input.importId));

            // Published by rename: the destination holds the clone, the staging sibling is gone,
            // and the user's file next to it is untouched.
            assert.isTrue(fs.existsSync(path.join(destination, "README.md")));
            assert.isFalse(fs.existsSync(projectImportStagingPath(destination, input.importId)));
            assert.equal(fs.readFileSync(path.join(parent, "keep.txt"), "utf8"), "user file");

            const types = harness.state.commands.map((command) => command.type);
            assert.deepEqual(types, [
              "project.create",
              "project.meta.update",
              "project.avatar.set",
              "thread.create",
              "thread.turn.start",
            ]);
            const [create, meta, avatar, , turn] = harness.state.commands;
            assert.equal(
              create?.commandId,
              projectImportCommandId(input.importId, "project-create"),
            );
            if (create?.type === "project.create") {
              assert.equal(create.workspaceRoot, path.join(destination, "packages/web"));
              assert.equal(create.createWorkspaceRootIfMissing, false);
              assert.equal(create.customSystemPrompt, "Be careful.");
            }
            if (meta?.type === "project.meta.update") {
              assert.deepEqual(
                meta.scripts?.map((script) => [script.id, script.runOnWorktreeCreate]),
                [
                  ["dev", false],
                  ["setup", true],
                ],
              );
              assert.equal(meta.preferredRemoteName, "upstream");
            }
            // The source's overrides, saved for the new project as the settings page saves them.
            assert.deepEqual(harness.state.settings.projectPreferences[input.projectId], {
              defaultThreadEnvMode: "worktree",
              worktreeBranchPrefix: "team",
            });
            assert.equal(avatar?.type, "project.avatar.set");
            assert.deepEqual(harness.state.avatarsWritten, [`${input.projectId}:image/png`]);
            if (turn?.type === "thread.turn.start") {
              assert.include(turn.message.text, "Install the toolchain");
              assert.include(turn.message.text, "exited with code 2");
              assert.include(turn.message.text, "npm ERR! missing");
            }
            assert.include(
              harness.state.events,
              `setup:bun install@${path.join(destination, "packages/web")}`,
            );
            assert.deepEqual(harness.state.released, [input.importId]);

            const row = yield* rowOf(input.importId);
            assert.equal(row?.status, "completed");
            assert.equal(row?.registered, 1);
            assert.isNull(row?.staging_path);
            assert.isNull(row?.child_pid);

            const listed = yield* imports.list({});
            assert.equal(listed.imports[0]?.importId, input.importId);
          }),
        );
      }),
    ),
  );

  it.effect("answers a repeated start from the job and refuses a reused id", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const harness = makeHarness({ cloneGate: gate });
        const destination = path.join(tempDir("digest"), "app");
        const input = makeInput({ destinationPath: destination });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const first = yield* imports.start(input);
            const again = yield* imports.start(input);
            assert.equal(again.importId, first.importId);
            assert.equal(again.createdAt, first.createdAt);
            const conflict = yield* imports
              .start({ ...input, title: "Another title" })
              .pipe(Effect.flip);
            assert.equal(conflict.code, "conflict");
            assert.notEqual(
              projectImportInputDigest(input),
              projectImportInputDigest({ ...input, title: "Another title" }),
            );
            yield* Deferred.succeed(gate, undefined);
            assert.equal((yield* settled(imports, input.importId)).status, "completed");
            // A settled job answers a retry with its final snapshot.
            assert.equal((yield* imports.start(input)).status, "completed");
          }),
        );
      }),
    ),
  );

  it.effect("cancels before register: the clone is stopped and only its staging folder goes", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const harness = makeHarness({ cloneGate: gate });
        const parent = tempDir("cancel");
        fs.writeFileSync(path.join(parent, "keep.txt"), "user file");
        const destination = path.join(parent, "app");
        // An empty destination folder the user made stays theirs when nothing was published.
        fs.mkdirSync(destination);
        const input = makeInput({ destinationPath: destination });
        const restartWork = makeRestartSensitiveWork();
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(input);
            yield* waitFor(
              imports,
              input.importId,
              (snapshot) => stepStatus(snapshot, "clone") === "running",
            );
            const staging = projectImportStagingPath(destination, input.importId);
            yield* untilEvent(harness, "clone-waiting");
            // A node update waits while the job runs.
            assert.equal(yield* restartWork.count, 1);
            assert.isTrue(fs.existsSync(path.join(staging, "README.md")));
            const row = yield* rowOf(input.importId);
            assert.equal(row?.staging_path, staging);
            assert.equal(row?.child_pid, 999_999);

            const cancelled = yield* imports.cancel({ importId: input.importId });
            assert.equal(cancelled.status, "cancelled");
            assert.equal(cancelled.error?.code, "cancelled");
            assert.equal(cancelled.error?.step, "clone");
            assert.isNull(cancelled.leftoverPath);
            assert.include(harness.state.events, "clone-interrupted");
            assert.isFalse(fs.existsSync(staging));
            assert.isTrue(fs.existsSync(destination));
            assert.equal(fs.readFileSync(path.join(parent, "keep.txt"), "utf8"), "user file");
            assert.deepEqual(harness.state.commands, []);
            assert.deepEqual(harness.state.released, [input.importId]);
            const settledRow = yield* rowOf(input.importId);
            assert.equal(settledRow?.status, "cancelled");
            assert.isNull(settledRow?.staging_path);
            assert.equal(yield* restartWork.count, 0);
          }),
        ).pipe(Effect.provideService(RestartSensitiveWork, restartWork));
      }),
    ),
  );

  it.effect("after register nothing is deleted: a cancel during setup keeps the project", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const harness = makeHarness({ setupGate: gate, failDispatch: ["project.avatar.set"] });
        const destination = path.join(tempDir("registered"), "app");
        const input = makeInput({
          destinationPath: destination,
          avatarTransferId: randomUUID(),
          setup: { command: "make setup", saveAsScript: false },
          followUpThread: followUp,
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(input);
            yield* waitFor(
              imports,
              input.importId,
              (snapshot) => stepStatus(snapshot, "setup") === "running",
            );
            const cancelled = yield* imports.cancel({ importId: input.importId });
            assert.equal(cancelled.status, "cancelled");
            assert.equal(stepStatus(cancelled, "register"), "done");
            assert.equal(stepStatus(cancelled, "avatar"), "failed");
            assert.equal(stepStatus(cancelled, "follow-up"), "skipped");
            assert.include(cancelled.error?.message ?? "", "stays on this node");
            assert.include(harness.state.events, "setup-interrupted");
            assert.isTrue(fs.existsSync(path.join(destination, "README.md")));
            const projects = yield* ProjectionProjectRepository;
            assert.isTrue(Option.isSome(yield* projects.getById({ projectId: input.projectId })));
            const discarded = yield* imports.discard({ importId: input.importId });
            assert.isFalse(discarded.deleted);
            assert.isTrue(fs.existsSync(destination));
          }),
        );
      }),
    ),
  );

  it.effect("an override that cannot be saved leaves a warning, not a failed import", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness({ failSettingsWrites: true });
        const input = makeInput({
          destinationPath: path.join(tempDir("overrides-fail"), "app"),
          settings: {
            scripts: [],
            customSystemPrompt: null,
            preferredRemoteName: "origin",
            projectMetadataDir: ".ryco",
            overrides: { pullRequestTemplates: false },
          },
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(input);
            const done = yield* settled(imports, input.importId);
            assert.equal(done.status, "completed");
            assert.equal(stepStatus(done, "settings"), "failed");
            assert.deepEqual(done.warnings, ["The project's overrides were not copied: disk full"]);
            // The scripts and preferred remote still arrived.
            assert.deepEqual(
              harness.state.commands.map((command) => command.type),
              ["project.create", "project.meta.update"],
            );
          }),
        );
      }),
    ),
  );

  it.effect("a failing step before register removes the owned folder and reports its code", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness({ failDispatch: ["project.create"] });
        const destination = path.join(tempDir("register-fails"), "app");
        const input = makeInput({ destinationPath: destination });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(input);
            const done = yield* settled(imports, input.importId);
            assert.equal(done.status, "failed");
            assert.equal(done.error?.step, "register");
            assert.equal(done.error?.code, "register-failed");
            // Published, then removed again: the project was never added.
            assert.isFalse(fs.existsSync(destination));
            assert.isFalse(fs.existsSync(projectImportStagingPath(destination, input.importId)));
          }),
        );
      }),
    ),
  );

  it.effect("fails the preflight for an unreachable remote or a destination in use", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness({ remoteReachable: false });
        const parent = tempDir("preflight");
        const unreachable = makeInput({ destinationPath: path.join(parent, "app") });
        const occupied = path.join(parent, "occupied");
        fs.mkdirSync(occupied);
        fs.writeFileSync(path.join(occupied, "file.txt"), "x");
        const notEmpty = makeInput({ destinationPath: occupied });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(unreachable);
            const failed = yield* settled(imports, unreachable.importId);
            assert.equal(failed.error?.code, "remote-unreachable");
            assert.equal(failed.preflight?.remoteReachable, false);
            assert.isFalse(
              fs.existsSync(
                projectImportStagingPath(path.join(parent, "app"), unreachable.importId),
              ),
            );

            const refused = yield* imports.start(notEmpty);
            assert.equal(refused.status, "failed");
            assert.equal(refused.error?.code, "destination-unavailable");
            assert.include(refused.error?.message ?? "", "not empty");
            // The refusal is a job: a retry and the list see it.
            assert.equal((yield* imports.start(notEmpty)).status, "failed");
            assert.equal((yield* imports.list({})).imports.length, 2);
          }),
        );
      }),
    ),
  );

  it.effect("fails a job whose uploads cannot be claimed", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness({ failClaims: true });
        const input = makeInput({
          destinationPath: path.join(tempDir("claims"), "app"),
          avatarTransferId: randomUUID(),
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            // Answered once the claim failed, as the job's preflight failure.
            const snapshot = yield* imports.start(input);
            assert.equal(snapshot.status, "failed");
            assert.equal(snapshot.error?.code, "transfer-missing");
            assert.equal(snapshot.error?.step, "preflight");
            assert.equal(stepStatus(snapshot, "preflight"), "failed");
            assert.equal((yield* rowOf(input.importId))?.status, "failed");
          }),
        );
      }),
    ),
  );

  it.effect("links an existing checkout without touching it", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness();
        const checkout = tempDir("link");
        fs.mkdirSync(path.join(checkout, ".git"));
        fs.writeFileSync(path.join(checkout, ".git", "ryco-test-key"), CANONICAL_KEY);
        fs.writeFileSync(path.join(checkout, "work.txt"), "uncommitted");
        const linked = makeInput({
          destinationPath: checkout,
          source: { kind: "existing-checkout", expectedCanonicalKey: CANONICAL_KEY },
        });
        const otherRepository = makeInput({
          destinationPath: checkout,
          source: { kind: "existing-checkout", expectedCanonicalKey: "github.com/acme/other" },
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const refused = yield* imports.start(otherRepository);
            assert.equal(refused.error?.code, "destination-unavailable");

            yield* imports.start(linked);
            const done = yield* settled(imports, linked.importId);
            assert.equal(done.status, "completed");
            assert.equal(stepStatus(done, "clone"), "skipped");
            assert.equal(stepStatus(done, "checkout"), "skipped");
            assert.equal(fs.readFileSync(path.join(checkout, "work.txt"), "utf8"), "uncommitted");
            assert.equal(harness.state.commands[0]?.type, "project.create");
            assert.isFalse(harness.state.events.some((event) => event.startsWith("checkout")));

            const invalid = yield* imports
              .start(
                makeInput({
                  destinationPath: checkout,
                  source: { kind: "existing-checkout", expectedCanonicalKey: CANONICAL_KEY },
                  commits: { transferId: randomUUID() },
                }),
              )
              .pipe(Effect.flip);
            assert.equal(invalid.code, "invalid");
          }),
        );
      }),
    ),
  );

  it.effect("skips the follow-up thread with a warning when its provider is not ready", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness({ providerReady: false });
        const input = makeInput({
          destinationPath: path.join(tempDir("follow-up"), "app"),
          followUpThread: followUp,
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(input);
            const done = yield* settled(imports, input.importId);
            assert.equal(done.status, "completed");
            assert.equal(stepStatus(done, "follow-up"), "skipped");
            assert.isNull(done.followUpThreadId);
            assert.isTrue(done.warnings.some((warning) => warning.includes("not ready")));
            assert.isFalse(
              harness.state.commands.some((command) => command.type === "thread.create"),
            );
          }),
        );
      }),
    ),
  );

  it.effect("a reserved destination refuses a second import and a legacy clone", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const harness = makeHarness({ cloneGate: gate });
        const parent = tempDir("reserve");
        const destination = path.join(parent, "app");
        const first = makeInput({ destinationPath: destination });
        // Another spelling of the same folder: through a symlinked parent.
        const alias = path.join(tempDir("alias"), "link");
        fs.symlinkSync(parent, alias);
        const second = makeInput({ destinationPath: path.join(alias, "app") });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(first);
            const refused = yield* imports.start(second).pipe(Effect.flip);
            assert.equal(refused.code, "conflict");
            const legacy = yield* Effect.succeed("cloned").pipe(
              withProjectDestinationReservation({
                destinationPath: destination,
                holder: "sourceControl.cloneRepository",
                onReserved: (message) => ({ _tag: "Reserved" as const, message }),
              }),
              Effect.flip,
            );
            assert.equal(legacy._tag, "Reserved");

            yield* imports.cancel({ importId: first.importId });
            yield* Deferred.succeed(gate, undefined);
            yield* imports.start(second);
            assert.equal((yield* settled(imports, second.importId)).status, "completed");
          }),
        );
      }),
    ),
  );

  it.effect("discards only a leftover the job still owns", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const harness = makeHarness({ cloneGate: gate });
        const parent = tempDir("discard");
        const first = makeInput({ destinationPath: path.join(parent, "one") });
        const second = makeInput({ destinationPath: path.join(parent, "two") });
        // A server stop interrupts both jobs: their staging folders stay for recovery or discard.
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(first);
            yield* imports.start(second);
            const running = yield* imports.discard({ importId: first.importId });
            assert.deepEqual(running, { deleted: false, reason: "The import is still running." });
            for (const input of [first, second]) {
              yield* waitFor(
                imports,
                input.importId,
                (snapshot) => stepStatus(snapshot, "clone") === "running",
              );
            }
            yield* untilEvent(harness, "clone-waiting", 2);
          }),
        );
        const stagingOne = projectImportStagingPath(path.join(parent, "one"), first.importId);
        const stagingTwo = projectImportStagingPath(path.join(parent, "two"), second.importId);
        assert.isTrue(fs.existsSync(stagingOne));
        // The user replaced the second folder since: same path, another directory (made before
        // the old one goes, so it cannot reuse its inode).
        const replacement = path.join(parent, "replacement");
        fs.mkdirSync(replacement);
        fs.rmSync(stagingTwo, { recursive: true });
        fs.renameSync(replacement, stagingTwo);

        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const interrupted = yield* imports.get(first.importId);
            assert.equal(Option.getOrThrow(interrupted).status, "interrupted");
            assert.equal(Option.getOrThrow(interrupted).leftoverPath, stagingOne);

            assert.deepEqual(yield* imports.discard({ importId: first.importId }), {
              deleted: true,
              reason: null,
            });
            assert.isFalse(fs.existsSync(stagingOne));
            const again = yield* imports.discard({ importId: first.importId });
            assert.isFalse(again.deleted);

            const replaced = yield* imports.discard({ importId: second.importId });
            assert.isFalse(replaced.deleted);
            assert.include(replaced.reason ?? "", "replaced");
            assert.isTrue(fs.existsSync(stagingTwo));

            const unknown = yield* imports
              .discard({ importId: randomUUID() as ProjectImportId })
              .pipe(Effect.flip);
            assert.equal(unknown.code, "not-found");
          }),
        );
      }),
    ),
  );

  it.effect(
    "recovers after a crash: stops the child, deletes unregistered staging, keeps registered roots",
    () =>
      memoryDatabase(
        Effect.gen(function* () {
          const harness = makeHarness({ processes: osProjectImportProcessControl });
          const parent = tempDir("crash");

          // A job that never registered, its clone still running in its own process group.
          const lost = makeInput({ destinationPath: path.join(parent, "lost") });
          const lostStaging = projectImportStagingPath(path.join(parent, "lost"), lost.importId);
          fs.mkdirSync(lostStaging);
          fs.writeFileSync(path.join(lostStaging, "partial.pack"), "x");
          const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
          child.unref();
          const childPid = child.pid!;
          const childStartedAt = new Date().toISOString();

          // A job whose project.create committed just before the crash, before its row said so.
          const kept = makeInput({
            destinationPath: path.join(parent, "kept"),
            settings: {
              scripts: [],
              customSystemPrompt: null,
              preferredRemoteName: "origin",
              projectMetadataDir: ".ryco",
              overrides: {},
            },
            setup: { command: "make", saveAsScript: false },
          });
          const keptRoot = path.join(parent, "kept");
          const keptStaging = projectImportStagingPath(keptRoot, kept.importId);
          fs.mkdirSync(keptStaging);
          const keptIdentity = identityOf(keptStaging);
          fs.renameSync(keptStaging, keptRoot);
          fs.writeFileSync(path.join(keptRoot, "README.md"), "# kept");
          const projects = yield* Effect.gen(function* () {
            return yield* ProjectionProjectRepository;
          }).pipe(Effect.provide(ProjectionProjectRepositoryLive));
          yield* projects.upsert({
            projectId: ProjectId.make(kept.projectId),
            kind: "project",
            title: kept.title,
            workspaceRoot: keptRoot,
            projectMetadataDir: ".ryco",
            defaultModelSelection: null,
            customAvatarContentHash: null,
            preferredRemoteName: null,
            scripts: [],
            createdAt: "2026-10-22T00:00:00.000Z",
            updatedAt: "2026-10-22T00:00:00.000Z",
            deletedAt: null,
          });

          yield* insertLeftoverRow(lost, {
            running: "clone",
            staging: { path: lostStaging, ...identityOf(lostStaging) },
            child: { pid: childPid, startedAt: childStartedAt },
          });
          yield* insertLeftoverRow(kept, {
            running: "register",
            staging: { path: keptStaging, ...keptIdentity },
          });

          yield* withImports(harness, (imports) =>
            Effect.gen(function* () {
              // Building the service settles what the earlier process left running.
              const lostNow = Option.getOrThrow(yield* imports.get(lost.importId));
              assert.equal(lostNow.status, "interrupted");
              assert.equal(lostNow.error?.code, "interrupted");
              assert.equal(lostNow.leftoverPath, lostStaging);
              assert.throws(() => process.kill(childPid, 0));
              assert.isNull((yield* rowOf(lost.importId))?.child_pid);

              const keptNow = Option.getOrThrow(yield* imports.get(kept.importId));
              assert.equal(keptNow.status, "interrupted");
              assert.equal(stepStatus(keptNow, "register"), "done");
              assert.equal(stepStatus(keptNow, "settings"), "pending");
              assert.equal(stepStatus(keptNow, "setup"), "skipped");
              assert.isTrue(
                keptNow.warnings.some((warning) => warning.includes("setup command did not run")),
              );

              yield* imports.recoverOnStartup();
              assert.isFalse(fs.existsSync(lostStaging));
              assert.isNull(Option.getOrThrow(yield* imports.get(lost.importId)).leftoverPath);
              assert.include(harness.state.released, lost.importId);

              assert.isTrue(fs.existsSync(path.join(keptRoot, "README.md")));
              const replayed = Option.getOrThrow(yield* imports.get(kept.importId));
              assert.equal(stepStatus(replayed, "settings"), "done");
              assert.equal(stepStatus(replayed, "avatar"), "skipped");
              assert.deepEqual(
                harness.state.commands.map((command) => command.commandId),
                [projectImportCommandId(kept.importId, "project-settings")],
              );
              assert.equal((yield* rowOf(kept.importId))?.registered, 1);

              // Running it again finds nothing left to do.
              yield* imports.recoverOnStartup();
              assert.equal(harness.state.commands.length, 1);
            }),
          );
        }),
      ),
  );

  it.effect("a start whose caller goes away mid-claim leaves a job that still runs", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const claimGate = yield* Deferred.make<void>();
        const harness = makeHarness({ claimGate });
        const destination = path.join(tempDir("start-dropped"), "app");
        const input = makeInput({
          destinationPath: destination,
          commits: { transferId: randomUUID() },
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            // The relay drops while the node verifies the uploaded bundle.
            const caller = yield* imports.start(input).pipe(Effect.forkChild);
            yield* untilEvent(harness, "claim-waiting");
            yield* Fiber.interrupt(caller);
            assert.notInclude(harness.state.events, "claim-interrupted");
            // A3: the caller asks again with the same id and input and gets the same job.
            const retry = yield* imports.start(input).pipe(Effect.forkChild);
            const elsewhere = yield* imports
              .start(makeInput({ destinationPath: destination }))
              .pipe(Effect.flip);
            assert.equal(elsewhere.code, "conflict");

            yield* Deferred.succeed(claimGate, undefined);
            assert.equal((yield* Fiber.join(retry)).importId, input.importId);
            const done = yield* settled(imports, input.importId);
            assert.equal(done.status, "completed");
            assert.include(harness.state.events, "commits");
            assert.deepEqual(harness.state.released, [input.importId]);
          }),
        );
      }),
    ),
  );

  it.effect("cancels a job whose start was interrupted mid-claim and frees its folder", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const claimGate = yield* Deferred.make<void>();
        const harness = makeHarness({ claimGate });
        const destination = path.join(tempDir("start-cancelled"), "app");
        const input = makeInput({
          destinationPath: destination,
          commits: { transferId: randomUUID() },
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const caller = yield* imports.start(input).pipe(Effect.forkChild);
            yield* untilEvent(harness, "claim-waiting");
            yield* Fiber.interrupt(caller);

            const cancelled = yield* imports.cancel({ importId: input.importId });
            assert.equal(cancelled.status, "cancelled");
            assert.equal(cancelled.error?.step, "preflight");
            assert.include(harness.state.events, "claim-interrupted");
            assert.deepEqual(harness.state.released, [input.importId]);
            assert.equal((yield* rowOf(input.importId))?.status, "cancelled");

            // Its destination is free again.
            yield* Deferred.succeed(claimGate, undefined);
            const next = makeInput({ destinationPath: destination });
            yield* imports.start(next);
            assert.equal((yield* settled(imports, next.importId)).status, "completed");
          }),
        );
      }),
    ),
  );

  it.effect("a stop while a finished job releases its files leaves it completed", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const releaseGate = yield* Deferred.make<void>();
        const harness = makeHarness({ releaseGate });
        const input = makeInput({
          destinationPath: path.join(tempDir("stop-completing"), "app"),
          commits: { transferId: randomUUID() },
          followUpThread: followUp,
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(input);
            yield* untilEvent(harness, "release-waiting");
            // The server stops now; the transfers registry frees up a moment later.
            yield* openSoon(releaseGate);
          }),
        );
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const after = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(after.status, "completed");
            assert.isNull(after.error);
            assert.equal(stepStatus(after, "follow-up"), "done");
            assert.equal((yield* rowOf(input.importId))?.status, "completed");
            assert.deepEqual(harness.state.released, [input.importId]);
          }),
        );
      }),
    ),
  );

  it.effect("a stop during setup releases the files of the registered, interrupted job", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const setupGate = yield* Deferred.make<void>();
        const harness = makeHarness({ setupGate });
        const input = makeInput({
          destinationPath: path.join(tempDir("stop-setup"), "app"),
          commits: { transferId: randomUUID() },
          avatarTransferId: randomUUID(),
          setup: { command: "make setup", saveAsScript: false },
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.start(input);
            yield* untilEvent(harness, "setup-waiting");
          }),
        );
        assert.include(harness.state.events, "setup-interrupted");
        assert.deepEqual(harness.state.released, [input.importId]);
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const after = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(after.status, "interrupted");
            assert.equal(stepStatus(after, "avatar"), "done");
            assert.equal((yield* rowOf(input.importId))?.registered, 1);
            yield* imports.recoverOnStartup();
            // Nothing records that the files went, so recovery deletes them again: a no-op.
            assert.deepEqual(harness.state.released, [input.importId, input.importId]);
          }),
        );
      }),
    ),
  );

  it.effect("a crash during preflight releases the job's files at the next start", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness();
        const input = makeInput({
          destinationPath: path.join(tempDir("crash-preflight"), "app"),
          commits: { transferId: randomUUID() },
          changes: { transferId: randomUUID(), baseOid: HEAD_OID, ignoredPaths: [] },
        });
        // Its claim moved the files; it never made a staging folder or registered a project.
        yield* insertLeftoverRow(input, { running: "preflight" });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const after = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(after.status, "interrupted");
            assert.deepEqual(harness.state.released, [input.importId]);
            yield* imports.recoverOnStartup();
            assert.deepEqual(harness.state.released, [input.importId]);
          }),
        );
      }),
    ),
  );

  it.effect("replays the settings or avatar step a crash cut short, then releases the files", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness();
        const parent = tempDir("crash-replay");
        const settings = {
          scripts: [],
          customSystemPrompt: null,
          preferredRemoteName: "origin",
          projectMetadataDir: ".ryco",
          overrides: { runSetupScript: false },
        };
        // One crashed while saving its settings, the other while copying its avatar.
        const duringSettings = makeInput({
          destinationPath: path.join(parent, "one"),
          settings,
          avatarTransferId: randomUUID(),
        });
        const duringAvatar = makeInput({
          destinationPath: path.join(parent, "two"),
          settings,
          avatarTransferId: randomUUID(),
        });
        yield* insertLeftoverRow(duringSettings, { running: "settings", registered: true });
        yield* insertLeftoverRow(duringAvatar, { running: "avatar", registered: true });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const settingsNow = Option.getOrThrow(yield* imports.get(duringSettings.importId));
            assert.equal(settingsNow.status, "interrupted");
            assert.equal(stepStatus(settingsNow, "settings"), "pending");
            assert.equal(stepStatus(settingsNow, "avatar"), "pending");
            const avatarNow = Option.getOrThrow(yield* imports.get(duringAvatar.importId));
            assert.equal(stepStatus(avatarNow, "avatar"), "pending");
            // The avatar's file stays for the replay.
            assert.deepEqual(harness.state.released, []);

            yield* imports.recoverOnStartup();
            const settingsAfter = Option.getOrThrow(yield* imports.get(duringSettings.importId));
            assert.equal(stepStatus(settingsAfter, "settings"), "done");
            assert.equal(stepStatus(settingsAfter, "avatar"), "done");
            const avatarAfter = Option.getOrThrow(yield* imports.get(duringAvatar.importId));
            assert.equal(stepStatus(avatarAfter, "avatar"), "done");
            // The replayed settings step saved the overrides too.
            assert.deepEqual(harness.state.settings.projectPreferences[duringSettings.projectId], {
              runSetupScript: false,
            });
            assert.sameMembers(
              harness.state.commands.map((command) => command.commandId),
              [
                projectImportCommandId(duringSettings.importId, "project-settings"),
                projectImportCommandId(duringSettings.importId, "project-avatar"),
                projectImportCommandId(duringAvatar.importId, "project-avatar"),
              ],
            );
            assert.sameMembers(harness.state.released, [
              duringSettings.importId,
              duringAvatar.importId,
            ]);

            // Nothing is left to replay.
            yield* imports.recoverOnStartup();
            assert.equal(harness.state.commands.length, 3);
          }),
        );
      }),
    ),
  );

  it.effect("a stop between a replay and its release releases the files at the next start", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const releaseGate = yield* Deferred.make<void>();
        const harness = makeHarness({ releaseGate });
        const input = makeInput({
          destinationPath: path.join(tempDir("stop-before-release"), "app"),
          avatarTransferId: randomUUID(),
        });
        yield* insertLeftoverRow(input, { running: "avatar", registered: true });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const recovery = yield* imports.recoverOnStartup().pipe(Effect.forkChild);
            yield* untilEvent(harness, "release-waiting");
            // The server stops with the avatar replayed and saved, before its files went.
            yield* Fiber.interrupt(recovery);
            const after = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(stepStatus(after, "avatar"), "done");
            assert.deepEqual(harness.state.released, []);
          }),
        );
        yield* Deferred.succeed(releaseGate, undefined);
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const before = Option.getOrThrow(yield* imports.get(input.importId));
            yield* imports.recoverOnStartup();
            assert.deepEqual(harness.state.released, [input.importId]);
            // Nothing is replayed again, and the row is not touched, so it still expires.
            assert.lengthOf(harness.state.avatarsWritten, 1);
            assert.deepEqual(
              harness.state.commands.map((command) => command.commandId),
              [projectImportCommandId(input.importId, "project-avatar")],
            );
            const after = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(after.updatedAt, before.updatedAt);
          }),
        );
      }),
    ),
  );

  it.effect("a crash during a replay fails the step instead of replaying it on every start", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness();
        const input = makeInput({
          destinationPath: path.join(tempDir("crash-in-replay"), "app"),
          avatarTransferId: randomUUID(),
        });
        // Startup recovery was replaying the avatar when the node crashed, perhaps because of it.
        yield* insertLeftoverRow(input, {
          running: "avatar",
          status: "interrupted",
          registered: true,
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.recoverOnStartup();
            const after = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(after.status, "interrupted");
            assert.equal(stepStatus(after, "settings"), "done");
            assert.equal(stepStatus(after, "avatar"), "failed");
            assert.isTrue(
              after.warnings.some((warning) =>
                warning.startsWith("The project's avatar was not copied: Ryco stopped"),
              ),
            );
            assert.deepEqual(harness.state.avatarsWritten, []);
            assert.deepEqual(harness.state.commands, []);
            assert.deepEqual(harness.state.released, [input.importId]);

            yield* imports.recoverOnStartup();
            const later = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(stepStatus(later, "avatar"), "failed");
            assert.lengthOf(later.warnings, after.warnings.length);
            assert.deepEqual(harness.state.avatarsWritten, []);
          }),
        );
      }),
    ),
  );

  it.effect("a stop during a replay puts the step back to pending for the next start", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const avatarGate = yield* Deferred.make<void>();
        const harness = makeHarness({ avatarGate });
        const input = makeInput({
          destinationPath: path.join(tempDir("stop-in-replay"), "app"),
          avatarTransferId: randomUUID(),
        });
        yield* insertLeftoverRow(input, { running: "avatar", registered: true });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const recovery = yield* imports.recoverOnStartup().pipe(Effect.forkChild);
            yield* untilEvent(harness, "avatar-waiting");
            yield* Fiber.interrupt(recovery);
            const after = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(stepStatus(after, "avatar"), "pending");
            assert.deepEqual(harness.state.released, []);
          }),
        );
        yield* Deferred.succeed(avatarGate, undefined);
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            yield* imports.recoverOnStartup();
            const after = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(stepStatus(after, "avatar"), "done");
            assert.deepEqual(after.warnings, []);
            assert.lengthOf(harness.state.avatarsWritten, 1);
            assert.deepEqual(harness.state.released, [input.importId]);
          }),
        );
      }),
    ),
  );

  it.effect("never deletes a folder a crash left published at the destination", () =>
    memoryDatabase(
      Effect.gen(function* () {
        const harness = makeHarness();
        const destination = path.join(tempDir("crash-published"), "app");
        const input = makeInput({ destinationPath: destination });
        const staging = projectImportStagingPath(destination, input.importId);
        fs.mkdirSync(staging);
        const identity = identityOf(staging);
        // The crash hit between publishing the clone and project.create.
        fs.renameSync(staging, destination);
        fs.writeFileSync(path.join(destination, "README.md"), "# app");
        yield* insertLeftoverRow(input, {
          running: "register",
          staging: { path: staging, ...identity },
        });
        yield* withImports(harness, (imports) =>
          Effect.gen(function* () {
            const interrupted = Option.getOrThrow(yield* imports.get(input.importId));
            assert.equal(interrupted.status, "interrupted");
            assert.equal(interrupted.leftoverPath, destination);

            // At the destination, dev and ino cannot tell it from a folder made there since.
            yield* imports.recoverOnStartup();
            assert.isTrue(fs.existsSync(path.join(destination, "README.md")));
            const recovered = Option.getOrThrow(yield* imports.get(input.importId));
            assert.isNull(recovered.leftoverPath);
            assert.isTrue(recovered.warnings.some((warning) => warning.includes(destination)));
            assert.isFalse((yield* imports.discard({ importId: input.importId })).deleted);
            assert.isTrue(fs.existsSync(path.join(destination, "README.md")));
          }),
        );
      }),
    ),
  );
});
