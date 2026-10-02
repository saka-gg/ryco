// FILE: WorkChapterRow.tsx
// Purpose: Renders one transcript chapter — a commentary paragraph and the
//          steps (tool calls, reasoning) that followed it. The live chapter
//          shows its paragraph, a three-row step ticker and running tallies;
//          finished chapters fold to a single line on a shared rail.
// Layer: Web chat timeline row
// Exports: WorkChapterRow, StepStatusGlyph
// Depends on: workChapters.logic (labels/tallies), the timeline's own entry
//             detail panel (passed in to avoid a circular import).

import {
  BotIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  FileTextIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type EnvironmentId, type ServerProviderSkill } from "@ryco/contracts";

import { type WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { visibleSecondTicker } from "../../lib/perf/ticker";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "../../lib/disclosureMotion";
import ChatMarkdown from "../ChatMarkdown";
import type { SkillInlineTextSearchHighlight } from "./SkillInlineText";
import {
  chapterExpansionKey,
  chapterStepsExpansionKey,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import {
  CHAPTER_TALLY_KINDS,
  chapterFallbackTitle,
  chapterTitleFromMessage,
  deriveChapterStepDisplay,
  deriveChapterTallies,
  describeTally,
  formatChapterDuration,
  isReasoningWorkEntry,
  reasoningEntryText,
  selectTickerEntries,
  type ChapterStepDisplay,
  type ChapterTallies,
  type ChapterTallyKind,
} from "./workChapters.logic";

type ChapterRow = Extract<MessagesTimelineRow, { kind: "chapter" }>;

export interface WorkChapterRowProps {
  row: ChapterRow;
  routeThreadKey: string;
  workspaceRoot: string | undefined;
  markdownCwd: string | undefined;
  environmentId: EnvironmentId;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  searchHighlight: Omit<SkillInlineTextSearchHighlight, "cursor" | "keyPrefix"> | undefined;
  /** The timeline's Activity + transcript panel for one tool entry. */
  renderEntryPanel: (entry: WorkLogEntry, panelId: string) => ReactNode;
}

/** Rail geometry: node sits on a 1px line 7px from the row's left edge. */
const NODE_CENTER_OPEN_PX = 12;
const NODE_CENTER_FOLDED_PX = 15;
const STEP_LEAVE_MS = 360;

const TALLY_ICON: Record<ChapterTallyKind, LucideIcon> = {
  read: FileTextIcon,
  search: SearchIcon,
  edit: PencilIcon,
  run: TerminalIcon,
  web: GlobeIcon,
  agent: BotIcon,
  tool: WrenchIcon,
};

export const WorkChapterRow = memo(function WorkChapterRow(props: WorkChapterRowProps) {
  const { row, routeThreadKey } = props;
  const setExpanded = useUiStateStore((store) => store.setThreadWorkGroupExpanded);
  const live = row.status === "active";
  const open = live || row.expanded;
  const tallies = useMemo(() => deriveChapterTallies(row.entries), [row.entries]);
  const nodeCenter = open && row.message ? NODE_CENTER_OPEN_PX : NODE_CENTER_FOLDED_PX;
  const duration = live ? null : formatChapterDuration(row.startedAt, row.endedAt);

  const toggle = (next: boolean) => setExpanded(routeThreadKey, chapterExpansionKey(row.id), next);
  // Only the visible face stays mounted; the other unmounts after its close
  // animation, so a long turn does not keep every chapter's steps rendered.
  const bodyMounted = useMountedWhile(open);
  const foldedMounted = useMountedWhile(!open);

  return (
    <section
      className={cn("relative pl-[26px]", row.isLastInTurn ? "pb-3" : "pb-0.5")}
      data-chapter-status={row.status}
      data-chapter-open={open ? "true" : "false"}
      data-message-id={row.message?.id}
    >
      <ChapterRail
        isFirst={row.isFirstInTurn}
        isLast={row.isLastInTurn}
        live={live}
        failed={tallies.failed > 0}
        nodeCenter={nodeCenter}
      />

      <DisclosureRegion open={!open}>
        {foldedMounted ? (
          <button
            type="button"
            aria-expanded={false}
            onClick={() => toggle(true)}
            className="group/chapter -mx-2 flex min-h-[30px] w-[calc(100%+1rem)] cursor-pointer items-center gap-3 rounded-lg px-2 text-left transition-colors duration-200 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          >
            <ChapterTitle row={row} tallies={tallies} />
            <ChapterTallyChips tallies={tallies} />
            <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/55">
              {duration}
            </span>
          </button>
        ) : null}
      </DisclosureRegion>

      <DisclosureRegion open={open}>
        {bodyMounted ? (
          <ChapterBody
            {...props}
            live={live}
            tallies={tallies}
            duration={duration}
            onFold={live ? undefined : () => toggle(false)}
            onShowAllSteps={() =>
              setExpanded(routeThreadKey, chapterStepsExpansionKey(row.id), !row.stepsExpanded)
            }
          />
        ) : null}
      </DisclosureRegion>
    </section>
  );
});

function ChapterTitle(props: { row: ChapterRow; tallies: ChapterTallies }) {
  const text = props.row.message
    ? chapterTitleFromMessage(props.row.message.text)
    : chapterFallbackTitle(props.row.entries, props.tallies);
  // Inline code keeps its mono face in the folded line; everything else is prose.
  const parts = text.split(/(`[^`]+`)/);
  return (
    <span
      className={cn(
        "min-w-0 flex-1 truncate text-[13px] leading-5",
        props.row.message ? "text-foreground/78" : "text-muted-foreground/70",
        "transition-colors group-hover/chapter:text-foreground",
      )}
      title={text.replace(/`/g, "")}
    >
      {titleSegments(parts).map(({ offset, part }) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
          <code key={offset} className="font-mono text-[12px]">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={offset}>{part}</span>
        ),
      )}
    </span>
  );
}

function ChapterBody(
  props: WorkChapterRowProps & {
    live: boolean;
    tallies: ChapterTallies;
    duration: string | null;
    onFold: (() => void) | undefined;
    onShowAllSteps: () => void;
  },
) {
  const { row, live, tallies } = props;
  const showAll = !live || row.stepsExpanded;
  const ticker = selectTickerEntries(row.entries);
  const visible = showAll ? row.entries : ticker.visible;
  const leaving = useLeavingSteps(visible, live && !showAll);

  return (
    <div className="pb-0.5">
      {row.message ? (
        <div className="min-w-0 py-0.5 pr-1">
          <ChatMarkdown
            text={row.message.text}
            cwd={props.markdownCwd}
            environmentId={props.environmentId}
            isStreaming={row.message.streaming}
            skills={props.skills}
            searchHighlight={props.searchHighlight}
          />
        </div>
      ) : null}

      {live && ticker.hiddenCount > 0 ? (
        <button
          type="button"
          onClick={props.onShowAllSteps}
          className="flex h-6 cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground/55 transition-colors hover:text-muted-foreground"
        >
          <ChevronUpIcon
            aria-hidden
            className={cn("size-3 transition-transform", row.stepsExpanded && "rotate-180")}
          />
          {row.stepsExpanded
            ? "Show recent steps"
            : `${ticker.hiddenCount} earlier ${ticker.hiddenCount === 1 ? "step" : "steps"}`}
        </button>
      ) : null}

      {visible.length > 0 || leaving.length > 0 ? (
        <div className="flex flex-col">
          {leaving.map((entry) => (
            <div key={`leaving:${entry.id}`} className="chapter-step-leave" aria-hidden>
              <ChapterStepRow
                entry={entry}
                workspaceRoot={props.workspaceRoot}
                routeThreadKey={props.routeThreadKey}
                markdownCwd={props.markdownCwd}
                environmentId={props.environmentId}
                animateIn={false}
                age={3}
                renderEntryPanel={props.renderEntryPanel}
              />
            </div>
          ))}
          {visible.map((entry, index) => (
            <ChapterStepRow
              key={entry.id}
              entry={entry}
              workspaceRoot={props.workspaceRoot}
              routeThreadKey={props.routeThreadKey}
              markdownCwd={props.markdownCwd}
              environmentId={props.environmentId}
              animateIn={live}
              age={live && !showAll ? visible.length - 1 - index : 0}
              renderEntryPanel={props.renderEntryPanel}
            />
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          "flex min-h-[26px] items-center gap-3",
          props.onFold && "-mx-2 cursor-pointer rounded-lg px-2 hover:bg-accent/40",
        )}
        onClick={props.onFold}
        role={props.onFold ? "button" : undefined}
        tabIndex={props.onFold ? 0 : undefined}
        aria-label={props.onFold ? "Fold chapter" : undefined}
        onKeyDown={(event) => {
          if (props.onFold && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            props.onFold();
          }
        }}
      >
        <ChapterTallyChips tallies={tallies} />
        <span className="ml-auto w-12 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground/55">
          {live ? <LiveElapsed startedAt={row.startedAt} /> : props.duration}
        </span>
      </div>
    </div>
  );
}

/** Title pieces keyed by their character offset (stable, unlike array indexes). */
function titleSegments(parts: ReadonlyArray<string>): Array<{ offset: number; part: string }> {
  let offset = 0;
  return parts.map((part) => {
    const segment = { offset, part };
    offset += part.length;
    return segment;
  });
}

/** True while `open`, and for the length of the close animation after. */
function useMountedWhile(open: boolean): boolean {
  const [lingering, setLingering] = useState(open);
  // Opening mounts immediately (derived during render); closing keeps the
  // content until the collapse animation has finished.
  if (open && !lingering) {
    setLingering(true);
  }
  useEffect(() => {
    if (open) return;
    const timeout = window.setTimeout(
      () => setLingering(false),
      DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [open]);
  return open || lingering;
}

/**
 * Steps that just scrolled out of the live ticker stay mounted briefly in a
 * collapsing state, so the window keeps a constant height as a new step grows
 * in below it instead of jumping by a row.
 */
function useLeavingSteps(
  visible: ReadonlyArray<WorkLogEntry>,
  enabled: boolean,
): ReadonlyArray<WorkLogEntry> {
  const visibleKey = visible.map((entry) => entry.id).join("\u0000");
  // "Previous props in state": when the window shifts, the steps that fell out
  // of it are kept for one collapse animation, then dropped by the timer.
  const [tracked, setTracked] = useState<{
    key: string;
    visible: ReadonlyArray<WorkLogEntry>;
    leaving: ReadonlyArray<WorkLogEntry>;
  }>({ key: visibleKey, visible, leaving: [] });
  if (tracked.key !== visibleKey) {
    const visibleIds = new Set(visible.map((entry) => entry.id));
    const exited = enabled
      ? tracked.visible.filter((entry) => !visibleIds.has(entry.id)).slice(-2)
      : [];
    setTracked({ key: visibleKey, visible, leaving: exited });
  }

  useEffect(() => {
    if (tracked.leaving.length === 0) return;
    const timeout = window.setTimeout(
      () =>
        setTracked((current) =>
          current.leaving.length === 0 ? current : { ...current, leaving: [] },
        ),
      STEP_LEAVE_MS + 20,
    );
    return () => window.clearTimeout(timeout);
  }, [tracked.leaving]);

  return enabled ? tracked.leaving : [];
}

function ChapterRail(props: {
  isFirst: boolean;
  isLast: boolean;
  live: boolean;
  failed: boolean;
  nodeCenter: number;
}) {
  const { isFirst, isLast, live, nodeCenter } = props;
  // The rail starts at the turn's first node and stops at its last one; the
  // live chapter's segment carries a slow travelling highlight instead.
  const top = isFirst ? nodeCenter : 0;
  const bottom = isLast && !live ? `calc(100% - ${nodeCenter}px)` : "0px";
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute left-[7px] w-px bg-muted-foreground/22 transition-[top] duration-300"
        style={{ top, bottom }}
      />
      {live ? (
        <span
          aria-hidden
          className="pointer-events-none absolute left-[7px] w-px overflow-hidden"
          style={{ top: nodeCenter, bottom: 0 }}
        >
          <span className="chapter-rail-flow absolute inset-x-0" />
        </span>
      ) : null}
      <span
        aria-hidden
        data-chapter-node={live ? "live" : "done"}
        className={cn(
          "pointer-events-none absolute left-[2.5px] size-2.5 rounded-full transition-[top,background-color,box-shadow,transform] duration-300",
          live
            ? "chapter-node-live bg-background shadow-[inset_0_0_0_1.5px_var(--color-foreground)]"
            : props.failed
              ? "scale-75 bg-muted-foreground/45"
              : "scale-75 bg-muted-foreground/45",
        )}
        style={{ top: nodeCenter - 5 }}
      />
    </>
  );
}

const ChapterTallyChips = memo(function ChapterTallyChips(props: { tallies: ChapterTallies }) {
  const { tallies } = props;
  const kinds = CHAPTER_TALLY_KINDS.filter((kind) => tallies.counts[kind] > 0);
  if (kinds.length === 0 && tallies.failed === 0 && !tallies.hasDiff) {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center gap-3 text-[12px] tabular-nums text-muted-foreground/55">
      {kinds.map((kind) => {
        const Icon = TALLY_ICON[kind];
        const count = tallies.counts[kind];
        return (
          <span
            key={kind}
            className="chapter-chip inline-flex items-center gap-1"
            title={describeTally(kind, count)}
          >
            <Icon aria-hidden className="size-3 opacity-85" />
            <span key={count} className="chapter-count">
              {count}
            </span>
          </span>
        );
      })}
      {tallies.failed > 0 ? (
        <span
          className="chapter-chip inline-flex items-center gap-1 text-destructive-foreground/90"
          title={`${tallies.failed} failed`}
        >
          <CircleAlertIcon aria-hidden className="size-3" />
          <span key={tallies.failed} className="chapter-count">
            {tallies.failed}
          </span>
        </span>
      ) : null}
      {tallies.hasDiff ? (
        <span className="chapter-chip inline-flex items-center gap-1">
          <span className="text-success">+{tallies.additions}</span>
          {tallies.deletions > 0 ? (
            <span className="text-destructive">−{tallies.deletions}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
});

// ---------------------------------------------------------------------------
// Step rows
// ---------------------------------------------------------------------------

const ChapterStepRow = memo(function ChapterStepRow(props: {
  entry: WorkLogEntry;
  workspaceRoot: string | undefined;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  environmentId: EnvironmentId;
  animateIn: boolean;
  /** 0 = newest; older ticker rows fade back. */
  age: number;
  renderEntryPanel: (entry: WorkLogEntry, panelId: string) => ReactNode;
}) {
  const { entry, routeThreadKey } = props;
  const display = deriveChapterStepDisplay(entry, props.workspaceRoot);
  const stored = useUiStateStore(
    (store) => store.threadWorkEntryExpandedById[routeThreadKey]?.[entry.id],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadWorkEntryExpanded);
  const isOpen = stored ?? false;
  const panelId = `chapter-step-panel:${entry.id}`;
  const keepPanelMounted = useMountedWhile(isOpen);

  const toggle = () => setExpanded(routeThreadKey, entry.id, !isOpen);
  const reasoning = isReasoningWorkEntry(entry);

  return (
    <div
      className={cn(
        "transition-opacity duration-500",
        props.animateIn && "chapter-step-enter",
        props.age === 1 && "opacity-80",
        props.age === 2 && "opacity-55",
        props.age >= 3 && "opacity-35",
      )}
      data-chapter-step-kind={display.kind}
      data-chapter-step-status={display.status}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
        className="group/step -mx-2 flex min-h-[30px] w-[calc(100%+1rem)] cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 hover:bg-accent/50"
        title={
          entry.rawCommand ??
          entry.command ??
          (entry.changedFiles && entry.changedFiles.length > 0
            ? entry.changedFiles.join("\n")
            : undefined)
        }
      >
        <StepStatusGlyph kind={display.kind} status={display.status} />
        <StepLabel display={display} />
        <StepMeta display={display} />
      </div>
      <DisclosureRegion open={isOpen} contentClassName="min-w-0 pl-[26px]">
        {keepPanelMounted ? (
          reasoning ? (
            <div id={panelId} className="pt-1 pb-2 text-[13px] text-muted-foreground/80">
              <ChatMarkdown
                text={reasoningEntryText(entry) || "_No reasoning text was shared._"}
                cwd={props.markdownCwd}
                environmentId={props.environmentId}
                isStreaming={!entry.completed}
              />
            </div>
          ) : (
            props.renderEntryPanel(entry, panelId)
          )
        ) : null}
      </DisclosureRegion>
    </div>
  );
});

function StepLabel(props: { display: ChapterStepDisplay }) {
  const { display } = props;
  const running = display.status === "running";
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
      {/* Keyed by verb so the tense change ("Reading" → "Read") replays the roll-in. */}
      <span key={display.verb} className="chapter-verb shrink-0 text-muted-foreground/80">
        <span className={cn(running && "shimmer thinking-status-shimmer")}>{display.verb}</span>
      </span>
      {display.target ? (
        <span
          className={cn(
            "min-w-0 truncate",
            display.kind === "think"
              ? "text-[12px] text-muted-foreground/50"
              : display.targetIsCode
                ? "font-mono text-[12px] text-foreground/82"
                : "text-foreground/82",
          )}
        >
          {display.target}
        </span>
      ) : null}
    </span>
  );
}

function StepMeta(props: { display: ChapterStepDisplay }) {
  const { meta } = props.display;
  if (!meta) return null;
  return (
    <span
      className={cn(
        "chapter-meta shrink-0 pl-3 text-[12px] tabular-nums text-muted-foreground/55",
        meta.type === "text" && meta.failed && "text-destructive-foreground/90",
      )}
    >
      {meta.type === "diff" ? (
        <>
          <span className="text-success">+{meta.additions}</span>
          {meta.deletions > 0 ? (
            <span className="ml-1.5 text-destructive">−{meta.deletions}</span>
          ) : null}
        </>
      ) : meta.type === "live" ? (
        <LiveElapsed startedAt={meta.startedAt} />
      ) : (
        meta.text
      )}
    </span>
  );
}

/**
 * Spinner while running; a check or cross that draws itself when the step
 * settles while on screen (and appears static when it mounted settled).
 */
export const StepStatusGlyph = memo(function StepStatusGlyph(props: {
  kind: ChapterStepDisplay["kind"];
  status: ChapterStepDisplay["status"];
}) {
  const { kind, status } = props;
  // Only a step seen running here animates when it settles; one that mounts
  // already settled appears static.
  const [sawRunning, setSawRunning] = useState(status === "running");
  if (status === "running" && !sawRunning) {
    setSawRunning(true);
  }
  const animateSettle = sawRunning && status !== "running";

  if (kind === "note") {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center",
          status === "failed" ? "text-destructive-foreground" : "text-muted-foreground/45",
        )}
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
          <circle cx="8" cy="8" r="2" />
        </svg>
      </span>
    );
  }
  if (kind === "think") {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center text-violet-500 dark:text-violet-300",
          status !== "running" && "opacity-70",
        )}
      >
        <svg
          viewBox="0 0 16 16"
          className={cn("size-4", status === "running" && "chapter-think-breathe")}
          fill="currentColor"
        >
          <path d="M8 1.8c.4 3.4 2 5 5.4 5.4v.2c-3.4.4-5 2-5.4 5.4h-.2c-.4-3.4-2-5-5.4-5.4v-.2c3.4-.4 5-2 5.4-5.4Z" />
        </svg>
      </span>
    );
  }
  if (status === "running") {
    return (
      <span
        aria-label="Running"
        className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60"
      >
        <svg
          viewBox="0 0 16 16"
          className="size-4 animate-spin"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="6" opacity=".25" />
          <path d="M8 2a6 6 0 0 1 6 6" />
        </svg>
      </span>
    );
  }
  const failed = status === "failed";
  return (
    <span
      aria-label={failed ? "Failed" : "Completed"}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center",
        failed ? "text-destructive-foreground" : "text-success",
        animateSettle && "chapter-glyph-pop",
      )}
    >
      <svg
        viewBox="0 0 16 16"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          className={animateSettle ? "chapter-glyph-draw" : undefined}
          pathLength={1}
          d={failed ? "M4.5 4.5l7 7M11.5 4.5l-7 7" : "M3.2 8.6 6.4 11.6 12.8 4.6"}
        />
      </svg>
    </span>
  );
});

/** Self-ticking elapsed label; writes its own text node once a second. */
function LiveElapsed({ startedAt }: { startedAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const format = (nowMs: number) => {
    const start = Date.parse(startedAt);
    if (!Number.isFinite(start)) return "";
    const seconds = Math.max(0, Math.floor((nowMs - start) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  useEffect(
    () =>
      visibleSecondTicker.subscribe((nowMs) => {
        if (textRef.current) textRef.current.textContent = format(nowMs);
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- format closes over startedAt only
    [startedAt],
  );
  return <span ref={textRef}>{format(Date.now())}</span>;
}
