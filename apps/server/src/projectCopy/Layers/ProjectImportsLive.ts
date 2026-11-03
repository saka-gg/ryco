/**
 * ProjectImportsLive - the import job on the destination node (see `Services/ProjectImports.ts`).
 *
 * A job is a row in `project_imports` plus, while it runs in this process, a fiber in the layer's
 * scope and a `SubscriptionRef` its subscribers follow. Step transitions are written to the row
 * before subscribers see them; output and progress reach subscribers at most once per throttle
 * interval and the row with the next transition.
 *
 * Ownership: the job creates a staging sibling of the destination with a non-recursive mkdir (the
 * proof that it owns it), records its dev and ino, clones into it and publishes it to the
 * destination by rename right before registering the project; when registering fails, it moves
 * it back. Until the project is registered a failure or cancel deletes that directory, only at
 * its staging path and only when it still has the recorded identity, no project is rooted in it
 * and the projection never saw the job's project. After register nothing is ever deleted.
 *
 * Lifetime: from the moment a job is in `active` it has its fiber in the layer's scope, so it is
 * recorded, runs and settles whatever happens to the `start` call that made it. Its claimed
 * transfers go once it settled and no step is left for startup recovery to replay.
 *
 * @module ProjectImportsLive
 */
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_PROJECT_METADATA_DIR,
  type OrchestrationCommand,
  type ProjectScript,
} from "@ryco/contracts";
import {
  PROJECT_COPY_MAX_AVATAR_BYTES,
  PROJECT_IMPORT_LIST_MAX,
  ProjectCopyError,
  type ProjectCopyErrorCode,
  ProjectImportSnapshot,
  ProjectImportStartInput,
  type ProjectImportErrorCode,
  type ProjectImportId,
  type ProjectImportStatus,
  type ProjectImportStepId,
} from "@ryco/contracts/project-copy";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import { TerminalOutputTail } from "../../project/worktreeSetupOutputTail.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { RestartSensitiveWork } from "../../updates/restartSensitiveWork.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  projectDestinationReservationKey,
  projectDestinationReservedMessage,
  tryReserveProjectDestination,
} from "../destinationReservation.ts";
import type { ProjectImportStepError } from "../Errors.ts";
import { PROJECT_IMPORT_SETTLED_RETENTION_MS } from "../projectCopyStartup.ts";
import { startProjectImportFollowUp } from "../projectImportFollowUp.ts";
import {
  osProjectImportProcessControl,
  type ProjectImportProcessControl,
} from "../projectImportProcesses.ts";
import {
  PROJECT_IMPORT_OUTPUT_TAIL_LINES,
  PROJECT_IMPORT_REPLAYED_STEPS,
  boundImportText,
  currentImportStep,
  dueReplayedImportSteps,
  failCutShortReplays,
  importStepOf,
  initialProjectImportSnapshot,
  isTerminalImportStatus,
  projectImportCommandId,
  projectImportInputDigest,
  projectImportPublishedPath,
  projectImportStagingPath,
  renderImportOutputTail,
  replayedImportStepWarning,
  settleImportSnapshot,
  withImportStep,
  withImportWarning,
  type ProjectImportReplayedStepId,
  type ProjectImportSetupFailure,
  type ProjectImportStepPatch,
} from "../projectImportSnapshot.ts";
import type {
  ProjectCopyChildProcess,
  ProjectCopyProcessObserver,
} from "../Services/ProjectCopyProcess.ts";
import { ProjectImportGit } from "../Services/ProjectImportGit.ts";
import { ProjectImports, type ProjectImportsShape } from "../Services/ProjectImports.ts";
import { ProjectSetupCommand } from "../Services/ProjectSetupCommand.ts";
import {
  ProjectTransfers,
  type ClaimedProjectTransfer,
  type ProjectTransferClaim,
} from "../Services/ProjectTransfers.ts";
import { GitNetwork } from "../Services/GitNetwork.ts";
import { NodePaths } from "../Services/NodePaths.ts";

/** Output and clone progress are published, and subscribers get a snapshot, at most this often. */
const DEFAULT_SNAPSHOT_THROTTLE_MS = 1_000;
const SETUP_SCRIPT_NAME = "Setup";

export interface ProjectImportsLiveOptions {
  /** Stops the children a crashed process left running; the operating system's by default. */
  readonly processes?: ProjectImportProcessControl | undefined;
  /** Default 1 s; 0 publishes and delivers every change at once (tests on a test clock). */
  readonly snapshotThrottleMs?: number | undefined;
}

// ── Persistence ───────────────────────────────────────────────────────

interface ProjectImportRow {
  readonly import_id: string;
  readonly destination_key: string;
  readonly staging_path: string | null;
  readonly staging_dev: string | null;
  readonly staging_ino: string | null;
  readonly status: string;
  readonly input_json: string;
  readonly input_digest: string;
  readonly snapshot_json: string;
  readonly owned: number;
  readonly child_pid: number | null;
  readonly child_pgid: number | null;
  readonly child_started_at: string | null;
  readonly registered: number;
}

/** The directory a job created: its staging path and the identity it was created with. */
interface OwnedDirectory {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}

/** Where the job's directory is now: at its staging path, or published to the destination. */
interface LocatedDirectory {
  readonly path: string;
  readonly published: boolean;
}

/** What `project_imports` holds about one job. */
interface JobRecord {
  readonly importId: ProjectImportId;
  readonly input: ProjectImportStartInput;
  readonly digest: string;
  readonly destinationKey: string;
  snapshot: ProjectImportSnapshot;
  owned: boolean;
  /** Null when it created none, or once it is deleted. */
  staging: OwnedDirectory | null;
  registered: boolean;
  child: ProjectCopyChildProcess | null;
}

/** A job running in this process. */
interface ActiveJob extends JobRecord {
  /** The destination with its existing ancestors' symlinks resolved: where staging publishes. */
  readonly destination: string;
  readonly ref: SubscriptionRef.SubscriptionRef<ProjectImportSnapshot>;
  readonly tail: TerminalOutputTail;
  readonly releaseReservation: () => void;
  /**
   * Completes once the job claimed its transfers or settled without them, which is what `start`
   * answers after; fails when its row could not be written, so the node never knew the job.
   */
  readonly admitted: Deferred.Deferred<void, ProjectCopyError>;
  claimed: ReadonlyArray<ClaimedProjectTransfer>;
  cloneUrl: string;
  projectRoot: string | null;
  setupFailure: ProjectImportSetupFailure | null;
  /** Forked together with the job's entry in `active`; settles the job. */
  fiber: Fiber.Fiber<void> | null;
  cancelRequested: boolean;
  flushScheduled: boolean;
}

const isActive = (record: JobRecord): record is ActiveJob => "ref" in record;

/**
 * A step failed and the job stops; up to `register`, its owned directory is deleted. `step` is
 * set by the step runner when the failure leaves it.
 */
class ImportJobFailure extends Data.TaggedError("ImportJobFailure")<{
  readonly code: ProjectImportErrorCode;
  readonly message: string;
  readonly step?: ProjectImportStepId | undefined;
}> {}

const fromStepError = (error: ProjectImportStepError) =>
  new ImportJobFailure({ code: error.code, message: error.message });

const copyError = (code: ProjectCopyErrorCode, message: string) =>
  new ProjectCopyError({ code, message: boundImportText(message, "Project import failed.") });

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectImportSnapshot));
const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectImportStartInput));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(ProjectImportSnapshot));
const encodeInput = Schema.encodeSync(Schema.fromJsonString(ProjectImportStartInput));

const errnoOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : undefined;

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;

const hasIdentity = (info: BigIntStats, owned: OwnedDirectory): boolean =>
  info.isDirectory() &&
  !info.isSymbolicLink() &&
  String(info.dev) === owned.dev &&
  String(info.ino) === owned.ino;

const sameOrInside = (candidate: string, directory: string): boolean => {
  const fold = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "darwin" || process.platform === "win32"
      ? resolved.toLowerCase()
      : resolved;
  };
  const relative = path.relative(fold(directory), fold(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** The image types the avatar pipeline accepts, by their magic bytes. */
const avatarContentType = (bytes: Buffer): string | null => {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
};

/**
 * The scripts to save: the source's, plus the import's setup command as the worktree setup
 * script when it asks to be saved and the project has none yet.
 */
const scriptsWithSetup = (
  scripts: ReadonlyArray<ProjectScript>,
  setup: ProjectImportStartInput["setup"],
): ReadonlyArray<ProjectScript> => {
  if (
    setup === null ||
    !setup.saveAsScript ||
    scripts.some((script) => script.runOnWorktreeCreate)
  ) {
    return scripts;
  }
  const taken = new Set(scripts.map((script) => script.id));
  let id = "setup";
  for (let suffix = 2; taken.has(id); suffix += 1) id = `setup-${suffix}`;
  return [
    ...scripts,
    {
      id,
      name: SETUP_SCRIPT_NAME,
      command: setup.command,
      icon: "configure",
      runOnWorktreeCreate: true,
    },
  ];
};

/** The transfers an input references, each with the purpose its field requires. */
const transferClaims = (input: ProjectImportStartInput): Array<ProjectTransferClaim> => [
  ...(input.source.kind === "repository-bundle"
    ? [{ transferId: input.source.transferId, purpose: "repository-bundle" as const }]
    : []),
  ...(input.commits === null
    ? []
    : [{ transferId: input.commits.transferId, purpose: "commits-bundle" as const }]),
  ...(input.changes === null
    ? []
    : [{ transferId: input.changes.transferId, purpose: "changes-patch" as const }]),
  ...(input.avatarTransferId === null
    ? []
    : [{ transferId: input.avatarTransferId, purpose: "avatar" as const }]),
];

const destinationRefusal = (
  input: ProjectImportStartInput,
  preview: {
    readonly state: string;
    readonly detail: string | null;
    readonly existingProjectId: string | null;
  },
  linking: boolean,
): { readonly code: ProjectImportErrorCode; readonly message: string } => {
  const where = input.destinationPath;
  if (preview.state === "access-denied") {
    return {
      code: "access-denied",
      message: preview.detail ?? `${where} is outside the folders Ryco may use on this node.`,
    };
  }
  if (preview.existingProjectId !== null) {
    return { code: "destination-unavailable", message: `A project is already rooted at ${where}.` };
  }
  const reason =
    preview.detail ??
    (linking
      ? `${where} is not a git repository that can be linked.`
      : preview.state === "exists-not-empty"
        ? `${where} already exists and is not empty.`
        : preview.state === "is-git-repository"
          ? `${where} is already a git repository; link it instead.`
          : `${where} cannot be used as the destination.`);
  return { code: "destination-unavailable", message: reason };
};

export const makeProjectImports = (options: ProjectImportsLiveOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const nodePaths = yield* NodePaths;
    const transfers = yield* ProjectTransfers;
    const importGit = yield* ProjectImportGit;
    const setupCommand = yield* ProjectSetupCommand;
    const gitNetwork = yield* GitNetwork;
    const engine = yield* OrchestrationEngineService;
    const projects = yield* ProjectionProjectRepository;
    const avatars = yield* ProjectAvatarStore;
    const workspaceAccess = yield* WorkspaceAccessPolicy;
    const providers = yield* Effect.serviceOption(ProviderRegistry);
    const gitWorkflow = yield* Effect.serviceOption(GitWorkflowService);
    const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
    const serverConfig = yield* Effect.serviceOption(ServerConfig);
    const layerScope = yield* Effect.scope;
    const restartWork = yield* RestartSensitiveWork;
    const processes = options.processes ?? osProjectImportProcessControl;
    const throttleMs = options.snapshotThrottleMs ?? DEFAULT_SNAPSHOT_THROTTLE_MS;

    const active = new Map<ProjectImportId, ActiveJob>();
    // Entering a start is quick (a judgement and a reservation; the job's fiber claims its
    // transfers) and serialized: one importId never starts twice and reservations are taken in
    // order.
    const startLock = Semaphore.makeUnsafe(1);
    // Discard and startup recovery delete directories; never two at once.
    const maintenanceLock = Semaphore.makeUnsafe(1);
    // Every row write reads the record inside the lock, so the latest state always lands last.
    const writeLock = Semaphore.makeUnsafe(1);

    const followUpDeps = {
      dispatch: (command: OrchestrationCommand) => engine.dispatch(command),
      providers,
      worktrees:
        Option.isSome(gitWorkflow) && Option.isSome(serverSettings) && Option.isSome(serverConfig)
          ? Option.some({
              managedCheckout: {
                gitWorkflow: gitWorkflow.value,
                workspaceAccessPolicy: workspaceAccess,
                config: serverConfig.value,
              },
              settings: serverSettings.value.getSettings,
            })
          : Option.none(),
    };

    // ── Rows ──────────────────────────────────────────────────────────

    const internal = (cause: unknown) =>
      copyError(
        "internal",
        `The import's record could not be read or written: ${messageOf(cause, "storage error")}`,
      );

    const readRow = (importId: string) =>
      sql<ProjectImportRow>`SELECT * FROM project_imports WHERE import_id = ${importId}`.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(internal),
      );

    const recordOf = (row: ProjectImportRow) =>
      Effect.gen(function* () {
        const input = yield* decodeInput(row.input_json);
        const snapshot = yield* decodeSnapshot(row.snapshot_json);
        return {
          importId: input.importId,
          input,
          digest: row.input_digest,
          destinationKey: row.destination_key,
          snapshot,
          owned: row.owned === 1,
          staging:
            row.staging_path !== null && row.staging_dev !== null && row.staging_ino !== null
              ? { path: row.staging_path, dev: row.staging_dev, ino: row.staging_ino }
              : null,
          registered: row.registered === 1,
          child:
            row.child_pid !== null && row.child_started_at !== null
              ? { pid: row.child_pid, pgid: row.child_pgid, startedAt: row.child_started_at }
              : null,
        } satisfies JobRecord;
      }).pipe(Effect.mapError(internal));

    const insertRow = (record: JobRecord) =>
      sql`INSERT INTO project_imports (import_id, project_id, destination_key, status, input_json,
          input_digest, snapshot_json, owned, registered, created_at, updated_at)
        VALUES (${record.importId}, ${record.input.projectId}, ${record.destinationKey},
          ${record.snapshot.status}, ${encodeInput(record.input)}, ${record.digest},
          ${encodeSnapshot(record.snapshot)}, 0, 0, ${record.snapshot.createdAt},
          ${record.snapshot.updatedAt})`.pipe(Effect.asVoid);

    /** Writes the record's current state; storage errors are logged, the job carries on. */
    const persist = (record: JobRecord) =>
      writeLock
        .withPermits(1)(
          Effect.suspend(
            () => sql`UPDATE project_imports SET
                status = ${record.snapshot.status},
                snapshot_json = ${encodeSnapshot(record.snapshot)},
                owned = ${record.owned ? 1 : 0},
                staging_path = ${record.staging?.path ?? null},
                staging_dev = ${record.staging?.dev ?? null},
                staging_ino = ${record.staging?.ino ?? null},
                registered = ${record.registered ? 1 : 0},
                child_pid = ${record.child?.pid ?? null},
                child_pgid = ${record.child?.pgid ?? null},
                child_started_at = ${record.child?.startedAt ?? null},
                updated_at = ${record.snapshot.updatedAt}
              WHERE import_id = ${record.importId}`,
          ),
        )
        .pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("project import record could not be written", {
              importId: record.importId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

    /** Applies a change, writes it, and shows it to subscribers of a running job. */
    const commit = (
      record: JobRecord,
      change: (snapshot: ProjectImportSnapshot) => ProjectImportSnapshot,
    ) =>
      Effect.suspend(() => {
        record.snapshot = change(record.snapshot);
        return persist(record).pipe(
          Effect.andThen(
            isActive(record) ? SubscriptionRef.set(record.ref, record.snapshot) : Effect.void,
          ),
        );
      });

    const setStep = (record: JobRecord, id: ProjectImportStepId, patch: ProjectImportStepPatch) =>
      commit(record, (snapshot) => withImportStep(snapshot, id, patch, new Date().toISOString()));

    const warn = (record: JobRecord, warning: string) =>
      commit(record, (snapshot) => withImportWarning(snapshot, warning, new Date().toISOString()));

    /** Shows output and progress to subscribers, at most once per throttle interval. */
    const scheduleFlush = (job: ActiveJob) =>
      Effect.suspend(() => {
        if (job.flushScheduled) return Effect.void;
        job.flushScheduled = true;
        return Effect.sleep(throttleMs).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              job.flushScheduled = false;
              return SubscriptionRef.set(job.ref, job.snapshot);
            }),
          ),
          Effect.forkIn(layerScope),
          Effect.asVoid,
        );
      });

    const appendOutput = (job: ActiveJob, text: string) =>
      Effect.suspend(() => {
        if (!job.tail.push(text)) return Effect.void;
        job.snapshot = {
          ...job.snapshot,
          outputTail: renderImportOutputTail(job.tail.snapshot()),
          updatedAt: new Date().toISOString(),
        };
        return scheduleFlush(job);
      });

    /** What a step's child reports: recorded for crash recovery, and its output for the tail. */
    const observerFor = (job: ActiveJob): ProjectCopyProcessObserver => ({
      onChild: (child) =>
        Effect.suspend(() => {
          job.child = child;
          return persist(job);
        }),
      onOutput: (chunk) => appendOutput(job, chunk),
    });

    // ── Ownership ─────────────────────────────────────────────────────

    /**
     * Whether the job's project ever existed here: the record says so, or the projection has a
     * row (live or deleted) for its id, which also covers a crash right after `project.create`.
     * `unknown` when the projection cannot be read: nothing is deleted on a guess.
     */
    const registrationOf = (record: JobRecord) =>
      record.registered
        ? Effect.succeed("registered" as const)
        : projects.getById({ projectId: record.input.projectId }).pipe(
            Effect.map((row) =>
              Option.isSome(row) ? ("registered" as const) : ("never" as const),
            ),
            Effect.orElseSucceed(() => "unknown" as const),
          );

    /** The job's directory where it is now, when it still has the identity it was created with. */
    const locateOwned = (record: JobRecord) =>
      Effect.promise(async (): Promise<LocatedDirectory | null> => {
        const staging = record.staging;
        if (staging === null) return null;
        const published = projectImportPublishedPath(staging.path, record.importId);
        const candidates: ReadonlyArray<LocatedDirectory> = [
          { path: staging.path, published: false },
          ...(published === null ? [] : [{ path: published, published: true }]),
        ];
        for (const candidate of candidates) {
          try {
            if (hasIdentity(await lstat(candidate.path, { bigint: true }), staging)) {
              return candidate;
            }
          } catch {
            // Not there; try the other location.
          }
        }
        return null;
      });

    /**
     * Whether startup recovery still replays a post-register step of the job. Until it did, the
     * job's claimed transfers stay: the avatar step reads one.
     */
    const replayDue = (record: JobRecord) =>
      record.registered && dueReplayedImportSteps(record.snapshot).length > 0;

    const projectRootedIn = (directory: string) =>
      projects.listAll().pipe(
        Effect.map((rows) =>
          rows.some((row) => row.deletedAt === null && sameOrInside(row.workspaceRoot, directory)),
        ),
        Effect.orElseSucceed(() => true),
      );

    /**
     * Deletes the job's own directory, only at its staging path, only when it never registered a
     * project, the directory still has its recorded identity and no project is rooted in it.
     * Clears `staging` once nothing of it is left to delete; a directory found published to the
     * destination is let go with a warning on the record's snapshot, never deleted.
     */
    const removeOwned = (record: JobRecord) =>
      Effect.gen(function* () {
        if (record.staging === null) {
          return {
            deleted: false,
            reason: "The import left no folder behind.",
            leftoverPath: null,
          };
        }
        const registration = yield* registrationOf(record);
        if (registration === "registered") {
          record.registered = true;
          record.staging = null;
          return {
            deleted: false,
            reason: "The import added a project, so its folder stays.",
            leftoverPath: null,
          };
        }
        const located = yield* locateOwned(record);
        if (registration === "unknown") {
          return {
            deleted: false,
            reason: "Could not check whether the import added a project; try again.",
            leftoverPath: located?.path ?? null,
          };
        }
        if (located === null) {
          record.staging = null;
          return {
            deleted: false,
            reason: "The import's folder is gone or was replaced since.",
            leftoverPath: null,
          };
        }
        if (located.published) {
          // A crash or a failed move back left it at the destination, where dev and ino alone
          // cannot tell it from a folder the user made there since (inodes are reused): it is
          // the user's to keep or delete (A15: only the staging path is ever deleted).
          record.staging = null;
          const reason = boundImportText(
            `The copy was already moved to ${located.path} when the import stopped, so Ryco leaves it there; add it as a project or delete it.`,
            "The copy was already moved to its destination, so Ryco leaves it there.",
          );
          record.snapshot = withImportWarning(record.snapshot, reason, new Date().toISOString());
          return { deleted: false, reason, leftoverPath: null };
        }
        if (yield* projectRootedIn(located.path)) {
          record.staging = null;
          return {
            deleted: false,
            reason: `A project now uses ${located.path}, so it stays.`,
            leftoverPath: null,
          };
        }
        const removed = yield* Effect.tryPromise(() =>
          rm(located.path, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 }),
        ).pipe(Effect.result);
        if (removed._tag === "Failure") {
          return {
            deleted: false,
            reason: boundImportText(
              `Could not delete ${located.path}: ${messageOf(removed.failure.cause, "unknown error")}`,
              "Could not delete the folder.",
            ),
            leftoverPath: located.path,
          };
        }
        record.staging = null;
        return { deleted: true, reason: null, leftoverPath: null };
      });

    // ── Ending a job ──────────────────────────────────────────────────

    /**
     * Settles a job of this process, once. Before register a failure or cancel deletes its
     * directory; an interruption (the server stopping) leaves that to startup recovery. Runs
     * uninterruptibly (from the job's fiber or the layer's finalizer): a stop or a cancel never
     * turns the outcome into another one halfway.
     */
    const finish = (
      job: ActiveJob,
      status: Exclude<ProjectImportStatus, "running">,
      error: {
        readonly code: ProjectImportErrorCode;
        readonly message: string;
        readonly step?: ProjectImportStepId | undefined;
      } | null,
    ) =>
      Effect.suspend(() => {
        if (isTerminalImportStatus(job.snapshot.status)) return Effect.void;
        return Effect.gen(function* () {
          let leftoverPath: string | null = null;
          if ((status === "failed" || status === "cancelled") && job.staging !== null) {
            leftoverPath = (yield* removeOwned(job)).leftoverPath;
          } else if (status === "interrupted" && job.staging !== null && !job.registered) {
            leftoverPath = (yield* locateOwned(job))?.path ?? null;
          }
          const step = error?.step ?? currentImportStep(job.snapshot);
          job.child = null;
          job.snapshot = settleImportSnapshot(
            job.snapshot,
            {
              status,
              error: error === null ? null : { step, code: error.code, message: error.message },
              leftoverPath,
              keepPending:
                status === "interrupted" && job.registered ? PROJECT_IMPORT_REPLAYED_STEPS : [],
            },
            new Date().toISOString(),
          );
          // The claimed files go before the row says the job ended: a crash in between leaves
          // a running row, whose recovery releases them again.
          if (!replayDue(job)) yield* transfers.releaseImport(job.importId);
          yield* persist(job);
          yield* SubscriptionRef.set(job.ref, job.snapshot);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              job.releaseReservation();
              active.delete(job.importId);
            }),
          ),
        );
      });

    const settle = (job: ActiveJob, exit: Exit.Exit<void, ImportJobFailure>) =>
      Effect.gen(function* () {
        if (Exit.isSuccess(exit)) return yield* finish(job, "completed", null);
        const cause = exit.cause;
        if (Cause.hasInterrupts(cause)) {
          if (job.cancelRequested) {
            return yield* finish(job, "cancelled", {
              code: "cancelled",
              message: job.registered
                ? `Cancelled after ${job.input.title} was added; the project stays on this node.`
                : "The import was cancelled.",
            });
          }
          return yield* finish(job, "interrupted", {
            code: "interrupted",
            message: "Ryco stopped while this import was running.",
          });
        }
        const failure = Cause.findErrorOption(cause);
        if (Option.isSome(failure)) {
          return yield* finish(job, "failed", failure.value);
        }
        yield* Effect.logError("project import failed unexpectedly", {
          importId: job.importId,
          cause: Cause.pretty(cause),
        });
        return yield* finish(job, "failed", {
          code: "internal",
          message: `The import failed unexpectedly: ${messageOf(Cause.squash(cause), "internal error")}`,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("project import could not be settled", {
            importId: job.importId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    // ── Steps ─────────────────────────────────────────────────────────

    /** Runs one step: running → done (with `detailOf`), or failed and the job stops. */
    const runStep = <A, R>(
      job: ActiveJob,
      id: ProjectImportStepId,
      body: Effect.Effect<A, ImportJobFailure, R>,
      detailOf?: (result: A) => string | null,
    ) =>
      Effect.gen(function* () {
        yield* setStep(job, id, { status: "running" });
        const result = yield* body.pipe(
          Effect.tapError((failure) =>
            setStep(job, id, { status: "failed", progressPercent: null, detail: failure.message }),
          ),
          Effect.mapError((failure) =>
            failure.step === undefined
              ? new ImportJobFailure({ code: failure.code, message: failure.message, step: id })
              : failure,
          ),
        );
        const detail = detailOf?.(result);
        yield* setStep(job, id, {
          status: "done",
          progressPercent: null,
          ...(detail === undefined ? {} : { detail }),
        });
        return result;
      });

    const skipStep = (record: JobRecord, id: ProjectImportStepId, detail: string | null) =>
      setStep(record, id, { status: "skipped", progressPercent: null, detail });

    const failWith = (code: ProjectImportErrorCode, message: string) =>
      Effect.fail(new ImportJobFailure({ code, message: boundImportText(message, "Failed.") }));

    const gitStep = <A, R>(job: ActiveJob, effect: Effect.Effect<A, ProjectImportStepError, R>) =>
      effect.pipe(
        Effect.tapError((error) =>
          error.detail === null ? Effect.void : appendOutput(job, `${error.detail}\n`),
        ),
        Effect.mapError(fromStepError),
      );

    const claimedPath = (
      record: { readonly claimed: ReadonlyArray<ClaimedProjectTransfer> },
      purpose: ClaimedProjectTransfer["purpose"],
    ) => record.claimed.find((claim) => claim.purpose === purpose)?.path ?? null;

    const preflight = (job: ActiveJob) =>
      runStep(
        job,
        "preflight",
        Effect.gen(function* () {
          const input = job.input;
          // The uploads move into the job's own directory (verified again) before anything else;
          // `start` answers once they did. A cancel or a stop may interrupt the verification.
          job.claimed = yield* transfers
            .claimForImport({ importId: job.importId, transfers: transferClaims(input) })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ImportJobFailure({
                    code: "transfer-missing",
                    message: boundImportText(
                      `The uploaded files are not ready: ${error.message}`,
                      "The uploaded files are not ready.",
                    ),
                  }),
              ),
            );
          yield* Deferred.succeed(job.admitted, undefined);
          const existing = yield* projects.getById({ projectId: input.projectId }).pipe(
            Effect.mapError(
              (cause) =>
                new ImportJobFailure({
                  code: "internal",
                  message: messageOf(cause, "The projects could not be read."),
                }),
            ),
          );
          if (Option.isSome(existing)) {
            return yield* failWith(
              "register-failed",
              "A project with this id already exists on this node; start the copy again.",
            );
          }
          if (input.source.kind !== "clone") {
            yield* commit(job, (snapshot) => ({
              ...snapshot,
              preflight: { remoteReachable: null, alternateRemoteUrl: null },
            }));
            return;
          }
          const remoteUrl = input.source.remoteUrl;
          const access = yield* gitNetwork
            .checkRemoteAccess({ remoteUrl })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ImportJobFailure({ code: "remote-unreachable", message: error.message }),
              ),
            );
          yield* commit(job, (snapshot) => ({
            ...snapshot,
            preflight: {
              remoteReachable: access.reachable,
              alternateRemoteUrl: access.reachable ? access.alternateRemoteUrl : null,
            },
          }));
          if (!access.reachable) {
            return yield* failWith(
              "remote-unreachable",
              `This node cannot reach ${remoteUrl}${access.detail === null ? "." : `: ${access.detail}`}`,
            );
          }
          if (access.alternateRemoteUrl !== null) {
            job.cloneUrl = access.alternateRemoteUrl;
            yield* warn(
              job,
              `${remoteUrl} did not answer from this node; cloned from ${access.alternateRemoteUrl} instead.`,
            );
          }
        }),
      );

    /** The staging sibling, created by a non-recursive mkdir: the job owns it exactly then. */
    const createStaging = (job: ActiveJob) =>
      Effect.gen(function* () {
        const stagingPath = projectImportStagingPath(job.destination, job.importId);
        yield* workspaceAccess
          .assertPath({ path: stagingPath, operation: "projects.importStart" })
          .pipe(
            Effect.mapError(
              () =>
                new ImportJobFailure({
                  code: "access-denied",
                  message: `The import's working folder next to ${job.input.destinationPath} is outside the folders Ryco may use.`,
                }),
            ),
          );
        const created = yield* Effect.tryPromise(async () => {
          await mkdir(path.dirname(stagingPath), { recursive: true });
          await mkdir(stagingPath);
          return await lstat(stagingPath, { bigint: true });
        }).pipe(
          Effect.mapError(
            (error) =>
              new ImportJobFailure({
                code: "destination-unavailable",
                message:
                  errnoOf(error.cause) === "EEXIST"
                    ? `A leftover folder ${stagingPath} is in the way; remove it and copy again.`
                    : `Could not create ${stagingPath}: ${messageOf(error.cause, "unknown error")}`,
              }),
          ),
        );
        job.owned = true;
        job.staging = { path: stagingPath, dev: String(created.dev), ino: String(created.ino) };
        yield* persist(job);
        return stagingPath;
      });

    const repositorySteps = (job: ActiveJob) =>
      Effect.gen(function* () {
        const input = job.input;
        const source = input.source;
        const cloneRemote = source.kind === "clone" ? source.remoteName : null;
        const observer = observerFor(job);
        const repositoryRoot = yield* runStep(
          job,
          "clone",
          Effect.gen(function* () {
            const stagingPath = yield* createStaging(job);
            if (source.kind === "clone") {
              yield* gitStep(
                job,
                importGit.cloneNoCheckout({
                  repositoryRoot: stagingPath,
                  remoteUrl: job.cloneUrl,
                  remoteName: source.remoteName,
                  observer,
                  onProgress: (progress) =>
                    Effect.suspend(() => {
                      job.snapshot = withImportStep(
                        job.snapshot,
                        "clone",
                        {
                          progressPercent: Math.max(0, Math.min(100, Math.round(progress.percent))),
                          detail: progress.detail,
                        },
                        new Date().toISOString(),
                      );
                      return scheduleFlush(job);
                    }),
                }),
              );
            } else {
              const bundlePath = claimedPath(job, "repository-bundle");
              if (bundlePath === null) {
                return yield* failWith("transfer-missing", "The repository bundle is missing.");
              }
              yield* gitStep(
                job,
                importGit.initFromBundle({ repositoryRoot: stagingPath, bundlePath, observer }),
              );
            }
            return stagingPath;
          }),
          () => null,
        );

        if (input.remotes.length === 0) {
          yield* skipStep(job, "remotes", null);
        } else {
          yield* runStep(
            job,
            "remotes",
            gitStep(
              job,
              importGit.setRemotes({
                repositoryRoot,
                remotes: input.remotes,
                keepRemoteName: cloneRemote,
              }),
            ).pipe(
              Effect.tap(({ warnings }) =>
                Effect.forEach(warnings, (warning) => warn(job, warning), { discard: true }),
              ),
            ),
            () => input.remotes.map((remote) => remote.name).join(", "),
          );
        }

        if (input.commits === null) {
          yield* skipStep(job, "commits", null);
        } else {
          const bundlePath = claimedPath(job, "commits-bundle");
          yield* runStep(
            job,
            "commits",
            bundlePath === null
              ? failWith("transfer-missing", "The bundle of unpushed commits is missing.")
              : gitStep(
                  job,
                  importGit.fetchCommitsBundle({
                    repositoryRoot,
                    importId: job.importId,
                    bundlePath,
                    observer,
                  }),
                ),
          );
        }

        yield* runStep(
          job,
          "checkout",
          gitStep(
            job,
            importGit.checkout({
              repositoryRoot,
              importId: job.importId,
              remoteName: cloneRemote,
              checkout: input.checkout,
              relativeRootInRepository: input.relativeRootInRepository,
              observer,
            }),
          ),
          (result) => `${result.branch ?? "Detached"} at ${result.headOid.slice(0, 7)}`,
        );

        yield* changesStep(job, repositoryRoot);

        const hasSubmodules = yield* Effect.promise(() =>
          lstat(path.join(repositoryRoot, ".gitmodules")).then(
            () => true,
            () => false,
          ),
        );
        if (!input.recurseSubmodules || !hasSubmodules) {
          yield* skipStep(job, "submodules", hasSubmodules ? "Not requested" : null);
        } else {
          yield* warnOnlyStep(
            job,
            "submodules",
            importGit.updateSubmodules({ repositoryRoot, observer }),
            () =>
              "Submodules could not be checked out; run `git submodule update --init --recursive` in the project.",
          );
        }

        if (!input.usesLfs) {
          yield* skipStep(job, "lfs", null);
        } else {
          yield* setStep(job, "lfs", { status: "running" });
          const pulled = yield* importGit
            .lfsPull({ repositoryRoot, remoteName: cloneRemote, observer })
            .pipe(Effect.result);
          if (pulled._tag === "Success" && pulled.success.status === "pulled") {
            yield* setStep(job, "lfs", { status: "done" });
          } else if (pulled._tag === "Success" && pulled.success.status === "not-used") {
            // Asked for (a plain clone cannot know), but the checkout has no LFS files.
            yield* setStep(job, "lfs", { status: "skipped", detail: "No Git LFS files" });
          } else if (pulled._tag === "Success") {
            yield* setStep(job, "lfs", { status: "skipped", detail: "Git LFS is not installed" });
            yield* warn(
              job,
              "Git LFS is not installed on this node; large files are pointers until you run `git lfs pull`.",
            );
          } else {
            yield* setStep(job, "lfs", { status: "failed", detail: pulled.failure.message });
            yield* warn(
              job,
              `Large files could not be downloaded (${pulled.failure.message}); run \`git lfs pull\` in the project.`,
            );
          }
        }
        return repositoryRoot;
      });

    /** Changes never stop the job: a patch that does not apply is kept for a manual apply. */
    const changesStep = (job: ActiveJob, repositoryRoot: string) =>
      Effect.gen(function* () {
        const changes = job.input.changes;
        if (changes === null) return yield* skipStep(job, "changes", null);
        const patchPath = claimedPath(job, "changes-patch");
        if (patchPath === null) {
          yield* setStep(job, "changes", { status: "failed", detail: "The patch is missing" });
          return yield* warn(
            job,
            "The uncommitted changes did not arrive, so they were not applied.",
          );
        }
        yield* setStep(job, "changes", { status: "running" });
        const outcome = yield* importGit
          .applyChanges({
            repositoryRoot,
            importId: job.importId,
            patchPath,
            baseOid: changes.baseOid,
            ignoredPaths: changes.ignoredPaths,
            observer: observerFor(job),
          })
          .pipe(Effect.result);
        if (outcome._tag === "Failure") {
          yield* setStep(job, "changes", { status: "failed", detail: outcome.failure.message });
          return yield* warn(
            job,
            `The uncommitted changes were not applied: ${outcome.failure.message}`,
          );
        }
        if (outcome.success.status === "applied") {
          return yield* setStep(job, "changes", { status: "done" });
        }
        const kept = outcome.success;
        // The repository moves to the destination when it is published; name the final path.
        const keptPath = path.join(job.destination, kept.keptPatchPath);
        yield* setStep(job, "changes", {
          status: kept.reason === "base-mismatch" ? "skipped" : "failed",
          detail: kept.detail,
        });
        yield* warn(
          job,
          `The uncommitted changes were not applied (${kept.detail}). They are kept in ${keptPath}; apply them with \`git apply --binary ${keptPath}\` from the repository root.`,
        );
      });

    const warnOnlyStep = <R>(
      job: ActiveJob,
      id: ProjectImportStepId,
      effect: Effect.Effect<void, ProjectImportStepError, R>,
      warningOf: (error: ProjectImportStepError) => string,
    ) =>
      Effect.gen(function* () {
        yield* setStep(job, id, { status: "running" });
        const result = yield* effect.pipe(Effect.result);
        if (result._tag === "Success") return yield* setStep(job, id, { status: "done" });
        yield* setStep(job, id, { status: "failed", detail: result.failure.message });
        yield* warn(job, warningOf(result.failure));
      });

    /** Re-judges the destination and moves the staging directory onto it. */
    const publish = (job: ActiveJob) =>
      Effect.gen(function* () {
        const input = job.input;
        const staging = job.staging;
        if (staging === null) return yield* failWith("internal", "The import's folder is missing.");
        const recheck = yield* nodePaths
          .judgeProjectDestination({
            path: job.destination,
            intent: "create",
            relativeRootInRepository: input.relativeRootInRepository,
          })
          .pipe(
            Effect.mapError(
              (error) => new ImportJobFailure({ code: "register-failed", message: error.message }),
            ),
          );
        if (!recheck.usable) {
          const refusal = destinationRefusal(input, recheck.preview, false);
          return yield* failWith(refusal.code, refusal.message);
        }
        yield* Effect.tryPromise(async () => {
          // An empty destination folder (made by the user or the dialog) gives way to the clone.
          await rmdir(job.destination).catch((error: unknown) => {
            if (errnoOf(error) !== "ENOENT") throw error;
          });
          await renameWithRetry(staging.path, job.destination);
        }).pipe(
          Effect.mapError(
            (error) =>
              new ImportJobFailure({
                code: "destination-unavailable",
                message: `Could not move the repository into ${input.destinationPath}: ${messageOf(error.cause, "unknown error")}`,
              }),
          ),
        );
        return staging;
      });

    /**
     * Moves a published directory back to its staging path after registering it failed, when the
     * projection shows the project never existed and the destination still has the directory's
     * identity, so cleanup deletes it there and only there (A15). Otherwise it stays put.
     */
    const unpublish = (job: ActiveJob, staging: OwnedDirectory) =>
      Effect.gen(function* () {
        if ((yield* registrationOf(job)) !== "never") return;
        yield* Effect.tryPromise(async () => {
          if (!hasIdentity(await lstat(job.destination, { bigint: true }), staging)) return;
          await renameWithRetry(job.destination, staging.path);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("project import could not move its folder back to staging", {
              importId: job.importId,
              cause: messageOf(error.cause, "unknown error"),
            }),
          ),
        );
      });

    /** Judges the published (or linked) checkout and adds it as the project. */
    const addProject = (job: ActiveJob) =>
      Effect.gen(function* () {
        const input = job.input;
        const final = yield* nodePaths
          .judgeProjectDestination({
            path: job.destination,
            intent: "link",
            relativeRootInRepository: input.relativeRootInRepository,
          })
          .pipe(
            Effect.mapError(
              (error) => new ImportJobFailure({ code: "register-failed", message: error.message }),
            ),
          );
        if (!final.usable || final.projectRoot === null) {
          const refusal = destinationRefusal(input, final.preview, true);
          return yield* failWith("register-failed", refusal.message);
        }
        const projectRoot = final.projectRoot;
        yield* engine
          .dispatch({
            type: "project.create",
            commandId: projectImportCommandId(job.importId, "project-create"),
            projectId: input.projectId,
            title: input.title,
            workspaceRoot: projectRoot,
            projectMetadataDir: input.settings?.projectMetadataDir ?? DEFAULT_PROJECT_METADATA_DIR,
            createWorkspaceRootIfMissing: false,
            customSystemPrompt: input.settings?.customSystemPrompt ?? null,
            createdAt: new Date().toISOString(),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ImportJobFailure({
                  code: "register-failed",
                  message: `The project could not be added: ${messageOf(error, "orchestration error")}`,
                }),
            ),
          );
        return projectRoot;
      });

    /**
     * Publishes the repository to the destination (re-judged first) and registers the project;
     * when registering fails, the repository moves back to its staging path. Runs uninterruptibly
     * (`runJob` is): a cancel waits for it, so the project either exists with the record
     * saying so, or not at all.
     */
    const register = (job: ActiveJob, linking: boolean) =>
      runStep(
        job,
        "register",
        Effect.gen(function* () {
          const published = linking ? null : yield* publish(job);
          const projectRoot = yield* addProject(job).pipe(
            Effect.tapError(() => (published === null ? Effect.void : unpublish(job, published))),
          );
          // From here the folder is the project's: nothing of it is the job's to delete any more.
          job.registered = true;
          job.staging = null;
          job.projectRoot = projectRoot;
          yield* persist(job);
          return projectRoot;
        }),
        (projectRoot) => projectRoot,
      );

    /** project.meta.update with the source's scripts and preferred remote; idempotent by id. */
    const settingsStep = (record: JobRecord) =>
      Effect.gen(function* () {
        const input = record.input;
        const scripts = scriptsWithSetup(input.settings?.scripts ?? [], input.setup);
        if (input.settings === null && scripts.length === 0) {
          return yield* skipStep(record, "settings", null);
        }
        yield* setStep(record, "settings", { status: "running" });
        const result = yield* engine
          .dispatch({
            type: "project.meta.update",
            commandId: projectImportCommandId(record.importId, "project-settings"),
            projectId: input.projectId,
            scripts: [...scripts],
            ...(input.settings === null
              ? {}
              : { preferredRemoteName: input.settings.preferredRemoteName }),
          })
          .pipe(Effect.result);
        if (result._tag === "Success")
          return yield* setStep(record, "settings", { status: "done" });
        const message = messageOf(result.failure, "orchestration error");
        yield* setStep(record, "settings", { status: "failed", detail: message });
        yield* warn(record, replayedImportStepWarning("settings", message));
      });

    /** The avatar through the upload pipeline, then project.avatar.set; idempotent by id. */
    const avatarStep = (record: JobRecord, avatarPath: string | null) =>
      Effect.gen(function* () {
        if (record.input.avatarTransferId === null) return yield* skipStep(record, "avatar", null);
        yield* setStep(record, "avatar", { status: "running" });
        const outcome = yield* Effect.gen(function* () {
          if (avatarPath === null) return yield* Effect.fail("The avatar did not arrive.");
          const bytes = yield* Effect.tryPromise(() => readFile(avatarPath)).pipe(
            Effect.mapError(() => "The avatar could not be read."),
          );
          if (bytes.length > PROJECT_COPY_MAX_AVATAR_BYTES) {
            return yield* Effect.fail("The avatar is too large.");
          }
          const contentType = avatarContentType(bytes);
          if (contentType === null)
            return yield* Effect.fail("The avatar is not a PNG, JPEG or WebP image.");
          const written = yield* avatars
            .write({ projectId: record.input.projectId, bytes, contentType })
            .pipe(Effect.mapError((error) => error.message));
          yield* engine
            .dispatch({
              type: "project.avatar.set",
              commandId: projectImportCommandId(record.importId, "project-avatar"),
              projectId: record.input.projectId,
              contentHash: written.contentHash,
            })
            .pipe(Effect.mapError((error) => messageOf(error, "orchestration error")));
        }).pipe(Effect.result);
        if (outcome._tag === "Success") return yield* setStep(record, "avatar", { status: "done" });
        yield* setStep(record, "avatar", { status: "failed", detail: outcome.failure });
        yield* warn(record, replayedImportStepWarning("avatar", outcome.failure));
      });

    /** A failing setup leaves the import completed, with the step failed and a warning. */
    const setupStep = (job: ActiveJob) =>
      Effect.gen(function* () {
        const setup = job.input.setup;
        const projectRoot = job.projectRoot;
        if (setup === null || projectRoot === null) return yield* skipStep(job, "setup", null);
        yield* setStep(job, "setup", { status: "running" });
        yield* appendOutput(job, `$ ${setup.command}\n`);
        const result = yield* setupCommand
          .run({ command: setup.command, projectRoot, observer: observerFor(job) })
          .pipe(Effect.result);
        if (result._tag === "Failure") {
          job.setupFailure = {
            command: setup.command,
            outcome: "could not start",
            exitCode: null,
            outputTail: "",
          };
          yield* setStep(job, "setup", { status: "failed", detail: result.failure.message });
          return yield* warn(job, `The setup command could not start: ${result.failure.message}`);
        }
        const run = result.success;
        if (run.outcome === "succeeded") {
          return yield* setStep(job, "setup", { status: "done", detail: "Exit code 0" });
        }
        job.setupFailure = { command: setup.command, ...run };
        const ended =
          run.outcome === "timed-out"
            ? "timed out"
            : run.exitCode === null
              ? "was stopped"
              : `exited with code ${run.exitCode}`;
        yield* setStep(job, "setup", { status: "failed", detail: `The command ${ended}` });
        yield* warn(
          job,
          `The setup command ${ended}; the project is ready, but its setup may be incomplete.`,
        );
      });

    const followUpStep = (job: ActiveJob) =>
      Effect.gen(function* () {
        const followUp = job.input.followUpThread;
        const projectRoot = job.projectRoot;
        if (followUp === null || projectRoot === null)
          return yield* skipStep(job, "follow-up", null);
        yield* setStep(job, "follow-up", { status: "running" });
        const result = yield* startProjectImportFollowUp(followUpDeps, {
          importId: job.importId,
          project: {
            id: job.input.projectId,
            title: job.input.title,
            workspaceRoot: projectRoot,
            projectMetadataDir:
              job.input.settings?.projectMetadataDir ?? DEFAULT_PROJECT_METADATA_DIR,
          },
          followUp,
          setupFailure: job.setupFailure,
        });
        if (result.status === "started") {
          yield* commit(job, (snapshot) => ({ ...snapshot, followUpThreadId: result.threadId }));
          return yield* setStep(job, "follow-up", { status: "done" });
        }
        yield* setStep(job, "follow-up", { status: result.status, detail: result.reason });
        yield* warn(job, `The setup thread was not started: ${result.reason}`);
      });

    /**
     * The steps. Uninterruptible but for the regions a cancel or a stop may cut short (their
     * children are killed and awaited), so once the follow-up step ran nothing can interrupt the
     * job any more and `settle` completes it.
     */
    const runJob = (job: ActiveJob) =>
      Effect.gen(function* () {
        const linking = job.input.source.kind === "existing-checkout";
        yield* Effect.interruptible(
          Effect.gen(function* () {
            yield* preflight(job);
            if (linking) {
              for (const id of [
                "clone",
                "remotes",
                "commits",
                "checkout",
                "changes",
                "submodules",
                "lfs",
              ] as const) {
                yield* skipStep(job, id, "Links the existing checkout");
              }
            } else {
              yield* repositorySteps(job);
            }
          }),
        );
        // The project exists with the record saying so, or not at all, and its settings and
        // avatar follow it.
        yield* register(job, linking);
        yield* settingsStep(job);
        yield* avatarStep(job, claimedPath(job, "avatar"));
        yield* Effect.interruptible(setupStep(job));
        yield* followUpStep(job);
      }).pipe(Effect.uninterruptible);

    /**
     * The job's fiber, forked uninterruptible into the layer's scope in the same step that puts
     * the job in `active`: whatever happens to the `start` call (a dropped relay interrupts it),
     * the job is recorded, runs and settles, and `start` (or its retry) is answered.
     */
    const lifecycle = (job: ActiveJob) =>
      Effect.gen(function* () {
        const inserted = yield* Effect.exit(insertRow(job));
        if (Exit.isFailure(inserted)) {
          active.delete(job.importId);
          job.releaseReservation();
          const cause = Cause.squash(inserted.cause);
          yield* Deferred.fail(
            job.admitted,
            messageOf(cause, "").includes("UNIQUE")
              ? copyError("conflict", projectDestinationReservedMessage(job.input.destinationPath))
              : internal(cause),
          );
          return;
        }
        // A restart (a node updating itself) waits until the job settled.
        yield* restartWork.track(
          Effect.exit(runJob(job)).pipe(Effect.flatMap((exit) => settle(job, exit))),
        );
      }).pipe(Effect.ensuring(Deferred.succeed(job.admitted, undefined)));

    // ── Service ───────────────────────────────────────────────────────

    const snapshotOf = (importId: ProjectImportId) =>
      Effect.gen(function* () {
        const job = active.get(importId);
        if (job !== undefined) return Option.some(job.snapshot);
        const row = yield* readRow(importId);
        if (Option.isNone(row)) return Option.none<ProjectImportSnapshot>();
        return Option.some(
          yield* decodeSnapshot(row.value.snapshot_json).pipe(Effect.mapError(internal)),
        );
      });

    const validateInput = (input: ProjectImportStartInput) =>
      input.source.kind === "existing-checkout" &&
      (input.commits !== null || input.changes !== null)
        ? Effect.fail(
            copyError("invalid", "Linking an existing checkout cannot bring commits or changes."),
          )
        : Effect.void;

    const checkLinkTarget = (
      input: ProjectImportStartInput,
      judgement: {
        readonly canonicalPath: string;
        readonly projectRoot: string | null;
        readonly preview: { readonly existingRepositoryCanonicalKey: string | null };
      },
    ) =>
      Effect.gen(function* () {
        if (input.source.kind !== "existing-checkout") return null;
        if (
          judgement.preview.existingRepositoryCanonicalKey !== input.source.expectedCanonicalKey
        ) {
          return `The repository at ${input.destinationPath} is a different repository than the project being linked.`;
        }
        // The project root of a monorepo subfolder must be a real directory inside the checkout.
        const projectRoot = judgement.projectRoot ?? judgement.canonicalPath;
        const inside = yield* Effect.promise(async () => {
          try {
            const info = await lstat(projectRoot);
            if (!info.isDirectory() || info.isSymbolicLink()) return false;
            const [root, repository] = await Promise.all([
              realpath(projectRoot),
              realpath(judgement.canonicalPath),
            ]);
            return sameOrInside(root, repository);
          } catch {
            return false;
          }
        });
        return inside
          ? null
          : `${input.relativeRootInRepository} is not a folder inside ${input.destinationPath}.`;
      });

    const reusedId = () =>
      copyError("conflict", "This import id was already used for a different import.");

    /**
     * What `start` answers with: a settled answer (a known id, a refused destination), or the
     * running job to wait for. Serialized by `startLock`: one importId never starts twice and
     * reservations are taken in order.
     */
    const enter = (input: ProjectImportStartInput) =>
      Effect.gen(function* () {
        const digest = projectImportInputDigest(input);
        // A job whose caller went away is still running, maybe before its row exists.
        const running = active.get(input.importId);
        if (running !== undefined) {
          if (running.digest !== digest) return yield* reusedId();
          return { job: running } as const;
        }
        const existing = yield* readRow(input.importId);
        if (Option.isSome(existing)) {
          if (existing.value.input_digest !== digest) return yield* reusedId();
          const snapshot = yield* decodeSnapshot(existing.value.snapshot_json).pipe(
            Effect.mapError(internal),
          );
          return { snapshot } as const;
        }
        yield* validateInput(input);
        const linking = input.source.kind === "existing-checkout";
        const judgement = yield* nodePaths.judgeProjectDestination({
          path: input.destinationPath,
          intent: linking ? "link" : "create",
          relativeRootInRepository: input.relativeRootInRepository,
        });
        const now = new Date().toISOString();
        const initial = initialProjectImportSnapshot(input, now);
        const linkRefusal =
          judgement.usable && judgement.canonicalPath !== null
            ? yield* checkLinkTarget(input, {
                ...judgement,
                canonicalPath: judgement.canonicalPath,
              })
            : null;
        if (!judgement.usable || judgement.canonicalPath === null || linkRefusal !== null) {
          // An unusable destination is the job's preflight failure, so retries and lists see it.
          const refusal =
            linkRefusal === null
              ? destinationRefusal(input, judgement.preview, linking)
              : { code: "destination-unavailable" as const, message: linkRefusal };
          const failed = settleImportSnapshot(
            withImportStep(initial, "preflight", { status: "running" }, now),
            { status: "failed", error: { step: "preflight", ...refusal }, leftoverPath: null },
            now,
          );
          yield* insertRow({
            importId: input.importId,
            input,
            digest,
            destinationKey: judgement.canonicalPath ?? input.destinationPath,
            snapshot: failed,
            owned: false,
            staging: null,
            registered: false,
            child: null,
          }).pipe(Effect.mapError(internal));
          return { snapshot: failed } as const;
        }
        const destination = judgement.canonicalPath;
        const destinationKey = yield* projectDestinationReservationKey(destination);
        const ref = yield* SubscriptionRef.make(initial);
        const admitted = yield* Deferred.make<void, ProjectCopyError>();
        // Reserving, entering `active` and forking happen in one uninterruptible step: a held
        // reservation always belongs to a job in `active`, and that job always has its fiber.
        return yield* Effect.uninterruptible(
          Effect.suspend(() => {
            const releaseReservation = tryReserveProjectDestination(
              destinationKey,
              `project import ${input.importId}`,
            );
            if (releaseReservation === null) {
              return Effect.fail(
                copyError("conflict", projectDestinationReservedMessage(input.destinationPath)),
              );
            }
            const job: ActiveJob = {
              importId: input.importId,
              input,
              digest,
              destinationKey,
              snapshot: initial,
              owned: false,
              staging: null,
              registered: false,
              child: null,
              destination,
              ref,
              tail: new TerminalOutputTail(PROJECT_IMPORT_OUTPUT_TAIL_LINES),
              releaseReservation,
              admitted,
              claimed: [],
              cloneUrl: input.source.kind === "clone" ? input.source.remoteUrl : "",
              projectRoot: null,
              setupFailure: null,
              fiber: null,
              cancelRequested: false,
              flushScheduled: false,
            };
            // Active before the row exists, so recovery never takes it for an earlier process's.
            active.set(job.importId, job);
            return lifecycle(job).pipe(
              Effect.forkIn(layerScope, { uninterruptible: true }),
              Effect.map((fiber) => {
                job.fiber = fiber;
                return { job } as const;
              }),
            );
          }),
        );
      });

    const start: ProjectImportsShape["start"] = (input) =>
      startLock
        .withPermits(1)(enter(input))
        .pipe(
          Effect.flatMap((entered) =>
            "snapshot" in entered
              ? Effect.succeed(entered.snapshot)
              : // Outside the lock, and interruptible: when the caller goes away meanwhile (a
                // dropped relay), the job runs on and a retry with the same id waits for it (A3).
                Deferred.await(entered.job.admitted).pipe(Effect.map(() => entered.job.snapshot)),
          ),
        );

    const get: ProjectImportsShape["get"] = (importId) => snapshotOf(importId);

    const subscribe: ProjectImportsShape["subscribe"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const job = active.get(input.importId);
          if (job !== undefined) {
            // Changed snapshots only (each change is a new object), at most one per throttle
            // interval and always the newest: a slow subscriber never builds a backlog, and a
            // busy job (half an hour of setup output) costs a relayed subscriber at most one
            // snapshot a second. The stream ends with the terminal one.
            return SubscriptionRef.changes(job.ref).pipe(
              Stream.changesWith((left, right) => left === right),
              newestAtMostEvery(throttleMs),
              Stream.takeUntil((snapshot) => isTerminalImportStatus(snapshot.status)),
            );
          }
          const snapshot = yield* snapshotOf(input.importId);
          if (Option.isNone(snapshot)) {
            return yield* copyError("not-found", "This node does not know that import.");
          }
          return Stream.make(snapshot.value);
        }),
      );

    const cancel: ProjectImportsShape["cancel"] = (input) =>
      Effect.gen(function* () {
        // A start still entering finishes first, so its job can be found and cancelled.
        yield* startLock.withPermits(1)(Effect.void);
        const job = active.get(input.importId);
        if (job !== undefined) {
          job.cancelRequested = true;
          // Returns once the job settled: its child exited and its folder is gone.
          if (job.fiber !== null) yield* Fiber.interrupt(job.fiber);
          if (isTerminalImportStatus(job.snapshot.status)) return job.snapshot;
          // Otherwise its row could not even be written: the node does not know it.
        }
        const snapshot = yield* snapshotOf(input.importId);
        if (Option.isNone(snapshot)) {
          return yield* copyError("not-found", "This node does not know that import.");
        }
        return snapshot.value;
      });

    const list: ProjectImportsShape["list"] = () =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly import_id: string; readonly snapshot_json: string }>`
          SELECT import_id, snapshot_json FROM project_imports
          ORDER BY created_at DESC, import_id DESC LIMIT ${PROJECT_IMPORT_LIST_MAX}`.pipe(
          Effect.mapError(internal),
        );
        const imports = yield* Effect.forEach(rows, (row) => {
          const job = active.get(row.import_id as ProjectImportId);
          return job !== undefined
            ? Effect.succeed(job.snapshot)
            : decodeSnapshot(row.snapshot_json).pipe(Effect.mapError(internal));
        });
        return { imports };
      });

    const discard: ProjectImportsShape["discard"] = (input) =>
      maintenanceLock.withPermits(1)(
        Effect.gen(function* () {
          if (active.has(input.importId)) {
            return { deleted: false, reason: "The import is still running." };
          }
          const row = yield* readRow(input.importId);
          if (Option.isNone(row)) {
            return yield* copyError("not-found", "This node does not know that import.");
          }
          const record = yield* recordOf(row.value);
          if (record.snapshot.status === "running") {
            return { deleted: false, reason: "The import is still running." };
          }
          // A child an earlier process left behind must not write while its folder is deleted.
          if (record.child !== null) {
            yield* processes.stopRecordedChild(record.child);
            record.child = null;
          }
          const removal = yield* removeOwned(record);
          record.snapshot = {
            ...record.snapshot,
            leftoverPath: removal.leftoverPath,
            updatedAt: new Date().toISOString(),
          };
          // The files normally went when the job settled; releasing again is a no-op then.
          if (!replayDue(record)) yield* transfers.releaseImport(record.importId);
          yield* persist(record);
          return { deleted: removal.deleted, reason: removal.reason };
        }),
      );

    // ── Startup recovery ──────────────────────────────────────────────

    /** Runs `settle` for each row of an earlier process; one bad row never stops the others. */
    const forEachLeftover = <E, R>(
      rows: ReadonlyArray<ProjectImportRow>,
      settleRow: (record: JobRecord) => Effect.Effect<void, E, R>,
    ) =>
      Effect.forEach(
        rows,
        (row) =>
          active.has(row.import_id as ProjectImportId)
            ? Effect.void
            : recordOf(row).pipe(
                Effect.flatMap(settleRow),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logWarning("project import could not be recovered", {
                        importId: row.import_id,
                        cause: Cause.pretty(cause),
                      }),
                ),
              ),
        { discard: true },
      );

    /**
     * Jobs an earlier process left `running`: their children are stopped (only when provably
     * theirs), and they become `interrupted`. A registered job's settings and avatar stay (or go
     * back to) pending for the replay; its setup and follow-up thread are skipped with a warning.
     * The claimed files of a job with nothing to replay go before its row says interrupted.
     */
    const interruptLeftoverJobs = Effect.gen(function* () {
      const rows = yield* sql<ProjectImportRow>`
        SELECT * FROM project_imports WHERE status = 'running'`;
      yield* forEachLeftover(rows, (record) =>
        Effect.gen(function* () {
          if (record.child !== null) {
            yield* processes.stopRecordedChild(record.child);
            record.child = null;
          }
          // project.create may have committed right before the crash.
          const registration = yield* registrationOf(record);
          record.registered = registration === "registered";
          const now = new Date().toISOString();
          let snapshot = record.snapshot;
          if (record.registered) {
            record.staging = null;
            if (importStepOf(snapshot, "register")?.status !== "done") {
              snapshot = withImportStep(snapshot, "register", { status: "done" }, now);
            }
            for (const [id, what, requested] of [
              ["setup", "setup command", record.input.setup !== null],
              ["follow-up", "setup thread", record.input.followUpThread !== null],
            ] as const) {
              const status = importStepOf(snapshot, id)?.status;
              if (requested && (status === "pending" || status === "running")) {
                snapshot = withImportWarning(
                  snapshot,
                  `The ${what} did not run: Ryco restarted during the import.`,
                  now,
                );
              }
            }
          }
          record.snapshot = settleImportSnapshot(
            snapshot,
            {
              status: "interrupted",
              error: {
                step: currentImportStep(snapshot),
                code: "interrupted",
                message: "Ryco restarted while this import was running.",
              },
              leftoverPath: record.registered ? null : ((yield* locateOwned(record))?.path ?? null),
              keepPending: record.registered ? PROJECT_IMPORT_REPLAYED_STEPS : [],
            },
            now,
          );
          if (!replayDue(record)) yield* transfers.releaseImport(record.importId);
          yield* persist(record);
        }),
      );
    });

    /**
     * Runs a step of a startup replay. A stop that cuts it short saves what it got to, and puts
     * it back to pending when it was still running: only a crash leaves a replay running, which
     * the next start fails rather than replays (`failCutShortReplays`).
     */
    const replayStep = <E, R>(
      record: JobRecord,
      id: ProjectImportReplayedStepId,
      step: Effect.Effect<void, E, R>,
    ) =>
      step.pipe(
        Effect.onInterrupt(() =>
          Effect.suspend(() => {
            if (importStepOf(record.snapshot, id)?.status === "running") {
              record.snapshot = withImportStep(
                record.snapshot,
                id,
                { status: "pending", progressPercent: null, detail: null },
                new Date().toISOString(),
              );
            }
            return persist(record);
          }),
        ),
      );

    /**
     * Interrupted jobs: a never-registered one's directory is deleted; a registered one's due
     * settings and avatar are replayed (idempotent by command id), then its files go. A replay a
     * crash cut short fails with a warning instead of running a third time.
     */
    const settleInterruptedJobs = Effect.gen(function* () {
      // Only rows with something left: a folder, a child, or a registered project to finish.
      const rows = yield* sql<ProjectImportRow>`
        SELECT * FROM project_imports WHERE status = 'interrupted'
          AND (staging_path IS NOT NULL OR child_pid IS NOT NULL OR registered = 1)`;
      yield* forEachLeftover(rows, (record) =>
        Effect.gen(function* () {
          const before = record.snapshot;
          if (record.registered) {
            record.snapshot = failCutShortReplays(record.snapshot, new Date().toISOString());
          }
          const failedReplays = record.snapshot !== before;
          const due = record.registered ? dueReplayedImportSteps(record.snapshot) : [];
          if (
            record.staging === null &&
            record.child === null &&
            due.length === 0 &&
            !failedReplays
          ) {
            // A registered job's files usually went when it settled, but a stop or a crash between
            // a replay saving its last step and the release below leaves them, and nothing marks
            // that. Releasing again deletes nothing else; the row is not written, so it expires.
            if (record.registered) yield* transfers.releaseImport(record.importId);
            return;
          }
          if (record.child !== null) {
            yield* processes.stopRecordedChild(record.child);
            record.child = null;
          }
          if (record.staging !== null) {
            const removal = yield* removeOwned(record);
            record.snapshot = { ...record.snapshot, leftoverPath: removal.leftoverPath };
          }
          if (due.length > 0) {
            const avatarClaims = transferClaims(record.input).filter(
              (claim) => claim.purpose === "avatar",
            );
            // Claiming again for the same import returns the files it already claimed.
            const claimed =
              avatarClaims.length === 0
                ? []
                : yield* transfers
                    .claimForImport({ importId: record.importId, transfers: avatarClaims })
                    .pipe(Effect.orElseSucceed((): ReadonlyArray<ClaimedProjectTransfer> => []));
            if (due.includes("settings")) {
              yield* replayStep(record, "settings", settingsStep(record));
            }
            if (due.includes("avatar")) {
              yield* replayStep(
                record,
                "avatar",
                avatarStep(record, claimedPath({ claimed }, "avatar")),
              );
            }
          }
          // Each replayed step saved its outcome, so nothing reads the files any more; they go
          // before the row records a failed replay, as everywhere a job stops owing a step.
          yield* transfers.releaseImport(record.importId);
          record.snapshot = { ...record.snapshot, updatedAt: new Date().toISOString() };
          yield* persist(record);
        }),
      );
      // Settled jobs without a leftover are only history after a month.
      const cutoff = new Date(Date.now() - PROJECT_IMPORT_SETTLED_RETENTION_MS).toISOString();
      yield* sql`DELETE FROM project_imports
        WHERE status <> 'running' AND staging_path IS NULL AND updated_at < ${cutoff}`;
    });

    const recoverOnStartup: ProjectImportsShape["recoverOnStartup"] = () =>
      maintenanceLock
        .withPermits(1)(Effect.andThen(interruptLeftoverJobs, settleInterruptedJobs))
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("project import recovery failed", { cause: Cause.pretty(cause) }),
          ),
        );

    // Nothing of an earlier process runs any more: its jobs are interrupted before any client
    // asks. Deleting their folders and replaying their steps waits for `recoverOnStartup`.
    yield* interruptLeftoverJobs.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project imports left running could not be settled", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    // On shutdown, after the job fibers were interrupted (their finalizers run first): any job
    // whose fiber never got to settle it is recorded as interrupted.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...active.values()],
        (job) =>
          finish(job, "interrupted", {
            code: "interrupted",
            message: "Ryco stopped while this import was running.",
          }).pipe(Effect.ignoreCause),
        { discard: true },
      ),
    );

    return ProjectImports.of({ start, get, subscribe, cancel, list, discard, recoverOnStartup });
  });

/**
 * At most one element per `intervalMs`, the newest winning: the first passes at once; after each
 * one the stream pauses for the interval, then takes whatever is newest by then.
 */
export const newestAtMostEvery =
  (intervalMs: number) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> => {
    const newest = self.pipe(Stream.buffer({ capacity: 1, strategy: "sliding" }));
    if (intervalMs <= 0) return newest;
    const pause = Stream.fromEffectDrain(Effect.sleep(intervalMs));
    return newest.pipe(Stream.flatMap((value) => Stream.concat(Stream.succeed(value), pause)));
  };

/** Renames, retrying the transient EPERM/EBUSY Windows reports while a scanner holds a file. */
const renameWithRetry = async (from: string, to: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errnoOf(error);
      const transient = process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
      if (attempt >= 4 || !transient) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
};

export const makeProjectImportsLive = (options: ProjectImportsLiveOptions = {}) =>
  Layer.effect(ProjectImports, makeProjectImports(options));

export const ProjectImportsLive = makeProjectImportsLive();
