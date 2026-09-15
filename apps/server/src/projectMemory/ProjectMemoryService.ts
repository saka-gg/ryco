import { createHash } from "node:crypto";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  ProjectMemoryEntry,
  ProjectMemoryError,
  ProjectMemoryMutateInput,
  ProjectMemoryRecallInput,
  ProjectMemoryListInput,
  ProjectMemoryScope,
  PROJECT_MEMORY_CAP,
  PROJECT_MEMORY_PAGE_SIZE,
  type ProjectMemoryExport,
  type ProjectMemoryPage,
  type ProjectMemoryProvenance,
  type ProjectMemoryRecallPreview,
} from "@ryco/contracts";
import {
  projectMemoryBytes,
  projectMemoryEnvelopeFits,
  projectMemoryNeedsReview,
  projectMemoryTextProblem,
  renderProjectMemoryEnvelope,
} from "@ryco/shared/projectMemory";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";

const processOwner = crypto.randomUUID();
const activeSubmissions = new Set<string>();
const finalizedSubmissions = new Set<string>();
export const MemoryRuntimeIdentity = Schema.Struct({
  threadId: ThreadId,
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  runtimeSessionId: RuntimeSessionId,
});
export type MemoryRuntimeIdentity = typeof MemoryRuntimeIdentity.Type;

const failure = (reason: ProjectMemoryError["reason"], message: string) =>
  new ProjectMemoryError({ reason, message });
const unavailable = () =>
  failure("unavailable", "Project memory is unavailable. Please reconnect and retry.");
const conflict = () =>
  failure("conflict", "Memory changed. Refresh and review before trying again.");
const decodeEntry = Schema.decodeUnknownEffect(ProjectMemoryEntry);
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => failure("invalid", "Invalid project memory request.")),
  );

export interface ProjectMemoryServiceShape {
  readonly recoverSubmissions: (
    stopRuntime: (runtime: MemoryRuntimeIdentity) => Effect.Effect<void, ProjectMemoryError>,
  ) => Effect.Effect<void, ProjectMemoryError>;
  readonly submitRecall: <A, E, R>(
    input: ProjectMemoryRecallInput & {
      readonly threadId: string;
      readonly runtime: MemoryRuntimeIdentity;
    },
    authorize: Effect.Effect<void, ProjectMemoryError>,
    submit: (envelope: string) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProjectMemoryError, R>;
  readonly list: (
    input: typeof ProjectMemoryListInput.Type,
  ) => Effect.Effect<ProjectMemoryPage, ProjectMemoryError>;
  readonly mutate: (
    input: ProjectMemoryMutateInput,
    authenticatedActor: string,
  ) => Effect.Effect<{ revision: number }, ProjectMemoryError>;
  readonly preview: (
    input: ProjectMemoryRecallInput,
  ) => Effect.Effect<ProjectMemoryRecallPreview, ProjectMemoryError>;
  readonly export: (
    input: typeof ProjectMemoryScope.Type,
  ) => Effect.Effect<ProjectMemoryExport, ProjectMemoryError>;
}
export class ProjectMemoryService extends Context.Service<
  ProjectMemoryService,
  ProjectMemoryServiceShape
>()("ryco/ProjectMemoryService") {}

/** Node-owned state. Every operation checks the project against the existing workspace policy. */
export const ProjectMemoryServiceLive = Layer.effect(
  ProjectMemoryService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const access = yield* WorkspaceAccessPolicy;
    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((error) => (Schema.is(ProjectMemoryError)(error) ? error : unavailable())),
      );
    const authorizeProject = (projectId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          workspaceRoot: string;
        }>`SELECT workspace_root AS "workspaceRoot" FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`;
        if (!rows[0]) return yield* Effect.fail(failure("notFound", "Project is unavailable."));
        yield* access.assertPath({ path: rows[0].workspaceRoot, operation: "project memory" });
      });
    const readSettings = (projectId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          enabled: number;
          revision: number;
        }>`SELECT enabled, revision FROM project_memory_settings WHERE project_id = ${projectId}`;
        return { enabled: rows[0]?.enabled === 1, revision: rows[0]?.revision ?? 0 };
      });
    // The database cap bounds decoding, filtering, ordering and export work to 200 rows.
    const readEntries = (projectId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
          projectId: string;
          kind: string;
          text: string;
          revision: number;
          pinned: number;
          createdAt: string;
          updatedAt: string;
          affirmedAt: string;
          provenanceJson: string;
        }>`
      SELECT id, project_id AS "projectId", kind, text, revision, pinned, created_at AS "createdAt", updated_at AS "updatedAt", affirmed_at AS "affirmedAt", provenance_json AS "provenanceJson"
      FROM project_memories WHERE project_id = ${projectId} ORDER BY pinned DESC, updated_at DESC, id LIMIT 201`;
        if (rows.length > PROJECT_MEMORY_CAP) return yield* Effect.fail(unavailable());
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const provenance = yield* Effect.try({
              try: () => JSON.parse(row.provenanceJson),
              catch: unavailable,
            });
            const entry = yield* decodeEntry({ ...row, pinned: row.pinned === 1, provenance });
            if (projectMemoryTextProblem(entry.text)) return yield* Effect.fail(unavailable());
            return entry;
          }),
        );
      });
    const validateText = (text: string) => {
      const problem = projectMemoryTextProblem(text);
      return problem
        ? Effect.fail(
            failure(
              problem,
              problem === "sensitive"
                ? "Do not save credentials, operational URLs, or private Hub details."
                : "Use 1–500 Unicode characters and at most 2 KiB of plain text.",
            ),
          )
        : Effect.void;
    };
    const list: ProjectMemoryServiceShape["list"] = (input) =>
      protect(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* decode(ProjectMemoryListInput, input);
            yield* authorizeProject(input.projectId);
            const settings = yield* readSettings(input.projectId);
            const entries = yield* readEntries(input.projectId);
            const query = input.query.trim().toLocaleLowerCase();
            const matched = entries.filter(
              (entry) => !query || entry.text.toLocaleLowerCase().includes(query),
            );
            const page = matched.slice(input.offset, input.offset + PROJECT_MEMORY_PAGE_SIZE);
            return {
              ...settings,
              entries: page,
              total: entries.length,
              matched: matched.length,
              nextOffset:
                input.offset + page.length < matched.length ? input.offset + page.length : null,
              asOf: new Date(yield* Clock.currentTimeMillis).toISOString(),
            };
          }),
        ),
      );
    const retryFinalizedCleanup = (projectId: string) =>
      Effect.gen(function* () {
        const claims = yield* sql<{
          id: string;
        }>`SELECT dispatch_id AS id FROM project_memory_settings WHERE project_id = ${projectId} AND dispatch_id IS NOT NULL`;
        for (const claim of claims) {
          if (!finalizedSubmissions.has(claim.id)) continue;
          yield* sql`UPDATE project_memory_settings SET dispatch_id = NULL, dispatch_thread_id = NULL, dispatch_owner_pid = NULL, dispatch_owner = NULL, dispatch_runtime_json = NULL WHERE project_id = ${projectId} AND dispatch_id = ${claim.id}`;
          finalizedSubmissions.delete(claim.id);
        }
      });
    const mutate: ProjectMemoryServiceShape["mutate"] = (input, authenticatedActor) =>
      protect(
        retryFinalizedCleanup(input.projectId).pipe(
          Effect.andThen(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* decode(ProjectMemoryMutateInput, input);
                yield* authorizeProject(input.projectId);
                const { mutation, projectId } = input;
                const settings = yield* readSettings(projectId);
                const gates = yield* sql<{
                  dispatchId: string | null;
                }>`SELECT dispatch_id AS "dispatchId" FROM project_memory_settings WHERE project_id = ${projectId}`;
                if (gates[0]?.dispatchId)
                  return yield* Effect.fail(
                    failure(
                      "conflict",
                      "Memory submission has begun and may already be delivered. Retry the change after submission finishes.",
                    ),
                  );
                if (settings.revision !== input.expectedRevision)
                  return yield* Effect.fail(conflict());
                if (
                  !settings.enabled &&
                  mutation.operation !== "enable" &&
                  mutation.operation !== "deleteAll" &&
                  mutation.operation !== "forget"
                )
                  return yield* Effect.fail(
                    failure("disabled", "Enable project memory before saving or changing entries."),
                  );
                const now = new Date(yield* Clock.currentTimeMillis).toISOString();
                const revision = settings.revision + 1;
                // This monotonically increasing revision survives forget/deleteAll. A retried old create cannot resurrect text.
                yield* sql`INSERT INTO project_memory_settings(project_id,enabled,revision) VALUES(${projectId},0,0) ON CONFLICT(project_id) DO NOTHING`;
                const claimed =
                  yield* sql`UPDATE project_memory_settings SET revision = ${revision} WHERE project_id = ${projectId} AND revision = ${input.expectedRevision} RETURNING project_id`;
                if (claimed.length !== 1) return yield* Effect.fail(conflict());
                if (mutation.operation === "enable") {
                  yield* sql`UPDATE project_memory_settings SET enabled = ${mutation.enabled ? 1 : 0} WHERE project_id = ${projectId}`;
                } else if (mutation.operation === "deleteAll") {
                  yield* sql`DELETE FROM project_memories WHERE project_id = ${projectId}`;
                  yield* sql`UPDATE project_memory_settings SET enabled = 0 WHERE project_id = ${projectId}`;
                } else if (mutation.operation === "create") {
                  yield* validateText(mutation.text);
                  const counts = yield* sql<{
                    count: number;
                  }>`SELECT count(*) AS count FROM project_memories WHERE project_id = ${projectId}`;
                  if ((counts[0]?.count ?? 0) >= PROJECT_MEMORY_CAP)
                    return yield* Effect.fail(
                      failure(
                        "capacity",
                        "Project memory is full (200 entries). Forget an entry first.",
                      ),
                    );
                  const existing =
                    yield* sql`SELECT id FROM project_memories WHERE project_id = ${projectId} AND id = ${mutation.id}`;
                  if (existing.length) return yield* Effect.fail(conflict());
                  const provenance: ProjectMemoryProvenance = {
                    kind: "user",
                    actorId: createHash("sha256")
                      .update(`ryco-project-memory:${projectId}:${authenticatedActor}`)
                      .digest("hex"),
                    ...(mutation.source ? { source: mutation.source } : {}),
                  };
                  if (mutation.source) {
                    const sources =
                      yield* sql`SELECT m.message_id FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id = m.thread_id WHERE m.message_id = ${mutation.source.messageId} AND t.thread_id = ${mutation.source.threadId} AND t.project_id = ${projectId} AND t.deleted_at IS NULL AND m.role IN ('user','assistant')`;
                    if (!sources.length)
                      return yield* Effect.fail(
                        failure("notFound", "Source message does not belong to this project."),
                      );
                  }
                  yield* sql`INSERT INTO project_memories(id,project_id,kind,text,revision,pinned,created_at,updated_at,affirmed_at,provenance_json)
        VALUES(${mutation.id},${projectId},${mutation.kind},${mutation.text},${revision},0,${now},${now},${now},${JSON.stringify(provenance)})`;
                } else {
                  const existing =
                    yield* sql`SELECT id FROM project_memories WHERE project_id = ${projectId} AND id = ${mutation.id} AND revision = ${mutation.revision}`;
                  if (!existing.length) return yield* Effect.fail(conflict());
                  switch (mutation.operation) {
                    case "forget":
                      yield* sql`DELETE FROM project_memories WHERE project_id = ${projectId} AND id = ${mutation.id}`;
                      break;
                    case "edit":
                      yield* validateText(mutation.text);
                      yield* sql`UPDATE project_memories SET text = ${mutation.text}, kind = ${mutation.kind}, revision = ${revision}, updated_at = ${now} WHERE project_id = ${projectId} AND id = ${mutation.id}`;
                      break;
                    case "pin":
                      yield* sql`UPDATE project_memories SET pinned = ${mutation.pinned ? 1 : 0}, revision = ${revision}, updated_at = ${now} WHERE project_id = ${projectId} AND id = ${mutation.id}`;
                      break;
                    case "affirm":
                      yield* sql`UPDATE project_memories SET affirmed_at = ${now}, revision = ${revision}, updated_at = ${now} WHERE project_id = ${projectId} AND id = ${mutation.id}`;
                      break;
                  }
                }
                return { revision };
              }),
            ),
          ),
        ),
      );
    const preview: ProjectMemoryServiceShape["preview"] = (input) =>
      protect(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* decode(ProjectMemoryRecallInput, input);
            yield* authorizeProject(input.projectId);
            if (!(yield* readSettings(input.projectId)).enabled)
              return yield* Effect.fail(failure("disabled", "Project memory is disabled."));
            if (new Set(input.references.map((ref) => ref.id)).size !== input.references.length)
              return yield* Effect.fail(failure("invalid", "Choose each memory only once."));
            const all = yield* readEntries(input.projectId);
            const now = yield* Clock.currentTimeMillis;
            const entries = yield* Effect.forEach(input.references, (ref) =>
              Effect.gen(function* () {
                const entry = all.find((item) => item.id === ref.id);
                if (!entry || entry.revision !== ref.revision)
                  return yield* Effect.fail(conflict());
                if (projectMemoryNeedsReview(entry, now))
                  return yield* Effect.fail(
                    failure("expired", "Affirm or pin memories that need review before recall."),
                  );
                return entry;
              }),
            );
            if (!projectMemoryEnvelopeFits(entries))
              return yield* Effect.fail(
                failure(
                  "envelopeTooLarge",
                  "Selected memories exceed 16 KiB. Select fewer entries.",
                ),
              );
            return {
              entries,
              envelopeBytes: projectMemoryBytes(renderProjectMemoryEnvelope(entries)),
            };
          }),
        ),
      );
    const exportEntries: ProjectMemoryServiceShape["export"] = (input) =>
      protect(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* decode(ProjectMemoryScope, input);
            yield* authorizeProject(input.projectId);
            return {
              version: 1 as const,
              projectId: input.projectId,
              enabled: (yield* readSettings(input.projectId)).enabled,
              exportedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
              entries: yield* readEntries(input.projectId),
            };
          }),
        ),
      );
    const submitRecall: ProjectMemoryServiceShape["submitRecall"] = (input, authorize, submit) => {
      const dispatchId = crypto.randomUUID();
      const acquire = protect(
        retryFinalizedCleanup(input.projectId).pipe(
          Effect.andThen(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* decode(MemoryRuntimeIdentity, input.runtime);
                if (input.runtime.threadId !== input.threadId)
                  return yield* Effect.fail(conflict());
                yield* authorize;
                const threads =
                  yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId} AND deleted_at IS NULL`;
                if (!threads.length)
                  return yield* Effect.fail(
                    failure("notFound", "Recall does not belong to this thread's project."),
                  );
                const claimed =
                  yield* sql`UPDATE project_memory_settings SET dispatch_id = ${dispatchId}, dispatch_thread_id = ${input.threadId}, dispatch_owner_pid = ${process.pid}, dispatch_owner = ${processOwner}, dispatch_runtime_json = ${JSON.stringify(input.runtime)}
        WHERE project_id = ${input.projectId} AND dispatch_id IS NULL RETURNING project_id`;
                if (!claimed.length) return yield* Effect.fail(conflict());
                const resolved = yield* preview(input);
                return renderProjectMemoryEnvelope(resolved.entries);
              }),
            ),
          ),
        ),
      );
      // No clock-based takeover: timeout requests cancellation, but exclusion lasts until the
      // submission fiber has actually finalized. Crash recovery must prove the prior owner gone.
      return Effect.acquireUseRelease(
        acquire,
        (envelope) =>
          Effect.gen(function* () {
            activeSubmissions.add(dispatchId);
            const current = yield* protect(
              sql`SELECT project_id FROM project_memory_settings WHERE project_id = ${input.projectId} AND dispatch_id = ${dispatchId} AND dispatch_owner = ${processOwner}`,
            );
            if (current.length !== 1) return yield* Effect.fail(conflict());
            yield* authorize;
            return yield* submit(envelope).pipe(
              Effect.timeout("30 seconds"),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  failure(
                    "unavailable",
                    "Memory submission timed out; delivery may have begun. Ryco will not retry it automatically.",
                  ),
                ),
              ),
            );
          }),
        () =>
          Effect.gen(function* () {
            // Positive local evidence is recorded only after the submission use fiber finalized.
            activeSubmissions.delete(dispatchId);
            finalizedSubmissions.add(dispatchId);
            yield* retryFinalizedCleanup(input.projectId).pipe(Effect.ignore);
          }),
      );
    };
    const recoverSubmissions: ProjectMemoryServiceShape["recoverSubmissions"] = (stopRuntime) =>
      protect(
        Effect.gen(function* () {
          const claims = yield* sql<{
            projectId: string;
            dispatchId: string;
            threadId: string;
            ownerPid: number;
            owner: string;
            runtimeJson: string;
          }>`SELECT project_id AS "projectId", dispatch_id AS "dispatchId", dispatch_thread_id AS "threadId", dispatch_owner_pid AS "ownerPid", dispatch_owner AS owner, dispatch_runtime_json AS "runtimeJson" FROM project_memory_settings WHERE dispatch_id IS NOT NULL`;
          for (const claim of claims) {
            if (activeSubmissions.has(claim.dispatchId)) continue;
            if (finalizedSubmissions.has(claim.dispatchId)) {
              yield* retryFinalizedCleanup(claim.projectId);
              continue;
            }
            let ownerGone = claim.ownerPid === process.pid && claim.owner !== processOwner;
            if (claim.ownerPid !== process.pid) {
              try {
                process.kill(claim.ownerPid, 0);
              } catch (error) {
                ownerGone =
                  typeof error === "object" &&
                  error !== null &&
                  "code" in error &&
                  error.code === "ESRCH";
              }
            }
            if (!ownerGone) continue;
            // No blanket cleanup and no reliance on elapsed time. Failure preserves the claim.
            const runtimeJson = yield* Effect.try({
              try: () => JSON.parse(claim.runtimeJson),
              catch: unavailable,
            });
            const runtime = yield* decode(MemoryRuntimeIdentity, runtimeJson);
            yield* stopRuntime(runtime);
            yield* sql`UPDATE project_memory_settings SET dispatch_id = NULL, dispatch_thread_id = NULL, dispatch_owner_pid = NULL, dispatch_owner = NULL, dispatch_runtime_json = NULL WHERE project_id = ${claim.projectId} AND dispatch_id = ${claim.dispatchId} AND dispatch_owner = ${claim.owner}`;
          }
        }),
      );
    return { list, mutate, preview, export: exportEntries, submitRecall, recoverSubmissions };
  }),
);
