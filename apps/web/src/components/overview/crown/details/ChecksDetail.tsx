import { CircleCheckIcon, CircleDashedIcon, CircleMinusIcon, CircleXIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { getOverviewSummary } from "../../overviewSummary.logic";
import type { OverviewPullRequestCheckRun } from "../../overviewTypes";
import {
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

function CheckRunRow({ run }: { run: OverviewPullRequestCheckRun }) {
  const failed = isFailedTone(run.tone);
  const running = run.tone === "running";
  const meta = run.activeDetail ?? run.detail ?? run.statusLabel;
  return (
    <li
      className="relative flex h-[27px] min-w-0 items-center gap-2 px-1"
      data-slot="crown-check-row"
      data-tone={run.tone}
    >
      <span className="grid size-3.5 shrink-0 place-items-center" title={run.statusLabel}>
        <CheckGlyph tone={run.tone} />
      </span>
      <span className={cn("min-w-0 flex-1 truncate", failed && "text-destructive-foreground")}>
        {run.name}
      </span>
      {failed && run.url ? (
        <a
          href={run.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`View ${run.name}`}
          className="shrink-0 rounded-sm text-[11.5px] font-medium text-info-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          View
        </a>
      ) : null}
      <span className="max-w-[45%] min-w-0 shrink-0 truncate font-mono text-[10.5px] font-medium text-muted-foreground">
        {meta}
      </span>
      {running ? (
        // No progress percentage is available, so running rows get an indeterminate bar.
        <span
          aria-hidden="true"
          className="absolute right-1 bottom-px left-[26px] h-0.5 overflow-hidden rounded-[1px] bg-muted"
        >
          <span className="crown-check-bar block h-full w-2/5 rounded-[1px] bg-warning" />
        </span>
      ) : null}
    </li>
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
          summary.checksTotal > 0 ? `${summary.checksPassed}/${summary.checksTotal}` : undefined
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
            <CheckRunRow key={run.id} run={run} />
          ))}
        </ul>
      ) : error ? null : (
        <CrownDetailEmpty>No checks reported</CrownDetailEmpty>
      )}
      {footnote ? <CrownDetailFootnote>{footnote}</CrownDetailFootnote> : null}
    </>
  );
}
