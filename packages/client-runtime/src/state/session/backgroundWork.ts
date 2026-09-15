import { deriveBackgroundWork, type BackgroundWork } from "@ryco/shared/backgroundWork";
import type { OrchestrationThreadActivity } from "@ryco/contracts";
import type { ThreadSession } from "../threads/types.ts";

/** Connection loss is uncertainty, not evidence that the provider process died. */
export function deriveThreadBackgroundWork(
  activities: readonly OrchestrationThreadActivity[],
  session: ThreadSession | null,
): BackgroundWork {
  if (
    !session ||
    session.orchestrationStatus === "stopped" ||
    session.orchestrationStatus === "interrupted"
  ) {
    return { tasks: [], detailsOmitted: false };
  }
  return deriveBackgroundWork(activities, session.runtimeSessionId);
}
