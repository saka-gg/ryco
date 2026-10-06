import {
  ChevronRightIcon,
  CircleDotIcon,
  FolderIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  TicketIcon,
} from "lucide-react";
import { memo, useEffect, useState } from "react";

import { visibleSecondTicker } from "../../../lib/perf/ticker";
import { cn } from "../../../lib/utils";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { DeviceIcon } from "../../DeviceIcon";
import { InboxStatusGlyph } from "../../inboxSidebar/InboxStatusGlyph";
import type { InboxGlyphKind } from "../../inboxSidebar/inboxRowPresentation";
import { ProjectFavicon } from "../../ProjectFavicon";
import { ChangeRequestStateGlyph, RelativeTime } from "../../pullRequests/primitives";
import {
  automationCycle,
  type MapAutomation,
  type MapCheckout,
  type MapThread,
  type MapWorkspace,
} from "./projectMap.logic";
import { nextRunLabel } from "./projectMapModel";

/** Ports are where wires plug in: the n8n read of "this connects to that". */
export type MapPort = "top" | "bottom" | "left" | "right" | "trunk";

export function MapPorts(props: { readonly ports: readonly MapPort[] }) {
  return (
    <>
      {props.ports.map((port) => (
        <i key={port} aria-hidden className="map-port" data-port={port} />
      ))}
    </>
  );
}

const TALLY_ORDER: Record<InboxGlyphKind, number> = {
  "needs-input": 0,
  error: 1,
  working: 2,
  connecting: 3,
  limited: 4,
  completed: 5,
  offline: 6,
  idle: 7,
};

/** A thread as a dot in a tally: the inbox's colour language, no motion. */
function TallyDot(props: { readonly glyph: InboxGlyphKind; readonly archived: boolean }) {
  return (
    <span aria-hidden className="map-dot" data-glyph={props.archived ? "archived" : props.glyph} />
  );
}

export const MapProjectNode = memo(function MapProjectNode(props: {
  readonly snapshot: SidebarProjectSnapshot;
  readonly devices: number;
  readonly workspaces: number;
  readonly threads: number;
  readonly repository: string | null;
}) {
  const { snapshot } = props;
  return (
    <>
      <div className="flex items-center gap-2.5 px-3.5 pt-3.5">
        <ProjectFavicon
          environmentId={snapshot.environmentId}
          cwd={snapshot.cwd}
          projectId={snapshot.id}
          customAvatarContentHash={snapshot.customAvatarContentHash ?? null}
          fallbackName={snapshot.displayName}
          className="size-5 shrink-0 rounded-[5px]"
        />
        <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
          {snapshot.displayName}
        </span>
      </div>
      {/* The repository says more than the name only when they differ. */}
      <div className="truncate px-3.5 pt-0.5 font-mono text-[11px] text-muted-foreground">
        {props.repository && props.repository !== snapshot.displayName
          ? props.repository
          : snapshot.cwd}
      </div>
      <div className="mt-2.5 grid grid-cols-3 border-t border-border/60">
        {(
          [
            [props.devices, props.devices === 1 ? "device" : "devices"],
            [props.workspaces, props.workspaces === 1 ? "workspace" : "workspaces"],
            [props.threads, props.threads === 1 ? "thread" : "threads"],
          ] as const
        ).map(([value, label]) => (
          <div
            key={label}
            className="flex flex-col px-3.5 py-1.5 not-first:border-l not-first:border-border/60"
          >
            <span className="text-[14px] font-semibold tabular-nums">{value}</span>
            <span className="map-detail text-[10.5px] text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
    </>
  );
});

const STATUS_TEXT: Record<MapCheckout["status"], string> = {
  online: "Online",
  connecting: "Connecting",
  offline: "Offline",
  unknown: "Unknown",
};

export const MapDeviceNode = memo(function MapDeviceNode(props: {
  readonly checkout: MapCheckout;
}) {
  const { checkout } = props;
  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <DeviceIcon
          environmentId={checkout.environmentId as never}
          label={checkout.deviceLabel}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {checkout.deviceLabel}
        </span>
        {checkout.isPrimary ? null : (
          <span
            className="map-presence inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
            data-status={checkout.status}
          >
            <i aria-hidden />
            {STATUS_TEXT[checkout.status]}
          </span>
        )}
      </div>
      <div
        className="map-detail truncate px-3 pt-1 pb-2.5 font-mono text-[11px] text-muted-foreground"
        title="Checkout folder"
      >
        {checkout.cwd}
      </div>
    </>
  );
});

function WorkspaceOrigin(props: { readonly origin: MapWorkspace["origin"] }) {
  const { origin } = props;
  if (!origin) return null;
  if (origin.kind === "pr")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
        {origin.state ? (
          <ChangeRequestStateGlyph
            state={origin.state}
            isDraft={origin.isDraft}
            className="size-3"
          />
        ) : null}
        #{origin.number}
      </span>
    );
  if (origin.kind === "issue")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
        <CircleDotIcon aria-hidden className="size-3" />#{origin.number}
      </span>
    );
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
      <TicketIcon aria-hidden className="size-3" />
      {origin.key}
    </span>
  );
}

export const MapWorkspaceNode = memo(function MapWorkspaceNode(props: {
  readonly workspace: MapWorkspace;
  readonly expanded: boolean;
  readonly onToggleThreads: () => void;
}) {
  const { workspace } = props;
  const name = workspace.main ? "Main checkout" : (workspace.title ?? workspace.branch);
  const Icon = workspace.main ? FolderIcon : GitBranchIcon;
  const dots = workspace.threads
    .toSorted((left, right) => TALLY_ORDER[left.glyph] - TALLY_ORDER[right.glyph])
    .slice(0, 5);
  /* One fact once: the branch shows under a title, and the tally says how many threads. */
  const subline = workspace.main || workspace.title ? workspace.branch : null;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            workspace.main || workspace.title
              ? "font-semibold"
              : "font-mono font-medium text-[12.5px]",
          )}
        >
          {name}
        </span>
        <WorkspaceOrigin origin={workspace.origin} />
      </div>
      <div className="flex min-w-0 items-start gap-2 px-3 pt-1 pb-2.5">
        <span
          className="map-detail map-facts flex min-w-0 flex-1 items-center gap-x-1.5 overflow-hidden text-[11px] whitespace-nowrap text-muted-foreground"
          title={workspace.facts.map((fact) => fact.label).join(" · ") || undefined}
        >
          {subline ? <span className="truncate font-mono">{subline}</span> : null}
          {workspace.facts.map((fact) => (
            <span
              key={fact.label}
              title={fact.detail}
              data-tone={fact.tone}
              className="map-fact shrink-0"
            >
              {fact.label}
            </span>
          ))}
          {!subline && workspace.facts.length === 0 && workspace.threads.length === 0 ? (
            <span>No threads</span>
          ) : null}
        </span>
        {workspace.threads.length > 0 ? (
          <button
            type="button"
            data-map-toggle
            aria-expanded={props.expanded}
            aria-label={`${props.expanded ? "Fold" : "Show"} ${workspace.threads.length} thread${workspace.threads.length === 1 ? "" : "s"}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleThreads();
            }}
            className="map-tally -my-0.5 -mr-1 inline-flex h-5 shrink-0 items-center gap-[3px] rounded-md pr-0.5 pl-1.5 outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            {dots.map((thread) => (
              <TallyDot key={thread.id} glyph={thread.glyph} archived={thread.archived} />
            ))}
            <span className="ml-0.5 text-[11px] text-muted-foreground tabular-nums">
              {workspace.threads.length}
            </span>
            <ChevronRightIcon aria-hidden className="map-chevron size-3 text-muted-foreground" />
          </button>
        ) : null}
      </div>
    </>
  );
});

/** Ticks once a second (only while visible): countdown text and ring stay live. */
export function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => visibleSecondTicker.subscribe(setNow), []);
  return now;
}

function CountdownRing(props: { readonly automation: MapAutomation }) {
  const now = useNowMs();
  const r = 9;
  const c = 2 * Math.PI * r;
  const done = automationCycle(props.automation, now);
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="map-ring size-[18px] shrink-0 -rotate-90">
      <circle cx="12" cy="12" r={r} className="map-ring-track" />
      <circle
        cx="12"
        cy="12"
        r={r}
        className="map-ring-progress"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - done)}
      />
      <path d="M12 8v4l2.5 1.5" className="map-ring-hand" />
    </svg>
  );
}

function NextRun(props: { readonly automation: MapAutomation }) {
  const now = useNowMs();
  return (
    <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
      {nextRunLabel(props.automation, now)}
    </span>
  );
}

export const MapAutomationNode = memo(function MapAutomationNode(props: {
  readonly automation: MapAutomation;
  readonly canDecide: boolean;
  /** Why this reader cannot approve here (role, connection), shown on the button. */
  readonly disabledReason: string | null;
  readonly busy: boolean;
  readonly onApprove: () => void;
}) {
  const { automation } = props;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
        <CountdownRing automation={automation} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {automation.title}
        </span>
        {!automation.enabled ? (
          <span className="shrink-0 text-[11.5px] text-muted-foreground">Paused</span>
        ) : automation.pendingProposalId ? (
          <button
            type="button"
            data-map-approve
            title={props.disabledReason ?? undefined}
            disabled={!props.canDecide || props.busy}
            onClick={(event) => {
              event.stopPropagation();
              props.onApprove();
            }}
            className="map-approve inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {props.busy ? <LoaderCircleIcon aria-hidden className="size-3 animate-spin" /> : null}
            Approve run
          </button>
        ) : automation.running ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-info-foreground">
            <InboxStatusGlyph kind="working" />
            Starting
          </span>
        ) : (
          <NextRun automation={automation} />
        )}
      </div>
      <div className="map-detail map-facts flex min-w-0 items-center gap-x-1.5 overflow-hidden px-3 pt-1 pb-2.5 text-[11px] whitespace-nowrap text-muted-foreground">
        <span className="truncate">{automation.scheduleLabel}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">
          {automation.envMode === "worktree" ? "New worktree each run" : "Main checkout"}
        </span>
        {automation.lastRunFailed && !automation.running && !automation.pendingProposalId ? (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0 text-warning-foreground">Last run failed</span>
          </>
        ) : null}
      </div>
    </>
  );
});

export const MapThreadNode = memo(function MapThreadNode(props: { readonly thread: MapThread }) {
  const { thread } = props;
  return (
    <div className="flex h-full min-w-0 items-center gap-2 px-2.5">
      {thread.archived ? (
        <span aria-hidden className="map-dot shrink-0" data-glyph="archived" />
      ) : (
        <InboxStatusGlyph key={thread.glyph} kind={thread.glyph} label={thread.glyphLabel} />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[12.5px] font-medium",
          thread.archived && "text-muted-foreground",
        )}
      >
        {thread.title}
      </span>
      {thread.activityAt ? (
        <RelativeTime
          value={thread.activityAt}
          className="map-detail shrink-0 text-[11px] text-muted-foreground tabular-nums"
        />
      ) : null}
    </div>
  );
});
