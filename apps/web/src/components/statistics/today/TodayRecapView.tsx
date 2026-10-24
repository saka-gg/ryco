import {
  buildDailyRecapDigest,
  buildDailyRecapTiles,
  type DailyRecapDigestInput,
  type DailyRecapFormat,
  type DailyRecapPart,
  type DailyRecapTile,
  type MergedDailyRecap,
  type MergedDailyRecapSection,
  type MergedDailyRecapThread,
} from "@ryco/client-runtime/state/dailyRecap";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  ActivityIcon,
  AlertCircleIcon,
  BarChart3Icon,
  CalendarCheckIcon,
  Clock3Icon,
  DatabaseIcon,
  Layers3Icon,
  MessagesSquareIcon,
  RefreshCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  formatCompact,
  formatDuration,
  formatInteger,
  formatModelLabel,
  formatUsd,
} from "~/lib/statisticsFormat";
import { cn } from "~/lib/utils";

import { Panel, StatCard, StatePanel, StatSkeleton } from "../../settings/statistics/parts";
import { EnvironmentSelect } from "../EnvironmentSelect";
import type { StatisticsSearch } from "../statisticsSearch";
import type { DailyRecapNodeView, UseDailyRecapResult } from "./useDailyRecap";

const RECAP_FORMAT: DailyRecapFormat = {
  integer: formatInteger,
  duration: formatDuration,
  compact: formatCompact,
  model: formatModelLabel,
  cost: formatUsd,
};

const TILE_ICONS: Record<DailyRecapTile["id"], LucideIcon> = {
  finished: ActivityIcon,
  "agent-time": Clock3Icon,
  "top-project": Layers3Icon,
  "provider-tokens": SparklesIcon,
  yesterday: BarChart3Icon,
  tasks: CalendarCheckIcon,
};

/** Rows a list shows before "Show all". */
const LISTED_ROWS = 8;

const nodeList = new Intl.ListFormat("en-US", { type: "conjunction" });

function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export interface TodayRecapViewProps {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
  readonly recap: Pick<
    UseDailyRecapResult,
    | "today"
    | "yesterday"
    | "nodes"
    | "availableEnvironments"
    | "connecting"
    | "loading"
    | "refreshing"
  >;
  readonly usage: DailyRecapDigestInput["usage"];
  readonly tasks: DailyRecapDigestInput["tasks"];
  readonly waitingThreads: number;
  /** Hosted: the recap covers the devices this browser is connected to, not every device. */
  readonly hosted: boolean;
  /** Where a listed chat lives, as the row's first detail. */
  readonly projectLabel: (thread: MergedDailyRecapThread) => string;
  readonly onRefresh: () => void;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly onOpenTasks: () => void;
}

/**
 * Today across the selected devices: a few sentences, the tiles under them,
 * the chats that finished or failed, and which devices are in it. Props only;
 * `TodayView` supplies the data.
 */
export function TodayRecapView(props: TodayRecapViewProps) {
  const { recap } = props;
  const notes = useMemo(() => nodeNotes(recap.nodes, recap.today), [recap.nodes, recap.today]);

  if (recap.today !== null) {
    return <TodayRecapContent {...props} today={recap.today} notes={notes} />;
  }
  // While this app's own node is still connecting there is nothing to ask yet.
  if (recap.loading || recap.connecting) return <StatSkeleton />;
  // Connected devices the filter leaves out: the choice stays, so another one can be picked.
  const filteredOut = recap.nodes.length === 0 && recap.availableEnvironments.length > 0;
  return (
    <div className="space-y-8">
      {recap.availableEnvironments.length > 0 ? (
        <EnvironmentSelect
          search={props.search}
          onSearchChange={props.onSearchChange}
          environments={recap.availableEnvironments}
          ariaLabel="Recap environment"
        />
      ) : null}
      {recap.nodes.length === 0 ? (
        <StatePanel
          icon={DatabaseIcon}
          title={filteredOut ? "The selected device isn’t connected" : "No devices are connected"}
          description={
            filteredOut
              ? "Choose a connected device to see what happened on it today."
              : "Connect a device to see what happened on it today."
          }
        />
      ) : (
        <StatePanel
          icon={AlertCircleIcon}
          title="Couldn’t load today’s recap"
          description={notes.map((note) => note.text).join(" ")}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={props.onRefresh}
              disabled={recap.refreshing}
            >
              <RefreshCwIcon className={recap.refreshing ? "animate-spin" : undefined} /> Try again
            </Button>
          }
        />
      )}
    </div>
  );
}

function TodayRecapContent(
  props: TodayRecapViewProps & {
    readonly today: MergedDailyRecap;
    readonly notes: readonly NodeNote[];
  },
) {
  const { recap, today, usage } = props;
  const digestInput = useMemo(
    (): DailyRecapDigestInput => ({
      today,
      yesterday: recap.yesterday,
      usage,
      tasks: props.tasks,
      waitingThreads: props.waitingThreads,
    }),
    [props.tasks, props.waitingThreads, recap.yesterday, today, usage],
  );
  const digest = useMemo(() => buildDailyRecapDigest(digestInput, RECAP_FORMAT), [digestInput]);
  const tiles = useMemo(() => buildDailyRecapTiles(digestInput, RECAP_FORMAT), [digestInput]);
  const sources = recap.nodes.flatMap((node) => (node.recap === undefined ? [] : [node.label]));
  const listProps = {
    showNode: sources.length > 1,
    projectLabel: props.projectLabel,
    onOpenThread: props.onOpenThread,
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <EnvironmentSelect
          search={props.search}
          onSearchChange={props.onSearchChange}
          environments={recap.availableEnvironments}
          ariaLabel="Recap environment"
        />
        <Button size="sm" variant="outline" onClick={props.onRefresh} disabled={recap.refreshing}>
          <RefreshCwIcon className={recap.refreshing ? "animate-spin" : undefined} />
          {recap.refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      <section className="rounded-2xl border bg-card p-6 text-card-foreground shadow-sm/4 not-dark:bg-clip-padding">
        <p className="max-w-4xl text-base leading-relaxed text-muted-foreground">
          {digest.length === 0
            ? "Nothing finished yet today."
            : digest.map((sentence, index) => (
                <Fragment key={sentence.id}>
                  {index > 0 ? " " : null}
                  <RecapParts parts={sentence.parts} />
                </Fragment>
              ))}
        </p>
        <p className="mt-4 text-[11px] text-muted-foreground">
          Updated {formatClockTime(today.updatedAtMs)}
        </p>
      </section>

      {tiles.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {tiles.map((tile) => (
            <StatCard
              key={tile.id}
              label={tile.label}
              icon={TILE_ICONS[tile.id]}
              value={tile.value}
              sub={
                tile.id === "tasks" ? (
                  <>
                    <RecapParts parts={tile.detail} />
                    {tile.detail.length > 0 ? " · " : null}
                    <button
                      type="button"
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                      onClick={props.onOpenTasks}
                    >
                      Open tasks
                    </button>
                  </>
                ) : tile.detail.length > 0 ? (
                  <RecapParts parts={tile.detail} />
                ) : undefined
              }
            />
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Finished today" icon={MessagesSquareIcon} bodyClassName="overflow-hidden">
          <RecapThreadList
            section={today.completed}
            emptyText="No chat finished a turn yet."
            {...listProps}
          />
        </Panel>
        <Panel title="Failed today" icon={TriangleAlertIcon} bodyClassName="overflow-hidden">
          <RecapThreadList section={today.failed} emptyText="No failed turns." {...listProps} />
        </Panel>
      </div>

      <footer className="space-y-1 text-xs text-muted-foreground">
        <p>From {nodeList.format(sources)}.</p>
        {props.notes.map((note) => (
          <p key={note.key}>{note.text}</p>
        ))}
        {usage !== null && usage.today.tokens > 0 ? (
          <p>Provider tokens come from provider histories and include sessions outside Ryco.</p>
        ) : null}
        {props.hosted ? <p>Includes connected devices only.</p> : null}
      </footer>
    </div>
  );
}

function RecapParts({ parts }: { readonly parts: readonly DailyRecapPart[] }) {
  return parts.map((part, index) =>
    part.kind === "text" ? (
      // oxlint-disable-next-line react/no-array-index-key -- parts are positional and can repeat
      <Fragment key={index}>{part.text}</Fragment>
    ) : (
      <strong
        // oxlint-disable-next-line react/no-array-index-key -- parts are positional and can repeat
        key={index}
        className={cn("font-medium", part.tone === "bad" ? "text-destructive" : "text-foreground")}
      >
        {part.text}
      </strong>
    ),
  );
}

function RecapThreadList(props: {
  readonly section: MergedDailyRecapSection;
  readonly emptyText: string;
  readonly showNode: boolean;
  readonly projectLabel: (thread: MergedDailyRecapThread) => string;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const { section } = props;
  const [expanded, setExpanded] = useState(false);
  if (section.threads.length === 0) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">{props.emptyText}</p>;
  }
  const shown = expanded ? section.threads : section.threads.slice(0, LISTED_ROWS);
  const collapsed = section.threads.length - shown.length;
  const unlisted = section.totalThreads - section.threads.length;
  return (
    <>
      <div className="divide-y divide-border/60">
        {shown.map((thread) => (
          <button
            key={`${thread.environmentId}:${thread.threadId}`}
            type="button"
            className="block w-full px-4 py-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => props.onOpenThread(thread.environmentId, thread.threadId)}
          >
            <span className="block truncate text-sm font-medium">{thread.threadTitle}</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {[
                props.projectLabel(thread),
                ...(props.showNode ? [thread.environmentLabel] : []),
                formatClockTime(Date.parse(thread.lastActivityAt)),
              ].join(" · ")}
            </span>
          </button>
        ))}
      </div>
      {collapsed > 0 || unlisted > 0 ? (
        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          {collapsed > 0 ? (
            <button
              type="button"
              className="font-medium text-foreground underline-offset-4 hover:underline"
              onClick={() => setExpanded(true)}
            >
              Show all
            </button>
          ) : (
            <span />
          )}
          {unlisted > 0 ? <span>{formatInteger(unlisted)} more not shown</span> : null}
        </div>
      ) : null}
    </>
  );
}

/** One footer sentence about a device. */
interface NodeNote {
  readonly key: string;
  readonly text: string;
}

/**
 * Why a device is missing from the recap or shows earlier numbers; null while
 * it is current or still answering.
 */
function nodeStatusText(node: DailyRecapNodeView): string | null {
  const { label, result } = node;
  const earlier =
    node.stale && node.recap !== undefined
      ? ` Its numbers are from ${formatClockTime(node.recap.requestedAtMs)}.`
      : "";
  switch (result?.status) {
    case "offline":
      return `${label} is offline.${earlier}`;
    case "unsupported":
      return `${label} needs a Ryco update for the recap.`;
    case "forbidden":
      return `No access to ${label}’s recap.`;
    case "failed":
      return `${label}: ${result.message}${earlier}`;
    default:
      return null;
  }
}

/** The footer's sentences about devices missing from the recap or in it with less. */
function nodeNotes(
  nodes: readonly DailyRecapNodeView[],
  today: MergedDailyRecap | null,
): NodeNote[] {
  const notes: NodeNote[] = [];
  for (const node of nodes) {
    const status = nodeStatusText(node);
    if (status !== null) notes.push({ key: `${node.environmentId}:status`, text: status });
    if (today?.activityMissing.includes(node.environmentId)) {
      notes.push({
        key: `${node.environmentId}:activity`,
        text: `${node.label} needs a Ryco update for agent time and projects.`,
      });
    }
  }
  return notes;
}
