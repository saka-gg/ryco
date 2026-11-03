/**
 * ThreadTrashRetirement - one-time move of Trash into Archive.
 *
 * Trash used to be a place conversations stayed in until the user emptied it. It is now only the
 * short undo window of a deletion (`ThreadPurgeReactor` deletes a trashed thread permanently once
 * `THREAD_DELETE_GRACE_MS` passed). Conversations that were already in Trash were never meant to
 * be deleted by that, so they are moved to Archive once, before anything is purged.
 *
 * The `trash_retired_at` lifecycle marker records the retirement. It is captured before the read
 * model is read, so every conversation this pass saw in Trash was trashed at or before it, and the
 * purge reactor only deletes threads trashed strictly after it. A conversation whose project was
 * removed cannot be restored (the decider refuses `thread.untrash`); it stays in Trash and, being
 * older than the marker, is never purged.
 *
 * @module ThreadTrashRetirement
 */
import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ThreadId,
} from "@ryco/contracts";
import { Cause, Clock, Effect, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  readLifecycleMarker,
  writeLifecycleMarkerOnce,
} from "../../persistence/lifecycleMarkers.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

export const TRASH_RETIRED_AT_MARKER = "trash_retired_at";

export const trashRetirementCommandId = (step: "untrash" | "archive", threadId: ThreadId) =>
  CommandId.make(`trash-retirement:${step}:${threadId}`);

/**
 * Moves every conversation in Trash to Archive unless the retirement was recorded already.
 * Returns the `trash_retired_at` marker, or `null` when it could not be established: purging
 * must then wait for a later start. Never fails; command failures are logged per thread and do
 * not block the marker (their deterministic ids keep a retry from repeating an accepted step).
 */
export const retireThreadTrash = <E>(input: {
  readonly dispatch: OrchestrationEngineShape["dispatch"];
  readonly readModel: Effect.Effect<OrchestrationReadModel, E>;
}): Effect.Effect<string | null, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const existing = yield* readLifecycleMarker(TRASH_RETIRED_AT_MARKER);
    if (Option.isSome(existing)) return existing.value;

    const retiredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const readModel = yield* input.readModel;
    const trashed = readModel.threads.filter(
      (thread) => thread.deletedAt !== null && thread.trashedAt != null,
    );
    const dispatchLogged = (command: OrchestrationCommand, threadId: ThreadId) =>
      input.dispatch(command).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("trash retirement could not move a conversation to Archive", {
                threadId,
                commandType: command.type,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );

    let archived = 0;
    for (const thread of trashed) {
      const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
      if (project === undefined || project.deletedAt !== null) {
        yield* Effect.logInfo("trash retirement kept a conversation whose project was removed", {
          threadId: thread.id,
          projectId: thread.projectId,
        });
        continue;
      }
      const restored = yield* dispatchLogged(
        {
          type: "thread.untrash",
          commandId: trashRetirementCommandId("untrash", thread.id),
          threadId: thread.id,
        },
        thread.id,
      );
      if (!restored) continue;
      // Trash kept the archive state, so an archived conversation is already where it belongs.
      if (thread.archivedAt === null) {
        yield* dispatchLogged(
          {
            type: "thread.archive",
            commandId: trashRetirementCommandId("archive", thread.id),
            threadId: thread.id,
          },
          thread.id,
        );
      }
      archived += 1;
    }

    const marker = yield* writeLifecycleMarkerOnce(TRASH_RETIRED_AT_MARKER, retiredAt);
    if (trashed.length > 0) {
      yield* Effect.logInfo("retired Trash: moved conversations to Archive", {
        archived,
        kept: trashed.length - archived,
      });
    }
    return marker;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("trash retirement failed; deleted conversations are kept for now", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
    ),
  );
