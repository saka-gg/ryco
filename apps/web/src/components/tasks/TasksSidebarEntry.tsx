import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { TASKS_ROUTE_PATH } from "~/tasksRoute";

import {
  DESTINATION_CLASS_NAME,
  FoldedTooltip,
  WaitingBadge,
  destinationStyle,
} from "../sidebar/SidebarPrimaryActions";
import { useTasksNeedingUserCount } from "./useTasksNeedingUserCount";

/**
 * The sidebar's Tasks destination, with a badge for open tasks whose chat
 * waits on the user. The count lives here, not in the sidebar, so a change
 * re-renders only this row. It never imports page code: the sidebar is part
 * of the boot graph.
 */
export const TasksSidebarEntry = memo(function TasksSidebarEntry(props: {
  readonly folded: boolean;
  readonly index: number;
  /** The Tasks page is open. */
  readonly current: boolean;
}) {
  const needingYou = useTasksNeedingUserCount();
  return (
    <FoldedTooltip
      folded={props.folded}
      label="Tasks"
      badge={needingYou > 0 ? <WaitingBadge>{needingYou}</WaitingBadge> : null}
    >
      <Link
        to={TASKS_ROUTE_PATH}
        aria-current={props.current ? "page" : undefined}
        aria-label={
          needingYou > 0
            ? `Tasks, ${needingYou} ${needingYou === 1 ? "needs" : "need"} you`
            : "Tasks"
        }
        data-testid="sidebar-tasks-link"
        style={destinationStyle(props.index)}
        className={cn(
          DESTINATION_CLASS_NAME,
          props.current
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground/70",
        )}
      />
    </FoldedTooltip>
  );
});
