/**
 * The Stage: a coded, faithful replica of the Ryco desktop window (macOS, the
 * default dark theme, not translucent), built on a fixed 1280×800 design
 * canvas and scaled to fit its container. Every value follows the app's own
 * source (apps/web/src: SidebarChrome, SidebarOmnifield, InboxThreadRow,
 * ChatHeader, ContentTabStrip, the Crown, MessagesTimeline, WorkChapterRow,
 * ChatComposer, ComposerFooter, BranchToolbar, NewThreadHero, DiffPanel,
 * ThreadTerminalDrawer), so the film looks like the app, not like a mock.
 * Because every coordinate is known, the film (film.ts) can choreograph camera
 * moves, a scripted cursor and panel transitions precisely at any size.
 *
 * The JSX is the *settled* composition (conversation finished, review panel
 * open). That is exactly what renders under reduced motion; with motion on,
 * the film rewinds everything to an empty thread and plays it back on scroll.
 * Animation targets are tagged with data-s="…".
 */
import { memo, useEffect, useRef } from "react";
import {
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleOff,
  ExternalLink,
  FileDiff,
  Folder,
  Folders,
  GitBranch,
  GitCompareArrows,
  GitPullRequest,
  Inbox,
  Laptop,
  ListChecks,
  ListTodo,
  ListTree,
  LockOpen,
  NotebookPen,
  PanelLeftClose,
  PanelRight,
  Paperclip,
  Plus,
  Rocket,
  Rows3,
  Send,
  Settings,
  SquareSplitHorizontal,
  SquareTerminal,
  Trash,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import { BrandIcon } from "@/assets/brands";
import { RycoMark } from "@/assets/RycoLogo";
import { providerById } from "@/data/content";
import { cn } from "@/lib/cn";
import { Code } from "./Code";
import {
  ANSWER,
  BACKOFF_FILE,
  BRANCH,
  CHANGES,
  DIFF,
  DIFF_CLICK_ROW,
  PROMPT,
  SPLIT_PANES,
  TERMINAL,
  TERMINAL_CMD,
  THREADS,
  TOOL_ROWS,
  type ToolRow,
} from "./script";

export const STAGE_W = 1280;
export const STAGE_H = 800;
/* Geometry shared with the film (the app's own sizes). */
export const SIDEBAR_W = 256;
/** Chat header: 56px bar plus its 1px border. */
export const HEADER_H = 57;
/** The Crown's column on the right of the chat row (48 + 2×12). */
export const CROWN_W = 72;
/** Main area right of the sidebar: the chat row (chat + Crown) and panels. */
export const BODY_W = STAGE_W - SIDEBAR_W;
export const CHAT_W = BODY_W - CROWN_W;
export const REVIEW_W = 440;
export const TERMINAL_H = 280;
export const GRID_GAP = 10;
/** A new thread centres its hero and composer; sending docks the composer
 *  this much lower, at the bottom of the chat. */
export const EMPTY_LIFT = 180;
/** The transcript keeps its newest content above the composer, like the
 *  app's scroll-to-bottom: once the turn ends, beside the open review panel
 *  (the column narrows and rewraps), and above the open terminal drawer. */
export const SCROLL_DONE = 30;
export const SCROLL_REVIEW = 70;
export const THREAD_SCROLL = 310;

/** The visible slice of the window. Phones frame the chat column (about 2x
 *  larger than fitting all 1280px) and let the film's camera pan to panels. */
export interface Crop {
  x: number;
  w: number;
}
export const FULL_CROP: Crop = { x: 0, w: STAGE_W };
export const NARROW_CROP: Crop = { x: SIDEBAR_W + CHAT_W / 2 - 310, w: 620 };

/* -------------------------------- primitives ------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("ry-spin", className)} fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The inbox's "working" glyph: an 11px sky ring, spinning. */
function RingSpinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "ry-spin block size-[11px] rounded-full border-[1.5px] border-[#00bcff]/25 border-t-[#00bcff]",
        className,
      )}
    />
  );
}

/** The work log's "think" glyph (WorkChapterRow). */
function ThinkGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("text-[#c4b4ff]", className)} aria-hidden>
      <path
        d="M8 1.8c.4 3.4 2 5 5.4 5.4v.6C10 8.2 8.4 9.8 8 13.2h-.6C7 9.8 5.4 8.2 2 7.8v-.6C5.4 6.8 7 5.2 7.4 1.8z"
        fill="currentColor"
      />
    </svg>
  );
}

/** The sidebar Omnifield's funnel. */
function Funnel({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M3 6h18M7 12h10M10 18h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A TypeScript file icon, as the change card and diff headers show it. */
function TsIcon({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[3px] bg-[#3178c6] font-sans text-[7px] font-bold leading-none text-white",
        className,
      )}
    >
      TS
    </span>
  );
}

function Delta({ add, del, className }: { add?: number; del?: number; className?: string }) {
  return (
    <span className={cn("tabular-nums", className)}>
      {add != null && <span className="text-rw-success">+{add}</span>}
      {del != null && <span className="ml-1.5 text-rw-danger">−{del}</span>}
    </span>
  );
}

/** One work-log step (WorkChapterRow): glyph, verb, target, meta. In the film
 *  (`live`) rows also carry a spinner for the spinner→check swap; static
 *  previews skip it so no loop runs unseen. */
export function ToolLine({
  row,
  compact = false,
  live = true,
}: {
  row: ToolRow;
  compact?: boolean;
  live?: boolean;
}) {
  const code = /[./“]/.test(row.target);
  return (
    <div
      data-s="tool"
      className={cn(
        "flex items-center rounded-lg",
        compact ? "h-6 gap-2 text-[12px]" : "h-[30px] gap-2.5 text-[13px]",
      )}
    >
      <span className="relative grid size-4 shrink-0 place-items-center">
        <Check
          data-s="tool-done"
          className={cn("absolute text-rw-success", compact ? "size-3" : "size-3.5")}
          strokeWidth={2.5}
        />
        {live && (
          <Spinner
            className={cn(
              "tool-spin absolute text-rw-muted opacity-0",
              compact ? "size-3" : "size-3.5",
            )}
          />
        )}
      </span>
      <span className="shrink-0 text-rw-muted/80">{row.verb}</span>
      <span
        className={cn(
          "min-w-0 truncate text-rw-fg/82",
          code && "font-rwmono",
          code && (compact ? "text-[11px]" : "text-[12px]"),
        )}
      >
        {row.target}
      </span>
      {row.meta && (
        <span className="ml-auto shrink-0 pl-3 text-[12px] text-rw-muted/55">
          {row.meta.text ?? <Delta add={row.meta.add} del={row.meta.del} />}
        </span>
      )}
    </div>
  );
}

function IconButton({
  children,
  className,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  [k: `data-${string}`]: string | undefined;
}) {
  return (
    <span
      {...rest}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full text-rw-muted/72 [&_svg]:size-4",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* --------------------------------- sidebar --------------------------------- */

const NAV = [
  [CalendarClock, "Automations"],
  [ListTodo, "Tasks"],
  [GitPullRequest, "Pull requests"],
  [Folders, "Projects"],
] as const;

/** PR badges a few rows carry, in the inbox's own colours. */
const ROW_PR: Record<string, { n: number; merged?: boolean }> = {
  t3: { n: 1098 },
  t5: { n: 1094, merged: true },
};

function SectionLabel({ title, count }: { title: string; count: number }) {
  return (
    <p className="flex items-center gap-2 px-2.5 py-1.5 text-[10px]">
      <span className="font-semibold uppercase tracking-[0.08em] text-rw-muted/65">{title}</span>
      <span className="tabular-nums text-rw-muted/45">{count}</span>
    </p>
  );
}

function ThreadRow({ index }: { index: number }) {
  const t = THREADS[index];
  const pr = ROW_PR[t.id];
  const first = index === 0;
  return (
    <div
      data-s="side-row"
      data-i={index}
      className={cn(
        "grid grid-cols-[22px_minmax(0,1fr)] rounded-[18px] px-2 py-1.5",
        first && "bg-rw-surface",
      )}
    >
      {/* status glyph: a resting glyph, swapped for the spinner while working */}
      <span className="relative grid h-[18px] place-items-center">
        <span data-s="side-age" className="grid place-items-center">
          {first ? (
            <span className="grid size-[13px] place-items-center rounded-full bg-rw-success">
              <Check className="size-[9px] text-black" strokeWidth={3.5} />
            </span>
          ) : (
            <span className="size-[5px] rounded-full bg-rw-muted/35" />
          )}
        </span>
        <RingSpinner className="side-spin absolute opacity-0" />
      </span>
      <span className="relative h-[18px] min-w-0 text-[13px] font-medium leading-[18px]">
        {first ? (
          <>
            <span
              data-s="side-title-new"
              className="absolute inset-0 truncate text-rw-fg/85 opacity-0"
            >
              New thread
            </span>
            <span data-s="side-title" className="block truncate font-semibold text-rw-fg">
              {t.title}
            </span>
          </>
        ) : (
          <span className="block truncate text-rw-fg/85">{t.title}</span>
        )}
      </span>
      <span className="grid h-4 place-items-center pt-px">
        <Folder className="size-3.5 text-rw-muted/50" />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pt-px text-[11.5px] leading-4 text-rw-muted">
        <span className="max-w-[45%] shrink-0 truncate font-medium text-rw-fg/70">ryco</span>
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <GitBranch className="size-[11px] shrink-0 opacity-70" />
          <span className="truncate">{t.branch}</span>
        </span>
        {pr && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-0.5 text-[11px] font-medium tabular-nums",
              pr.merged ? "text-[#a684ff]" : "text-[#5ee9b5]",
            )}
          >
            <GitPullRequest className="size-[11px]" />#{pr.n}
          </span>
        )}
        <span className="shrink-0 tabular-nums text-rw-muted/70">{t.age}</span>
      </span>
    </div>
  );
}

function Sidebar() {
  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-white/[0.07] bg-rw-side"
      style={{ width: SIDEBAR_W }}
    >
      {/* macOS traffic lights (titleBarStyle hiddenInset, inset 16/18) */}
      <span className="absolute left-4 top-[18px] flex gap-2">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </span>
      <div className="flex h-[52px] shrink-0 items-center gap-2 pl-[90px] pr-4">
        <RycoMark className="ml-1 h-[18px] text-rw-fg" />
        <span className="grid size-7 place-items-center rounded-full bg-rw-primary/10 text-rw-primary">
          <Inbox className="size-4" />
        </span>
        <span className="ml-auto flex items-center gap-0.5 text-rw-muted/70">
          <span className="grid h-[22px] w-[26px] place-items-center">
            <Settings className="size-3.5" />
          </span>
          <span className="grid h-[22px] w-[26px] place-items-center">
            <PanelLeftClose className="size-3.5" />
          </span>
        </span>
      </div>

      {/* the Omnifield, the new-thread button and the destinations */}
      <div className="relative mx-2 h-[154px] shrink-0">
        <div className="absolute left-0 top-0 flex h-[30px] w-[calc(100%-36px)] items-center gap-[3px] rounded-full border border-white/[0.12] bg-rw-fg/[0.035] pl-[3px] pr-1.5">
          <span className="grid size-[22px] shrink-0 place-items-center text-rw-muted/75">
            <Funnel className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-rw-muted/60">
            Filter, or type @ or is:
          </span>
          <kbd className="rounded-[4px] bg-rw-fg/[0.07] px-[5px] py-[3px] font-sans text-[10px] font-medium leading-none text-rw-muted/75">
            ⌘K
          </kbd>
        </div>
        <span className="absolute right-0 top-0 grid size-[30px] place-items-center rounded-full bg-rw-primary text-rw-bg">
          <Plus className="size-3.5" strokeWidth={2.4} />
        </span>
        {NAV.map(([Icon, label], i) => (
          <div
            key={label}
            className="absolute inset-x-0 flex h-7 items-center gap-2 rounded-[18px] px-2 text-[12px] text-rw-muted/70"
            style={{ top: 36 + i * 28 }}
          >
            <Icon className="size-3.5" />
            {label}
          </div>
        ))}
      </div>

      <div className="px-2 pb-2 pt-1">
        <SectionLabel title="Pinned" count={1} />
        <ThreadRow index={0} />
        <div className="h-2" />
        {/* the other threads move from Recent to Active now when they start */}
        <div className="grid">
          <div data-s="side-recent" className="col-start-1 row-start-1 opacity-0">
            <SectionLabel title="Recent" count={THREADS.length - 1} />
          </div>
          <div data-s="side-active" className="col-start-1 row-start-1">
            <SectionLabel title="Active now" count={THREADS.length - 1} />
          </div>
        </div>
        <div className="space-y-px">
          {THREADS.slice(1).map((t, i) => (
            <ThreadRow key={t.id} index={i + 1} />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2 rounded-[16px] px-2.5 py-1.5 text-[10px]">
          <ChevronRight className="size-3 text-rw-muted/55" />
          <span className="font-semibold uppercase tracking-[0.08em] text-rw-muted/65">
            Settled
          </span>
          <span className="ml-auto tabular-nums text-rw-muted/45">38</span>
        </div>
      </div>

      <div className="mx-2 mb-[17px] mt-auto h-px bg-white/[0.07]" />
    </aside>
  );
}

/* --------------------------------- header ---------------------------------- */

function Tab({ thread, active }: { thread: (typeof THREADS)[number]; active?: boolean }) {
  const p = providerById(thread.provider);
  return (
    <span
      className={cn(
        "relative flex h-8 min-w-[108px] shrink basis-[216px] items-center gap-2 rounded-full pl-2.5 text-[12px]",
        active
          ? "bg-rw-bg pr-8 text-rw-fg shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.14)]"
          : "pr-3 text-rw-muted",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <BrandIcon name={p.brand} className="size-3.5" style={{ color: p.accent }} />
      </span>
      {active ? (
        <span className="relative h-4 min-w-0 flex-1 leading-4 [mask-image:linear-gradient(90deg,#000_calc(100%-1rem),transparent)]">
          <span data-s="title-new" className="absolute inset-0 whitespace-nowrap opacity-0">
            New thread
          </span>
          <span data-s="title-real" className="absolute inset-0 whitespace-nowrap">
            {thread.title}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(90deg,#000_calc(100%-1rem),transparent)]">
          {thread.title}
        </span>
      )}
      {active && (
        <span className="absolute right-1 grid size-6 place-items-center text-rw-muted">
          <X className="size-3.5" />
        </span>
      )}
    </span>
  );
}

function ChatHeader() {
  return (
    <header
      className="@container absolute inset-x-0 top-0 z-[3] flex items-center gap-3 border-b border-white/[0.07] bg-rw-side px-5"
      style={{ height: HEADER_H }}
    >
      <span className="flex shrink-0 items-center gap-1.5 text-[14px] font-medium text-rw-fg">
        <Folder className="size-4 text-rw-muted" />
        ryco
        <ChevronRight className="size-3 text-rw-muted/60" />
      </span>
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        <Tab thread={THREADS[0]} active />
        <span className="mx-1 h-5 w-px shrink-0 bg-white/[0.09]" />
        <Tab thread={THREADS[1]} />
        <span className="mx-1 h-5 w-px shrink-0 bg-white/[0.09]" />
        <Tab thread={THREADS[2]} />
      </div>
      <div className="flex shrink-0 items-center gap-2 @min-[768px]:gap-3">
        {/* Overview toggle: pressed, the Crown is open */}
        <IconButton className="bg-rw-fg/10 text-rw-fg">
          <ListChecks />
        </IconButton>
        {/* Workspace panel toggle: pressed while the review panel is open */}
        <IconButton data-s="btn-panel" className="bg-rw-fg/10 text-rw-fg">
          <PanelRight />
        </IconButton>
        <span className="flex h-7 items-center gap-1.5 px-2 text-[12px] text-rw-muted/72">
          <Plus className="size-3.5" />
          <span className="@max-[767px]:hidden">Add action</span>
        </span>
        <span className="flex h-7 items-center text-[12px] text-rw-muted/72">
          <span className="flex items-center gap-1.5 px-2">
            <BrandIcon name="cursor" className="size-4" />
            <span className="@max-[767px]:hidden">Open</span>
          </span>
          <span className="grid size-7 place-items-center">
            <ChevronDown className="size-4" />
          </span>
        </span>
      </div>
    </header>
  );
}

/* ---------------------------------- crown ---------------------------------- */

const CROWN_SURFACE =
  "bg-rw-crown ring-1 ring-inset ring-white/[0.08] shadow-[0_16px_44px_-16px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.05)]";

function RailButton({ children, badge }: { children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <span className="relative grid size-9 place-items-center rounded-full text-rw-muted [&_svg]:size-4">
      {children}
      {badge}
    </span>
  );
}

function RailBadge({
  children,
  info,
  ...rest
}: {
  children: React.ReactNode;
  info?: boolean;
  "data-s"?: string;
}) {
  return (
    <span
      {...rest}
      className={cn(
        "absolute -bottom-0.5 -right-[3px] grid h-[15px] min-w-[15px] place-items-center rounded-[8px] px-1 font-rwmono text-[9px] font-semibold leading-none ring-2 ring-rw-crown",
        info ? "bg-rw-info text-white" : "bg-[#222226] text-rw-fg",
      )}
    >
      {children}
    </span>
  );
}

function Crown() {
  return (
    <div data-s="crown" className="absolute right-3 z-[2] w-12" style={{ top: HEADER_H + 12 }}>
      {/* the face: project logo with its status dot */}
      <div className={cn("relative grid size-12 place-items-center rounded-full", CROWN_SURFACE)}>
        <span className="grid size-[38px] place-items-center rounded-full bg-rw-monogram text-[19px] font-semibold text-white">
          R
        </span>
        <span
          data-s="crown-dot"
          className="absolute bottom-0 right-0 size-[11px] rounded-full bg-rw-success ring-2 ring-rw-crown"
        />
      </div>
      {/* the rail */}
      <div
        className={cn(
          "mt-2 flex flex-col items-center gap-[5px] rounded-[24px] p-1.5",
          CROWN_SURFACE,
        )}
      >
        <RailButton badge={<RailBadge data-s="diff-count">{CHANGES.files}</RailBadge>}>
          <FileDiff />
        </RailButton>
        <RailButton>
          <svg viewBox="0 0 30 30" className="!size-[30px]" aria-hidden>
            <circle
              cx="15"
              cy="15"
              r="12.5"
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="2.5"
            />
            <circle
              cx="15"
              cy="15"
              r="12.5"
              fill="none"
              stroke="#00bc7d"
              strokeWidth="2.5"
              strokeDasharray="78.5"
              strokeDashoffset="0"
              transform="rotate(-90 15 15)"
            />
            <circle cx="15" cy="15" r="3.5" fill="#00bc7d" />
          </svg>
        </RailButton>
        <RailButton>
          <Bot />
        </RailButton>
        <RailButton>
          <GitPullRequest />
        </RailButton>
        <span className="my-0.5 h-px w-5 bg-white/[0.09]" />
        <RailButton>
          <NotebookPen />
        </RailButton>
        {/* Ship: ready once the turn has changes (the film reveals it) */}
        <RailButton>
          <Rocket className="text-rw-muted" />
          <span data-s="ship-ready" className="absolute inset-0 grid place-items-center">
            <span className="absolute inset-0 rounded-full bg-rw-crown ring-[1.5px] ring-inset ring-rw-info/70" />
            <Rocket className="relative text-rw-info-fg" />
            <RailBadge info>{CHANGES.files}</RailBadge>
          </span>
        </RailButton>
      </div>
    </div>
  );
}

/* -------------------------------- composer --------------------------------- */

function Composer() {
  const claude = providerById("claude");
  return (
    <div data-s="composer" className="absolute inset-x-0 bottom-0 z-[1] px-5">
      {/* the scrim that fades the transcript behind the composer */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 bg-gradient-to-b from-transparent via-rw-bg/90 to-rw-bg"
      />
      <div className="relative mx-auto max-w-(--rw-composer) pt-2">
        <div data-s="composer-plate" className="rounded-[28px] bg-rw-surface">
          <div className="px-4 pb-2 pt-4">
            <div data-s="editor" className="relative min-h-[26px] text-[14px] leading-relaxed">
              <span data-s="placeholder" className="absolute inset-0 truncate text-rw-muted/35">
                Ask anything, @tag files/folders, or use / to show available commands
              </span>
              <span
                data-s="placeholder-run"
                className="absolute inset-0 truncate text-rw-muted/35 opacity-0"
              >
                Queue a follow-up · ⌘↵ to steer
              </span>
              <span data-s="typed" className="relative text-rw-fg" />
              <span data-s="typed-caret" className="ry-caret relative text-rw-fg opacity-0" />
            </div>
          </div>
          <div className="@container flex items-center gap-1 whitespace-nowrap px-2.5 pb-2.5 text-[12px]">
            <span className="grid size-6 place-items-center text-rw-muted/70">
              <Paperclip className="size-4" />
            </span>
            <span className="flex h-6 items-center gap-1.5 rounded-full px-2 text-rw-muted/70">
              <BrandIcon name={claude.brand} className="size-4" style={{ color: claude.accent }} />
              <span className="text-rw-fg/85">Opus 5.5</span>
              <span className="font-medium text-[#ae90fc]">XHigh</span>
              <Zap className="size-3 fill-current text-[#fdc700]" />
              <span className="rounded-[4px] px-1 text-[10px] ring-1 ring-inset ring-white/[0.09]">
                1M
              </span>
              <ChevronDown className="size-3 opacity-60" />
            </span>
            <span className="flex h-6 items-center gap-1.5 rounded-full px-2 text-rw-muted/80">
              <Laptop className="size-3.5" />
              {/* labels collapse when the composer gets narrow */}
              <span className="@max-[520px]:hidden">MacBook Pro</span>
              <ChevronDown className="size-3 opacity-60 @max-[520px]:hidden" />
            </span>
            <span className="grid size-6 place-items-center text-[#ff8904]">
              <LockOpen className="size-4" />
            </span>
            <span className="grid size-6 place-items-center text-rw-muted/70">
              <CircleOff className="size-4" />
            </span>
            {/* context window: 24px ring with the share in its middle */}
            <span className="relative ml-auto grid size-6 place-items-center" aria-hidden>
              <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90">
                <circle
                  cx="12"
                  cy="12"
                  r="9.75"
                  fill="none"
                  stroke="rgba(255,255,255,0.042)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r="9.75"
                  fill="none"
                  stroke="#b2b2b2"
                  strokeWidth="3"
                  strokeDasharray="61.3"
                  strokeDashoffset="53.9"
                  strokeLinecap="round"
                />
              </svg>
              <span className="relative grid size-[15px] place-items-center rounded-full bg-rw-bg font-sans text-[8px] text-rw-fg/80">
                12
              </span>
            </span>
            <span className="relative ml-1.5 size-8">
              <span
                data-s="send"
                className="absolute inset-0 grid place-items-center rounded-full bg-rw-primary/90 text-rw-bg"
              >
                <Send className="size-3.5" />
              </span>
              <span
                data-s="stop"
                className="absolute inset-0 grid place-items-center rounded-full bg-[#ff2056]/90 opacity-0"
              >
                <span className="size-2 rounded-[1.5px] bg-white" />
              </span>
            </span>
          </div>
        </div>
        {/* the branch toolbar */}
        <div className="relative flex h-9 items-center justify-center px-3 pb-3 pt-1 text-[12px] text-rw-muted/70">
          <span data-s="btn-term" className="flex h-6 items-center gap-1.5 rounded-full px-2">
            <SquareTerminal className="size-3" />
            <span className="grid">
              <span data-s="term-open" className="col-start-1 row-start-1">
                Open Terminal
              </span>
              <span data-s="term-close" className="col-start-1 row-start-1 opacity-0">
                Close Terminal
              </span>
            </span>
          </span>
          <span className="absolute right-3 flex h-6 items-center gap-1 px-2">
            {BRANCH}
            <ChevronDown className="size-3.5" />
          </span>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- thread ---------------------------------- */

/** A brand-new thread (NewThreadHero, the work location and context bar). */
function EmptyHero() {
  return (
    <div
      data-s="empty"
      className="pointer-events-none absolute inset-x-0 flex flex-col items-center px-5 text-center opacity-0"
      style={{ top: 250 }}
    >
      <span className="grid size-[52px] place-items-center rounded-[14px] bg-rw-monogram text-[24px] font-semibold text-white shadow-[0_10px_30px_-10px_rgba(207,54,76,0.55),inset_0_0_0_1px_rgba(255,255,255,0.08)]">
        R
      </span>
      <p className="mt-4 text-[30px] font-medium leading-9 tracking-tight text-rw-fg">
        What should we do in ryco?
      </p>
      <p className="mt-2 text-[13px] text-rw-muted/70">
        Work in <span className="text-rw-fg/85">ryco</span> ›{" "}
        <span className="text-rw-fg/85">a new worktree</span> from{" "}
        <span className="text-rw-fg/85">main</span>
      </p>
      <div className="mt-6 flex w-full max-w-(--rw-composer) items-center justify-between text-[12px] text-rw-fg/85">
        <span className="flex h-7 items-center gap-2 rounded-full border border-white/[0.09] bg-rw-bg pl-1.5 pr-3">
          <span className="relative h-4 w-7 rounded-full bg-rw-primary">
            <span className="absolute right-0.5 top-0.5 size-3 rounded-full bg-rw-bg" />
          </span>
          New worktree
        </span>
        <span className="flex h-7 items-center gap-2 rounded-full border border-white/[0.09] bg-rw-bg px-3">
          <span className="size-1.5 rounded-full bg-[#00bc7d]" />
          MacBook Pro
        </span>
      </div>
    </div>
  );
}

function Thread() {
  const claude = providerById("claude");
  return (
    <div
      data-s="thread"
      className="absolute inset-0 origin-top"
      style={{ transform: `translateY(${-SCROLL_REVIEW}px)` }}
    >
      <EmptyHero />
      <div className="mx-auto max-w-(--rw-timeline) px-5" style={{ paddingTop: HEADER_H + 8 + 16 }}>
        <div data-s="user-msg" className="flex flex-col items-end pb-4">
          <p className="max-w-[80%] whitespace-pre-wrap rounded-[26px] rounded-br-[14px] bg-rw-bubble px-3 py-2 text-[14px] leading-relaxed text-rw-fg shadow-md shadow-black/5">
            {PROMPT}
          </p>
          <span className="mt-1 text-[11px] text-rw-muted/50">20:41:07</span>
        </div>

        <div data-s="assistant">
          {/* turn header: Working → Worked for */}
          <div className="flex h-[30px] items-center gap-2 rounded-lg text-[13px] text-rw-muted/70">
            <BrandIcon name={claude.brand} className="size-3.5" style={{ color: claude.accent }} />
            <span className="relative flex-1">
              <span data-s="turn-working" className="absolute inset-0 flex gap-2 opacity-0">
                <span className="ry-shimmer">Working</span>
                <span className="text-rw-muted/50">31s</span>
              </span>
              <span data-s="worked">Worked for 48s</span>
            </span>
            <ChevronRight className="size-4 rotate-90 text-rw-muted/55" />
          </div>
          {/* one work chapter: rail, node, steps */}
          <div className="relative mt-0.5 pl-[26px]">
            <span className="absolute bottom-3 left-[7px] top-3 w-px bg-rw-muted/22" />
            <span className="absolute left-[2.5px] top-[10px] size-2.5 scale-75 rounded-full bg-rw-muted/45" />
            <div data-s="think" className="flex h-[30px] items-center gap-2.5 text-[13px]">
              <ThinkGlyph className="size-4 shrink-0" />
              <span className="text-rw-muted/80">Thought for 3.1s</span>
              <span className="text-[12px] text-rw-muted/55">Reading the relay client</span>
            </div>
            {TOOL_ROWS.map((row) => (
              <ToolLine key={row.verb + row.target} row={row} />
            ))}
          </div>
          <p className="mt-3 min-h-[69px] text-[14px] leading-relaxed text-rw-fg/80">
            <span data-s="answer">{ANSWER}</span>
            <span data-s="answer-caret" className="ry-caret text-rw-fg opacity-0" />
          </p>
          <p data-s="answer-meta" className="mt-1.5 text-[10px] text-rw-muted/30">
            20:41:55 • 48s
          </p>
          {/* the change summary card */}
          <div
            data-s="changes"
            className="mb-1 mt-2 overflow-hidden rounded-[0.65rem] border border-white/[0.065]"
          >
            <div className="flex items-center gap-2.5 bg-white/[0.024] px-3 py-1.5">
              <FileDiff className="size-3.5 text-rw-muted" />
              <span className="flex-1 leading-tight">
                <span className="block text-[12px] text-rw-fg/92">
                  Edited {CHANGES.files} files
                </span>
                <span className="text-[11px]">
                  <span className="text-rw-success">+{CHANGES.add}</span>
                  <span className="text-rw-muted/50"> / </span>
                  <span className="text-rw-danger">-{CHANGES.del}</span>
                </span>
              </span>
              <span className="flex items-center gap-1 text-[12px] text-rw-muted">
                Undo <Undo2 className="size-3.5" />
              </span>
              <span data-s="review-btn" className="ml-2 rounded-md px-1 text-[12px] text-rw-muted">
                Review changes
              </span>
              <ChevronDown className="size-4 text-rw-muted/70" />
            </div>
            {[
              ["relay/client.ts", 11, 2],
              ["relay/backoff.ts", 52, 0],
              ["relay/backoff.test.ts", 68, 0],
            ].map(([path, add, del]) => (
              <div
                key={path}
                className="flex items-center gap-2.5 border-t border-white/[0.09] px-3 py-2 text-[12px]"
              >
                <TsIcon />
                <span className="flex-1 truncate text-rw-fg/85">{path}</span>
                <span className="tabular-nums">
                  <span className="text-rw-success">+{add}</span>
                  <span className="text-rw-muted/50"> / </span>
                  <span className="text-rw-danger">-{del}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- parallel panes ------------------------------- */

function ParallelGrid() {
  return (
    <div
      data-s="grid"
      className="invisible absolute inset-x-0 bottom-0 grid grid-cols-2 grid-rows-2 opacity-0"
      style={{ top: HEADER_H, gap: GRID_GAP, padding: GRID_GAP }}
    >
      {SPLIT_PANES.map((pane) => {
        const t = THREADS.find((x) => x.id === pane.thread)!;
        const p = providerById(t.provider);
        return (
          <div
            key={pane.thread}
            data-s="pane"
            className="relative flex flex-col overflow-hidden rounded-[18px] bg-rw-bg ring-1 ring-inset ring-white/[0.09]"
          >
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.07] bg-rw-side px-3.5 text-[12px]">
              <BrandIcon name={p.brand} className="size-3.5 shrink-0" style={{ color: p.accent }} />
              <span className="min-w-0 truncate text-rw-fg">{t.title}</span>
              <span className="ml-auto shrink-0 text-[11px] text-rw-muted/60">{pane.model}</span>
            </div>
            <div className="flex-1 px-4 pt-3">
              <div className="flex h-6 items-center gap-2 text-[12px] text-rw-muted/70">
                <BrandIcon name={p.brand} className="size-3" style={{ color: p.accent }} />
                <span className="ry-shimmer">Working</span>
              </div>
              <div className="relative pl-[22px]">
                <span className="absolute bottom-2 left-[7px] top-2 w-px bg-rw-muted/22" />
                {pane.rows.map((row) => (
                  <ToolLine key={row.verb + row.target} row={row} compact />
                ))}
              </div>
              <p className="mt-2.5 text-[13px] leading-[1.6] text-rw-fg/80">
                <span data-s="pane-text">{pane.text}</span>
                <span className="ry-caret pane-caret text-rw-fg opacity-0" />
              </p>
            </div>
            <div className="m-2.5 flex h-10 shrink-0 items-center rounded-[20px] bg-rw-surface pl-4 pr-1.5 text-[11.5px] text-rw-muted/35">
              Queue a follow-up · ⌘↵ to steer
              <span className="ml-auto grid size-7 place-items-center rounded-full bg-[#ff2056]/90">
                <span className="size-[7px] rounded-[1.5px] bg-white" />
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ review panel ------------------------------- */

function DiffFile({
  path,
  add,
  del,
  children,
  open = true,
}: {
  path: string;
  add: number;
  del?: number;
  children?: React.ReactNode;
  open?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-[14px] bg-[#141415] ring-1 ring-inset ring-white/[0.07]">
      <div
        className={cn(
          "flex h-9 items-center gap-2 bg-[#222223] px-3 text-[12px]",
          open && "border-b border-white/[0.09]",
        )}
      >
        {open ? (
          <ChevronDown className="size-3.5 text-rw-muted" />
        ) : (
          <ChevronRight className="size-3.5 text-rw-muted" />
        )}
        <TsIcon />
        <span className="font-rwmono text-[11.5px] text-rw-fg">{path}</span>
        <span className="ml-auto text-[11.5px]">
          <span className="text-rw-success">+{add}</span>
          {del != null && <span className="ml-1.5 text-rw-danger">-{del}</span>}
        </span>
      </div>
      {children}
    </div>
  );
}

function ReviewPanel() {
  return (
    <aside
      data-s="review"
      className="absolute bottom-0 right-0 top-0 z-[4] flex flex-col border-l border-white/[0.09] bg-rw-bg"
      style={{ width: REVIEW_W }}
    >
      {/* workspace panel tabs */}
      <div className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-white/[0.09] px-3">
        <span className="flex h-8 items-center gap-2 rounded-full bg-white/[0.06] pl-3 pr-2 text-[14px] text-rw-fg">
          <GitCompareArrows className="size-4" /> Review
          <X className="ml-1 size-3.5 text-rw-muted" />
        </span>
        <span className="grid size-8 place-items-center text-rw-muted">
          <Plus className="size-4" />
        </span>
      </div>
      {/* turns and file navigation */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-white/[0.09] px-4 text-[10px]">
        <span className="rounded-full border border-white/[0.09] bg-white/[0.09] px-2 py-1 text-rw-fg">
          All turns
        </span>
        <span className="rounded-full border border-white/[0.09] px-2 py-1 text-rw-muted">
          Turn 1 <span className="text-rw-muted/60">20:41</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-rw-muted">
          <ChevronUp className="size-3.5" />
          1/3 <span className="font-rwmono text-rw-fg/85">relay/client.ts</span>
        </span>
        <span className="ml-1 flex items-center gap-1 text-rw-muted">
          <Rows3 className="size-3" />
        </span>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.045] px-3 text-[11px] text-rw-muted">
        <ListTree className="size-3.5" />
        <span>{CHANGES.files} files</span>
        <span>
          <span className="text-rw-success">+{CHANGES.add}</span> /{" "}
          <span className="text-rw-danger">-{CHANGES.del}</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          <ChevronUp className="size-3.5" />
          <ChevronDown className="size-3.5" />
        </span>
      </div>

      <div className="flex-1 space-y-2 overflow-hidden p-2.5">
        <DiffFile path="relay/client.ts" add={11} del={2}>
          <div className="py-1 font-rwmono text-[11.5px] leading-[22px]">
            {DIFF.map((line, i) => (
              <div
                key={i}
                data-s={i === DIFF_CLICK_ROW ? "diff-hit" : "diff-line"}
                className={cn(
                  "relative flex whitespace-pre",
                  line.kind === "add" && "bg-[#0a1915]",
                  line.kind === "del" && "bg-[#1e0f11]",
                )}
              >
                {i === DIFF_CLICK_ROW && (
                  <span
                    data-s="diff-hit-glow"
                    className="pointer-events-none absolute inset-0 bg-white/[0.07] opacity-0 ring-1 ring-inset ring-white/25"
                  />
                )}
                <span className="w-9 shrink-0 pr-2 text-right text-rw-muted/40">
                  {line.n ?? ""}
                </span>
                <span
                  className={cn(
                    "w-4 shrink-0",
                    line.kind === "add" && "text-rw-success",
                    line.kind === "del" && "text-rw-danger",
                  )}
                >
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                </span>
                <span className="min-w-0 overflow-hidden pr-3">
                  <Code code={line.code} />
                </span>
              </div>
            ))}
          </div>
        </DiffFile>
        <DiffFile path="relay/backoff.ts" add={52}>
          <div className="py-1 font-rwmono text-[11.5px] leading-[22px]">
            {BACKOFF_FILE.map((code, i) => (
              <div key={i} className="flex whitespace-pre bg-[#0a1915]">
                <span className="w-9 shrink-0 pr-2 text-right text-rw-muted/40">{i + 12}</span>
                <span className="w-4 shrink-0 text-rw-success">+</span>
                <span className="min-w-0 overflow-hidden pr-3">
                  <Code code={code} />
                </span>
              </div>
            ))}
          </div>
        </DiffFile>
        <DiffFile path="relay/backoff.test.ts" add={68} open={false} />
      </div>
    </aside>
  );
}

/* -------------------------------- terminal --------------------------------- */

function TerminalDrawer() {
  return (
    <div
      data-s="terminal"
      className="relative shrink-0 overflow-hidden bg-rw-bg"
      /* settled: closed; the film opens it to TERMINAL_H */
      style={{ height: 0 }}
    >
      <div className="flex flex-col border-t border-white/[0.072]" style={{ height: TERMINAL_H }}>
        <div className="flex h-7 shrink-0 items-center border-b border-white/[0.063] bg-white/[0.006] text-[12px]">
          <span className="flex h-full items-center gap-1.5 bg-rw-bg px-2 text-rw-fg">
            <SquareTerminal className="size-3" /> Terminal 1
            <span className="size-1.5 rounded-full bg-[#00bc7d]" />
          </span>
          <span className="flex h-full items-center gap-1.5 px-2 text-rw-muted">
            <SquareTerminal className="size-3" /> dev
          </span>
          <span className="grid h-full w-7 place-items-center text-rw-muted">
            <Plus className="size-[13px]" />
          </span>
          <span className="ml-auto grid h-full w-8 place-items-center border-l border-white/[0.063] text-rw-muted">
            <SquareSplitHorizontal className="size-3.5" />
          </span>
          <span className="grid h-full w-8 place-items-center border-l border-white/[0.063] text-rw-muted">
            <Trash className="size-3.5" />
          </span>
        </div>
        <div className="flex-1 px-3 py-2 font-rwmono text-[12px] leading-[1.2] text-rw-fg/90 [&>div]:min-h-[14.4px]">
          <div>
            <span className="text-[#89beff]">~/code/ryco</span>{" "}
            <span className="text-[#86e795]">{BRANCH}</span>
          </div>
          <div>
            <span className="text-[#ff7a8e]">❯ </span>
            <span data-s="term-cmd">{TERMINAL_CMD}</span>
            <span data-s="term-caret" className="ry-block-caret ml-px text-[#b4cbff] opacity-0" />
          </div>
          {TERMINAL.map((l, i) => (
            <div
              key={i}
              data-s="term-line"
              className={cn(
                "whitespace-pre",
                l.tone === "ok" && "text-[#86e795]",
                l.tone === "dim" && "text-rw-muted/70",
                l.tone === "bold" && "font-semibold text-rw-fg",
              )}
            >
              {l.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- cursor ---------------------------------- */

function Cursor() {
  return (
    <div data-s="cursor" className="pointer-events-none absolute left-0 top-0 z-10 opacity-0">
      <span
        data-s="cursor-ring"
        className="absolute -left-3 -top-3 size-6 rounded-full border border-white/70 opacity-0"
      />
      <svg
        width="20"
        height="22"
        viewBox="0 0 20 22"
        className="drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
      >
        <path
          d="M2 1.5v16.2l4.3-4 2.7 6.3 3-1.3-2.7-6.2h6z"
          fill="#fff"
          stroke="#111"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/* ---------------------------------- window --------------------------------- */

/** The app's chat column widths (--chat-timeline-max-width and
 *  --chat-composer-max-width). Through the phone crop the window plays as a
 *  narrower one, so the conversation fits the slice the camera shows. */
const COLUMN_WIDTHS = { "--rw-timeline": "768px", "--rw-composer": "832px" };
const COMPACT_COLUMN_WIDTHS = { "--rw-timeline": "600px", "--rw-composer": "600px" };

const Window = memo(function Window({ compact }: { compact: boolean }) {
  return (
    <div
      data-s="window"
      className="relative flex overflow-hidden rounded-[14px] bg-rw-bg font-sans text-rw-fg ring-1 ring-inset ring-white/[0.08]"
      style={
        {
          width: STAGE_W,
          height: STAGE_H,
          ...(compact ? COMPACT_COLUMN_WIDTHS : COLUMN_WIDTHS),
        } as React.CSSProperties
      }
    >
      <Sidebar />

      <section className="relative h-full flex-1 overflow-hidden">
        {/* the chat row: header, transcript, composer, Crown, terminal. Settled
            narrowed beside the open review panel; the film widens it. */}
        <div
          data-s="chat"
          className="absolute left-0 top-0 flex h-full flex-col"
          style={{ width: BODY_W - REVIEW_W }}
        >
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ChatHeader />
            <div className="absolute inset-y-0 left-0" style={{ right: CROWN_W }}>
              <Thread />
              <Composer />
            </div>
            <Crown />
            <div
              data-s="toast"
              className="invisible absolute bottom-[132px] left-5 z-[3] flex items-center gap-2.5 rounded-[14px] bg-rw-surface px-3.5 py-2.5 text-[12.5px] text-rw-fg opacity-0 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.8)] ring-1 ring-inset ring-white/[0.09]"
            >
              <ExternalLink className="size-3.5 text-rw-muted" />
              Opened in Cursor
              <span className="font-rwmono text-[11.5px] text-rw-muted">relay/client.ts:80</span>
            </div>
          </div>
          <TerminalDrawer />
        </div>
        <ParallelGrid />
        <ReviewPanel />
      </section>

      <Cursor />
    </div>
  );
});

/**
 * Scales the 1280×800 window (or its `crop` slice) to the container width. The
 * `data-cam` layer is the film's camera (zoom/pan); the fit layer only ever
 * carries the fit scale and the crop offset.
 */
export const Stage = memo(function Stage({
  className,
  crop = FULL_CROP,
}: {
  className?: string;
  crop?: Crop;
}) {
  const box = useRef<HTMLDivElement>(null);
  const fit = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    const inner = fit.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(([entry]) => {
      inner.style.transform = `scale(${entry.contentRect.width / crop.w}) translateX(${-crop.x}px)`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [crop]);

  return (
    <div
      ref={box}
      data-s="stage"
      data-loops
      className={cn(
        /* will-change: the tilt (and camera below) move every scrolled frame;
           without their own locked layers Chrome re-rasters the whole window
           each frame (measured ~10x more raster time) */
        "relative w-full overflow-hidden rounded-[10px] ring-1 ring-white/[0.12] will-change-transform sm:rounded-[14px]",
        className,
      )}
      style={{ aspectRatio: `${crop.w} / ${STAGE_H}` }}
      role="img"
      aria-label="The Ryco desktop app: a Claude thread adding relay reconnect backoff, with the review panel showing the diff."
    >
      {/* the role=img wrapper speaks for the replica via its aria-label */}
      <div
        ref={fit}
        aria-hidden
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: STAGE_W, height: STAGE_H }}
      >
        <div data-s="cam" className="h-full w-full origin-top-left will-change-transform">
          <Window compact={crop.w < STAGE_W} />
        </div>
      </div>
    </div>
  );
});
