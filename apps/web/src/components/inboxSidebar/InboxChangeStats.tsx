import type { PrCheckStatusKind } from "../projectExplorer/prCheckStatus";
import { cn } from "../../lib/utils";
import type { InboxChangeStats } from "./inboxPullRequests";

const MAX_DOTS = 12;

const DOT_TONE: Record<PrCheckStatusKind, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  running: "animate-status-pulse bg-muted-foreground/60",
  pending: "animate-status-pulse bg-muted-foreground/60",
  cancelled: "bg-muted-foreground/25",
  unavailable: "bg-muted-foreground/25",
  loading: "bg-muted-foreground/25",
  "api-error": "bg-muted-foreground/25",
};

/** Checks as a dot strip with one verdict, then the diff: one line in the card. */
export function InboxChangeStatsLine(props: { readonly stats: InboxChangeStats }) {
  const { checks, additions, deletions, changedFiles } = props.stats;
  const verdict = checks
    ? checks.failed > 0
      ? { text: `${checks.failed} failing`, tone: "text-destructive-foreground" }
      : checks.active > 0
        ? { text: `${checks.passed}/${checks.total} checks`, tone: "text-muted-foreground" }
        : checks.passed === checks.total
          ? { text: `${checks.total} checks passed`, tone: "text-success-foreground" }
          : { text: `${checks.passed}/${checks.total} checks`, tone: "text-muted-foreground" }
    : null;
  const hasDiff = additions !== null || deletions !== null;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-4"
      data-testid="inbox-preview-stats"
    >
      {checks && verdict ? (
        <span className="flex items-center gap-1.5" aria-label={checks.view.label} role="img">
          <span aria-hidden className="flex items-center gap-[3px]">
            {checks.items.slice(0, MAX_DOTS).map((item) => (
              <span key={item.id} className={cn("size-[5px] rounded-full", DOT_TONE[item.kind])} />
            ))}
          </span>
          {checks.total > MAX_DOTS ? (
            <span aria-hidden className="text-muted-foreground/70">
              +{checks.total - MAX_DOTS}
            </span>
          ) : null}
          <span aria-hidden className={cn("font-medium", verdict.tone)}>
            {verdict.text}
          </span>
        </span>
      ) : null}
      {checks && hasDiff ? (
        <span aria-hidden className="text-muted-foreground/40">
          ·
        </span>
      ) : null}
      {hasDiff ? (
        <span className="flex items-center gap-1 tabular-nums">
          {additions !== null ? (
            <span className="text-success-foreground">+{additions}</span>
          ) : null}
          {deletions !== null ? (
            <span className="text-destructive-foreground">−{deletions}</span>
          ) : null}
          {changedFiles !== null ? (
            <span className="text-muted-foreground/70">
              <span aria-hidden className="pr-1 text-muted-foreground/40">
                ·
              </span>
              {changedFiles} {changedFiles === 1 ? "file" : "files"}
            </span>
          ) : null}
          {props.stats.scope === "working-tree" ? (
            <span className="text-muted-foreground/70">uncommitted</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
