import { mintStorageCleanupClaim } from "./cleanupClaim.ts";
import { readPersistedCwd } from "../provider/runtimeCwd.ts";
import { ProviderProtectedPaths, type ProviderProtectedPathsShape } from "./providerProtection.ts";
import { workspaceSessionActive } from "../workspace/lifecycleSafety.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { Context, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CommandId,
  type DatabaseStorageReport,
  ProjectId,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageError,
  type GitCommandError,
  StorageSnapshot,
  type StorageEntry,
  type StorageRetentionPolicy,
} from "@ryco/contracts";
import { resolveStorageRetentionPolicy, retentionDue } from "@ryco/shared/storageRetention";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { databaseBackupsDirectory } from "../persistence/databaseBackupPolicy.ts";
import { EventLogCompaction } from "../persistence/Services/EventLogCompaction.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
  readProjectShells,
  readWorkspacePlacement,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { TerminalManager, type TerminalManagerShape } from "../terminal/Services/Manager.ts";
import {
  WorkspaceAccessPolicy,
  type WorkspaceAccessPolicyShape,
} from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
import {
  assertCanonicalPath,
  assertCleanWorktree,
  captureWorktreeIdentity,
  MAX_QUARANTINE_REMOVAL_ENTRIES,
  measureDirectory,
  removeQuarantinedTemporaryDirectory,
  type ScanBudget,
  type MeasuredSize,
  type WorktreeIdentity,
} from "./filesystem.ts";
import {
  storageLifecycleLock,
  acquireStorageSettingsLease,
  hasStorageSettingsUpdateLease,
  hasWorktreeCreationLease,
  isWorktreeRelocationBlocked,
  canonicalStoragePath,
} from "./lifecycle.ts";

export interface OwnedStorageRow {
  id: string;
  path: string;
  repository_path: string | null;
  project_id: string | null;
  category: "worktree" | "temporary";
  identity_json: string;
  created_at: string;
  state: "unverified" | "in_use" | "owned" | "removing" | "removed";
  completed_at: string | null;
  last_error: string | null;
}
interface PreviewRow {
  entries_json: string;
  policy_json: string;
  expires_at: string;
  result_json: string | null;
  protected_paths_json: string;
  state: string;
}
const detail = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Storage operation failed; refresh and retry.";
const failure = (cause: unknown) => new StorageError({ detail: detail(cause) });
const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failure });

/**
 * The size a node-level entry shows: a location that does not exist yet (no backup taken so far)
 * holds nothing, and the database counts its write-ahead log, as the Database block does.
 */
const sizeOnDisk = <S extends { readonly bytes: number | null; readonly sizeStatus: string }>(
  entry: { readonly id: string; readonly path: string },
  size: S,
) =>
  Effect.gen(function* () {
    const sizeOf = (file: string) =>
      attempt(() =>
        fs.lstat(file).then(
          (stat) => stat.size,
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return null;
            throw cause;
          },
        ),
      ).pipe(Effect.orElseSucceed(() => undefined));
    if (size.bytes === null && (yield* sizeOf(entry.path)) === null) {
      return { ...size, bytes: 0, sizeStatus: "complete" as const };
    }
    if (entry.id === "history" && size.bytes !== null) {
      return { ...size, bytes: size.bytes + ((yield* sizeOf(`${entry.path}-wal`)) ?? 0) };
    }
    return size;
  });
const canonical = canonicalStoragePath;
const contains = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export function makeStorageService(deps: {
  sql: SqlClient.SqlClient;
  config: ServerConfigShape;
  settings: Pick<ServerSettingsShape, "getSettings">;
  snapshots: Pick<
    ProjectionSnapshotQueryShape,
    "getShellSnapshot" | "getSnapshotSequence" | "listProjectShells"
  >;
  providers: Pick<ProviderSessionDirectoryShape, "listBindings">;
  terminals: Pick<TerminalManagerShape, "listDiagnostics">;
  providerProtection: ProviderProtectedPathsShape;
  policy: WorkspaceAccessPolicyShape;
  git: Pick<GitWorkflowServiceShape, "removeWorktree" | "listWorktreePaths">;
  /** Records a removed checkout on its workspace record (shared lifecycle state). */
  recordCheckoutRemoval?: (checkoutPath: string) => Effect.Effect<void>;
  /** The node's database (size, free space, compaction); every scan page carries it. */
  readDatabase?: Effect.Effect<DatabaseStorageReport>;
}) {
  const { sql, config, settings, snapshots, providers, terminals, policy, git } = deps;
  const resolveProtectedSources = (
    current: Parameters<ProviderProtectedPathsShape["resolve"]>[0],
  ) =>
    Effect.try({
      try: () => {
        const resolved = deps.providerProtection.resolve(current);
        return resolved === null ? null : [...new Set(resolved)].toSorted();
      },
      catch: failure,
    });
  const scanLock = Semaphore.makeUnsafe(1);
  const ownedRows = (projectId?: ProjectId, cursor?: string) =>
    sql<OwnedStorageRow>`SELECT * FROM storage_owned_entries WHERE state != 'removed' AND id > ${cursor ?? ""} AND (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null} OR project_id IS NULL) ORDER BY id LIMIT 257`;

  const inventory = () =>
    Effect.gen(function* () {
      const snapshot = yield* snapshots.getShellSnapshot();
      const canonicalPaths = new Map<string, Promise<string>>();
      const inventoryDeadline = Date.now() + 1500;
      let inventoryBounded = false;
      const resolvePath = (candidate: string) => {
        let resolved = canonicalPaths.get(candidate);
        if (!resolved) {
          if (canonicalPaths.size >= 2048 || Date.now() >= inventoryDeadline) {
            inventoryBounded = true;
            return Promise.resolve(path.resolve(candidate));
          }
          resolved = canonical(candidate).catch(() => {
            inventoryBounded = true;
            return path.resolve(candidate);
          });
          canonicalPaths.set(candidate, resolved);
        }
        return resolved;
      };
      const pendingStarts = yield* sql<{
        thread_id: string;
      }>`SELECT thread_id FROM projection_turns WHERE state = 'pending' LIMIT 5001`;
      const providerSettings = yield* settings.getSettings;
      const protectedSources = yield* resolveProtectedSources(providerSettings).pipe(
        Effect.orElseSucceed(() => null),
      );
      const nodeProtectedSources = [
        config.dbPath,
        config.dbPath + "-wal",
        config.dbPath + "-shm",
        databaseBackupsDirectory(config.dbPath),
        config.attachmentsDir,
        config.taskFilesDir,
        config.logsDir,
        config.settingsPath,
        config.secretsDir,
        config.hubIdentityStatePath,
        config.serverRuntimeStatePath,
      ].filter((value): value is string => typeof value === "string");
      const protectedPaths =
        protectedSources && protectedSources.length <= 256
          ? yield* Effect.forEach(
              [...protectedSources, ...nodeProtectedSources],
              (source) => attempt(() => resolvePath(source)),
              { concurrency: 4 },
            )
          : null;
      const bindings = (yield* providers.listBindings()).filter(
        (binding) => binding.status !== "stopped",
      );
      const terminalRows = yield* terminals.listDiagnostics;
      const projectRoots = yield* Effect.forEach(
        snapshot.projects.slice(0, 256),
        (project) =>
          attempt(async () => ({ project, root: await resolvePath(project.workspaceRoot) })),
        { concurrency: 4 },
      );
      const threadPaths = yield* Effect.forEach(
        snapshot.threads.slice(0, 5000),
        (thread) =>
          attempt(async () => ({
            thread,
            root: thread.worktreePath
              ? await resolvePath(thread.worktreePath)
              : (projectRoots.find((item) => item.project.id === thread.projectId)?.root ?? null),
          })),
        { concurrency: 4 },
      );
      const worktreePaths = yield* Effect.forEach(
        (snapshot.worktrees ?? []).slice(0, 1000),
        (worktree) =>
          attempt(async () => ({
            worktree,
            root: worktree.worktreePath ? await resolvePath(worktree.worktreePath) : null,
          })),
        { concurrency: 4 },
      );
      const terminalPaths = yield* Effect.forEach(
        terminalRows.slice(0, 1000),
        (terminal) =>
          attempt(async () => ({
            terminal,
            cwd: await resolvePath(terminal.cwd),
            worktree: terminal.worktreePath ? await resolvePath(terminal.worktreePath) : null,
          })),
        { concurrency: 4 },
      );
      const bindingPaths = yield* Effect.forEach(
        bindings.slice(0, 1000),
        (binding) =>
          attempt(async () => {
            const cwd = readPersistedCwd(binding.runtimePayload);
            return { binding, cwd: cwd ? await resolvePath(cwd) : null };
          }),
        { concurrency: 4 },
      );
      return {
        snapshot,
        bindingPaths,
        bindings,
        pendingStarts,
        protectedSources,
        protectedPaths,
        projectRoots,
        threadPaths,
        worktreePaths,
        terminalPaths,
        incomplete:
          bindings.length > 1000 ||
          pendingStarts.length > 5000 ||
          inventoryBounded ||
          snapshot.projects.length > 256 ||
          snapshot.threads.length > 5000 ||
          (snapshot.worktrees?.length ?? 0) > 1000 ||
          terminalRows.length > 1000,
      };
    });

  type InventoryContext = Effect.Success<ReturnType<typeof inventory>>;
  type EntryBase = Pick<StorageEntry, "id" | "projectId" | "category" | "label" | "path">;
  /** Why a row is not removable now. */
  type Refusal = {
    readonly eligible: false;
    readonly reason: string;
    /** Null when nothing was measured yet: display measures it with what is left. */
    readonly size: MeasuredSize | null;
  };
  type Verification = { readonly eligible: true; readonly entry: StorageEntry } | Refusal;
  type Classification =
    | { readonly kind: "protected"; readonly base: EntryBase; readonly refusal: Refusal }
    | {
        readonly kind: "candidate";
        readonly base: EntryBase;
        readonly project: InventoryContext["projectRoots"][number]["project"];
        /** A session references the path (else it is abandoned Ryco-owned data). */
        readonly associated: boolean;
        /** When the retention clock starts. */
        readonly completedAt: string;
      };
  const UNKNOWN_SIZE: MeasuredSize = { bytes: null, sizeStatus: "unknown", unsafe: true };
  const UNAVAILABLE = "Path is unavailable or unreadable; size and safety are unknown.";
  const INCOMPLETE =
    "Scan budget, symbolic link, mount or unreadable entry prevents a complete safety check.";
  /** One scan's shared budget, or one entry's own when it is previewed, retained or removed. */
  const measurementBudget = (): ScanBudget => ({ remaining: 30_000, deadline: Date.now() + 3000 });
  /** The later of two ISO instants (`fallback` when `value` is absent or unreadable). */
  const later = (value: string | null | undefined, fallback: string) =>
    value && Date.parse(value) > Date.parse(fallback) ? value : fallback;

  /**
   * Ownership, project and activity rules for one ledger row, from the inventory alone: no
   * filesystem traversal and no Git. Rows it protects never spend a measurement budget.
   */
  const classify = (row: OwnedStorageRow, context: InventoryContext) =>
    Effect.gen(function* () {
      const root = yield* attempt(() => canonical(row.path));
      const matchingProjects = context.projectRoots.filter((item) =>
        row.category === "worktree"
          ? item.root === row.repository_path &&
            (!row.project_id || item.project.id === row.project_id)
          : item.project.id === row.project_id,
      );
      const project = matchingProjects.length === 1 ? matchingProjects[0]!.project : null;
      const projectId = project?.id ?? (row.project_id ? ProjectId.make(row.project_id) : null);
      const base: EntryBase = {
        id: row.id,
        projectId,
        category: row.category,
        label: path.basename(row.path),
        path: row.path,
      };
      // Provider sources are never traversed, not even for display.
      const protect = (reason: string, measure = true): Classification => ({
        kind: "protected",
        base,
        refusal: { eligible: false, reason, size: measure ? null : UNKNOWN_SIZE },
      });
      if (!context.protectedPaths)
        return protect(
          "Provider history/export locations could not be verified on this node; cleanup is protected.",
          false,
        );
      if (
        context.protectedPaths.some(
          (protectedPath) => contains(root, protectedPath) || contains(protectedPath, root),
        )
      )
        return protect(
          "Checkout/data overlaps a declared provider archive, export, home or credential location; protected.",
          false,
        );
      if (context.incomplete)
        return protect(
          "Lifecycle inventory exceeds its bounds. Ownership/active state cannot be established safely.",
        );
      if (!project) return protect("Owning project is missing or ambiguous; protected.");
      if (row.state === "unverified")
        return protect(
          "Creation completed, but ownership could not be verified. Inspect manually; cleanup is protected.",
        );
      if (row.state === "in_use")
        return protect("Temporary staging data is still in use by its producer.");
      if (row.state !== "owned")
        return protect(
          "Interrupted cleanup or removed checkout; inspect on disk before retrying. No automatic retry." +
            (row.last_error ? ` ${row.last_error}` : ""),
        );
      const associatedRows = context.worktreePaths.filter((item) => item.root === root);
      if (
        associatedRows.some((item) => item.worktree.origin === "main") ||
        context.projectRoots.some((item) => contains(root, item.root))
      )
        return protect("Repository roots are always protected.");
      if (associatedRows.some(({ worktree }) => worktree.origin === "manual"))
        return protect("Adopted/manual worktrees are protected.");
      if (
        context.worktreePaths.some(
          (item) =>
            item.root &&
            item.root !== root &&
            (contains(root, item.root) || contains(item.root, root)),
        )
      )
        return protect("Checkout overlaps another worktree; protected.");
      if (associatedRows.length > 1) return protect("Shared worktree registrations are protected.");
      const associated = context.threadPaths.filter(
        (item) =>
          (item.root && contains(root, item.root)) ||
          (associatedRows[0] && item.thread.worktreeId === associatedRows[0].worktree.worktreeId),
      );
      const overlapping = context.threadPaths.filter(
        (item) =>
          (item.root && (contains(root, item.root) || contains(item.root, root))) ||
          associated.includes(item),
      );
      if (
        context.pendingStarts.some((pending) =>
          overlapping.some(({ thread }) => thread.id === pending.thread_id),
        )
      )
        return protect("An accepted turn start is pending provider readiness.");
      if (
        overlapping.some(
          ({ thread }) =>
            thread.goal?.synchronization?.state === "pending" &&
            !thread.goal.synchronization.deferUntilTurn,
        )
      )
        return protect("Provider goal synchronization is pending.");
      if (associated.length > 1)
        return protect("Shared worktrees with multiple historical sessions are protected.");
      if (
        overlapping.some(
          ({ thread }) =>
            !thread.archivedAt ||
            (thread.session && thread.session.status !== "stopped") ||
            workspaceSessionActive(thread) ||
            thread.hasPendingApprovals ||
            thread.hasPendingUserInput ||
            thread.hasActionableProposedPlan,
        )
      )
        return protect("Session must be archived and stopped, with no pending or background work.");
      if (
        context.bindingPaths.some(
          ({ binding, cwd }) =>
            binding.status !== "stopped" &&
            (!cwd ||
              contains(root, cwd) ||
              contains(cwd, root) ||
              overlapping.some(({ thread }) => thread.id === binding.threadId) ||
              !context.snapshot.threads.some((thread) => thread.id === binding.threadId)),
        )
      )
        return protect("Provider runtime is active or cannot be associated safely.");
      if (
        context.terminalPaths.some(
          ({ terminal, cwd, worktree }) =>
            (terminal.pid !== null ||
              terminal.status === "running" ||
              terminal.status === "starting" ||
              terminal.hasRunningSubprocess) &&
            (contains(root, cwd) ||
              contains(cwd, root) ||
              (worktree !== null && (contains(root, worktree) || contains(worktree, root))) ||
              associated.some(({ thread }) => thread.id === terminal.threadId)),
        )
      )
        return protect("A terminal or subprocess still uses this checkout.");
      // A checkout recreated after its thread was archived (Restore) starts a new clock:
      // the ledger's `created_at` is reset whenever Ryco creates the checkout again.
      const completedAt =
        row.category === "temporary"
          ? row.completed_at
          : later(associated[0]?.thread.archivedAt, row.created_at);
      if (!completedAt) return protect("Temporary staging has not been explicitly completed.");
      if (associated.length === 0 && Date.now() - Date.parse(row.created_at) < 86_400_000)
        return protect("New abandoned checkouts have a 24-hour safety grace period.");
      return {
        kind: "candidate",
        base,
        project,
        associated: associated.length > 0,
        completedAt,
      } satisfies Classification;
    });

  /** Apparent size for display only; protected rows are never eligible whatever it says. */
  const displaySize = (row: OwnedStorageRow, budget: ScanBudget) =>
    policy.assertExistingPath({ path: row.path, operation: "storage.scan" }).pipe(
      Effect.andThen(attempt(() => measureDirectory(row.path, budget))),
      Effect.orElseSucceed(() => UNKNOWN_SIZE),
    );

  /** Ownership, Git and filesystem checks that must hold right before a row is removed. */
  const safetyChecks = (
    row: OwnedStorageRow,
    project: Extract<Classification, { kind: "candidate" }>["project"],
  ) =>
    Effect.gen(function* () {
      yield* policy.assertExistingPath({ path: row.path, operation: "storage.cleanup" });
      yield* policy.assertExistingPath({
        path: project.workspaceRoot,
        operation: "storage.cleanup",
      });
      yield* attempt(() => assertCanonicalPath(row.path));
      if (row.category === "worktree") {
        if (!row.repository_path)
          return yield* new StorageError({ detail: "Ownership repository is missing." });
        const current = yield* attempt(() =>
          captureWorktreeIdentity(row.repository_path!, row.path),
        );
        if (JSON.stringify(current) !== row.identity_json)
          return yield* new StorageError({ detail: "Worktree ownership identity changed." });
        const registered = yield* git.listWorktreePaths(project.workspaceRoot);
        if (!registered.includes(row.path))
          return yield* new StorageError({
            detail: "Git no longer registers this exact checkout.",
          });
        yield* attempt(() => assertCleanWorktree(row.path, row.repository_path!));
      } else {
        const temporaryRoot = yield* attempt(() =>
          assertCanonicalPath(path.join(config.stateDir, "storage-temporary")),
        );
        if (path.dirname(row.path) !== temporaryRoot)
          return yield* new StorageError({
            detail: "Temporary data is outside Ryco's dedicated staging directory.",
          });
        const gitMarker = yield* attempt(() =>
          fs
            .lstat(path.join(row.path, ".git"))
            .then(() => true)
            .catch((cause) => {
              if (cause.code === "ENOENT") return false;
              throw cause;
            }),
        );
        if (gitMarker)
          return yield* new StorageError({
            detail: "Temporary directory contains a repository; protected.",
          });
      }
    });

  /** Completed staging data must still match the manifest pinned at completion. */
  const assertTemporaryUnchanged = (row: OwnedStorageRow, size: MeasuredSize) =>
    Effect.gen(function* () {
      const stat = yield* attempt(() => fs.lstat(row.path));
      const identity = yield* Effect.try({
        try: () =>
          JSON.parse(row.identity_json) as {
            device: number;
            inode: number;
            fingerprint?: string;
          },
        catch: failure,
      });
      if (
        identity.device !== stat.dev ||
        identity.inode !== stat.ino ||
        !identity.fingerprint ||
        identity.fingerprint !== size.fingerprint
      )
        return yield* new StorageError({
          detail: "Completed temporary data changed; external or unfinished work is protected.",
        });
    });

  /**
   * Whether a candidate can be removed now. The checks that need no traversal (ownership,
   * Git registration, the classified Git status, merge state) run first, so a checkout they
   * protect is never walked; then the whole tree is measured within `budget` and must be
   * complete, link-free and small enough for one quarantined removal. A spent `budget` (a
   * scan's shared one) refuses before any Git process starts, so it bounds those checks too.
   */
  const verify = (
    row: OwnedStorageRow,
    candidate: Extract<Classification, { kind: "candidate" }>,
    budget: ScanBudget,
  ) =>
    Effect.gen(function* () {
      const refuse = (reason: string, size: MeasuredSize | null = null): Refusal => ({
        eligible: false,
        reason,
        size,
      });
      const present = yield* policy
        .assertExistingPath({ path: row.path, operation: "storage.scan" })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!present) return refuse(UNAVAILABLE, UNKNOWN_SIZE);
      if (budget.remaining <= 0 || Date.now() >= budget.deadline) return refuse(INCOMPLETE);
      const unsafe = yield* safetyChecks(row, candidate.project).pipe(
        Effect.match({ onSuccess: () => null, onFailure: detail }),
      );
      if (unsafe) return refuse(unsafe);
      const size = yield* attempt(() =>
        measureDirectory(row.path, budget, new Set(), row.category === "temporary"),
      ).pipe(Effect.orElseSucceed(() => UNKNOWN_SIZE));
      if (size.sizeStatus === "unknown") return refuse(UNAVAILABLE, size);
      if (size.unsafe || size.sizeStatus !== "complete") return refuse(INCOMPLETE, size);
      if ((size.entries ?? 0) > MAX_QUARANTINE_REMOVAL_ENTRIES)
        return refuse(
          `Too many files to remove safely in one pass (more than ${MAX_QUARANTINE_REMOVAL_ENTRIES.toLocaleString("en-US")}).`,
          size,
        );
      if (row.category === "temporary") {
        const changed = yield* assertTemporaryUnchanged(row, size).pipe(
          Effect.match({ onSuccess: () => null, onFailure: detail }),
        );
        if (changed) return refuse(changed, size);
      }
      yield* sql`UPDATE storage_owned_entries SET project_id = ${candidate.base.projectId}, completed_at = ${candidate.completedAt} WHERE id = ${row.id}`;
      return {
        eligible: true,
        entry: {
          ...candidate.base,
          bytes: size.bytes,
          sizeStatus: size.sizeStatus,
          eligible: true,
          reason: candidate.associated
            ? "Archived, stopped session; owned and clean checkout."
            : "Abandoned Ryco-owned data; no session references this path.",
        },
      } satisfies Verification;
    });

  /**
   * The entry for a row: as verified, or protected. A refusal shows what verification measured;
   * with a `displayBudget` (scans) an unmeasured one is measured for display, else its size
   * stays unknown (preview and removal only need the verdict).
   */
  const presentEntry = (
    row: OwnedStorageRow,
    base: EntryBase,
    verdict: Verification,
    displayBudget: ScanBudget | null,
  ) =>
    verdict.eligible
      ? Effect.succeed(verdict.entry)
      : Effect.map(
          verdict.size
            ? Effect.succeed(verdict.size)
            : displayBudget
              ? displaySize(row, displayBudget)
              : Effect.succeed(UNKNOWN_SIZE),
          (measured): StorageEntry => ({
            ...base,
            bytes: measured.bytes,
            sizeStatus: measured.sizeStatus,
            eligible: false,
            reason: verdict.reason,
          }),
        );

  /** Classifies and verifies one row for preview and removal (no display measurement). */
  const inspect = (row: OwnedStorageRow, context: InventoryContext, budget: ScanBudget) =>
    Effect.gen(function* () {
      const classified = yield* classify(row, context);
      const verdict =
        classified.kind === "candidate"
          ? yield* verify(row, classified, budget)
          : classified.refusal;
      return yield* presentEntry(row, classified.base, verdict, null);
    });

  const scanInventory = (projectId?: ProjectId, cursor?: string) =>
    scanLock.withPermit(
      Effect.gen(function* () {
        const context = yield* inventory();
        const rows = yield* ownedRows(projectId, cursor);
        const budget = measurementBudget();
        const entries: StorageEntry[] = [];
        // A single shared budget bounds all node I/O. No startup scan, no repository globbing.
        // Candidates are verified first, so protected rows earlier in the ledger never use
        // the budget a removable one needs; protected rows are measured with what is left.
        const classified: { row: OwnedStorageRow; classification: Classification }[] = [];
        for (const row of rows.slice(0, 256)) {
          if (projectId && row.project_id && row.project_id !== projectId) continue;
          const classification = yield* classify(row, context);
          if (!projectId || classification.base.projectId === projectId)
            classified.push({ row, classification });
        }
        const verdicts: Verification[] = [];
        for (const { row, classification } of classified)
          verdicts.push(
            classification.kind === "candidate"
              ? yield* verify(row, classification, budget)
              : classification.refusal,
          );
        for (const [index, { row, classification }] of classified.entries())
          entries.push(yield* presentEntry(row, classification.base, verdicts[index]!, budget));
        const registeredOwnership = yield* sql<{
          path: string;
        }>`SELECT path FROM storage_owned_entries WHERE ${sql.in(
          "path",
          context.worktreePaths.slice(0, 256).flatMap((item) => (item.root ? [item.root] : [])),
        )}`;
        const registeredOwnershipPaths = new Set(registeredOwnership.map((row) => row.path));
        const accountingRows = yield* sql<{
          path: string;
        }>`SELECT path FROM storage_owned_entries WHERE state != 'removed' LIMIT 2049`;
        const accountingIncomplete = accountingRows.length > 2048;
        const ownedPaths = new Set([
          ...accountingRows.slice(0, 2048).map((row) => row.path),
          ...context.worktreePaths
            .map((item) => item.root)
            .filter((root): root is string => root !== null),
        ]);
        const extra = [
          ...context.projectRoots
            .slice(0, 128)
            .filter(({ project }) => !projectId || project.id === projectId)
            .map(({ project, root }) => ({
              id: `repository:${project.id}`,
              projectId: project.id,
              category: "repository" as const,
              label: project.title,
              path: root,
              reason:
                "Repository and git metadata are protected. Nested managed checkouts are counted separately.",
            })),
          ...context.worktreePaths
            .slice(0, 256)
            .filter(
              ({ worktree, root }) =>
                root &&
                !registeredOwnershipPaths.has(root) &&
                worktree.origin !== "main" &&
                (!projectId || worktree.projectId === projectId),
            )
            .map(({ worktree, root }) => ({
              id: `protected:${worktree.worktreeId}`,
              projectId: worktree.projectId,
              category: "worktree" as const,
              label: worktree.title ?? worktree.branch,
              path: root!,
              reason: "No durable Ryco creation record. Existing/adopted checkouts are protected.",
            })),
          ...(!projectId
            ? [
                {
                  id: "history",
                  projectId: null,
                  category: "history" as const,
                  label: "Node database and session history",
                  path: config.dbPath,
                  reason: "History, usage totals and provider archives are retained.",
                },
                {
                  id: "database-backups",
                  projectId: null,
                  category: "history" as const,
                  label: "Database backups",
                  path: databaseBackupsDirectory(config.dbPath),
                  reason: "Kept to undo an upgrade; the newest three are kept.",
                },
                {
                  id: "attachments",
                  projectId: null,
                  category: "attachments" as const,
                  label: "Persistent attachments",
                  path: config.attachmentsDir,
                  reason: "Persistent message attachments are protected.",
                },
                {
                  id: "task-files",
                  projectId: null,
                  category: "attachments" as const,
                  label: "Task files",
                  path: config.taskFilesDir,
                  reason: "Files kept with tasks are protected.",
                },
                {
                  id: "logs",
                  projectId: null,
                  category: "history" as const,
                  label: "Node logs",
                  path: config.logsDir,
                  reason: "Logs may contain session history; protected.",
                },
              ]
            : []),
        ];
        const measuredExtraPaths = new Set<string>();
        for (const entry of extra) {
          if (measuredExtraPaths.has(entry.path)) continue;
          measuredExtraPaths.add(entry.path);
          const protectedSource =
            ((entry.category === "repository" || entry.category === "worktree") &&
              context.protectedPaths?.some((root) => contains(root, entry.path))) ||
            (entry.category === "repository" && accountingIncomplete);
          const size = protectedSource
            ? UNKNOWN_SIZE
            : yield* policy
                .assertExistingPath({ path: entry.path, operation: "storage.scan" })
                .pipe(
                  Effect.andThen(
                    attempt(() =>
                      measureDirectory(
                        entry.path,
                        budget,
                        new Set([...ownedPaths, ...(context.protectedPaths ?? [])]),
                      ),
                    ),
                  ),
                  Effect.orElseSucceed(() => UNKNOWN_SIZE),
                );
          const shown = protectedSource ? size : yield* sizeOnDisk(entry, size);
          entries.push({
            ...entry,
            reason:
              entry.category === "repository" && accountingIncomplete
                ? entry.reason +
                  " Managed path exclusions exceed their bound; repository size is unavailable."
                : entry.reason,
            bytes: shown.bytes,
            sizeStatus: shown.sizeStatus,
            eligible: false,
          });
        }
        if (!projectId)
          entries.push({
            id: "archives-and-secrets",
            projectId: null,
            category: "protected",
            label: "User provider archives, credentials and other content",
            path: "",
            bytes: null,
            sizeStatus: "unknown",
            eligible: false,
            reason: "Outside the managed inventory; never scanned or removed.",
          });
        const scannedAt = new Date().toISOString();
        const omittedInventory =
          accountingIncomplete ||
          context.incomplete ||
          rows.length > 256 ||
          context.projectRoots.length > 128 ||
          context.worktreePaths.length > 256;
        const groups = new Set(entries.map((entry) => entry.projectId));
        for (const group of groups) {
          const groupEntries = entries.filter((entry) => entry.projectId === group);
          yield* sql`INSERT INTO storage_usage_history (sampled_at, project_id, measured_bytes, incomplete_entries)
        SELECT ${scannedAt}, ${group}, ${groupEntries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)}, ${groupEntries.filter((entry) => entry.sizeStatus !== "complete").length + (omittedInventory ? 1 : 0)}
        WHERE NOT EXISTS (SELECT 1 FROM storage_usage_history WHERE project_id IS ${group} AND sampled_at > ${new Date(Date.now() - 300_000).toISOString()})`;
        }
        const historyRows = yield* sql<{
          sampled_at: string;
          project_id: string | null;
          measured_bytes: number;
          incomplete_entries: number;
        }>`SELECT * FROM storage_usage_history WHERE (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null}) ORDER BY id DESC LIMIT 72`;
        return {
          scannedAt,
          entries,
          nextCursor: rows.length > 256 ? rows[255]!.id : null,
          truncated:
            accountingIncomplete ||
            context.incomplete ||
            rows.length > 256 ||
            context.projectRoots.length > 128 ||
            context.worktreePaths.length > 256 ||
            budget.remaining <= 0 ||
            Date.now() >= budget.deadline,
          history: historyRows.map((row) => ({
            sampledAt: row.sampled_at,
            projectId: row.project_id ? ProjectId.make(row.project_id) : null,
            measuredBytes: row.measured_bytes,
            incompleteEntries: row.incomplete_entries,
          })),
        } satisfies StorageSnapshot;
      }).pipe(Effect.mapError(failure)),
    );

  // On every page, not only the first: a page replaces the shown snapshot, and the report is a
  // few header reads. Retention passes do not scan (see `runRetention`), so only shown scans pay it.
  const scan = (projectId?: ProjectId, cursor?: string) =>
    scanInventory(projectId, cursor).pipe(
      Effect.flatMap((snapshot) =>
        deps.readDatabase
          ? Effect.map(deps.readDatabase, (database): StorageSnapshot => ({
              ...snapshot,
              database,
            }))
          : Effect.succeed(snapshot),
      ),
    );

  const preview = (principalKey: string, entryIds: readonly string[]) =>
    Effect.gen(function* () {
      if (entryIds.length < 1 || entryIds.length > 20)
        return yield* new StorageError({ detail: "Select between one and twenty entries." });
      const context = yield* inventory();
      const rows =
        yield* sql<OwnedStorageRow>`SELECT * FROM storage_owned_entries WHERE ${sql.in("id", entryIds)}`;
      const entries: StorageEntry[] = [];
      // Each entry gets its own budget, as at removal: entries selected from different scan
      // pages each fit their page's budget, not necessarily one shared one.
      for (const row of rows) entries.push(yield* inspect(row, context, measurementBudget()));
      if (
        new Set(entryIds).size !== entryIds.length ||
        entries.length !== entryIds.length ||
        entries.some((entry) => !entry.eligible)
      )
        return yield* new StorageError({
          detail: "Selection changed or contains protected data. Refresh and review again.",
        });
      const currentSettings = yield* settings.getSettings;
      const policies = entries.map((entry) =>
        resolveStorageRetentionPolicy(currentSettings, entry.projectId),
      );
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      yield* sql`DELETE FROM storage_cleanup_previews WHERE expires_at < ${new Date(Date.now() - 86_400_000).toISOString()}`;
      yield* sql`INSERT INTO storage_cleanup_previews (token, principal_key, expires_at, entries_json, policy_json, protected_paths_json) VALUES (${token}, ${principalKey}, ${expiresAt}, ${JSON.stringify(entries)}, ${JSON.stringify(policies)}, ${JSON.stringify({ sources: context.protectedSources, paths: context.protectedPaths })})`;
      return { token, expiresAt, entries } satisfies StorageCleanupPreview;
    }).pipe(Effect.mapError(failure));

  const remove = (
    entry: StorageEntry,
    approvedPolicy: StorageRetentionPolicy,
    automatic: boolean,
    approvedSources?: { sources: readonly string[]; paths: readonly string[] },
  ) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<OwnedStorageRow>`SELECT * FROM storage_owned_entries WHERE id = ${entry.id}`;
      const row = rows[0];
      if (!row || row.state !== "owned")
        return {
          id: entry.id,
          status: "protected" as const,
          detail: "Entry is no longer owned or cleanup was interrupted.",
        };
      const context = yield* inventory();
      if (
        approvedSources &&
        JSON.stringify(approvedSources) !==
          JSON.stringify({ sources: context.protectedSources, paths: context.protectedPaths })
      )
        return {
          id: entry.id,
          status: "protected" as const,
          detail: "Provider archive/source configuration changed. Preview again.",
        };
      const fresh = yield* inspect(row, context, measurementBudget());
      if (!fresh.eligible || fresh.path !== entry.path || fresh.projectId !== entry.projectId)
        return { id: entry.id, status: "protected" as const, detail: fresh.reason };
      let settingsLease: ReturnType<typeof acquireStorageSettingsLease> | null = null;
      const claimed = yield* storageLifecycleLock.withPermit(
        Effect.gen(function* () {
          if (hasStorageSettingsUpdateLease())
            return "Settings update is in progress. Review cleanup again after it completes.";
          if (yield* isWorktreeRelocationBlocked(sql, row.path))
            return "Checkout relocation is pending or complete; review the current workspace path.";
          if (hasWorktreeCreationLease(row.path))
            return "A worktree creation/hydration operation is still using this path.";
          // Only the sequence: no whole shell built while every command and lease waits.
          const current = yield* snapshots.getSnapshotSequence();
          const bindings = (yield* providers.listBindings()).filter(
            (binding) => binding.status !== "stopped",
          );
          const terminalRows = yield* terminals.listDiagnostics;
          const currentSettings = yield* settings.getSettings;
          const currentPolicy = resolveStorageRetentionPolicy(currentSettings, entry.projectId);
          const currentSources = yield* resolveProtectedSources(currentSettings);
          if (JSON.stringify(currentSources) !== JSON.stringify(context.protectedSources))
            return "Provider archive/source configuration changed. Preview again.";
          if (
            current.snapshotSequence !== context.snapshot.snapshotSequence ||
            JSON.stringify(bindings) !== JSON.stringify(context.bindings) ||
            JSON.stringify(terminalRows) !==
              JSON.stringify(context.terminalPaths.map((item) => item.terminal))
          )
            return "Lifecycle changed during inspection. Review again.";
          if (JSON.stringify(currentPolicy) !== JSON.stringify(approvedPolicy))
            return "Retention policy changed. Preview again.";
          const relevantThreads = context.threadPaths
            .filter(
              (item) =>
                item.root && (contains(row.path, item.root) || contains(item.root, row.path)),
            )
            .map((item) => item.thread.id);
          const pending = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM projection_turns WHERE state = 'pending' AND ${sql.in("thread_id", relevantThreads)} LIMIT 1`;
          if (pending.length) return "An accepted turn start is pending provider readiness.";
          const currentRows =
            yield* sql<OwnedStorageRow>`SELECT * FROM storage_owned_entries WHERE id = ${entry.id}`;
          if (
            currentRows[0]?.state !== "owned" ||
            currentRows[0].identity_json !== row.identity_json
          )
            return "Ownership changed during inspection.";
          if (
            automatic &&
            !retentionDue(currentPolicy, row.category, currentRows[0].completed_at!, Date.now())
          )
            return "Retention period has not elapsed.";
          yield* sql`UPDATE storage_owned_entries SET state = 'removing', last_error = NULL WHERE id = ${entry.id} AND state = 'owned'`;
          settingsLease = acquireStorageSettingsLease();
          yield* Effect.addFinalizer(() => Effect.sync(() => settingsLease!.release()));
          return null;
        }),
      );
      if (claimed) return { id: entry.id, status: "protected" as const, detail: claimed };
      // Persistent refusal state now owns this path. Long I/O runs outside the admission lock.
      // Normal turn/bootstrap/editor/terminal admissions all refuse this path until completion.
      const finalContext = yield* inventory();
      const revalidated = yield* inspect(row, finalContext, measurementBudget());
      const deletionManifest =
        row.category === "worktree"
          ? yield* attempt(() => measureDirectory(row.path, measurementBudget(), new Set(), true))
          : null;
      // Read authoritative settings AFTER the final filesystem inspection. Resolve
      // source declarations again, including aliases/missing leaves, under admission.
      const settingsRefusal = yield* storageLifecycleLock.withPermit(
        Effect.gen(function* () {
          const latestSettings = yield* settings.getSettings;
          const latestPolicy = resolveStorageRetentionPolicy(latestSettings, entry.projectId);
          const latestSources = yield* resolveProtectedSources(latestSettings).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (
            !latestSources ||
            latestSources.length > 256 ||
            JSON.stringify(latestSources) !== JSON.stringify(context.protectedSources) ||
            JSON.stringify(latestPolicy) !== JSON.stringify(approvedPolicy)
          )
            return "Policy or provider archive/source configuration changed before removal.";
          const latestPaths = yield* Effect.forEach(
            latestSources,
            (source) => attempt(() => canonical(source)),
            { concurrency: 4 },
          ).pipe(Effect.orElseSucceed(() => null));
          if (
            !latestPaths ||
            latestPaths.some((source) => contains(source, row.path) || contains(row.path, source))
          )
            return "Current provider archive/source paths protect this data.";
          const previousPaths = context.protectedPaths?.slice(0, latestSources.length);
          if (JSON.stringify(latestPaths) !== JSON.stringify(previousPaths))
            return "Provider archive/source path identity changed before removal.";
          return null;
        }),
      );
      if (
        !revalidated.eligible ||
        (row.category === "worktree" && !deletionManifest?.fingerprint) ||
        JSON.stringify(finalContext.protectedSources) !==
          JSON.stringify(context.protectedSources) ||
        JSON.stringify(finalContext.protectedPaths) !== JSON.stringify(context.protectedPaths) ||
        settingsRefusal !== null
      ) {
        yield* sql`UPDATE storage_owned_entries SET state = 'owned' WHERE id = ${entry.id} AND state = 'removing'`;
        return {
          id: entry.id,
          status: "protected" as const,
          detail: revalidated.eligible
            ? (settingsRefusal ??
              "Policy or provider archive/source configuration changed before removal.")
            : revalidated.reason,
        };
      }
      const quarantine = path.join(
        path.dirname(row.path),
        `.cleanup-${row.id}-${crypto.randomUUID()}`,
      );
      const identity = JSON.parse(row.identity_json) as WorktreeIdentity & { fingerprint?: string };
      // Persist recovery location before either category is moved. Original path
      // refusal survives restart; no interrupted batch repeats unknown deletion.
      yield* sql`UPDATE storage_owned_entries SET identity_json = ${JSON.stringify({ ...identity, quarantinePath: quarantine })} WHERE id = ${row.id} AND state = 'removing'`;
      const cleanupClaim =
        row.category === "worktree"
          ? yield* mintStorageCleanupClaim(sql, {
              id: row.id,
              repository: row.repository_path!,
              candidate: row.path,
              quarantine,
              fingerprint: deletionManifest!.fingerprint!,
              identity,
              lease: settingsLease!,
            })
          : null;
      const removal: Effect.Effect<void, GitCommandError | StorageError> =
        row.category === "worktree"
          ? git.removeWorktree({
              cwd: row.repository_path!,
              path: row.path,
              force: false,
              cleanup: {
                quarantinePath: quarantine,
                fingerprint: deletionManifest!.fingerprint!,
                identity,
                claim: cleanupClaim!,
                assertAdmission: () => settingsLease!.assertValid(),
              },
            })
          : attempt(() =>
              removeQuarantinedTemporaryDirectory(
                row.path,
                quarantine,
                identity.fingerprint!,
                undefined,
                () => settingsLease!.assertValid(),
              ),
            );
      const removed = yield* removal.pipe(
        Effect.uninterruptible,
        Effect.match({ onSuccess: () => null, onFailure: detail }),
      );
      if (removed) {
        yield* sql`UPDATE storage_owned_entries SET last_error = ${removed} WHERE id = ${entry.id}`;
        return { id: entry.id, status: "failed" as const, detail: removed };
      }
      yield* sql`UPDATE storage_owned_entries SET state = 'removed' WHERE id = ${entry.id}`;
      // Keep the workspace record truthful: it stays (with branch and path) as provenance.
      if (row.category === "worktree" && deps.recordCheckoutRemoval)
        yield* deps.recordCheckoutRemoval(row.path);
      return {
        id: entry.id,
        status: "removed" as const,
        detail:
          "Removed verified checkout/data. Git registration, branches, messages and historical usage are retained; Restore workspace checks a removed checkout out again.",
      };
    }).pipe(Effect.scoped, Effect.mapError(failure));

  const executeBatch = (principalKey: string, token: string) =>
    Effect.gen(function* () {
      // Claim once before filesystem changes. Interrupted executions stay inspectable, never replay deletion.
      const claimed = yield* storageLifecycleLock.withPermit(
        Effect.gen(function* () {
          const rows =
            yield* sql<PreviewRow>`SELECT * FROM storage_cleanup_previews WHERE token = ${token} AND principal_key = ${principalKey}`;
          const row = rows[0];
          if (!row)
            return yield* new StorageError({
              detail: "Preview belongs to another connection or is missing. Review again.",
            });
          if (row.result_json) {
            const recorded = Schema.decodeUnknownSync(StorageCleanupResult)(
              JSON.parse(row.result_json),
            );
            if (row.state !== "done") {
              const expected = Schema.decodeUnknownSync(StorageCleanupPreview.fields.entries)(
                JSON.parse(row.entries_json),
              );
              const results = [
                ...recorded.results,
                ...expected
                  .filter((entry) => !recorded.results.some((result) => result.id === entry.id))
                  .map((entry) => ({
                    id: entry.id,
                    status: "failed" as const,
                    detail:
                      "Batch interrupted before this result was recorded. No deletion is replayed; refresh and inspect.",
                  })),
              ];
              yield* sql`UPDATE storage_cleanup_previews SET result_json = ${JSON.stringify({ results })}, state = 'done' WHERE token = ${token}`;
              return { replay: { results }, row };
            }
            return { replay: recorded, row };
          }
          if (row.state !== "preview" || Date.parse(row.expires_at) <= Date.now())
            return yield* new StorageError({
              detail: "Preview expired or execution was interrupted. Refresh the inventory.",
            });
          yield* sql`UPDATE storage_cleanup_previews SET state = 'executing' WHERE token = ${token}`;
          return { replay: null, row };
        }),
      );
      if (claimed.replay) return claimed.replay;
      const entries = Schema.decodeUnknownSync(StorageCleanupPreview.fields.entries)(
        JSON.parse(claimed.row.entries_json),
      );
      const policies = Schema.decodeUnknownSync(Schema.Array(StorageRetentionPolicySchema))(
        JSON.parse(claimed.row.policy_json),
      );
      const protectedSources = Schema.decodeUnknownSync(
        Schema.Struct({ sources: Schema.Array(Schema.String), paths: Schema.Array(Schema.String) }),
      )(JSON.parse(claimed.row.protected_paths_json));
      const results: StorageCleanupResult["results"][number][] = [];
      for (const [index, entry] of entries.entries()) {
        if (Date.parse(claimed.row.expires_at) <= Date.now())
          results.push({
            id: entry.id,
            status: "protected",
            detail: "Preview expired before this removal. Review again.",
          });
        else
          results.push(
            yield* remove(entry, policies[index]!, false, protectedSources).pipe(
              Effect.catch((cause) =>
                Effect.succeed({ id: entry.id, status: "failed" as const, detail: cause.detail }),
              ),
            ),
          );
        // Persist each result so a process failure never turns a partial batch into a false success.
        yield* sql`UPDATE storage_cleanup_previews SET result_json = ${JSON.stringify({ results })} WHERE token = ${token}`;
      }
      yield* sql`UPDATE storage_cleanup_previews SET state = 'done' WHERE token = ${token}`;
      return { results } satisfies StorageCleanupResult;
    }).pipe(Effect.mapError(failure));

  // Same-process retries serialize per token; only a restarted/interrupted batch is finalized.
  const executions = new Map<string, { lock: Semaphore.Semaphore; users: number }>();
  const execute = (principalKey: string, token: string) =>
    Effect.suspend(() => {
      let active = executions.get(token);
      if (!active) {
        active = { lock: Semaphore.makeUnsafe(1), users: 0 };
        executions.set(token, active);
      }
      active.users++;
      const current = active;
      return current.lock.withPermit(executeBatch(principalKey, token)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (--current.users === 0) executions.delete(token);
          }),
        ),
      );
    });

  // Where the next retention pass continues in the ledger (by id); wraps to the start.
  let retentionCursor: string | undefined;
  /**
   * One retention pass. No inventory scan: classification needs no traversal, and each due
   * candidate is verified with its own fresh budget against the pass's inventory, so protected
   * or large rows earlier in the ledger never use up what a due one needs. Only eligible ones go
   * to `remove`, which takes a fresh inventory and verifies them again. A pass removes at most
   * 20 entries and verifies at most 64 due candidates; the next pass continues after the last
   * one it checked, so candidates that stay protected never keep the ones after them waiting.
   */
  const runRetention = Effect.gen(function* () {
    const currentSettings = yield* settings.getSettings;
    if (
      ![
        currentSettings.storageRetention,
        ...Object.values(currentSettings.projectStorageRetention),
      ].some((value) => value?.automatic)
    )
      return;
    const context = yield* inventory();
    let cursor = retentionCursor;
    let verified = 0;
    let removals = 0;
    // 8 pages of 256 rows: the ledger accounting bound (2,048 rows) per pass.
    for (let page = 0; page < 8; page++) {
      const rows = yield* ownedRows(undefined, cursor);
      for (const row of rows.slice(0, 256)) {
        cursor = row.id;
        const classified = yield* classify(row, context).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("storage retention could not classify an entry", cause),
          ),
          Effect.option,
        );
        if (Option.isNone(classified) || classified.value.kind !== "candidate") continue;
        const candidate = classified.value;
        const retention = resolveStorageRetentionPolicy(currentSettings, candidate.base.projectId);
        if (!retentionDue(retention, row.category, candidate.completedAt, Date.now())) continue;
        const verdict = yield* verify(row, candidate, measurementBudget()).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("storage retention could not verify an entry", cause),
          ),
          Effect.option,
        );
        if (Option.isSome(verdict) && verdict.value.eligible) {
          const status = yield* remove(verdict.value.entry, retention, true).pipe(
            Effect.map((result) => result.status),
            Effect.tapError((cause) =>
              Effect.logWarning("storage retention could not remove an entry", cause),
            ),
            Effect.orElseSucceed(() => "failed" as const),
          );
          // Only removals that started count toward the operation cap; refusals cost a check.
          if (status !== "protected") removals++;
        }
        if (++verified >= 64 || removals >= 20) {
          retentionCursor = cursor;
          return;
        }
      }
      if (rows.length <= 256) {
        cursor = undefined;
        break;
      }
    }
    retentionCursor = cursor;
  }).pipe(Effect.mapError(failure));

  /** Only this allocator makes temporary data eligible. Existing caches/archives are never adopted. */
  const createTemporaryDirectory = (projectId: ProjectId) =>
    storageLifecycleLock.withPermit(
      Effect.gen(function* () {
        const projects = yield* readProjectShells(snapshots);
        if (!projects.some((project) => project.id === projectId))
          return yield* new StorageError({ detail: "Project not available." });
        const root = path.join(config.stateDir, "storage-temporary");
        yield* attempt(() => fs.mkdir(root, { recursive: true }));
        yield* attempt(() => assertCanonicalPath(root));
        const target = yield* attempt(() => fs.mkdtemp(path.join(root, "staging-")));
        const stat = yield* attempt(() => fs.lstat(target));
        const id = crypto.randomUUID();
        yield* sql`INSERT INTO storage_owned_entries (id, path, project_id, category, identity_json, created_at, state) VALUES (${id}, ${target}, ${projectId}, 'temporary', ${JSON.stringify({ device: stat.dev, inode: stat.ino })}, ${new Date().toISOString()}, 'in_use')`;
        return { id, path: target };
      }).pipe(Effect.mapError(failure)),
    );
  const completeTemporaryDirectory = (id: string) =>
    storageLifecycleLock.withPermit(
      Effect.gen(function* () {
        const rows =
          yield* sql<OwnedStorageRow>`SELECT * FROM storage_owned_entries WHERE id = ${id} AND category = 'temporary' AND state = 'in_use'`;
        const row = rows[0];
        if (!row) return yield* new StorageError({ detail: "Staging allocation is not in use." });
        yield* attempt(() => assertCanonicalPath(row.path));
        const stat = yield* attempt(() => fs.lstat(row.path));
        if (JSON.stringify({ device: stat.dev, inode: stat.ino }) !== row.identity_json)
          return yield* new StorageError({ detail: "Staging allocation identity changed." });
        const size = yield* attempt(() =>
          measureDirectory(row.path, measurementBudget(), new Set(), true),
        );
        if (size.unsafe || size.sizeStatus !== "complete" || !size.fingerprint)
          return yield* new StorageError({
            detail: "Staging completion cannot establish a bounded, complete ownership manifest.",
          });
        yield* sql`UPDATE storage_owned_entries SET state = 'owned', completed_at = ${new Date().toISOString()}, identity_json = ${JSON.stringify({ device: stat.dev, inode: stat.ino, fingerprint: size.fingerprint })} WHERE id = ${id}`;
      }).pipe(Effect.mapError(failure)),
    );
  return {
    scan,
    preview,
    execute,
    runRetention,
    createTemporaryDirectory,
    completeTemporaryDirectory,
  };
}

// Import alias avoids conflating the value schema with the policy TypeScript type above.
import { StorageRetentionPolicy as StorageRetentionPolicySchema } from "@ryco/contracts";
export class StorageService extends Context.Service<
  StorageService,
  ReturnType<typeof makeStorageService>
>()("ryco/storage/StorageService") {}
export const StorageServiceLive = Layer.effect(
  StorageService,
  Effect.gen(function* () {
    const protection = yield* Effect.serviceOption(ProviderProtectedPaths);
    const engine = yield* Effect.serviceOption(OrchestrationEngineService);
    const snapshots = yield* ProjectionSnapshotQuery;
    const recordCheckoutRemoval = (checkoutPath: string) =>
      Option.match(engine, {
        onNone: () => Effect.void,
        onSome: (orchestration) =>
          Effect.gen(function* () {
            const { worktrees } = yield* readWorkspacePlacement(snapshots);
            const canonicalRemoved = yield* attempt(() => canonical(checkoutPath));
            for (const worktree of worktrees) {
              if (worktree.worktreePath === null || worktree.checkoutRemovedAt != null) continue;
              const candidate = yield* attempt(() => canonical(worktree.worktreePath!)).pipe(
                Effect.orElseSucceed(() => worktree.worktreePath!),
              );
              if (candidate !== canonicalRemoved) continue;
              yield* orchestration.dispatch({
                type: "worktree.checkout.remove",
                commandId: CommandId.make(
                  `storage-cleanup:${worktree.worktreeId}:${crypto.randomUUID()}`,
                ),
                worktreeId: worktree.worktreeId,
                reason: "removed",
                removedAt: new Date().toISOString(),
              });
            }
          }).pipe(Effect.ignore({ log: true })),
      });
    const databaseServices = yield* Effect.context<
      SqlClient.SqlClient | ServerConfig | FileSystem.FileSystem | EventLogCompaction
    >();
    const service = makeStorageService({
      recordCheckoutRemoval,
      // The report (and the doctor suggestion in it) loads when Storage settings first ask, which
      // keeps it off the server's boot path (serverBundleBoundaries.test.ts).
      readDatabase: Effect.promise(() => import("../persistence/databaseStorageReport.ts")).pipe(
        Effect.flatMap((report) => report.readDatabaseStorageReport()),
        Effect.provideContext(databaseServices),
      ),
      providerProtection: Option.getOrElse(protection, () => ({ resolve: () => null })),
      sql: yield* SqlClient.SqlClient,
      config: yield* ServerConfig,
      settings: yield* ServerSettingsService,
      snapshots: yield* ProjectionSnapshotQuery,
      providers: yield* ProviderSessionDirectory,
      terminals: yield* TerminalManager,
      policy: yield* WorkspaceAccessPolicy,
      git: yield* GitWorkflowService,
    });
    // Sleep first: no filesystem traversal on startup, and disabled installs do no traversal at all.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep("1 hour").pipe(
          Effect.andThen(service.runRetention),
          Effect.ignore({ log: true }),
        ),
      ),
    );
    return service;
  }),
);
