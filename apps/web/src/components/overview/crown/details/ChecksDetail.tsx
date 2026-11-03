import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleXIcon,
} from "lucide-react";
import type { PullRequestWatchTone } from "@ryco/client-runtime/state/threads";
import { useMemo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { handleInAppLinkClick } from "~/pullRequestsRoute";

import { usePullRequestWatchControl } from "~/rpc/useSourceControl";
import { Button } from "../../../ui/button";
import { Switch } from "../../../ui/switch";
import { getOverviewSummary } from "../../overviewSummary.logic";
import type {
  OverviewLayoutProps,
  OverviewPullRequestCheckRun,
  OverviewPullRequestState,
} from "../../overviewTypes";
import {
  CROWN_PILL_BUTTON_CLASS,
  CrownDetailActions,
  CrownDetailEmpty,
  CrownDetailFootnote,
  CrownDetailHeading,
  type CrownDetailViewProps,
} from "./crownDetailPrimitives";

function isFailedTone(tone: OverviewPullRequestCheckRun["tone"]): boolean {
  return tone === "failure" || tone === "error";
}

/** The status glyph (`.sg`): pass / fail / running spinner / queued. */
function CheckGlyph({ tone }: { tone: OverviewPullRequestCheckRun["tone"] }): ReactNode {
  if (tone === "success") return <CircleCheckIcon className="size-3.5 text-success" />;
  if (isFailedTone(tone)) return <CircleXIcon className="size-3.5 text-destructive" />;
  // The crown's spinner; its stylesheet pauses it with the app's activity motion.
  if (tone === "running") return <span className="crown-spin" />;
  if (tone === "cancelled") {
    return <CircleMinusIcon className="size-3.5 text-muted-foreground/60" />;
  }
  return <CircleDashedIcon className="size-3.5 text-muted-foreground/60" />;
}

/** The row's single interactive element: hover wash, focus ring, trailing affordance. */
const CHECK_ROW_ACTION_CLASS =
  "group/check flex h-[27px] w-full min-w-0 items-center gap-2 rounded-md px-1 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring";

const AFFORDANCE_SLOT_CLASS = "-ml-1 size-3 shrink-0";

/**
 * The heading's count insets by what trails a row's meta (row padding 4px,
 * gap 8px, affordance slot 12px − 4px), so the two share a right edge.
 */
const ROW_META_TRAILING_INSET_CLASS = "pr-5";

/**
 * One check run. With a host URL the whole row is a link: a plain click opens
 * the check in the workspace panel's pull request reader when there is one
 * (`onOpenInApp`), ⌘/Ctrl- or middle-click keeps the host page. Without a URL
 * an in-app opener makes it a button; with neither it stays static.
 */
function CheckRunRow({
  run,
  onOpenInApp,
}: {
  run: OverviewPullRequestCheckRun;
  onOpenInApp: ((run: OverviewPullRequestCheckRun) => void) | undefined;
}) {
  const failed = isFailedTone(run.tone);
  const running = run.tone === "running";
  const meta = run.activeDetail ?? run.detail ?? run.statusLabel;
  const openInApp = onOpenInApp ? () => onOpenInApp(run) : undefined;
  const interactive = Boolean(run.url) || openInApp !== undefined;
  // In-app rows lead into the reader (chevron); host-only rows leave Ryco (↗).
  const AffordanceIcon = openInApp ? ChevronRightIcon : ArrowUpRightIcon;
  const content = (
    <>
      <span className="grid size-3.5 shrink-0 place-items-center" title={run.statusLabel}>
        <CheckGlyph tone={run.tone} />
      </span>
      <span className={cn("min-w-0 flex-1 truncate", failed && "text-destructive-foreground")}>
        {run.name}
      </span>
      <span className="max-w-[45%] min-w-0 shrink-0 truncate font-mono text-[10.5px] font-medium text-muted-foreground">
        {meta}
      </span>
      {interactive ? (
        <AffordanceIcon
          aria-hidden="true"
          data-slot="crown-check-affordance"
          className={cn(
            AFFORDANCE_SLOT_CLASS,
            "text-muted-foreground transition-opacity group-hover/check:opacity-100 group-focus-visible/check:opacity-100",
            // Failed rows keep theirs, standing in for the old "View" link.
            failed ? "opacity-70" : "opacity-0",
          )}
        />
      ) : (
        // Static rows keep the slot so every row's meta lines up.
        <span aria-hidden="true" className={AFFORDANCE_SLOT_CLASS} />
      )}
    </>
  );
  // The label replaces the row's content, so it carries the visible meta too.
  const label = [run.name, run.statusLabel, meta !== run.statusLabel ? meta : null]
    .filter(Boolean)
    .join(", ");
  let row: ReactNode;
  if (run.url) {
    row = (
      <a
        href={run.url}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        title={openInApp ? "⌘/Ctrl-click opens the host page" : undefined}
        className={CHECK_ROW_ACTION_CLASS}
        data-opens={openInApp ? "app" : "host"}
        onClick={(event) => handleInAppLinkClick(event, openInApp)}
      >
        {content}
      </a>
    );
  } else if (openInApp) {
    row = (
      <button
        type="button"
        aria-label={label}
        className={CHECK_ROW_ACTION_CLASS}
        data-opens="app"
        onClick={openInApp}
      >
        {content}
      </button>
    );
  } else {
    row = <div className="flex h-[27px] min-w-0 items-center gap-2 px-1">{content}</div>;
  }
  return (
    <li className="relative min-w-0" data-slot="crown-check-row" data-tone={run.tone}>
      {row}
      {running ? (
        // No progress percentage is available, so running rows get an indeterminate bar.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-1 bottom-px left-[26px] h-0.5 overflow-hidden rounded-[1px] bg-muted"
        >
          <span className="crown-check-bar block h-full w-2/5 rounded-[1px] bg-warning" />
        </span>
      ) : null}
    </li>
  );
}

const WATCH_TONE_CLASS: Record<PullRequestWatchTone, string> = {
  muted: "text-muted-foreground",
  active: "font-medium text-foreground",
  warning: "text-warning-foreground",
};

/**
 * The server-side watch of the thread's pull request: the Auto-fix CI switch,
 * what the watch is doing, and Resume / Stop watching. The flyout previews the
 * status line only; the card hosts the controls. Nothing on nodes without pull
 * request watches, and nothing for branch-only CI.
 */
function PullRequestWatchSection({
  layout,
  pullRequest,
  variant,
}: {
  layout: OverviewLayoutProps;
  pullRequest: OverviewPullRequestState;
  variant: CrownDetailViewProps["variant"];
}) {
  const binding = layout.pullRequestWatch;
  const number = pullRequest.number ?? null;
  const url = pullRequest.url ?? null;
  const target = useMemo(() => (number === null ? null : { number, url }), [number, url]);
  const control = usePullRequestWatchControl({
    environmentId: layout.environmentId,
    threadId: binding?.threadId ?? null,
    target,
    watches: binding?.watches,
    closed: pullRequest.state === "merged" || pullRequest.state === "closed",
  });
  if (!control.supported) return null;
  const { view } = control;
  const statusLine = view ? (
    <p className={cn("mx-1 text-[11.5px]", WATCH_TONE_CLASS[view.tone])}>{view.label}</p>
  ) : control.endedLabel ? (
    <p className="mx-1 text-[11.5px] text-muted-foreground">{control.endedLabel}</p>
  ) : null;
  // The flyout previews the status only; a merged or closed pull request only says why its
  // watch ended, if it had one.
  if (variant === "flyout" || !control.switchOffered) {
    return statusLine ? (
      <div className="mt-2" data-slot="crown-pull-request-watch">
        {statusLine}
      </div>
    ) : null;
  }
  const disabled = !control.ready || control.pending;
  return (
    <div className="mt-2.5 flex min-w-0 flex-col gap-1" data-slot="crown-pull-request-watch">
      <div className="flex min-w-0 items-center gap-2 px-1 text-[12px]">
        <span className="min-w-0 flex-1 truncate font-medium" aria-hidden>
          Auto-fix CI
        </span>
        <Switch
          checked={control.autoFixChecked}
          disabled={disabled}
          aria-label="Auto-fix CI"
          title={control.ready ? undefined : "Reconnect to change Auto-fix CI"}
          onCheckedChange={(checked) => control.run(checked ? "auto-fix-on" : "auto-fix-off")}
        />
      </div>
      {statusLine}
      {view?.detail ? (
        <p className="mx-1 text-[11.5px] text-muted-foreground">{view.detail}</p>
      ) : null}
      {view ? (
        <CrownDetailActions>
          {view.paused ? (
            <Button
              variant="ghost"
              size="sm"
              className={CROWN_PILL_BUTTON_CLASS}
              disabled={disabled}
              onClick={() => control.run("resume")}
            >
              Resume
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className={CROWN_PILL_BUTTON_CLASS}
            disabled={disabled}
            onClick={() => control.run("stop")}
          >
            Stop watching
          </Button>
        </CrownDetailActions>
      ) : null}
    </div>
  );
}

export function ChecksDetail({ layout, variant }: CrownDetailViewProps) {
  const pullRequest = layout.pullRequest;
  const summary = getOverviewSummary(layout);
  if (!pullRequest) {
    return (
      <>
        <CrownDetailHeading section="checks" variant={variant} />
        <CrownDetailEmpty>No checks reported</CrownDetailEmpty>
      </>
    );
  }
  // Terminal errors stay loud; transient ones (timeout / network blip) get a
  // quiet muted line, mirroring the classic panel's ChecksContent.
  const error = pullRequest.checksError;
  // Default-branch CI has no pull request to open in Ryco: its rows keep their host links.
  const openCheckInApp = pullRequest.number != null ? layout.onOpenPullRequestCheck : undefined;
  const refName = summary.refName;
  const footnote =
    pullRequest.number != null
      ? `CI on PR #${pullRequest.number}${refName ? ` · ${refName}` : ""}`
      : refName
        ? `CI on ${refName}`
        : null;
  return (
    <>
      <CrownDetailHeading
        section="checks"
        variant={variant}
        meta={
          summary.checksTotal > 0 ? (
            <span className={ROW_META_TRAILING_INSET_CLASS}>
              {summary.checksPassed}/{summary.checksTotal}
            </span>
          ) : undefined
        }
      />
      {error ? (
        <p
          className={cn(
            "px-1 py-1 text-[11.5px]",
            error.kind === "terminal" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {error.message}
        </p>
      ) : null}
      {pullRequest.latestRuns.length > 0 ? (
        <ul className="flex flex-col gap-px">
          {pullRequest.latestRuns.map((run) => (
            <CheckRunRow key={run.id} run={run} onOpenInApp={openCheckInApp} />
          ))}
        </ul>
      ) : error ? null : (
        <CrownDetailEmpty>No checks reported</CrownDetailEmpty>
      )}
      {pullRequest.number != null ? (
        <PullRequestWatchSection layout={layout} pullRequest={pullRequest} variant={variant} />
      ) : null}
      {footnote ? <CrownDetailFootnote>{footnote}</CrownDetailFootnote> : null}
    </>
  );
}
