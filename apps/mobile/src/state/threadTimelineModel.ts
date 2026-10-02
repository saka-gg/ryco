import type { Thread } from "@ryco/client-runtime/state/threads";
import {
  deriveThreadActivityViewModel,
  createTimelineEntryIndex,
  type ThreadActivityViewModel,
  type TimelineEntry,
} from "@ryco/client-runtime/state/session";

export interface ThreadTimeline {
  readonly viewModel: ThreadActivityViewModel;
  readonly timeline: ReadonlyArray<TimelineEntry>;
}

/** One builder per mounted timeline; activity work survives text-only updates. */
export function createThreadTimelineBuilder() {
  const index = createTimelineEntryIndex();
  let activities: Thread["activities"] | undefined;
  let turnId: string | null = null;
  let viewModel: ThreadActivityViewModel | undefined;
  return (thread: Thread | null | undefined): ThreadTimeline | null => {
    if (!thread) return null;
    const nextTurnId = thread.latestTurn?.turnId ?? null;
    if (!viewModel || activities !== thread.activities || turnId !== nextTurnId) {
      activities = thread.activities;
      turnId = nextTurnId;
      viewModel = deriveThreadActivityViewModel(activities, nextTurnId);
    }
    const timeline = index.update({
      messages: thread.messages,
      proposedPlans: thread.proposedPlans,
      workEntries: viewModel.workLogEntries,
      contextCompactionEntries: viewModel.contextCompactionEntries,
      contextHandoffEntries: viewModel.contextHandoffEntries,
    });
    return { viewModel, timeline };
  };
}

export function buildThreadTimeline(thread: Thread | null | undefined): ThreadTimeline | null {
  return createThreadTimelineBuilder()(thread);
}
