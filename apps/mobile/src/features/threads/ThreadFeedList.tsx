import { LegendList, type LegendListProps, type LegendListRef } from "@legendapp/list/react-native";
import { useMemo, useState, type Ref } from "react";

import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import { useThreadTimeline } from "../../state/threadTimeline";
import { buildThreadTimelineRows } from "./threadActivityFold";
import { useThreadStreamHaptics } from "./threadStreamHaptics";
import {
  createThreadListRowAnnotator,
  type ThreadListRow,
  type ThreadListRowFlags,
} from "./threadTimelineList";

/**
 * The thread's feed. It subscribes to the live thread itself, so a streamed delta re-renders the
 * feed alone; the screen around it (header, composer, sheets) follows the thread's chrome
 * selection (`createThreadChromeSelector`) and renders only when that changes.
 */
export function ThreadFeedList(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The running turn whose work folds read "Working…"; null once settled or shown offline. */
  readonly runningTurnId: string | null;
  readonly expandedFoldIds: ReadonlySet<string>;
  readonly flags: ThreadListRowFlags;
  readonly streamHapticsEnabled: boolean;
  readonly listRef: Ref<LegendListRef>;
  readonly listProps: Omit<LegendListProps<ThreadListRow>, "data">;
}) {
  const { environmentId, threadId, runningTurnId, expandedFoldIds, flags, listRef, listProps } =
    props;
  const built = useThreadTimeline(environmentId, threadId);
  useThreadStreamHaptics(
    `${environmentId}:${threadId}`,
    built?.timeline,
    props.streamHapticsEnabled,
  );
  const timeline = built?.timeline;
  const timelineRows = useMemo(
    () =>
      buildThreadTimelineRows({
        entries: timeline ?? [],
        runningTurnId,
        expandedFoldIds,
        // Running folds deliberately use a stable "Working…" label. Sampling
        // the clock only when the timeline changes avoids rebuilding the whole
        // virtualized list every second for a duration that is not displayed.
        now: new Date().toISOString(),
      }),
    [timeline, expandedFoldIds, runningTurnId],
  );
  // Keeps each row's object while its content and flags are unchanged, so rows skip renders.
  const [annotateRows] = useState(createThreadListRowAnnotator);
  const listRows = useMemo(
    () => annotateRows(timelineRows, flags),
    [annotateRows, flags, timelineRows],
  );
  return <LegendList ref={listRef} data={listRows} {...listProps} />;
}
