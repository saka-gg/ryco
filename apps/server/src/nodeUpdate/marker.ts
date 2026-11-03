/**
 * nodeUpdate/marker - The note a node leaves itself before it restarts into a release.
 *
 * An update ends with this process going away, so its result can only be reported by
 * the process that comes back. Before the restart the node writes the request into
 * its state directory; on boot the new process reads it once, reports whether it came
 * back on the target release, and deletes it. Markers older than a day are ignored:
 * nobody is waiting for that answer any more.
 *
 * A CLI update also records how to undo it (`rollback`): the boot guard (bootGuard.ts)
 * counts the target's starts in `bootAttempts` until the server marks it `readyAt`, and
 * after too many it reinstalls the previous release, restores the database snapshot and
 * records `rolledBack`, which the previous release then reports. Every field added for
 * that is optional, so markers from earlier releases (and desktop updates) still decode. An
 * update the node ran on its own says so (`unattended`).
 *
 * @module nodeUpdate/marker
 */
import {
  IsoDateTime,
  NonNegativeInt,
  type NodeUpdateRun,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@ryco/contracts";
import { Duration, Effect, FileSystem, Option, Schema } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { NODE_UPDATE_MARKER_FILE_NAME, NODE_UPDATE_MARKER_MAX_AGE_MS } from "./updateProtocol.ts";

export { NODE_UPDATE_MARKER_FILE_NAME };
export const NODE_UPDATE_MARKER_MAX_AGE = Duration.millis(NODE_UPDATE_MARKER_MAX_AGE_MS);

/** The shape `bootGuard.ts` reads without Effect: keep the two in step. */
export const NodeUpdateRollbackPlan = Schema.Struct({
  /** Reinstalls `fromVersion` into the installation the update changed. */
  install: Schema.Struct({
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
    timeoutMs: PositiveInt,
  }),
  databasePath: TrimmedNonEmptyString,
  /** The database as it was right before the restart. */
  snapshotPath: TrimmedNonEmptyString,
});
export type NodeUpdateRollbackPlan = typeof NodeUpdateRollbackPlan.Type;

/** Written by the boot guard once the previous release is reinstalled. */
export const NodeUpdateRolledBack = Schema.Struct({
  at: IsoDateTime,
  /** Starts of the target that never got ready. */
  failedBoots: NonNegativeInt,
  databaseRestored: Schema.Boolean,
  databaseError: Schema.optional(Schema.String),
  /** The tail of what the reinstall printed. */
  output: Schema.optional(Schema.String),
});

export const NodeUpdateMarker = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  fromVersion: TrimmedNonEmptyString,
  targetVersion: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
  rollback: Schema.optional(NodeUpdateRollbackPlan),
  bootAttempts: Schema.optional(NonNegativeInt),
  readyAt: Schema.optional(IsoDateTime),
  rolledBack: Schema.optional(NodeUpdateRolledBack),
  /**
   * Nobody asked for this update: the node updated itself (`nodeAutoUpdater.ts`). The restarted
   * release then exits when it is not ready in time, so the boot guard counts the start and rolls
   * back (`awaitNodeReadyAfterUpdate`'s watchdog); an update someone runs is left to them.
   */
  unattended: Schema.optional(Schema.Literal(true)),
});
export type NodeUpdateMarker = typeof NodeUpdateMarker.Type;

const NodeUpdateMarkerJson = Schema.fromJsonString(NodeUpdateMarker);
const decodeMarker = Schema.decodeUnknownEffect(NodeUpdateMarkerJson);
const encodeMarker = Schema.encodeEffect(NodeUpdateMarkerJson);

const isStale = (marker: NodeUpdateMarker, nowMs: number) => {
  const startedAtMs = Date.parse(marker.startedAt);
  return (
    !Number.isFinite(startedAtMs) ||
    nowMs - startedAtMs > Duration.toMillis(NODE_UPDATE_MARKER_MAX_AGE)
  );
};

/**
 * Whether this process is the update's target, restarted with a rollback plan and not yet
 * ready: the boot guard counts its starts until the server confirms it is ready.
 */
export function markerAwaitsBootReady(input: {
  readonly marker: NodeUpdateMarker;
  readonly runningVersion: string;
  readonly nowMs: number;
}): boolean {
  const { marker } = input;
  return (
    marker.rollback !== undefined &&
    marker.readyAt === undefined &&
    marker.rolledBack === undefined &&
    input.runningVersion === marker.targetVersion &&
    !isStale(marker, input.nowMs)
  );
}

const rollbackMessage = (
  marker: NodeUpdateMarker,
  rolledBack: typeof NodeUpdateRolledBack.Type,
) => {
  const attempts =
    rolledBack.failedBoots === 1 ? "1 attempt" : `${rolledBack.failedBoots} attempts`;
  const failure = `Ryco ${marker.targetVersion} did not finish starting (${attempts}), so the node rolled back to ${marker.fromVersion}`;
  return rolledBack.databaseRestored
    ? `${failure} and restored the database from before the update.`
    : `${failure}, but could not restore the database from before the update: ${rolledBack.databaseError ?? "unknown error"}.`;
};

/**
 * The run a restarted process reports for `marker`, or `null` when the marker is too
 * old (or unreadable in time) to answer anyone.
 */
export function bootRunFromMarker(input: {
  readonly marker: NodeUpdateMarker;
  readonly runningVersion: string;
  readonly nowMs: number;
}): NodeUpdateRun | null {
  const { marker } = input;
  if (isStale(marker, input.nowMs)) return null;
  const rolledBack = marker.rolledBack;
  const succeeded = rolledBack === undefined && input.runningVersion === marker.targetVersion;
  return {
    status: succeeded ? "succeeded" : "failed",
    requestId: marker.requestId,
    fromVersion: marker.fromVersion,
    targetVersion: marker.targetVersion,
    startedAt: marker.startedAt,
    finishedAt: new Date(input.nowMs).toISOString(),
    restartAt: null,
    progressPercent: null,
    message: succeeded
      ? null
      : rolledBack !== undefined
        ? rollbackMessage(marker, rolledBack)
        : `Restarted on ${input.runningVersion} instead of ${marker.targetVersion}.`,
    output: rolledBack?.output ?? null,
  };
}

/** The marker at `filePath`; an unreadable one is deleted and reads as none. */
export const readNodeUpdateMarker = Effect.fn("readNodeUpdateMarker")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(filePath).pipe(Effect.option);
  if (Option.isNone(raw)) return Option.none<NodeUpdateMarker>();
  const marker = yield* decodeMarker(raw.value).pipe(Effect.option);
  if (Option.isNone(marker)) yield* removeNodeUpdateMarker(filePath);
  return marker;
});

export const writeNodeUpdateMarker = Effect.fn("writeNodeUpdateMarker")(function* (
  filePath: string,
  marker: NodeUpdateMarker,
) {
  const contents = yield* encodeMarker(marker);
  yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` });
});

/** Best effort: a marker that cannot be deleted is ignored once it is a day old. */
export const removeNodeUpdateMarker = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(filePath, { force: true });
  }).pipe(Effect.ignore);
