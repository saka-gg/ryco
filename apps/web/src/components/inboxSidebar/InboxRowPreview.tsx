import { FolderIcon, GitBranchIcon, GitForkIcon, InfoIcon, ShieldAlertIcon } from "lucide-react";

import { formatElapsedClockLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { DeviceIcon } from "../DeviceIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { InboxContextHandoffPreview } from "./InboxContextHandoffPreview";
import { InboxPullRequestBadges } from "./InboxPullRequestBadges";
import type { resolveInboxPullRequests } from "./inboxPullRequests";
import {
  inboxAttentionDetail,
  inboxGlyphLabel,
  resolveInboxGlyph,
  resolveInboxStateLine,
} from "./inboxRowPresentation";
import { describeInboxFocus, type InboxSidebarRow } from "./inboxSidebarModel";
import { InboxStatusGlyph } from "./InboxStatusGlyph";
import { useInboxClock } from "./useInboxListMotion";

/** What a row hands the shared preview card when it becomes the hovered trigger. */
export interface InboxRowPreviewPayload {
  readonly row: InboxSidebarRow;
  readonly unseen: boolean;
  readonly timestamp: string;
  readonly pullRequests: ReturnType<typeof resolveInboxPullRequests>;
  readonly changeRequestShortName: string;
  readonly sourceControlName: string;
}

const STATUS_TONE = {
  "needs-input": "text-warning-foreground",
  completed: "text-success-foreground",
  error: "text-destructive-foreground",
  working: "text-foreground",
  connecting: "text-muted-foreground",
  offline: "text-muted-foreground",
  idle: "text-muted-foreground",
} as const;

export function InboxProjectIcon(props: {
  readonly row: InboxSidebarRow;
  readonly className?: string;
}) {
  const project = props.row.project;
  if (!project) {
    return (
      <FolderIcon aria-hidden className={`${props.className ?? "size-3.5"} shrink-0 opacity-60`} />
    );
  }
  return (
    <ProjectFavicon
      key={`${props.row.environmentId}:${project.id}:${project.customAvatarContentHash ?? ""}`}
      environmentId={props.row.environmentId}
      cwd={project.cwd}
      projectId={project.id}
      customAvatarContentHash={project.customAvatarContentHash ?? null}
      className={`${props.className ?? "size-3.5"} shrink-0`}
    />
  );
}

function RunningClock(props: { readonly since: string }) {
  const now = useInboxClock();
  return <>{formatElapsedClockLabel(props.since, now)}</>;
}

/**
 * The hover card: state, title, the one actionable fact, then where the work
 * lives. No tool calls, no reasoning; the transcript owns those.
 */
export function InboxRowPreview({ payload }: { readonly payload: InboxRowPreviewPayload }) {
  const { row, unseen } = payload;
  const glyph = resolveInboxGlyph(row, unseen);
  const line = resolveInboxStateLine(row);
  const ProviderIcon = row.providerDriver
    ? (PROVIDER_ICON_BY_PROVIDER[row.providerDriver] ?? null)
    : null;
  const WorkspaceIcon = row.isWorktree ? GitForkIcon : GitBranchIcon;
  const focus = row.focus ? describeInboxFocus(row.focus) : null;
  return (
    <div className="w-[18.875rem] space-y-2 py-1.5 text-left" data-testid="inbox-preview">
      <div className="flex min-w-0 items-center gap-3 text-[11px] leading-4">
        <span
          className={`inline-flex min-w-0 items-center gap-1.5 font-medium ${STATUS_TONE[glyph]}`}
          data-testid="inbox-preview-status"
        >
          <InboxStatusGlyph key={glyph} kind={glyph} />
          <span className="truncate">{inboxGlyphLabel(row, unseen)}</span>
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/75">
          {row.runningSince ? (
            <RunningClock since={row.runningSince} />
          ) : (
            formatRelativeTimeLabel(payload.timestamp)
          )}
        </span>
      </div>
      <p
        className="line-clamp-2 text-[13px] font-semibold leading-[18px] text-popover-foreground"
        data-testid="inbox-preview-title"
      >
        {row.title}
      </p>
      {line.kind === "error" ? (
        <p className="rounded-md bg-destructive/8 px-2 py-1.5 font-mono text-[10.5px] leading-4 break-words text-destructive-foreground">
          {line.text}
        </p>
      ) : line.kind === "attention" ? (
        <p className="text-[11.5px] leading-4 text-warning-foreground">
          {inboxAttentionDetail(row)}
        </p>
      ) : line.kind === "status" ? (
        <p className="text-[11.5px] leading-4 text-muted-foreground">{line.text}</p>
      ) : null}
      <div className="space-y-1.5 border-t border-border/60 pt-2 text-[11px] leading-4 text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          <InboxProjectIcon row={row} />
          <span className="shrink-0 font-medium text-popover-foreground/90">
            {row.projectLabel}
          </span>
          <span aria-hidden className="text-muted-foreground/40">
            /
          </span>
          <WorkspaceIcon
            aria-label={row.isWorktree ? "Worktree" : "Original directory"}
            role="img"
            className="size-3 shrink-0"
          />
          <span className="truncate font-mono text-[10.5px]">
            {row.branchLabel ?? row.workspaceLabel}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <DeviceIcon
              environmentId={row.environmentId}
              label={row.machineLabel}
              className="size-3 shrink-0"
            />
            <span className="truncate">{row.machineLabel}</span>
          </span>
          {row.providerLabel ? (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              {/* The provider logo names the agent; the text names the model. */}
              <span className="flex min-w-0 items-center gap-1.5">
                {ProviderIcon ? (
                  <ProviderIcon
                    aria-label={row.providerLabel}
                    className="size-3 shrink-0"
                    role="img"
                  />
                ) : null}
                <span className="truncate">{row.modelLabel ?? row.providerLabel}</span>
              </span>
            </>
          ) : null}
        </div>
        {payload.pullRequests.requests.length > 0 ? (
          <InboxPullRequestBadges
            {...payload.pullRequests}
            providerName={payload.sourceControlName}
            shortName={payload.changeRequestShortName}
          />
        ) : null}
        {row.trustLabel || row.roleLabel ? (
          <div className="flex flex-wrap items-center gap-1">
            {row.trustLabel ? (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 text-[10px]">
                {row.trustLabel !== "Encrypted · Account trusted" ? (
                  <ShieldAlertIcon aria-hidden className="size-3 text-warning-foreground" />
                ) : null}
                {row.trustLabel}
              </span>
            ) : null}
            {row.roleLabel ? (
              <span className="rounded bg-muted px-1 py-0.5 text-[10px]">{row.roleLabel}</span>
            ) : null}
          </div>
        ) : null}
        {row.modelSelection ? (
          <InboxContextHandoffPreview
            key={`${row.key}:${row.modelSelection.instanceId}:${row.modelSelection.model}:${row.updatedAt}`}
            environmentId={row.environmentId}
            threadId={row.threadId}
            selection={row.modelSelection}
          />
        ) : null}
      </div>
      {focus ? (
        <div className="border-t border-border/60 pt-1.5 text-[11px] leading-4 text-muted-foreground">
          <div className="flex items-start gap-2 text-popover-foreground/85">
            <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="whitespace-normal">
              <span className="font-medium">Why focused? {focus.title}.</span> {focus.detail}
            </span>
          </div>
          {focus.aiGenerated && row.focus?.ranking ? (
            <div className="ml-5 mt-1 whitespace-normal text-[10px] text-muted-foreground/75">
              {row.rankingModelLabel ? `${row.rankingModelLabel} · ` : ""}
              ranked {formatRelativeTimeLabel(row.focus.ranking.rankedAt)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
