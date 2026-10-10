/**
 * A project's schedules said in one line — "3 schedules · 1 waiting for
 * approval" — with "Open automations", which grows the Automations dialog
 * out of the button. Settings surfaces show this instead of an embedded
 * centre: schedules are edited in the dialog, in one place.
 */
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { CalendarClockIcon } from "lucide-react";

import { Button } from "../ui/button";
import { openAutomationsDialog } from "./automationsDialogStore";
import { checkoutAutomationCounts } from "./data/automationProjectCounts.logic";
import { useMinuteNow } from "./dialog/clock";
import { plural } from "./dialog/dialogWords";
import { useAutomationCentre } from "./useAutomationCentre";

/** "No schedules yet" · "3 schedules · 1 waiting for approval" · "Loading schedules…" */
export function automationsSummaryLine(
  counts: { readonly schedules: number; readonly waiting: number } | null,
  error: string | null,
): string {
  if (!counts) return error ?? "Loading schedules…";
  const schedules = counts.schedules ? plural(counts.schedules, "schedule") : "No schedules yet";
  return counts.waiting ? `${schedules} · ${counts.waiting} waiting for approval` : schedules;
}

export function AutomationsSummary(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Runs before the dialog opens (a host dialog closing itself first). */
  readonly onOpen?: () => void;
}) {
  const centre = useAutomationCentre(props.environmentId, props.projectId);
  const nowMs = useMinuteNow();
  const counts = centre.snapshot
    ? checkoutAutomationCounts({ projectId: props.projectId, snapshot: centre.snapshot, nowMs })
    : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <CalendarClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-[13px] text-muted-foreground" role="status">
        {automationsSummaryLine(counts, centre.error)}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={(event) => {
          props.onOpen?.();
          openAutomationsDialog({
            environmentId: props.environmentId,
            projectId: props.projectId,
            origin: event.currentTarget,
          });
        }}
      >
        Open automations
      </Button>
    </div>
  );
}
