/**
 * EventLogCompactionState - where event-log compaction keeps its state (`lifecycle_markers`)
 * and how it is read. Shared by the boot-side layer (`EventLogCompactionDeferred.ts`) and the
 * lazily loaded pass (`EventLogCompaction.ts`), which must not import the boot-side layer: that
 * layer hands Statistics to the pass, and a boot module imported from a lazy chunk splits the
 * boot chunk.
 *
 * @module EventLogCompactionState
 */
import { Effect, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import { readLifecycleMarker } from "../lifecycleMarkers.ts";
import {
  CompactionState,
  EMPTY_COMPACTION_STATE,
  type EventLogCompactionMode,
} from "../Services/EventLogCompaction.ts";

export const EVENT_COMPACTION_STATE_KEY = "orchestration_event_compaction";
export const EVENT_COMPACTION_DRY_RUN_STATE_KEY = "orchestration_event_compaction_dry_run";

/** Dry runs keep their own state, so switching one to deleting never skips what it only counted. */
export const compactionStateKey = (mode: EventLogCompactionMode) =>
  mode === "delete" ? EVENT_COMPACTION_STATE_KEY : EVENT_COMPACTION_DRY_RUN_STATE_KEY;

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(CompactionState));

/** The stored state of a mode; the empty state when none (or an undecodable one) is stored. */
export const readCompactionState = (mode: EventLogCompactionMode) =>
  readLifecycleMarker(compactionStateKey(mode)).pipe(
    Effect.map((stored) =>
      Option.isNone(stored)
        ? EMPTY_COMPACTION_STATE
        : Option.getOrElse(decodeState(stored.value), () => EMPTY_COMPACTION_STATE),
    ),
    Effect.mapError(toPersistenceSqlError("EventLogCompaction.readState")),
  );
