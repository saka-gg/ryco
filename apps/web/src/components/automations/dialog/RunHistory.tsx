/**
 * A schedule's finished runs. One roving tab stop: ↑/↓ Home End move, ↵ acts
 * (opens the thread or retries), U toggles unread — the keys are handled by
 * the dialog; this renders the stop and its buttons.
 */
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  AUTOMATION_RUN_STATUS,
  scheduleRetryState,
  type ScheduleRetryState,
  type ScheduleRow,
} from "@ryco/client-runtime/state/agentControl";
import type { AutomationCentreRun } from "@ryco/contracts";
import { when } from "@ryco/shared/automationSchedule";
import { ArrowUpRightIcon, RefreshCwIcon } from "lucide-react";
import { useId } from "react";

import { cn } from "../../../lib/utils";
import { selectSidebarThreadSummaryByRef, useStore } from "../../../store";
import { DialogButton, type ScheduleDialogActions } from "./dialogControls";
import type { DialogRow } from "./dialogModel.logic";
import { runAriaLabel, runHistoryText, runStatusLabel } from "./dialogWords";

/** How many runs show before "Show all". */
export const RUN_HISTORY_PREVIEW = 6;

export function RunHistory(props: {
  readonly item: DialogRow;
  /** The checkout's rows, for the retry rules. */
  readonly scheduleRows: readonly ScheduleRow[];
  readonly nowMs: number;
  readonly showAll: boolean;
  readonly focusRunId: string | null;
  readonly lockedReason: string | null;
  readonly actions: ScheduleDialogActions;
}) {
  const { item, actions } = props;
  const runs = item.row.history;
  const shown = props.showAll ? runs : runs.slice(0, RUN_HISTORY_PREVIEW);
  const unread = runs.filter((entry) => entry.unread).length;
  const current = shown.some((entry) => entry.run.runId === props.focusRunId)
    ? props.focusRunId
    : (shown[0]?.run.runId ?? null);
  const retry = new Map(
    shown.map((entry) => [entry.run.runId, scheduleRetryState(entry, props.scheduleRows)]),
  );
  const held = shown
    .map((entry) => retry.get(entry.run.runId)?.block ?? null)
    .find((block) => block?.active);
  return (
    <section className="ad-sec ad-hist">
      <h4 className="ad-sec-h">
        Runs{" "}
        <span className="ad-muted tnum">
          {runs.length}
          {unread ? ` · ${unread} unread` : ""}
        </span>
        {held ? <span className="ad-hist-why">{held.short}</span> : null}
      </h4>
      {runs.length ? (
        <>
          <ul className="ad-runs" aria-label="Run history">
            {shown.map((entry) => (
              <RunHistoryItem
                key={entry.run.runId}
                item={item}
                entry={entry}
                nowMs={props.nowMs}
                tabStop={entry.run.runId === current}
                retry={retry.get(entry.run.runId) ?? null}
                lockedReason={props.lockedReason}
                actions={actions}
              />
            ))}
          </ul>
          {runs.length > RUN_HISTORY_PREVIEW ? (
            <button
              type="button"
              className="ad-link"
              data-act="toggle-hist"
              onClick={() => actions.toggleHistory(item.key)}
            >
              {props.showAll ? "Show fewer" : `Show all ${runs.length}`}
            </button>
          ) : null}
        </>
      ) : (
        <p className="ad-muted ad-none">No runs yet.</p>
      )}
    </section>
  );
}

function RunHistoryItem(props: {
  readonly item: DialogRow;
  readonly entry: AutomationCentreRun;
  readonly nowMs: number;
  readonly tabStop: boolean;
  readonly retry: ScheduleRetryState | null;
  readonly lockedReason: string | null;
  readonly actions: ScheduleDialogActions;
}) {
  const { item, entry, actions } = props;
  const { run } = entry;
  const threadId = entry.threadIds[0] ?? null;
  const threadTitle = useStore((state) =>
    threadId
      ? (selectSidebarThreadSummaryByRef(state, scopeThreadRef(item.environmentId, threadId))
          ?.title ?? null)
      : null,
  );
  const text = runHistoryText(entry, threadTitle);
  const tabIndex = props.tabStop ? 0 : -1;
  const id = useId();
  const textId = `${id}-text`;
  const whyId = `${id}-why`;
  const why = props.retry?.block && !props.retry.block.active ? props.retry.block : null;
  let action = null;
  let described = textId;
  if (run.status === "completed" && threadId)
    action = (
      <DialogButton
        tone="quiet"
        size="xs"
        tabIndex={tabIndex}
        dataAct="open-thread"
        onAction={() => actions.openThread(item, entry)}
      >
        Open thread
        <ArrowUpRightIcon />
      </DialogButton>
    );
  else if (props.retry?.ok)
    action = (
      <DialogButton
        tone="quiet"
        size="xs"
        tabIndex={tabIndex}
        tip="Asks for approval again"
        offReason={props.lockedReason}
        dataAct="retry"
        onAction={() => actions.retry(item, entry)}
      >
        <RefreshCwIcon />
        Retry
      </DialogButton>
    );
  else if (why) {
    described = `${textId} ${whyId}`;
    action = (
      <span className="ad-run-why" title={why.long}>
        {why.short}
        {/* The whole reason, for the run's tab stop (the title is pointer-only). */}
        <span id={whyId} className="sr-only">
          {why.long}
        </span>
      </span>
    );
  }
  return (
    <li
      className="ad-run"
      data-run={run.runId}
      data-status={run.status}
      data-unread={entry.unread ? "" : undefined}
      tabIndex={tabIndex}
      aria-label={runAriaLabel(entry, props.nowMs)}
      // The name is the status and time; what happened (and why it can't be
      // retried) is the description, so the tab stop says all the row shows.
      aria-describedby={described}
      onClick={(event) => {
        // Its buttons act on their own (Open thread also marks it read).
        if (event.target instanceof Element && event.target.closest("[data-act]")) return;
        actions.focusRun(item.key, run.runId);
        if (entry.unread) actions.setUnread(item, entry, false);
      }}
    >
      <span
        className="ad-dot"
        data-tone={AUTOMATION_RUN_STATUS[run.status].tone}
        aria-hidden="true"
      />
      <span className="ad-run-l">{runStatusLabel(run.status)}</span>
      <span className="ad-run-w tnum">{when(run.scheduledFor, props.nowMs)}</span>
      <span
        id={textId}
        className={cn(
          "ad-run-t",
          run.status === "completed" && "ad-trunc",
          text.tone === "err" && "ad-tone-err",
        )}
      >
        {text.missed ? <span className="ad-run-co">{text.missed}</span> : null}
        {text.retry ? <span className="ad-muted">Retry · </span> : null}
        {text.text}
      </span>
      <span className="ad-run-a">{action}</span>
    </li>
  );
}
