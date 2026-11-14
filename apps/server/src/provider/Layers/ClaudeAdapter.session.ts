/**
 * Claude session-context helpers that need no adapter state: clock and resume cursor.
 */
import { DateTime, Effect } from "effect";

import { planTasksCursorField } from "../claudePlanTasks.ts";
import type { ClaudeSessionContext } from "./ClaudeAdapter.types.ts";

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** The cursor's `transcriptSeen`, for the session it resumes. */
export const transcriptSeenMarker = (context: ClaudeSessionContext) =>
  context.resumeSessionId !== undefined && context.transcriptSeenFor === context.resumeSessionId
    ? { transcriptSeen: true as const }
    : {};

export const updateResumeCursor = Effect.fnUntraced(function* (context: ClaudeSessionContext) {
  if (!context.session.threadId) return;
  // Yield before reading the session: a spread taken across a yield would write back a
  // stale status/activeTurnId over a concurrent turn install.
  const updatedAt = yield* nowIso;
  const threadId = context.session.threadId;
  const resumeCursor = {
    threadId,
    ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
    ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
    ...(context.pendingRewind ? { rewind: { at: context.pendingRewind.at } } : {}),
    turnCount: context.completedTurnIds.length,
    ...transcriptSeenMarker(context),
    // A resumed session must still know the tasks an update names only by id.
    ...planTasksCursorField(context.planTasks, context.resumeSessionId),
  };
  context.session = { ...context.session, resumeCursor, updatedAt };
});
