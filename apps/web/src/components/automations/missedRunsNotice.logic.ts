/**
 * The words of the missed-runs notice: what a device's scheduler caught up
 * on after its server was not running. Pure; times use the dialog's
 * vocabulary (`when`), counts its `plural`.
 */
import type { MissedAutomationRun } from "@ryco/client-runtime/state/agentControl";
import { when } from "@ryco/shared/automationSchedule";

import { plural } from "./dialog/dialogWords";

export interface MissedRunsNoticeView {
  readonly title: string;
  readonly description: string;
  /** One waiting run can be approved from the notice; anything else is reviewed in the dialog. */
  readonly canRunNow: boolean;
}

/** "A" · "A and B" · "A, B and C" · "A, B and 2 more" */
function titleList(titles: readonly string[]): string {
  const shown = titles.length > 3 ? titles.slice(0, 2) : titles;
  const rest = titles.length - shown.length;
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown;
  return parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function missedRunsNoticeView(
  runs: readonly MissedAutomationRun[],
  input: {
    /** The device's name when it is not this app's own server. */
    readonly deviceLabel: string | null;
    readonly nowMs: number;
  },
): MissedRunsNoticeView {
  const offline = `${input.deviceLabel ?? "Ryco"} was offline`;
  const [only] = runs;
  if (runs.length === 1 && only) {
    const later = only.laterOccurrences
      ? ` (and ${plural(only.laterOccurrences, "later time")}, folded into one run)`
      : "";
    const due = `Due ${when(only.scheduledFor, input.nowMs)}${later} while ${offline}.`;
    return {
      title: `Missed run · ${only.title}`,
      description:
        only.state === "waiting"
          ? `${due} Run it now?`
          : `${due} Its catch-up run wasn't approved within 15 min.`,
      canRunNow: only.state === "waiting",
    };
  }
  const waiting = runs.filter((run) => run.state === "waiting").length;
  return {
    title: `${runs.length} automations missed their runs`,
    description:
      `${offline} when ${titleList(runs.map((run) => run.title))} came due.` +
      (waiting ? ` ${plural(waiting, "catch-up run")} waiting for approval.` : ""),
    canRunNow: false,
  };
}
