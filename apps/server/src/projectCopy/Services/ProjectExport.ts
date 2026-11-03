/**
 * ProjectExport - the source side of a cross-node copy: what a copy would carry (`inspect`),
 * then the artifacts themselves (commits bundle, repository bundle, changes patch, avatar),
 * read in chunks and deleted on dispose or once their TTL passed.
 *
 * Artifact bytes never exist as JS strings: git writes them to files, sizes come from `stat`,
 * and chunks are base64 of the raw file bytes. Artifacts live under the node's state directory,
 * looked up by the export's own artifact ids, which are never joined into a path.
 *
 * @module ProjectExport
 */
import type {
  ProjectCopyError,
  ProjectExportDisposeInput,
  ProjectExportInspectInput,
  ProjectExportInspection,
  ProjectExportReadChunkInput,
  ProjectExportReadChunkResult,
  ProjectExportResult,
  ProjectExportStartInput,
} from "@ryco/contracts/project-copy";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ProjectCopyCallerChannel } from "../callerChannel.ts";

/**
 * Started over an `unencrypted` channel, an export never carries opted-in ignored files such as
 * `.env` (`skipped: insecure-channel`).
 */

export interface ProjectExportStartRequest {
  readonly input: ProjectExportStartInput;
  readonly channel: ProjectCopyCallerChannel;
}

export interface ProjectExportShape {
  /**
   * Repository, pushed state, working tree (with the ignored files that may be opted in),
   * settings and per-artifact size estimates, without creating any artifact.
   */
  readonly inspect: (
    input: ProjectExportInspectInput,
  ) => Effect.Effect<ProjectExportInspection, ProjectCopyError>;
  /**
   * Builds the requested artifacts. Single-flight per `exportId`: a retry joins the running
   * computation, and a finished export answers with its result. `ignoredPaths` must be among
   * the ignored candidates recomputed here. An artifact it cannot build (conflicts, over the
   * limit, nothing unpushed) is a `skipped` entry, not a failure.
   */
  readonly start: (
    request: ProjectExportStartRequest,
  ) => Effect.Effect<ProjectExportResult, ProjectCopyError>;
  /**
   * One chunk of an artifact; slides the export's TTL (30 min from the last read). With the
   * caller's `channel`, an artifact that carries opted-in ignored files is refused on
   * an `unencrypted` channel (`access-denied`), like `start` leaves them out there.
   */
  readonly readChunk: (
    input: ProjectExportReadChunkInput,
    channel?: ProjectCopyCallerChannel,
  ) => Effect.Effect<ProjectExportReadChunkResult, ProjectCopyError>;
  /** Deletes the export's artifacts; idempotent, and an unknown id is already gone. */
  readonly dispose: (input: ProjectExportDisposeInput) => Effect.Effect<void, ProjectCopyError>;
  /** Deletes expired exports (and leftovers of an earlier process); never fails. */
  readonly sweep: () => Effect.Effect<void>;
}

export class ProjectExport extends Context.Service<ProjectExport, ProjectExportShape>()(
  "ryco/projectCopy/Services/ProjectExport",
) {}
