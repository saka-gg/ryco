/**
 * ProjectImports - the durable import job on the destination node: preflight → clone (or a
 * repository bundle, or an existing checkout to link) → remotes → commits → checkout → changes
 * → submodules → LFS → register → settings → avatar → setup → follow-up thread.
 *
 * A job runs detached from the caller, so it finishes after the client closed. The job owns
 * only the staging directory it created (`<parent>/.<name>.ryco-import-<importId>`, by a
 * non-recursive mkdir, recorded with its dev and ino) and publishes it to the destination by
 * rename. A per-node reservation keeps a second running import or legacy clone away from the
 * same destination. Before register, a failure or cancel removes the staging directory; after
 * register, everything stays. Jobs persist in `project_imports`; at startup, running jobs become
 * `interrupted` (their surviving children signalled first), and post-register steps resume.
 *
 * @module ProjectImports
 */
import type {
  ProjectCancelImportInput,
  ProjectCopyError,
  ProjectDiscardImportInput,
  ProjectDiscardImportResult,
  ProjectImportId,
  ProjectImportSnapshot,
  ProjectImportStartInput,
  ProjectListImportsInput,
  ProjectListImportsResult,
  ProjectSubscribeImportInput,
} from "@ryco/contracts/project-copy";
import { Context } from "effect";
import type { Effect, Option, Stream } from "effect";

export interface ProjectImportsShape {
  /**
   * Starts the job, or answers with the existing job's snapshot for the same `importId` and
   * input digest (a different digest fails `conflict`). Claims every referenced transfer and
   * takes the destination's reservation before it answers; `origin` is display-only. Once the
   * job exists it runs on when the caller goes away, and a retry with the same id waits for it.
   */
  readonly start: (
    input: ProjectImportStartInput,
  ) => Effect.Effect<ProjectImportSnapshot, ProjectCopyError>;
  /** The job's current snapshot, for Agent Control to settle an `importProject` from. */
  readonly get: (
    importId: ProjectImportId,
  ) => Effect.Effect<Option.Option<ProjectImportSnapshot>, ProjectCopyError>;
  /** The current snapshot, then each change until the job is terminal; unknown ids fail `not-found`. */
  readonly subscribe: (
    input: ProjectSubscribeImportInput,
  ) => Stream.Stream<ProjectImportSnapshot, ProjectCopyError>;
  /** Cancels a running job (its child is killed and awaited first); a terminal job is answered as is. */
  readonly cancel: (
    input: ProjectCancelImportInput,
  ) => Effect.Effect<ProjectImportSnapshot, ProjectCopyError>;
  /** At most `PROJECT_IMPORT_LIST_MAX` recent jobs, newest first. */
  readonly list: (
    input: ProjectListImportsInput,
  ) => Effect.Effect<ProjectListImportsResult, ProjectCopyError>;
  /**
   * Deletes a terminal job's leftover staging directory, only when the job never registered a
   * project (read from the projection), the directory still has the recorded dev and ino, and
   * no project is rooted at or under it. A directory already moved to the destination is never
   * deleted. Otherwise `{ deleted: false, reason }`.
   */
  readonly discard: (
    input: ProjectDiscardImportInput,
  ) => Effect.Effect<ProjectDiscardImportResult, ProjectCopyError>;
  /**
   * Settles what an earlier process left running: signals surviving children whose start time
   * matches, marks those jobs `interrupted`, deletes the staging directories of jobs that never
   * registered, and replays the idempotent post-register steps. Never fails.
   */
  readonly recoverOnStartup: () => Effect.Effect<void>;
}

export class ProjectImports extends Context.Service<ProjectImports, ProjectImportsShape>()(
  "ryco/projectCopy/Services/ProjectImports",
) {}
