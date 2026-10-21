/**
 * nodeUpdate/marker - The note a node leaves itself before it restarts into a release.
 *
 * An update ends with this process going away, so its result can only be reported by
 * the process that comes back. Before the restart the node writes the request into
 * its state directory; on boot the new process reads it once, reports whether it came
 * back on the target release, and deletes it. Markers older than a day are ignored:
 * nobody is waiting for that answer any more.
 *
 * @module nodeUpdate/marker
 */
import { IsoDateTime, type NodeUpdateRun, TrimmedNonEmptyString } from "@ryco/contracts";
import { Duration, Effect, FileSystem, Option, Schema } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";

export const NODE_UPDATE_MARKER_FILE_NAME = "node-update.json";
export const NODE_UPDATE_MARKER_MAX_AGE = Duration.hours(24);

export const NodeUpdateMarker = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  fromVersion: TrimmedNonEmptyString,
  targetVersion: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
});
export type NodeUpdateMarker = typeof NodeUpdateMarker.Type;

const NodeUpdateMarkerJson = Schema.fromJsonString(NodeUpdateMarker);
const decodeMarker = Schema.decodeUnknownEffect(NodeUpdateMarkerJson);
const encodeMarker = Schema.encodeEffect(NodeUpdateMarkerJson);

/**
 * The run a restarted process reports for `marker`, or `null` when the marker is too
 * old (or unreadable in time) to answer anyone.
 */
export function bootRunFromMarker(input: {
  readonly marker: NodeUpdateMarker;
  readonly runningVersion: string;
  readonly nowMs: number;
}): NodeUpdateRun | null {
  const startedAtMs = Date.parse(input.marker.startedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  if (input.nowMs - startedAtMs > Duration.toMillis(NODE_UPDATE_MARKER_MAX_AGE)) return null;
  const succeeded = input.runningVersion === input.marker.targetVersion;
  return {
    status: succeeded ? "succeeded" : "failed",
    requestId: input.marker.requestId,
    fromVersion: input.marker.fromVersion,
    targetVersion: input.marker.targetVersion,
    startedAt: input.marker.startedAt,
    finishedAt: new Date(input.nowMs).toISOString(),
    restartAt: null,
    progressPercent: null,
    message: succeeded
      ? null
      : `Restarted on ${input.runningVersion} instead of ${input.marker.targetVersion}.`,
    output: null,
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
