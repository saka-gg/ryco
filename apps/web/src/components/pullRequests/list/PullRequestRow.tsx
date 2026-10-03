import type { ChangeRequest, SourceControlLabel } from "@ryco/contracts";
import { summarizeChangeRequestChecks } from "@ryco/client-runtime/state/pull-request-review";
import { CopyIcon, ExternalLinkIcon, FolderGit2Icon } from "lucide-react";
import { memo } from "react";

import { openExternalLink } from "../../../lib/openExternalLink";
import { cn } from "../../../lib/utils";
import { INBOX_ROW_KEY_ATTRIBUTE } from "../../inboxSidebar/useInboxListMotion";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger, MenuItem } from "../../ui/menu";
import { Skeleton } from "../../ui/skeleton";
import {
  ActorAvatar,
  CHECKS_OVERALL_LABEL,
  ChangeRequestStateGlyph,
  CheckStateGlyph,
  DiffStat,
  RelativeTime,
  changeRequestStateLabel,
} from "../primitives";
import type { PullRequestReadiness, PullRequestReadinessTone } from "./pullRequestListRows.logic";
import {
  stackFootParts,
  type PullRequestRowSpine,
  type PullRequestStackFoot,
  type StackFootPartTone,
} from "./pullRequestListStacks.logic";

/**
 * One pull request in the list. Line 1: the glyph column (state over checks),
 * the title, the time. Line 2: `#n` and the readiness label — or, for rows
 * waiting on the viewer's review, who wrote it and how big it is (diffstat and
 * file count; the group already says "Needs your review"). Stack layers draw
 * their own spine segments, so each row stands alone (virtualization and FLIP
 * safe). The context menu: copy link, open on the host, check out in a worktree.
 */

export type PullRequestRowDensity = "compact" | "wide";

/** Marks a row's button; the list moves focus between these. */
export const PULL_REQUEST_ROW_BUTTON_ATTRIBUTE = "data-pr-row-button";

/** Shared row geometry; the skeleton uses it too so loading never shifts layout. */
const ROW_GRID_CLASS =
  "grid w-full grid-cols-[1.375rem_minmax(0,1fr)_auto] grid-rows-[18px_16px] gap-y-0.5 py-[7px] pr-2.5 pl-1.5";

const READINESS_TONE_CLASS: Record<PullRequestReadinessTone, string> = {
  neutral: "text-muted-foreground",
  progress: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
  merged: "text-violet-700 dark:text-violet-300",
};

export interface PullRequestRowProps {
  readonly entry: ChangeRequest;
  readonly itemKey: string;
  readonly selected: boolean;
  /** The one row Tab lands on (roving focus): the selected row, else the first. */
  readonly tabStop: boolean;
  readonly readiness: PullRequestReadiness;
  /** Show the author and size instead of the readiness label (needs-your-review rows). */
  readonly reviewer: boolean;
  readonly density: PullRequestRowDensity;
  readonly spine: PullRequestRowSpine | null;
  /** The viewer's login; "wide" rows name other authors. */
  readonly viewerLogin: string | null;
  /** The host's name, for "Open on GitHub". */
  readonly providerName: string;
  readonly onSelect: (number: number) => void;
  readonly onCopyLink: (url: string) => void;
  /** Check this row's pull request out into a worktree; absent when unavailable. */
  readonly onCheckoutWorktree?: ((entry: ChangeRequest) => void) | undefined;
}

export const PullRequestRow = memo(function PullRequestRow(props: PullRequestRowProps) {
  const { entry, readiness, spine } = props;
  const overall = summarizeChangeRequestChecks(entry.checkRollup).overall;
  const ownRow =
    props.viewerLogin !== null &&
    entry.author !== undefined &&
    entry.author.toLowerCase() === props.viewerLogin.toLowerCase();
  const wide = props.density === "wide";
  const author =
    entry.author && (props.reviewer || (wide && !ownRow)) ? (
      <span className="inline-flex min-w-0 shrink items-center gap-1">
        <ActorAvatar login={entry.author} size={14} />
        <span className="truncate">{entry.author}</span>
      </span>
    ) : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        // The list motion hook tracks rows (FLIP, enter) by this key; the
        // selection plate measures the same element.
        {...{ [INBOX_ROW_KEY_ATTRIBUTE]: props.itemKey }}
        data-pr-row={entry.number}
      >
        <button
          type="button"
          {...{ [PULL_REQUEST_ROW_BUTTON_ATTRIBUTE]: entry.number }}
          tabIndex={props.tabStop ? 0 : -1}
          aria-current={props.selected ? "true" : undefined}
          aria-label={rowAccessibleName(entry, props.reviewer ? null : readiness.label)}
          data-stack-edge={spine?.edge}
          className={cn(
            ROW_GRID_CLASS,
            "group/pr-row relative rounded-lg text-left outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            props.selected ? "" : "hover:bg-accent/55",
          )}
          onClick={() => props.onSelect(entry.number)}
        >
          {spine ? <StackSpine spine={spine} /> : null}
          <span className="relative flex items-center justify-center">
            <ChangeRequestStateGlyph state={entry.state} isDraft={entry.isDraft} />
          </span>
          <span
            className={cn(
              "min-w-0 truncate text-[13px] leading-[18px] font-medium",
              props.selected
                ? "text-foreground"
                : "text-foreground/85 group-hover/pr-row:text-foreground",
            )}
          >
            {entry.title}
          </span>
          <RelativeTime
            value={entry.updatedAt}
            className="pl-2 text-[11px] leading-[18px] text-muted-foreground/70"
          />
          <span className="relative flex items-center justify-center">
            <CheckStateGlyph key={overall} overall={overall} className="size-3" />
          </span>
          <span className="col-span-2 flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
            <span className="shrink-0 text-muted-foreground/70 tabular-nums">#{entry.number}</span>
            {props.reviewer ? (
              <>
                {author}
                <DiffStat additions={entry.additions} deletions={entry.deletions} />
                {entry.changedFiles !== undefined ? (
                  <span className="shrink-0 tabular-nums">
                    {entry.changedFiles} {entry.changedFiles === 1 ? "file" : "files"}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <span className={cn("min-w-0 truncate", READINESS_TONE_CLASS[readiness.tone])}>
                  {readiness.label}
                </span>
                {wide ? (
                  <>
                    {author}
                    <RowLabels labels={entry.labels} />
                    <DiffStat
                      additions={entry.additions}
                      deletions={entry.deletions}
                      className="ml-auto pl-2"
                    />
                  </>
                ) : null}
              </>
            )}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuPopup className="min-w-48">
        <MenuItem onClick={() => props.onCopyLink(entry.url)}>
          <CopyIcon aria-hidden />
          Copy link
        </MenuItem>
        <MenuItem onClick={() => openExternalLink(entry.url, "Unable to open pull request")}>
          <ExternalLinkIcon aria-hidden />
          Open on {props.providerName}
        </MenuItem>
        <MenuItem
          disabled={!props.onCheckoutWorktree}
          onClick={() => props.onCheckoutWorktree?.(entry)}
        >
          <FolderGit2Icon aria-hidden />
          Check out in worktree
        </MenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
});

function rowAccessibleName(entry: ChangeRequest, readinessLabel: string | null): string {
  const parts = [entry.title, `#${entry.number}`];
  const state = changeRequestStateLabel(entry);
  if ((entry.state !== "open" || entry.isDraft) && state !== readinessLabel) parts.push(state);
  parts.push(readinessLabel ?? `by ${entry.author ?? "unknown"}`);
  const overall = summarizeChangeRequestChecks(entry.checkRollup).overall;
  if (overall !== "none") parts.push(CHECKS_OVERALL_LABEL[overall].toLowerCase());
  return parts.join(", ");
}

/** Up to two labels as colour dots with names, the rest as a count; only on roomy pages. */
function RowLabels(props: { readonly labels: ReadonlyArray<SourceControlLabel> | undefined }) {
  const labels = props.labels ?? [];
  if (labels.length === 0) return null;
  const shown = labels.slice(0, 2);
  return (
    <span className="hidden shrink-0 items-center gap-2 pl-1 @[38rem]/prs:inline-flex">
      {shown.map((label) => (
        <span key={label.name} className="inline-flex items-center gap-1 text-[11px]">
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-muted-foreground/50"
            style={label.color ? { backgroundColor: `#${label.color}` } : undefined}
          />
          {label.name}
        </span>
      ))}
      {labels.length > shown.length ? (
        <span className="text-[11px] text-muted-foreground/70 tabular-nums">
          +{labels.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The stack's spine through this row's glyph column: a segment above the
 * state glyph (absent on the top layer), one between the two glyphs, and one
 * below the checks glyph. The upper segment continues the layer above's tone.
 */
function StackSpine(props: { readonly spine: PullRequestRowSpine }) {
  const { spine } = props;
  return (
    <span aria-hidden className="pr-stack-spine">
      {spine.edge === "top" ? null : (
        <span className="pr-stack-segment" data-segment="up" data-tone={spine.up} />
      )}
      <span className="pr-stack-segment" data-segment="mid" data-tone={spine.down} />
      <span className="pr-stack-segment" data-segment="down" data-tone={spine.down} />
    </span>
  );
}

const FOOT_TONE_CLASS: Record<StackFootPartTone, string> = {
  landable: "text-success-foreground",
  merged: "text-violet-700 dark:text-violet-300",
  blocked: "text-muted-foreground",
};

/** The stack's base: a ring on the spine, the base branch, and what can land. */
export function StackFoot(props: {
  readonly foot: PullRequestStackFoot;
  readonly itemKey: string;
}) {
  const parts = stackFootParts(props.foot);
  return (
    <div
      {...{ [INBOX_ROW_KEY_ATTRIBUTE]: props.itemKey }}
      data-stack-foot={props.foot.stack}
      className="relative mb-1.5 grid h-6 grid-cols-[1.375rem_minmax(0,1fr)] items-center pr-2.5 pl-1.5 text-[11px] text-muted-foreground"
    >
      <span aria-hidden className="pr-stack-foot-node" data-tone={props.foot.tone}>
        <span className="pr-stack-segment" data-segment="up" data-tone={props.foot.tone} />
        <span className="pr-stack-ring" />
      </span>
      <span className="col-start-2 flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-mono text-muted-foreground/80">
          {props.foot.baseRefName}
        </span>
        {parts.map((part) => (
          <span key={part.tone} className="inline-flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span className={cn("truncate", FOOT_TONE_CLASS[part.tone])}>{part.text}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

const SKELETON_TITLE_WIDTHS = [72, 58, 84, 66, 50, 78, 62, 70];
const SKELETON_LABEL_WIDTHS = [64, 92, 56, 80, 72, 60, 88, 52];

/** A loading row with the loaded row's exact geometry. */
export function PullRequestRowSkeleton(props: { readonly index: number }) {
  const title = SKELETON_TITLE_WIDTHS[props.index % SKELETON_TITLE_WIDTHS.length];
  const label = SKELETON_LABEL_WIDTHS[props.index % SKELETON_LABEL_WIDTHS.length];
  return (
    <div aria-hidden className={ROW_GRID_CLASS}>
      <span className="flex items-center justify-center">
        <Skeleton className="size-3.5 rounded-full" />
      </span>
      <span className="flex items-center">
        <Skeleton className="h-2.5 rounded-full" style={{ width: `${title}%` }} />
      </span>
      <span className="flex items-center pl-2">
        <Skeleton className="h-2 w-5 rounded-full" />
      </span>
      <span className="flex items-center justify-center">
        <Skeleton className="size-3 rounded-full" />
      </span>
      <span className="col-span-2 flex items-center gap-1.5">
        <Skeleton className="h-2 w-7 rounded-full" />
        <Skeleton className="h-2 rounded-full" style={{ width: label }} />
      </span>
    </div>
  );
}
