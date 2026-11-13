/**
 * The composer's offered next prompt: the provider's prediction after the thread's latest turn
 * completed. Read from the thread's one `prompt.suggestion` activity, so web and mobile offer the
 * same thing and it survives reloads and reconnects.
 */
import type { OrchestrationLatestTurn, OrchestrationThreadActivity } from "@ryco/contracts";
import {
  PROMPT_SUGGESTION_ACTIVITY_KIND,
  readPromptSuggestionPayload,
} from "@ryco/shared/promptSuggestion";

export interface PromptSuggestion {
  /** The completed turn the provider predicted from; dismissals are keyed by it. */
  readonly turnId: string;
  readonly text: string;
}

/**
 * The suggestion for the thread's latest turn, or null. Null unless that turn completed (a failed,
 * interrupted or still running turn has none), and null once a newer turn starts, so a suggestion
 * never outlives the reply it followed.
 */
export function derivePromptSuggestion(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity> | undefined;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null | undefined;
}): PromptSuggestion | null {
  const latestTurn = input.latestTurn;
  if (!input.activities || !latestTurn || latestTurn.state !== "completed") return null;
  const activity = input.activities.findLast(
    (candidate) => candidate.kind === PROMPT_SUGGESTION_ACTIVITY_KIND,
  );
  if (!activity || activity.turnId !== latestTurn.turnId) return null;
  const text = readPromptSuggestionPayload(activity.payload);
  return text === undefined ? null : { turnId: latestTurn.turnId, text: text.trim() };
}
