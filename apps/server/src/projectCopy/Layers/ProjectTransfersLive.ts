/**
 * ProjectTransfersLive - the destination's chunked uploads, kept on disk so a client resumes after
 * a reconnect and `begin` stays idempotent across a restart.
 *
 * Under `<stateDir>`:
 * - `project-transfers/<transferId>.json`: the sidecar `{ purpose, byteLength, sha256,
 *   carriesIgnoredFiles, createdAt, lastAppendAt }`. Written at begin; appends refresh
 *   `lastAppendAt` at most once a minute, and the data file's mtime covers the rest.
 * - `project-transfers/<transferId>.part`: the bytes received so far; `.ready` once committed.
 * - `project-imports/<importId>/<transferId>.<purpose>` with its sidecar beside it: a transfer an
 *   import claimed. It stays there until the job releases it.
 *
 * The files are the truth. An index rebuilt from them at startup answers every call, and the same
 * pass deletes what no transfer owns: half-finished begins, foreign names, leftovers of a claim
 * that a crash interrupted (rolled forward when the data already moved). Ids are validated again
 * before they name a file, because the service is also called from inside the node.
 *
 * Locks: `registry` serializes the calls that change which transfers exist or who owns them
 * (begin's capacity admission, claim, release, sweep); a per-transfer lock serializes the calls on
 * one transfer. The order is always the registry first, then transfer locks in id order.
 *
 * Out of order: a client keeps a few appends of one transfer in flight, and two calls sent in order
 * may reach the lock in either order (each first learns its caller's channel). An append that
 * starts at most {@link PROJECT_TRANSFER_MAX_WAITING_APPENDS} chunks ahead of `receivedBytes` waits,
 * without the lock, until the bytes before it arrived or {@link PROJECT_TRANSFER_AHEAD_WAIT_MS}
 * passed. At most that many appends wait per transfer, holding at most
 * {@link PROJECT_TRANSFERS_MAX_WAITING_BYTES} together on the node; past any bound the gap fails
 * at once with `receivedBytes`, as it always did, and the client resumes from there.
 *
 * @module ProjectTransfersLive
 */
import { mkdir, open, readFile, readdir, rename, rm, stat, truncate } from "node:fs/promises";
import nodePath from "node:path";

import { PositiveInt } from "@ryco/contracts";
import {
  PROJECT_COPY_DIRECT_CHUNK_BYTES,
  PROJECT_COPY_MAX_ARTIFACT_BYTES,
  PROJECT_COPY_MAX_AVATAR_BYTES,
  ProjectCopyError,
  type ProjectCopyErrorCode,
  ProjectCopySha256,
  ProjectImportId,
  ProjectTransferId,
  type ProjectTransferAppendInput,
  type ProjectTransferProgress,
  ProjectTransferPurpose,
} from "@ryco/contracts/project-copy";
import { bytesEqual } from "@ryco/shared/bytesEqual";
import { makeKeyedSerialExecutor } from "@ryco/shared/KeyedSerialExecutor";
import { Clock, Data, Deferred, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import {
  ignoredFilesRefused,
  mayCarryIgnoredFiles,
  type ProjectCopyCallerChannel,
} from "../callerChannel.ts";
import { sha256File } from "../fileSha256.ts";
import {
  type ClaimedProjectTransfer,
  ProjectTransfers,
  type ProjectTransfersShape,
} from "../Services/ProjectTransfers.ts";
import { PROJECT_IMPORTS_DIRECTORY, PROJECT_TRANSFERS_DIRECTORY } from "../projectCopyStartup.ts";

/** Uncommitted and unclaimed transfers expire this long after their last append. */
export const PROJECT_TRANSFER_TTL_MS = 60 * 60 * 1000;
/** Declared bytes of every unclaimed transfer together. Claimed files belong to their import. */
export const PROJECT_TRANSFERS_CAPACITY_BYTES = 512 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** How stale an open transfer's sidecar `lastAppendAt` may get while chunks arrive. */
const SIDECAR_REFRESH_MS = 60 * 1000;
/** Appends of one transfer that may wait for the bytes before them; also how many chunks ahead. */
export const PROJECT_TRANSFER_MAX_WAITING_APPENDS = 8;
/** Raw bytes every waiting append of the node holds together. */
export const PROJECT_TRANSFERS_MAX_WAITING_BYTES = 16 * 1024 * 1024;
/**
 * How long an append ahead waits for the bytes before it; then it fails with the gap. Long enough
 * for the client to retry the missing chunk a few times, short enough that a client that gave up
 * on it learns soon.
 */
export const PROJECT_TRANSFER_AHEAD_WAIT_MS = 15_000;

const TransferSidecar = Schema.Struct({
  purpose: ProjectTransferPurpose,
  byteLength: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_COPY_MAX_ARTIFACT_BYTES)),
  sha256: ProjectCopySha256,
  carriesIgnoredFiles: Schema.optional(Schema.Boolean),
  createdAt: Schema.String,
  lastAppendAt: Schema.String,
});
type TransferSidecar = typeof TransferSidecar.Type;
const decodeSidecar = Schema.decodeUnknownOption(Schema.fromJsonString(TransferSidecar));

const isTransferId = Schema.is(ProjectTransferId);
const isImportId = Schema.is(ProjectImportId);
const isPurpose = Schema.is(ProjectTransferPurpose);
const isSha256 = Schema.is(ProjectCopySha256);

type TransferState = "open" | "committed" | "claimed";

interface TransferEntry {
  readonly transferId: ProjectTransferId;
  readonly purpose: ProjectTransferPurpose;
  readonly byteLength: number;
  readonly sha256: string;
  /** Holds opted-in ignored files: never taken over an unencrypted connection (A33). */
  readonly carriesIgnoredFiles: boolean;
  readonly createdAt: string;
  state: TransferState;
  receivedBytes: number;
  lastAppendAtMs: number;
  /** The `lastAppendAt` the sidecar holds; appends rewrite it at most once a minute. */
  sidecarAppendAtMs: number;
  claimedBy: ProjectImportId | null;
}

interface StoreDirectories {
  readonly transfers: string;
  readonly imports: string;
}

const projectTransferDirectories = (stateDir: string): StoreDirectories => ({
  transfers: nodePath.join(stateDir, PROJECT_TRANSFERS_DIRECTORY),
  imports: nodePath.join(stateDir, PROJECT_IMPORTS_DIRECTORY),
});

// Every path below is built from an id that passed its schema (a lowercase UUID) and, for claimed
// files, a purpose literal: no input string reaches a path unchecked.
const storePaths = (dirs: StoreDirectories) => ({
  part: (id: ProjectTransferId) => nodePath.join(dirs.transfers, `${id}.part`),
  ready: (id: ProjectTransferId) => nodePath.join(dirs.transfers, `${id}.ready`),
  sidecar: (id: ProjectTransferId) => nodePath.join(dirs.transfers, `${id}.json`),
  importDirectory: (importId: ProjectImportId) => nodePath.join(dirs.imports, importId),
  claimed: (importId: ProjectImportId, id: ProjectTransferId, purpose: ProjectTransferPurpose) =>
    nodePath.join(dirs.imports, importId, `${id}.${purpose}`),
  claimedSidecar: (importId: ProjectImportId, id: ProjectTransferId) =>
    nodePath.join(dirs.imports, importId, `${id}.json`),
});
type StorePaths = ReturnType<typeof storePaths>;

const transferError = (code: ProjectCopyErrorCode, message: string, receivedBytes?: number) =>
  new ProjectCopyError({
    code,
    message,
    ...(receivedBytes === undefined ? {} : { receivedBytes }),
  });

const errnoCode = (cause: unknown): string | null =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : null;

class TransferIoFailure extends Data.TaggedError("TransferIoFailure")<{
  readonly cause: unknown;
}> {}

/**
 * A file operation failed: logged with its cause, then reported without paths. A full disk is
 * the node's capacity; anything else is internal.
 */
const io = <A>(
  action: string,
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ProjectCopyError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TransferIoFailure({ cause }) }).pipe(
    Effect.catch(({ cause }) => {
      const code = errnoCode(cause);
      const error =
        code === "ENOSPC" || code === "EDQUOT"
          ? transferError("capacity", `This node's disk is full: could not ${action}.`)
          : transferError("internal", `Could not ${action}${code === null ? "" : ` (${code})`}.`);
      return Effect.logWarning("project-transfers.io-failed", { action, cause }).pipe(
        Effect.andThen(Effect.fail(error)),
      );
    }),
  );

const sidecarOf = (entry: TransferEntry): TransferSidecar => ({
  purpose: entry.purpose,
  byteLength: entry.byteLength,
  sha256: entry.sha256,
  carriesIgnoredFiles: entry.carriesIgnoredFiles,
  createdAt: entry.createdAt,
  lastAppendAt: new Date(entry.lastAppendAtMs).toISOString(),
});

const progressOf = (entry: TransferEntry): ProjectTransferProgress => ({
  transferId: entry.transferId,
  receivedBytes: entry.state === "open" ? entry.receivedBytes : entry.byteLength,
});

const maxBytesFor = (purpose: ProjectTransferPurpose) =>
  purpose === "avatar" ? PROJECT_COPY_MAX_AVATAR_BYTES : PROJECT_COPY_MAX_ARTIFACT_BYTES;

// ── Startup recovery ──────────────────────────────────────────────────

const readSidecarFile = async (filePath: string): Promise<TransferSidecar | null> => {
  try {
    return Option.getOrNull(decodeSidecar(await readFile(filePath, "utf8")));
  } catch {
    return null;
  }
};

const statOrNull = async (filePath: string) => {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
};

/** Truncates a file to nothing; false when it could not. */
const emptied = async (filePath: string) => {
  try {
    await truncate(filePath, 0);
    return true;
  } catch {
    return false;
  }
};

/** `name` split at its first dot: ids are UUIDs, so the rest is the file's role. */
const splitFileName = (name: string) => {
  const dot = name.indexOf(".");
  return dot <= 0 ? null : { id: name.slice(0, dot), role: name.slice(dot + 1) };
};

const recoveredEntry = (input: {
  readonly transferId: ProjectTransferId;
  readonly sidecar: TransferSidecar;
  readonly state: TransferState;
  readonly receivedBytes: number;
  readonly dataModifiedAtMs: number;
  readonly claimedBy: ProjectImportId | null;
}): TransferEntry => {
  const sidecarAppendAtMs = Date.parse(input.sidecar.lastAppendAt);
  const sidecarMs = Number.isFinite(sidecarAppendAtMs) ? sidecarAppendAtMs : 0;
  return {
    transferId: input.transferId,
    purpose: input.sidecar.purpose,
    byteLength: input.sidecar.byteLength,
    sha256: input.sidecar.sha256,
    carriesIgnoredFiles: input.sidecar.carriesIgnoredFiles === true,
    createdAt: input.sidecar.createdAt,
    state: input.state,
    receivedBytes: input.receivedBytes,
    // The sidecar lags behind appends by up to a minute; the data file's mtime does not.
    lastAppendAtMs: Math.max(sidecarMs, input.dataModifiedAtMs),
    sidecarAppendAtMs: sidecarMs,
    claimedBy: input.claimedBy,
  };
};

/**
 * Rebuilds the index from disk and deletes what no transfer owns. Inside `project-imports` it
 * reads only `<transferId>.<json|purpose>` files of directories named like an import id; the
 * import job owns everything else there.
 */
const recoverStore = async (
  dirs: StoreDirectories,
  paths: StorePaths,
): Promise<{ readonly entries: ReadonlyArray<TransferEntry>; readonly removed: number }> => {
  await mkdir(dirs.transfers, { recursive: true });
  await mkdir(dirs.imports, { recursive: true });
  let removed = 0;
  const remove = async (target: string) => {
    try {
      await rm(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best effort: the next startup tries again.
    }
  };

  interface LocalFiles {
    sidecar: boolean;
    part: boolean;
    ready: boolean;
  }
  const local = new Map<ProjectTransferId, LocalFiles>();
  for (const name of await readdir(dirs.transfers)) {
    const parts = splitFileName(name);
    if (
      parts === null ||
      !isTransferId(parts.id) ||
      (parts.role !== "json" && parts.role !== "part" && parts.role !== "ready")
    ) {
      await remove(nodePath.join(dirs.transfers, name));
      continue;
    }
    const files = local.get(parts.id) ?? { sidecar: false, part: false, ready: false };
    if (parts.role === "json") files.sidecar = true;
    else if (parts.role === "part") files.part = true;
    else files.ready = true;
    local.set(parts.id, files);
  }
  const removeLocal = async (id: ProjectTransferId, files: LocalFiles) => {
    // Sidecar first: a crash in between leaves data without a sidecar, which the next start drops.
    if (files.sidecar) await remove(paths.sidecar(id));
    if (files.part) await remove(paths.part(id));
    if (files.ready) await remove(paths.ready(id));
  };

  interface ScannedClaim {
    readonly importId: ProjectImportId;
    sidecar: boolean;
    readonly purposes: Array<ProjectTransferPurpose>;
  }
  const claims = new Map<ProjectTransferId, ScannedClaim>();
  for (const importName of await readdir(dirs.imports)) {
    if (!isImportId(importName)) continue;
    let names: ReadonlyArray<string>;
    try {
      names = await readdir(paths.importDirectory(importName));
    } catch {
      continue;
    }
    for (const name of names) {
      const parts = splitFileName(name);
      if (parts === null || !isTransferId(parts.id)) continue;
      if (parts.role !== "json" && !isPurpose(parts.role)) continue;
      const claim: ScannedClaim = claims.get(parts.id) ?? {
        importId: importName,
        sidecar: false,
        purposes: [],
      };
      // A transfer is claimed by one import; a copy under a second import is not indexed.
      if (claim.importId !== importName) continue;
      if (parts.role === "json") claim.sidecar = true;
      else if (isPurpose(parts.role)) claim.purposes.push(parts.role);
      claims.set(parts.id, claim);
    }
  }

  const entries: Array<TransferEntry> = [];
  for (const [id, claim] of claims) {
    const { importId } = claim;
    const purpose = claim.purposes.length === 1 ? claim.purposes[0] : undefined;
    if (purpose === undefined) {
      // No data moved (or a corrupt pair): the claim never happened. Local files stay a transfer.
      if (claim.sidecar) await remove(paths.claimedSidecar(importId, id));
      for (const extra of claim.purposes) await remove(paths.claimed(importId, id, extra));
      continue;
    }
    const files = local.get(id);
    local.delete(id);
    let sidecar = claim.sidecar ? await readSidecarFile(paths.claimedSidecar(importId, id)) : null;
    if (sidecar === null && files?.sidecar === true) {
      // The data moved but a crash stopped the sidecar from following: finish the claim.
      const pending = await readSidecarFile(paths.sidecar(id));
      if (pending !== null && pending.purpose === purpose) {
        try {
          await rename(paths.sidecar(id), paths.claimedSidecar(importId, id));
          files.sidecar = false;
          sidecar = pending;
        } catch {
          sidecar = null;
        }
      }
    }
    const data = await statOrNull(paths.claimed(importId, id, purpose));
    if (sidecar === null || sidecar.purpose !== purpose || data?.size !== sidecar.byteLength) {
      await remove(paths.claimed(importId, id, purpose));
      await remove(paths.claimedSidecar(importId, id));
      if (files !== undefined) await removeLocal(id, files);
      continue;
    }
    if (files !== undefined) await removeLocal(id, files);
    entries.push(
      recoveredEntry({
        transferId: id,
        sidecar,
        state: "claimed",
        receivedBytes: sidecar.byteLength,
        dataModifiedAtMs: data.mtimeMs,
        claimedBy: importId,
      }),
    );
  }

  for (const [id, files] of local) {
    const sidecar = files.sidecar ? await readSidecarFile(paths.sidecar(id)) : null;
    if (sidecar === null || (!files.part && !files.ready)) {
      await removeLocal(id, files);
      continue;
    }
    if (files.ready) {
      if (files.part) await remove(paths.part(id));
      const data = await statOrNull(paths.ready(id));
      if (data?.size !== sidecar.byteLength) {
        await removeLocal(id, { ...files, part: false });
        continue;
      }
      entries.push(
        recoveredEntry({
          transferId: id,
          sidecar,
          state: "committed",
          receivedBytes: sidecar.byteLength,
          dataModifiedAtMs: data.mtimeMs,
          claimedBy: null,
        }),
      );
      continue;
    }
    const data = await statOrNull(paths.part(id));
    // More bytes than declared can only be damage: the upload starts over.
    const damaged = data !== null && data.size > sidecar.byteLength;
    if (data === null || (damaged && !(await emptied(paths.part(id))))) {
      await removeLocal(id, files);
      continue;
    }
    const receivedBytes = damaged ? 0 : data.size;
    entries.push(
      recoveredEntry({
        transferId: id,
        sidecar,
        state: "open",
        receivedBytes,
        dataModifiedAtMs: data.mtimeMs,
        claimedBy: null,
      }),
    );
  }
  return { entries, removed };
};

// ── File steps of one transfer ────────────────────────────────────────

/** Reads exactly `length` bytes at `position`; a short file yields fewer. */
const readRange = async (
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
) => {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
};

const writeRange = async (
  handle: Awaited<ReturnType<typeof open>>,
  data: Uint8Array,
  position: number,
) => {
  let written = 0;
  while (written < data.byteLength) {
    const { bytesWritten } = await handle.write(
      data,
      written,
      data.byteLength - written,
      position + written,
    );
    written += bytesWritten;
  }
};

/**
 * Writes `data` at `offset` into a part file holding `receivedBytes`: the part already held must
 * equal what it holds (else `"conflict"`), and only the rest is written, at `receivedBytes`.
 */
const appendChunk = async (input: {
  readonly filePath: string;
  readonly receivedBytes: number;
  readonly offset: number;
  readonly data: Uint8Array;
}): Promise<"appended" | "unchanged" | "conflict"> => {
  const held = Math.min(input.offset + input.data.byteLength, input.receivedBytes) - input.offset;
  const handle = await open(input.filePath, "r+");
  try {
    if (held > 0) {
      const existing = await readRange(handle, input.offset, held);
      if (!bytesEqual(existing, input.data.subarray(0, held))) return "conflict";
    }
    if (held === input.data.byteLength) return "unchanged";
    await writeRange(handle, input.data.subarray(held), input.receivedBytes);
    return "appended";
  } finally {
    await handle.close();
  }
};

const removeFiles = (action: string, filePaths: ReadonlyArray<string>) =>
  io(action, async () => {
    for (const filePath of filePaths) await rm(filePath, { force: true });
  });

// ── Service ───────────────────────────────────────────────────────────

export interface ProjectTransfersOptions {
  readonly stateDir: string;
  readonly ttlMs?: number;
  readonly capacityBytes?: number;
  readonly sweepIntervalMs?: number;
  readonly aheadWaitMs?: number;
}

/** An append that waits, outside the transfer's lock, for the bytes before it. */
interface AheadWaiter {
  readonly woken: Deferred.Deferred<void>;
  readonly bytes: number;
}

type AppendAttempt =
  | { readonly _tag: "done"; readonly progress: ProjectTransferProgress }
  | {
      readonly _tag: "wait";
      readonly transferId: ProjectTransferId;
      readonly waiter: AheadWaiter;
    };

/**
 * Builds the transfer store over `<stateDir>`: recovers it from disk, sweeps it once, then every
 * few minutes for as long as the calling scope lives.
 */
export const makeProjectTransfers = Effect.fn("makeProjectTransfers")(function* (
  options: ProjectTransfersOptions,
) {
  const ttlMs = options.ttlMs ?? PROJECT_TRANSFER_TTL_MS;
  const capacityBytes = options.capacityBytes ?? PROJECT_TRANSFERS_CAPACITY_BYTES;
  const aheadWaitMs = options.aheadWaitMs ?? PROJECT_TRANSFER_AHEAD_WAIT_MS;
  const dirs = projectTransferDirectories(options.stateDir);
  const paths = storePaths(dirs);
  const fileServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const entries = new Map<ProjectTransferId, TransferEntry>();
  const registry = yield* Semaphore.make(1);
  const transferLocks = yield* makeKeyedSerialExecutor<ProjectTransferId>();
  const waiters = new Map<ProjectTransferId, Set<AheadWaiter>>();
  let waitingBytes = 0;

  /** Registers an append ahead; null when a bound is reached. Call it holding the transfer's lock. */
  const addWaiter = (transferId: ProjectTransferId, bytes: number): AheadWaiter | null => {
    const waiting = waiters.get(transferId) ?? new Set<AheadWaiter>();
    if (
      waiting.size >= PROJECT_TRANSFER_MAX_WAITING_APPENDS ||
      waitingBytes + bytes > PROJECT_TRANSFERS_MAX_WAITING_BYTES
    ) {
      return null;
    }
    const waiter: AheadWaiter = { woken: Deferred.makeUnsafe<void>(), bytes };
    waiting.add(waiter);
    waiters.set(transferId, waiting);
    waitingBytes += bytes;
    return waiter;
  };

  /** Forgets a waiter that timed out or was interrupted; a woken one is gone already. */
  const dropWaiter = (transferId: ProjectTransferId, waiter: AheadWaiter) => {
    const waiting = waiters.get(transferId);
    if (waiting === undefined || !waiting.delete(waiter)) return;
    waitingBytes -= waiter.bytes;
    if (waiting.size === 0) waiters.delete(transferId);
  };

  /** The transfer changed (bytes arrived, or it was committed, reset or removed): look again. */
  const wakeWaiters = (transferId: ProjectTransferId) => {
    const waiting = waiters.get(transferId);
    if (waiting === undefined) return;
    waiters.delete(transferId);
    for (const waiter of waiting) {
      waitingBytes -= waiter.bytes;
      Deferred.doneUnsafe(waiter.woken, Effect.void);
    }
  };

  /** Holds the locks of `ids` in id order, so two claims can never wait on each other. */
  const withTransferLocks = <A, E>(
    ids: ReadonlyArray<ProjectTransferId>,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    [...new Set(ids)]
      .toSorted()
      .reduceRight<Effect.Effect<A, E>>((inner, id) => transferLocks.withLock(id, inner), effect);

  const writeSidecar = (entry: TransferEntry) =>
    writeFileStringAtomically({
      filePath: paths.sidecar(entry.transferId),
      contents: `${JSON.stringify(sidecarOf(entry))}\n`,
    }).pipe(
      Effect.provideContext(fileServices),
      Effect.tap(() =>
        Effect.sync(() => {
          entry.sidecarAppendAtMs = entry.lastAppendAtMs;
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("project-transfers.io-failed", { action: "write a sidecar", cause }).pipe(
          Effect.andThen(
            Effect.fail(transferError("internal", "Could not record the transfer on disk.")),
          ),
        ),
      ),
    );

  const unknownTransfer = (transferId: ProjectTransferId) =>
    transferError("not-found", `Transfer ${transferId} is unknown or expired; begin it again.`);

  /** Deletes an unclaimed transfer's files; its sidecar goes first, so a crash leaves only orphans. */
  const removeTransfer = (entry: TransferEntry) =>
    Effect.sync(() => {
      entries.delete(entry.transferId);
      wakeWaiters(entry.transferId);
    }).pipe(
      Effect.andThen(
        removeFiles("delete a transfer", [
          paths.sidecar(entry.transferId),
          paths.part(entry.transferId),
          paths.ready(entry.transferId),
        ]),
      ),
    );

  const reservedBytes = () => {
    let total = 0;
    for (const entry of entries.values()) {
      if (entry.state !== "claimed") total += entry.byteLength;
    }
    return total;
  };

  /** Deletes unclaimed transfers idle for the TTL. Call it holding `registry`. */
  const sweepExpired = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const expired = [...entries.values()].filter(
      (entry) => entry.state !== "claimed" && nowMs - entry.lastAppendAtMs >= ttlMs,
    );
    yield* Effect.forEach(
      expired,
      (candidate) =>
        transferLocks.withLock(
          candidate.transferId,
          Effect.suspend(() => {
            // An append may have refreshed it while this sweep waited for its lock.
            const entry = entries.get(candidate.transferId);
            return entry !== undefined &&
              entry.state !== "claimed" &&
              nowMs - entry.lastAppendAtMs >= ttlMs
              ? removeTransfer(entry).pipe(Effect.ignore({ log: true }))
              : Effect.void;
          }),
        ),
      { discard: true },
    );
  });

  /** Runs `use` holding the lock of a valid transfer id; any other id fails `invalid`. */
  const withTransfer = <A>(
    transferId: string,
    use: (transferId: ProjectTransferId) => Effect.Effect<A, ProjectCopyError>,
  ): Effect.Effect<A, ProjectCopyError> =>
    isTransferId(transferId)
      ? transferLocks.withLock(
          transferId,
          Effect.suspend(() => use(transferId)),
        )
      : Effect.fail(transferError("invalid", "A transfer id must be a lowercase version 4 UUID."));

  const begin: ProjectTransfersShape["begin"] = (
    input,
    channel,
    maxChunkBytes = PROJECT_COPY_DIRECT_CHUNK_BYTES,
  ) =>
    withTransfer(input.transferId, (transferId) =>
      Effect.gen(function* () {
        if (!isPurpose(input.purpose) || !isSha256(input.sha256)) {
          return yield* transferError("invalid", "A transfer needs a known purpose and a sha-256.");
        }
        const carriesIgnoredFiles = input.carriesIgnoredFiles === true;
        if (carriesIgnoredFiles && !mayCarryIgnoredFiles(channel)) {
          return yield* ignoredFilesRefused("This transfer");
        }
        if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
          return yield* transferError("invalid", "A transfer's length must be a positive integer.");
        }
        const maxBytes = maxBytesFor(input.purpose);
        if (input.byteLength > maxBytes) {
          return yield* transferError(
            "too-large",
            `A ${input.purpose} transfer may hold at most ${maxBytes} bytes.`,
          );
        }
        const existing = entries.get(transferId);
        if (existing !== undefined) {
          if (
            existing.purpose !== input.purpose ||
            existing.byteLength !== input.byteLength ||
            existing.sha256 !== input.sha256 ||
            existing.carriesIgnoredFiles !== carriesIgnoredFiles
          ) {
            return yield* transferError(
              "conflict",
              `Transfer ${transferId} was begun with a different purpose, length, sha-256 or content.`,
            );
          }
          return { ...progressOf(existing), maxChunkBytes };
        }
        // This transfer is not in the index, so the sweep never waits on the lock held here.
        if (reservedBytes() + input.byteLength > capacityBytes) yield* sweepExpired;
        if (reservedBytes() + input.byteLength > capacityBytes) {
          return yield* transferError(
            "capacity",
            "This node holds too many pending transfers; finish or cancel another copy first.",
          );
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const entry: TransferEntry = {
          transferId,
          purpose: input.purpose,
          byteLength: input.byteLength,
          sha256: input.sha256,
          carriesIgnoredFiles,
          createdAt: new Date(nowMs).toISOString(),
          state: "open",
          receivedBytes: 0,
          lastAppendAtMs: nowMs,
          sidecarAppendAtMs: nowMs,
          claimedBy: null,
        };
        // The data file first: a crash before the sidecar exists leaves an orphan startup deletes.
        yield* io("create a transfer file", async () => {
          await rm(paths.ready(transferId), { force: true });
          await (await open(paths.part(transferId), "w")).close();
        }).pipe(
          Effect.andThen(writeSidecar(entry)),
          Effect.andThen(Effect.sync(() => entries.set(transferId, entry))),
          Effect.uninterruptible,
        );
        return { ...progressOf(entry), maxChunkBytes };
      }),
    ).pipe(registry.withPermits(1));

  /**
   * One try at an append, holding the transfer's lock. A chunk a little ahead of `receivedBytes`
   * is registered to wait (when `mayWait` and the bounds allow) instead of failing with the gap.
   */
  const appendOnce = (
    input: ProjectTransferAppendInput,
    data: Buffer,
    channel: ProjectCopyCallerChannel | undefined,
    maxChunkBytes: number,
    mayWait: boolean,
  ): Effect.Effect<AppendAttempt, ProjectCopyError> =>
    withTransfer(input.transferId, (transferId) =>
      Effect.gen(function* () {
        const entry = entries.get(transferId);
        if (entry === undefined) return yield* unknownTransfer(transferId);
        // The channel can change between chunks (a reconnect, a downgrade): asked every time.
        if (entry.carriesIgnoredFiles && !mayCarryIgnoredFiles(channel)) {
          return yield* ignoredFilesRefused("This transfer");
        }
        if (entry.state !== "open") {
          return yield* transferError("conflict", `Transfer ${transferId} is already committed.`);
        }
        if (data.byteLength === 0 || data.byteLength > maxChunkBytes) {
          return yield* transferError(
            "invalid",
            `A chunk must hold 1 to ${maxChunkBytes} bytes over this connection.`,
            entry.receivedBytes,
          );
        }
        if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
          return yield* transferError(
            "invalid",
            "A chunk's offset must be a non-negative integer.",
          );
        }
        if (input.offset + data.byteLength > entry.byteLength) {
          return yield* transferError(
            "invalid",
            `The chunk ends past the transfer's ${entry.byteLength} bytes.`,
            entry.receivedBytes,
          );
        }
        if (input.offset > entry.receivedBytes) {
          const waiter =
            mayWait &&
            input.offset - entry.receivedBytes <=
              PROJECT_TRANSFER_MAX_WAITING_APPENDS * PROJECT_COPY_DIRECT_CHUNK_BYTES
              ? addWaiter(transferId, data.byteLength)
              : null;
          if (waiter !== null) return { _tag: "wait", transferId, waiter } as const;
          return yield* transferError(
            "invalid",
            `Transfer ${transferId} holds ${entry.receivedBytes} bytes; resume there.`,
            entry.receivedBytes,
          );
        }
        const outcome = yield* io("write a chunk", () =>
          appendChunk({
            filePath: paths.part(transferId),
            receivedBytes: entry.receivedBytes,
            offset: input.offset,
            data,
          }),
        ).pipe(
          Effect.tap((written) =>
            written === "appended"
              ? Effect.sync(() => {
                  entry.receivedBytes = input.offset + data.byteLength;
                  wakeWaiters(transferId);
                })
              : Effect.void,
          ),
          Effect.uninterruptible,
        );
        if (outcome === "conflict") {
          return yield* transferError(
            "conflict",
            `The chunk at ${input.offset} differs from the bytes transfer ${transferId} already holds.`,
            entry.receivedBytes,
          );
        }
        const nowMs = yield* Clock.currentTimeMillis;
        entry.lastAppendAtMs = nowMs;
        if (nowMs - entry.sidecarAppendAtMs >= SIDECAR_REFRESH_MS) {
          // Only the TTL reads it, and the data file's mtime backs it up: never fail a chunk.
          yield* writeSidecar(entry).pipe(Effect.ignore);
        }
        return { _tag: "done", progress: progressOf(entry) } as const;
      }),
    );

  const append: ProjectTransfersShape["append"] = (
    input,
    channel,
    maxChunkBytes = PROJECT_COPY_DIRECT_CHUNK_BYTES,
  ) =>
    Effect.gen(function* () {
      const data = Buffer.from(input.dataBase64, "base64");
      const deadlineMs = (yield* Clock.currentTimeMillis) + aheadWaitMs;
      for (;;) {
        const nowMs = yield* Clock.currentTimeMillis;
        const attempt = yield* appendOnce(input, data, channel, maxChunkBytes, nowMs < deadlineMs);
        if (attempt._tag === "done") return attempt.progress;
        const { transferId, waiter } = attempt;
        // Woken when the transfer changed; after the deadline the next try fails with the gap.
        yield* Deferred.await(waiter.woken).pipe(
          Effect.timeoutOption(Math.max(0, deadlineMs - nowMs)),
          Effect.ensuring(Effect.sync(() => dropWaiter(transferId, waiter))),
        );
      }
    });

  const commit: ProjectTransfersShape["commit"] = (input) =>
    withTransfer(input.transferId, (transferId) =>
      Effect.gen(function* () {
        const entry = entries.get(transferId);
        if (entry === undefined) return yield* unknownTransfer(transferId);
        const result = { transferId, byteLength: entry.byteLength, sha256: entry.sha256 };
        if (entry.state !== "open") return result;
        if (entry.receivedBytes !== entry.byteLength) {
          return yield* transferError(
            "invalid",
            `Transfer ${transferId} holds ${entry.receivedBytes} of ${entry.byteLength} bytes.`,
            entry.receivedBytes,
          );
        }
        const digest = yield* io("hash a transfer", (signal) =>
          sha256File(paths.part(transferId), signal),
        );
        if (digest.byteLength !== entry.byteLength || digest.sha256 !== entry.sha256) {
          // These bytes can never commit: start the upload over under the same id.
          yield* io("reset a transfer", () => truncate(paths.part(transferId), 0)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                entry.receivedBytes = 0;
                wakeWaiters(transferId);
              }),
            ),
            Effect.uninterruptible,
          );
          return yield* transferError(
            "invalid",
            `Transfer ${transferId} does not match its sha-256; upload it again from the start.`,
            0,
          );
        }
        const committedAtMs = yield* Clock.currentTimeMillis;
        yield* io("commit a transfer", () =>
          rename(paths.part(transferId), paths.ready(transferId)),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              entry.state = "committed";
              entry.lastAppendAtMs = committedAtMs;
              wakeWaiters(transferId);
            }),
          ),
          Effect.uninterruptible,
        );
        return result;
      }),
    );

  const abort: ProjectTransfersShape["abort"] = (input) =>
    withTransfer(input.transferId, (transferId) => {
      const entry = entries.get(transferId);
      // Claimed files belong to their import now.
      return entry === undefined || entry.state === "claimed"
        ? Effect.void
        : removeTransfer(entry).pipe(Effect.uninterruptible);
    });

  const claimedResult = (
    importId: ProjectImportId,
    entry: TransferEntry,
  ): ClaimedProjectTransfer => ({
    transferId: entry.transferId,
    purpose: entry.purpose,
    path: paths.claimed(importId, entry.transferId, entry.purpose),
    byteLength: entry.byteLength,
    sha256: entry.sha256,
  });

  /** Moves a committed transfer into the import's directory: data first, then its sidecar. */
  const moveIntoImport = (importId: ProjectImportId, entry: TransferEntry) =>
    io("claim a transfer", async () => {
      await rename(
        paths.ready(entry.transferId),
        paths.claimed(importId, entry.transferId, entry.purpose),
      );
      try {
        await rename(
          paths.sidecar(entry.transferId),
          paths.claimedSidecar(importId, entry.transferId),
        );
      } catch (error) {
        await rename(
          paths.claimed(importId, entry.transferId, entry.purpose),
          paths.ready(entry.transferId),
        ).catch(() => undefined);
        throw error;
      }
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          entry.state = "claimed";
          entry.claimedBy = importId;
        }),
      ),
    );

  /** Undoes a claim this call made, so a failed claim leaves every transfer as it was. */
  const moveBack = (importId: ProjectImportId, entry: TransferEntry) =>
    io("release a claim", async () => {
      await rename(
        paths.claimedSidecar(importId, entry.transferId),
        paths.sidecar(entry.transferId),
      );
      await rename(
        paths.claimed(importId, entry.transferId, entry.purpose),
        paths.ready(entry.transferId),
      );
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          entry.state = "committed";
          entry.claimedBy = null;
        }),
      ),
      Effect.ignore({ log: true }),
    );

  const claimForImport: ProjectTransfersShape["claimForImport"] = (input) =>
    Effect.gen(function* () {
      if (!isImportId(input.importId)) {
        return yield* transferError("invalid", "An import id must be a lowercase UUID.");
      }
      const importId = input.importId;
      const ids = input.transfers.map((claim) => claim.transferId);
      if (!ids.every(isTransferId)) {
        return yield* transferError("invalid", "A transfer id must be a lowercase version 4 UUID.");
      }
      if (new Set(ids).size !== ids.length) {
        return yield* transferError("invalid", "An import names each transfer once.");
      }
      return yield* withTransferLocks(
        ids,
        Effect.gen(function* () {
          // Check every transfer before touching any: the claim is all or nothing.
          const claimed: Array<TransferEntry> = [];
          for (const { transferId, purpose } of input.transfers) {
            const entry = entries.get(transferId);
            if (entry === undefined) return yield* unknownTransfer(transferId);
            if (entry.purpose !== purpose) {
              return yield* transferError(
                "invalid",
                `Transfer ${transferId} holds a ${entry.purpose}, not a ${purpose}.`,
              );
            }
            if (entry.state === "open") {
              return yield* transferError(
                "invalid",
                `Transfer ${transferId} is not committed yet.`,
                entry.receivedBytes,
              );
            }
            if (entry.state === "claimed" && entry.claimedBy !== importId) {
              return yield* transferError(
                "conflict",
                `Transfer ${transferId} belongs to another import.`,
              );
            }
            claimed.push(entry);
          }
          const pending = claimed.filter((entry) => entry.state === "committed");
          for (const entry of pending) {
            const digest = yield* io("verify a transfer", (signal) =>
              sha256File(paths.ready(entry.transferId), signal),
            );
            if (digest.byteLength !== entry.byteLength || digest.sha256 !== entry.sha256) {
              // Changed on disk since its commit; it can never pass again.
              yield* removeTransfer(entry).pipe(Effect.ignore({ log: true }));
              return yield* transferError(
                "invalid",
                `Transfer ${entry.transferId} no longer matches its sha-256; upload it again.`,
              );
            }
          }
          if (pending.length > 0) {
            yield* io("create the import's directory", () =>
              mkdir(paths.importDirectory(importId), { recursive: true }),
            );
          }
          const moved: Array<TransferEntry> = [];
          yield* Effect.forEach(
            pending,
            (entry) =>
              moveIntoImport(importId, entry).pipe(
                Effect.tap(() => Effect.sync(() => moved.push(entry))),
              ),
            { discard: true },
          ).pipe(
            Effect.tapError(() =>
              Effect.forEach(moved.toReversed(), (entry) => moveBack(importId, entry), {
                discard: true,
              }),
            ),
            Effect.uninterruptible,
          );
          return claimed.map((entry) => claimedResult(importId, entry));
        }),
      );
    }).pipe(registry.withPermits(1));

  const releaseImport: ProjectTransfersShape["releaseImport"] = (importId) =>
    Effect.gen(function* () {
      if (!isImportId(importId)) {
        return yield* Effect.logWarning("project-transfers.release-invalid-import-id");
      }
      for (const entry of entries.values()) {
        if (entry.claimedBy === importId) entries.delete(entry.transferId);
      }
      yield* io("delete an import's transfers", () =>
        rm(paths.importDirectory(importId), { recursive: true, force: true }),
      ).pipe(Effect.ignore);
    }).pipe(Effect.uninterruptible, registry.withPermits(1));

  const sweep: ProjectTransfersShape["sweep"] = () => sweepExpired.pipe(registry.withPermits(1));

  const recovered = yield* Effect.tryPromise(() => recoverStore(dirs, paths)).pipe(
    Effect.tap(({ removed }) =>
      removed > 0
        ? Effect.logInfo("project-transfers.recovered", { removedOrphans: removed })
        : Effect.void,
    ),
    Effect.catch((cause) =>
      // The store starts empty; calls that touch the disk report their own failures.
      Effect.logWarning("project-transfers.recover-failed", { cause }).pipe(
        Effect.as({ entries: [] as ReadonlyArray<TransferEntry>, removed: 0 }),
      ),
    ),
  );
  for (const entry of recovered.entries) entries.set(entry.transferId, entry);
  yield* sweep();
  yield* Effect.sleep(options.sweepIntervalMs ?? SWEEP_INTERVAL_MS).pipe(
    Effect.andThen(sweep()),
    Effect.forever,
    Effect.forkScoped,
  );

  return ProjectTransfers.of({
    begin,
    append,
    commit,
    abort,
    claimForImport,
    releaseImport,
    sweep,
  });
});

/** Transfers under the node's state directory. */
export const ProjectTransfersLive = Layer.effect(
  ProjectTransfers,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeProjectTransfers({ stateDir: config.stateDir });
  }),
);
