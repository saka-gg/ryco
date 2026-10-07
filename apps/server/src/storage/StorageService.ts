import { mintStorageCleanupClaim } from "./cleanupClaim.ts";
import { readPersistedCwd } from "../provider/runtimeCwd.ts";
import { ProviderProtectedPaths, type ProviderProtectedPathsShape } from "./providerProtection.ts";
import { workspaceSessionActive } from "../workspace/lifecycleSafety.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
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
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
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
const canonical = canonicalStoragePath;
const contains = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export function makeStorageService(deps: {
  sql: SqlClient.SqlClient;
  config: ServerConfigShape;
  settings: Pick<ServerSettingsShape, "getSettings">;
  snapshots: Pick<ProjectionSnapshotQueryShape, "getShellSnapshot">;
  providers: Pick<ProviderSessionDirectoryShape, "listBindings">;
  terminals: Pick<TerminalManagerShape, "listDiagnostics">;
  providerProtection: ProviderProtectedPathsShape;
  policy: WorkspaceAccessPolicyShape;
  git: Pick<GitWorkflowServiceShape, "removeWorktree" | "listWorktreePaths">;
  /** Records a removed checkout on its workspace record (shared lifecycle state). */
  recordCheckoutRemoval?: (checkoutPath: string) => Effect.Effect<void>;
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
        config.attachmentsDir,
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

  const inspect = (
    row: OwnedStorageRow,
    context: Effect.Success<ReturnType<typeof inventory>>,
    budget: ScanBudget,
    alreadyMeasured?: MeasuredSize,
  ) =>
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
      const base = {
        id: row.id,
        projectId,
        category: row.category,
        label: path.basename(row.path),
        path: row.path,
      };
      const providerReason = !context.protectedPaths
        ? "Provider history/export locations could not be verified on this node; cleanup is protected."
        : context.protectedPaths.some(
              (protectedPath) => contains(root, protectedPath) || contains(protectedPath, root),
            )
          ? "Checkout/data overlaps a declared provider archive, export, home or credential location; protected."
          : null;
      if (providerReason)
        return {
          ...base,
          bytes: null,
          sizeStatus: "unknown",
          eligible: false,
          reason: providerReason,
        } satisfies StorageEntry;
      const size: MeasuredSize =
        alreadyMeasured ??
        (yield* policy.assertExistingPath({ path: row.path, operation: "storage.scan" }).pipe(
          Effect.andThen(
            attempt(() =>
              measureDirectory(row.path, budget, new Set(), row.category === "temporary"),
            ),
          ),
          Effect.orElseSucceed(() => ({
            bytes: null,
            sizeStatus: "unknown" as const,
            unsafe: true,
          })),
        ));
      const protect = (reason: string): StorageEntry => ({
        ...base,
        bytes: size.bytes,
        sizeStatus: size.sizeStatus,
        eligible: false,
        reason,
      });
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
      if (size.sizeStatus === "unknown")
        return protect("Path is unavailable or unreadable; size and safety are unknown.");
      if (size.unsafe || size.sizeStatus !== "complete")
        return protect(
          "Scan budget, symbolic link, mount or unreadable entry prevents a complete safety check.",
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
      const completedAt =
        row.category === "temporary"
          ? row.completed_at
          : (associated[0]?.thread.archivedAt ?? row.created_at);
      if (!completedAt) return protect("Temporary staging has not been explicitly completed.");
      if (associated.length === 0 && Date.now() - Date.parse(row.created_at) < 86_400_000)
        return protect("New abandoned checkouts have a 24-hour safety grace period.");
      const safety = yield* Effect.gen(function* () {
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
        }
      }).pipe(Effect.match({ onSuccess: () => null, onFailure: detail }));
      if (safety) return protect(safety);
      yield* sql`UPDATE storage_owned_entries SET project_id = ${projectId}, completed_at = ${completedAt} WHERE id = ${row.id}`;
      return {
        ...base,
        bytes: size.bytes,
        sizeStatus: size.sizeStatus,
        eligible: true,
        reason: associated.length
          ? "Archived, stopped session; owned and clean checkout."
          : "Abandoned Ryco-owned data; no session references this path.",
      } satisfies StorageEntry;
    });

  const scan = (projectId?: ProjectId, cursor?: string) =>
    scanLock.withPermit(
      Effect.gen(function* () {
        const context = yield* inventory();
        const rows = yield* ownedRows(projectId, cursor);
        const budget = { remaining: 30_000, deadline: Date.now() + 3000 };
        const entries: StorageEntry[] = [];
        // A single shared budget bounds all node I/O. No startup scan, no repository globbing.
        for (const row of rows.slice(0, 256)) {
          if (projectId && row.project_id && row.project_id !== projectId) continue;
          const entry = yield* inspect(row, context, budget);
          if (!projectId || entry.projectId === projectId) entries.push(entry);
        }
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
                  id: "attachments",
                  projectId: null,
                  category: "attachments" as const,
                  label: "Persistent attachments",
                  path: config.attachmentsDir,
                  reason: "Persistent message attachments are protected.",
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
            ? { bytes: null, sizeStatus: "unknown" as const, unsafe: true }
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
                  Effect.orElseSucceed(() => ({
                    bytes: null,
                    sizeStatus: "unknown" as const,
                    unsafe: true,
                  })),
                );
          entries.push({
            ...entry,
            reason:
              entry.category === "repository" && accountingIncomplete
                ? entry.reason +
                  " Managed path exclusions exceed their bound; repository size is unavailable."
                : entry.reason,
            bytes: size.bytes,
            sizeStatus: size.sizeStatus,
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

  const preview = (principalKey: string, entryIds: readonly string[]) =>
    Effect.gen(function* () {
      if (entryIds.length < 1 || entryIds.length > 20)
        return yield* new StorageError({ detail: "Select between one and twenty entries." });
      const context = yield* inventory();
      const rows =
        yield* sql<OwnedStorageRow>`SELECT * FROM storage_owned_entries WHERE ${sql.in("id", entryIds)}`;
      const entries: StorageEntry[] = [];
      const budget = { remaining: 30_000, deadline: Date.now() + 3000 };
      for (const row of rows) entries.push(yield* inspect(row, context, budget));
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
      const fresh = yield* inspect(row, context, {
        remaining: 30_000,
        deadline: Date.now() + 3000,
      });
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
          const current = yield* snapshots.getShellSnapshot();
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
      const revalidated = yield* inspect(row, finalContext, {
        remaining: 30_000,
        deadline: Date.now() + 3000,
      });
      const deletionManifest =
        row.category === "worktree"
          ? yield* attempt(() =>
              measureDirectory(
                row.path,
                { remaining: 30_000, deadline: Date.now() + 3000 },
                new Set(),
                true,
              ),
            )
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
          "Removed verified checkout/data. Git registration, branches, messages and historical usage are retained; missing registrations may be pruned explicitly.",
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

  let retentionCursor: string | undefined;
  const runRetention = Effect.gen(function* () {
    const currentSettings = yield* settings.getSettings;
    if (
      ![
        currentSettings.storageRetention,
        ...Object.values(currentSettings.projectStorageRetention),
      ].some((value) => value?.automatic)
    )
      return;
    const snapshot = yield* scan(undefined, retentionCursor);
    retentionCursor = snapshot.nextCursor ?? undefined;
    const rows = yield* sql<OwnedStorageRow>`SELECT * FROM storage_owned_entries WHERE ${sql.in(
      "id",
      snapshot.entries.filter((entry) => entry.eligible).map((entry) => entry.id),
    )}`;
    for (const entry of snapshot.entries
      .filter((entry) => {
        const row = rows.find((row) => row.id === entry.id);
        return (
          entry.eligible &&
          row?.completed_at &&
          retentionDue(
            resolveStorageRetentionPolicy(currentSettings, entry.projectId),
            row.category,
            row.completed_at,
            Date.now(),
          )
        );
      })
      .slice(0, 20)) {
      yield* remove(
        entry,
        resolveStorageRetentionPolicy(currentSettings, entry.projectId),
        true,
      ).pipe(Effect.ignore({ log: true }));
    }
  }).pipe(Effect.mapError(failure));

  /** Only this allocator makes temporary data eligible. Existing caches/archives are never adopted. */
  const createTemporaryDirectory = (projectId: ProjectId) =>
    storageLifecycleLock.withPermit(
      Effect.gen(function* () {
        const snapshot = yield* snapshots.getShellSnapshot();
        if (!snapshot.projects.some((project) => project.id === projectId))
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
          measureDirectory(
            row.path,
            { remaining: 30_000, deadline: Date.now() + 3000 },
            new Set(),
            true,
          ),
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
            const snapshot = yield* snapshots.getShellSnapshot();
            const canonicalRemoved = yield* attempt(() => canonical(checkoutPath));
            for (const worktree of snapshot.worktrees ?? []) {
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
    const service = makeStorageService({
      recordCheckoutRemoval,
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
