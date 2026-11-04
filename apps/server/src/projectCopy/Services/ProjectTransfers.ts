/**
 * ProjectTransfers - the destination side's chunked uploads: a client begins a transfer with
 * the artifact's length and sha-256, appends base64 chunks at `receivedBytes` (resumable after a
 * reconnect), commits it (length and digest verified), and an import then claims it.
 *
 * Each transfer is a `<transferId>.part` file with a JSON sidecar under the node's state
 * directory, so `begin` stays idempotent across a restart. Appends to one transfer are
 * serialized. Uncommitted and unclaimed transfers expire one hour after their last append; the
 * node's scratch space for them is bounded (`capacity`).
 *
 * @module ProjectTransfers
 */
import type {
  ProjectCopyError,
  ProjectImportId,
  ProjectTransferAbortInput,
  ProjectTransferAppendInput,
  ProjectTransferBeginInput,
  ProjectTransferCommitInput,
  ProjectTransferCommitResult,
  ProjectTransferId,
  ProjectTransferProgress,
  ProjectTransferPurpose,
} from "@ryco/contracts/project-copy";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ProjectCopyCallerChannel } from "../callerChannel.ts";

/** One transfer an import references, with the purpose its field requires. */
export interface ProjectTransferClaim {
  readonly transferId: ProjectTransferId;
  /** commits → `commits-bundle`, changes → `changes-patch`, avatar → `avatar`, a bundle source → `repository-bundle`. */
  readonly purpose: ProjectTransferPurpose;
}

export interface ClaimedProjectTransfer {
  readonly transferId: ProjectTransferId;
  readonly purpose: ProjectTransferPurpose;
  /** The claimed file in the import's own directory; pass it to git by path, never as text. */
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ProjectTransfersShape {
  /**
   * Idempotent for the same id, purpose, length, digest and `carriesIgnoredFiles`; a different
   * one fails `conflict`. With the caller's `channel`, a transfer that carries opted-in ignored
   * files is refused on an `unencrypted` channel (`access-denied`), before anything is stored.
   * `maxChunkBytes` is the largest chunk the caller's connection carries
   * (`PROJECT_COPY_DIRECT_CHUNK_BYTES` when absent); the answer announces it.
   */
  readonly begin: (
    input: ProjectTransferBeginInput,
    channel?: ProjectCopyCallerChannel,
    maxChunkBytes?: number,
  ) => Effect.Effect<ProjectTransferProgress, ProjectCopyError>;
  /**
   * Appends at `offset == receivedBytes`. A range already written is a no-op when its bytes
   * match and `conflict` when they differ. A chunk that starts a little ahead (a client keeps
   * several appends in flight, and they may arrive out of order) waits, bounded in count, bytes
   * and time, for the bytes before it; any other gap fails with the node's `receivedBytes`. A
   * chunk over `maxChunkBytes` fails `invalid` with `receivedBytes`. Bytes of a transfer that
   * carries ignored files are refused on an `unencrypted` channel, whatever channel began it.
   */
  readonly append: (
    input: ProjectTransferAppendInput,
    channel?: ProjectCopyCallerChannel,
    maxChunkBytes?: number,
  ) => Effect.Effect<ProjectTransferProgress, ProjectCopyError>;
  /** Verifies length and digest and seals the transfer; later appends fail. Idempotent. */
  readonly commit: (
    input: ProjectTransferCommitInput,
  ) => Effect.Effect<ProjectTransferCommitResult, ProjectCopyError>;
  /** Deletes an unclaimed transfer; idempotent. */
  readonly abort: (input: ProjectTransferAbortInput) => Effect.Effect<void, ProjectCopyError>;
  /**
   * Claims every transfer an import references, all or nothing: each must be committed and of
   * the claimed purpose (else `not-found` / `invalid`). The files move into the import's
   * directory and their sha-256 is verified again. Claiming again for the same import returns
   * the files it already claimed; a transfer claimed by another import fails `conflict`.
   */
  readonly claimForImport: (input: {
    readonly importId: ProjectImportId;
    readonly transfers: ReadonlyArray<ProjectTransferClaim>;
  }) => Effect.Effect<ReadonlyArray<ClaimedProjectTransfer>, ProjectCopyError>;
  /** Deletes an import's claimed files; the job calls it once it settled or was discarded. */
  readonly releaseImport: (importId: ProjectImportId) => Effect.Effect<void>;
  /** Deletes expired unclaimed transfers; never fails. Claimed files go with `releaseImport`. */
  readonly sweep: () => Effect.Effect<void>;
}

export class ProjectTransfers extends Context.Service<ProjectTransfers, ProjectTransfersShape>()(
  "ryco/projectCopy/Services/ProjectTransfers",
) {}
