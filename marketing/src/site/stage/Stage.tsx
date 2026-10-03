/**
 * The Stage: a coded, faithful replica of the Ryco desktop window, built on a
 * fixed 1280×800 design canvas and scaled to fit its container. Because every
 * coordinate is known, the film (film.ts) can choreograph camera moves, a
 * scripted cursor and panel transitions precisely at any viewport size.
 *
 * The JSX is the *settled* composition (conversation finished, review panel
 * open). That is exactly what renders under reduced motion; with motion on,
 * the film rewinds everything to an empty thread and plays it back on scroll.
 * Animation targets are tagged with data-s="…".
 */
import { memo, useEffect, useRef } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Columns2,
  ExternalLink,
  FileDiff,
  FilePlus2,
  FolderClosed,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  Paperclip,
  Plus,
  Search,
  Settings,
  SquareTerminal,
  X,
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
  DIFF,
  DIFF_CLICK_ROW,
  PANES,
  PROMPT,
  TERMINAL,
  TERMINAL_CMD,
  THREADS,
  TOOL_ROWS,
  type ToolRow,
} from "./script";

export const STAGE_W = 1280;
export const STAGE_H = 800;
/* Geometry shared with the film. */
export const SIDEBAR_W = 252;
export const HEADER_H = 48;
export const REVIEW_W = 440;
export const TERMINAL_H = 250;
export const GRID_GAP = 10;

/** The visible slice of the window. Phones frame the chat column (about 2x
 *  larger than fitting all 1280px) and let the film's camera pan to panels. */
export interface Crop {
  x: number;
  w: number;
}
export const FULL_CROP: Crop = { x: 0, w: STAGE_W };
export const NARROW_CROP: Crop = { x: 456, w: 620 };

/* -------------------------------- primitives ------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("ry-spin", className)} fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Delta({ add, del, className }: { add?: number; del?: number; className?: string }) {
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {add != null && <span className="text-[#5fcf86]">+{add}</span>}
      {del != null && <span className="ml-1.5 text-[#f2766b]">−{del}</span>}
    </span>
  );
}

/** One work-log row. In the film (`live`) rows also carry a spinner for the
 *  spinner→check swap; static previews skip it so no loop runs unseen. */
export function ToolLine({
  row,
  compact = false,
  live = true,
}: {
  row: ToolRow;
  compact?: boolean;
  live?: boolean;
}) {
  const file = /[./]/.test(row.target) && !row.target.includes(" ");
  return (
    <div
      data-s="tool"
      className={cn(
        "flex items-center gap-2 text-app-muted",
        compact ? "h-[21px] text-[11px]" : "h-[28px] text-[12.5px]",
      )}
    >
      <span
        className={cn("relative grid shrink-0 place-items-center", compact ? "size-3" : "size-3.5")}
      >
        <Check data-s="tool-done" className="absolute size-full text-[#5fcf86]" strokeWidth={2.5} />
        {live && <Spinner className="tool-spin absolute size-full text-app-muted opacity-0" />}
      </span>
      <span className="shrink-0">{row.verb}</span>
      <span className={cn("min-w-0 truncate text-app-fg/90", file && "font-mono text-[0.92em]")}>
        {row.target}
      </span>
      {row.meta && (
        <span className="ml-auto shrink-0 pl-3">
          {row.meta.text ? (
            <span className="text-app-muted">{row.meta.text}</span>
          ) : (
            <Delta add={row.meta.add} del={row.meta.del} />
          )}
        </span>
      )}
    </div>
  );
}

function IconButton({
  children,
  label,
  className,
  ...rest
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
  [k: `data-${string}`]: string | undefined;
}) {
  return (
    <span
      {...rest}
      aria-label={label}
      className={cn(
        "grid size-[30px] place-items-center rounded-lg text-app-muted [&_svg]:size-[15px]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* --------------------------------- sidebar --------------------------------- */

function Sidebar() {
  return (
    <aside
      className="flex h-full flex-col border-r border-white/[0.07] bg-app-side"
      style={{ width: SIDEBAR_W }}
    >
      <div className="flex h-10 items-center gap-2 px-[14px]">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>
      <div className="flex h-9 items-center justify-between px-3.5">
        <RycoMark className="h-[17px] text-app-fg" />
        <div className="flex items-center gap-0.5">
          <IconButton>
            <Search />
          </IconButton>
          <IconButton>
            <Settings />
          </IconButton>
        </div>
      </div>

      <div className="mx-2.5 mt-1.5 flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-[13px] text-app-fg/90 hover:bg-white/5">
        <Plus className="size-4 text-app-muted" />
        New thread
        <span className="ml-auto font-mono text-[11px] text-app-muted/70">⌘N</span>
      </div>

      <p className="mt-5 px-5 text-[11px] font-medium tracking-[0.04em] text-app-muted/70">
        Projects
      </p>

      <div className="mt-1.5 px-2.5">
        <div className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium text-app-fg">
          <FolderOpen className="size-4 text-app-muted" />
          ryco
          <span className="ml-auto text-[11px] font-normal text-app-muted/70">6</span>
        </div>
        <div className="relative ml-[17px] border-l border-white/[0.07] pl-1.5">
          {THREADS.map((t, i) => {
            const p = providerById(t.provider);
            return (
              <div
                key={t.id}
                data-s="side-row"
                data-i={i}
                className={cn(
                  "relative flex h-[30px] items-center gap-2 rounded-md px-2 text-[12.5px]",
                  i === 0 ? "bg-white/[0.075] text-app-fg" : "text-app-fg/75",
                )}
              >
                <BrandIcon
                  name={p.brand}
                  className="size-[13px] shrink-0"
                  style={{ color: p.accent }}
                />
                <span className="relative min-w-0 flex-1">
                  {i === 0 ? (
                    <>
                      <span
                        data-s="side-title-new"
                        className="absolute inset-0 truncate text-app-muted opacity-0"
                      >
                        New thread
                      </span>
                      <span data-s="side-title" className="block truncate">
                        {t.title}
                      </span>
                    </>
                  ) : (
                    <span className="block truncate">{t.title}</span>
                  )}
                </span>
                <span className="relative grid w-7 shrink-0 place-items-end text-[11px] text-app-muted/70">
                  <span data-s="side-age">
                    {i === 0 ? <Check className="size-3.5 text-[#5fcf86]" /> : t.age}
                  </span>
                  <Spinner className="side-spin absolute right-0 top-1/2 size-3 -translate-y-1/2 text-app-muted opacity-0" />
                </span>
              </div>
            );
          })}
        </div>
        {["website", "dotfiles"].map((name) => (
          <div
            key={name}
            className="mt-0.5 flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-app-fg/75"
          >
            <FolderClosed className="size-4 text-app-muted" />
            {name}
          </div>
        ))}
      </div>

      <div className="mt-auto flex h-12 items-center gap-2.5 border-t border-white/[0.06] px-4 text-[12px] text-app-muted">
        <span className="relative grid size-2 place-items-center">
          <span className="size-2 rounded-full bg-[#5fcf86]" />
        </span>
        MacBook Pro
        <span className="ml-auto text-app-muted/60">Local</span>
      </div>
    </aside>
  );
}

/* -------------------------------- composer --------------------------------- */

function Composer() {
  const claude = providerById("claude");
  return (
    <div
      data-s="composer"
      className="absolute rounded-[20px] border border-white/[0.09] bg-app-card/95 p-3.5 shadow-[0_18px_50px_-20px_rgba(0,0,0,0.8)]"
      style={{ width: 572, left: (STAGE_W - SIDEBAR_W - 572) / 2, bottom: 16 }}
    >
      <div className="relative min-h-[42px] text-[13.5px] leading-[1.5]">
        <span data-s="placeholder" className="absolute inset-0 text-app-muted/60">
          Ask anything. @ for files, # for issues and PRs
        </span>
        <span data-s="typed" className="relative text-app-fg" />
        <span data-s="typed-caret" className="ry-caret relative text-app-fg opacity-0" />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[12px] text-app-muted">
        <Paperclip className="mr-1 size-4" />
        <span className="flex h-7 items-center gap-1.5 rounded-full border border-white/[0.08] px-2.5 text-app-fg/90">
          <BrandIcon name={claude.brand} className="size-3.5" style={{ color: claude.accent }} />
          Opus 5.5
          <ChevronDown className="size-3.5 text-app-muted" />
        </span>
        <span className="flex h-7 items-center rounded-full bg-[#3a2a55] px-2.5 font-medium text-[#d6b8ff]">
          High
        </span>
        <span className="flex h-7 items-center rounded-full px-2 text-app-muted">1M</span>
        <span
          data-s="send"
          className="ml-auto grid size-8 place-items-center rounded-full bg-app-indigo text-white"
        >
          <ArrowUp className="size-4" strokeWidth={2.4} />
        </span>
      </div>
    </div>
  );
}

/* --------------------------------- thread ---------------------------------- */

function Thread() {
  const claude = providerById("claude");
  return (
    <div data-s="thread" className="absolute inset-0 origin-top-left">
      {/* Empty-thread state: only ever shown by the film's rewound start. */}
      <div
        data-s="empty"
        className="pointer-events-none absolute inset-x-0 top-[170px] flex flex-col items-center text-center opacity-0"
      >
        <RycoMark className="h-10 text-white/[0.13]" />
        <p className="mt-5 text-[18px] font-medium tracking-[-0.01em] text-app-fg/90">
          What should we build in ryco?
        </p>
        <p className="mt-1.5 font-mono text-[11.5px] text-app-muted">{BRANCH}</p>
        <div className="mt-6 flex gap-2 text-[12px] text-app-muted">
          {[
            ["@", "Mention files"],
            ["#", "Attach an issue"],
            ["/", "Commands"],
          ].map(([k, label]) => (
            <span
              key={k}
              className="flex items-center gap-1.5 rounded-full border border-white/[0.08] px-3 py-1.5"
            >
              <span className="font-mono text-app-fg/80">{k}</span>
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="mx-auto pt-7" style={{ width: 560 }}>
        <div data-s="user-msg" className="flex justify-end">
          <p className="max-w-[86%] rounded-[18px] rounded-br-md bg-app-pop px-4 py-2.5 text-[13.5px] leading-[1.5] text-app-fg">
            {PROMPT}
          </p>
        </div>

        <div data-s="assistant" className="mt-5">
          <div className="flex items-center gap-2 text-[12.5px]">
            <BrandIcon name={claude.brand} className="size-3.5" style={{ color: claude.accent }} />
            <span className="font-medium text-app-fg">Claude</span>
            <span className="text-app-muted">Opus 5.5</span>
          </div>
          <div className="mt-2 border-l border-white/[0.08] pl-3.5">
            {TOOL_ROWS.map((row) => (
              <ToolLine key={row.verb + row.target} row={row} />
            ))}
          </div>
          <p data-s="worked" className="mt-1.5 text-[12px] text-app-muted/80">
            Worked for 48s
          </p>
          <p className="mt-2.5 min-h-[63px] text-[13.5px] leading-[1.55] text-app-fg/90">
            <span data-s="answer">{ANSWER}</span>
            <span data-s="answer-caret" className="ry-caret text-app-fg opacity-0" />
          </p>
          <div
            data-s="changes"
            className="mt-4 flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-2.5 text-[12.5px]"
          >
            <FileDiff className="size-4 text-app-muted" />
            <span className="text-app-fg/90">2 files changed</span>
            <Delta add={63} del={2} className="text-[12px]" />
            <span
              data-s="review-btn"
              className="ml-auto rounded-md border border-white/10 px-2.5 py-1 text-[12px] text-app-fg"
            >
              Review
            </span>
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
      className="invisible absolute inset-0 grid grid-cols-3 grid-rows-2 opacity-0"
      style={{ gap: GRID_GAP, padding: GRID_GAP }}
    >
      {PANES.map((pane) => {
        const t = THREADS.find((x) => x.id === pane.thread)!;
        const p = providerById(t.provider);
        return (
          <div
            key={pane.thread}
            data-s="pane"
            className="relative flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-app"
          >
            <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 text-[12px]">
              <BrandIcon name={p.brand} className="size-3.5 shrink-0" style={{ color: p.accent }} />
              <span className="min-w-0 truncate font-medium text-app-fg">{t.title}</span>
              <span className="ml-auto shrink-0 rounded-full border border-white/[0.08] px-2 py-0.5 text-[10.5px] text-app-muted">
                {pane.model}
              </span>
            </div>
            <div className="flex-1 px-3 pt-3">
              <div className="border-l border-white/[0.08] pl-2.5">
                {pane.rows.map((row) => (
                  <ToolLine key={row.verb + row.target} row={row} compact />
                ))}
              </div>
              <p className="mt-3 text-[12.5px] leading-[1.6] text-app-fg/85">
                <span data-s="pane-text">{pane.text}</span>
                <span className="ry-caret pane-caret text-app-fg opacity-0" />
              </p>
            </div>
            <div className="m-2.5 flex h-8 shrink-0 items-center rounded-[10px] border border-white/[0.07] bg-app-card px-3 text-[11px] text-app-muted/60">
              Reply…
              <span className="ml-auto grid size-5 place-items-center rounded-full bg-white/10">
                <ArrowUp className="size-3 text-app-fg/70" />
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ review panel ------------------------------- */

function ReviewPanel() {
  return (
    <aside
      data-s="review"
      className="absolute bottom-0 right-0 top-0 flex flex-col border-l border-white/[0.08] bg-app-side"
      style={{ width: REVIEW_W }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
        <span className="flex h-7 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-[12.5px] text-app-fg">
          <GitCompareArrows className="size-3.5" /> Review
          <X className="ml-1 size-3 text-app-muted" />
        </span>
        <Plus className="size-3.5 text-app-muted" />
      </div>
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-3 text-[11.5px]">
        <span className="rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 text-app-fg">
          All turns
        </span>
        <span className="rounded-full border border-white/[0.07] px-2.5 py-1 text-app-muted">
          Turn 1 <span className="text-app-muted/60">just now</span>
        </span>
      </div>

      <div className="flex-1 overflow-hidden p-2.5">
        <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-app">
          <div className="flex h-9 items-center gap-2 border-b border-white/[0.06] px-3 text-[12px]">
            <ChevronDown className="size-3.5 text-app-muted" />
            <FileDiff className="size-3.5 text-[#7cb7ff]" />
            <span className="font-mono text-[11.5px] text-app-fg">relay/client.ts</span>
            <Delta add={11} del={2} className="ml-auto text-[11.5px]" />
          </div>
          <div className="py-1 font-mono text-[11.5px] leading-[22px]">
            {DIFF.map((line, i) => (
              <div
                key={i}
                data-s={i === DIFF_CLICK_ROW ? "diff-hit" : "diff-line"}
                className={cn(
                  "relative flex whitespace-pre",
                  line.kind === "add" && "bg-[#2ea043]/[0.13]",
                  line.kind === "del" && "bg-[#f85149]/[0.12]",
                )}
              >
                {i === DIFF_CLICK_ROW && (
                  <span
                    data-s="diff-hit-glow"
                    className="pointer-events-none absolute inset-0 bg-white/[0.07] opacity-0 ring-1 ring-inset ring-white/25"
                  />
                )}
                <span className="w-9 shrink-0 pr-2 text-right text-app-muted/45">
                  {line.n ?? ""}
                </span>
                <span
                  className={cn(
                    "w-4 shrink-0",
                    line.kind === "add" && "text-[#5fcf86]",
                    line.kind === "del" && "text-[#f2766b]",
                  )}
                >
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                </span>
                <span className="min-w-0 overflow-hidden pr-3">
                  <Code code={line.code} />
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-2 overflow-hidden rounded-xl border border-white/[0.07] bg-app">
          <div className="flex h-9 items-center gap-2 border-b border-white/[0.06] px-3 text-[12px]">
            <ChevronDown className="size-3.5 text-app-muted" />
            <FilePlus2 className="size-3.5 text-[#5fcf86]" />
            <span className="font-mono text-[11.5px] text-app-fg">relay/backoff.ts</span>
            <Delta add={52} className="ml-auto text-[11.5px]" />
          </div>
          <div className="py-1 font-mono text-[11.5px] leading-[22px]">
            {BACKOFF_FILE.map((code, i) => (
              <div key={i} className="flex whitespace-pre bg-[#2ea043]/[0.13]">
                <span className="w-9 shrink-0 pr-2 text-right text-app-muted/45">{i + 12}</span>
                <span className="w-4 shrink-0 text-[#5fcf86]">+</span>
                <span className="min-w-0 overflow-hidden pr-3">
                  <Code code={code} />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

/* -------------------------------- terminal --------------------------------- */

function TerminalDrawer() {
  return (
    <div
      data-s="terminal"
      className="invisible absolute inset-x-0 bottom-0 flex flex-col border-t border-white/[0.08] bg-[#0c0c0d]"
      style={{ height: TERMINAL_H }}
    >
      <div className="flex h-[34px] shrink-0 items-center gap-1 border-b border-white/[0.06] px-2 text-[12px]">
        <span className="flex h-6 items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 text-app-fg">
          <SquareTerminal className="size-3.5" /> Terminal 1
        </span>
        <span className="flex h-6 items-center gap-1.5 px-2.5 text-app-muted">
          <SquareTerminal className="size-3.5" /> dev
        </span>
        <Plus className="ml-1 size-3.5 text-app-muted" />
        <Columns2 className="ml-auto size-3.5 text-app-muted" />
      </div>
      <div className="flex-1 px-4 py-3 font-mono text-[12px] leading-[19px] text-app-fg/85">
        <div>
          <span className="text-[#7cb7ff]">~/ryco</span>{" "}
          <span className="text-[#c3a6ff]">{BRANCH}</span>
        </div>
        <div>
          <span className="text-[#ff8a5c]">$ </span>
          <span data-s="term-cmd">{TERMINAL_CMD}</span>
          <span data-s="term-caret" className="ry-block-caret ml-px text-app-fg/70 opacity-0" />
        </div>
        {TERMINAL.map((l, i) => (
          <div
            key={i}
            data-s="term-line"
            className={cn(
              "min-h-[19px] whitespace-pre",
              l.tone === "ok" && "text-[#5fcf86]",
              l.tone === "dim" && "text-app-muted",
              l.tone === "bold" && "font-semibold text-app-fg",
            )}
          >
            {l.text}
          </div>
        ))}
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

const Window = memo(function Window() {
  return (
    <div
      data-s="window"
      className="relative flex overflow-hidden rounded-[14px] bg-app font-sans text-app-fg ring-1 ring-inset ring-white/[0.06]"
      style={{ width: STAGE_W, height: STAGE_H }}
    >
      <Sidebar />

      <section className="relative flex-1 overflow-hidden">
        <header
          className="relative z-[2] flex items-center gap-2.5 border-b border-white/[0.06] bg-app px-4"
          style={{ height: HEADER_H }}
        >
          <span className="relative h-5 min-w-[180px] text-[13.5px] font-semibold">
            <span data-s="title-new" className="absolute inset-0 text-app-muted opacity-0">
              New thread
            </span>
            <span data-s="title-real" className="absolute inset-0">
              {THREADS[0].title}
            </span>
          </span>
          <span className="rounded-md bg-white/[0.05] px-2 py-0.5 text-[11.5px] text-app-muted">
            ryco
          </span>
          <span className="flex items-center gap-1 rounded-md bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-app-muted">
            <GitBranch className="size-3" />
            {BRANCH}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <IconButton data-s="btn-split">
              <Columns2 />
            </IconButton>
            <span
              data-s="btn-diff"
              className="flex h-[30px] items-center gap-1.5 rounded-lg bg-white/[0.07] px-2 text-[11.5px] text-app-fg"
            >
              <FileDiff className="size-[15px]" />
              <span data-s="diff-count" className="inline-block overflow-hidden whitespace-nowrap">
                <Delta add={63} del={2} />
              </span>
            </span>
            <IconButton data-s="btn-term">
              <SquareTerminal />
            </IconButton>
          </div>
        </header>

        <div className="absolute inset-x-0 bottom-0 overflow-hidden" style={{ top: HEADER_H }}>
          <div
            data-s="chat"
            className="absolute inset-0"
            style={{ transform: `translateX(${-REVIEW_W / 2}px)` }}
          >
            <Thread />
            <Composer />
          </div>
          <ParallelGrid />
          <ReviewPanel />
          <TerminalDrawer />
          <div
            data-s="toast"
            className="invisible absolute bottom-[136px] left-4 flex items-center gap-2.5 rounded-xl border border-white/10 bg-app-pop/95 px-3.5 py-2.5 text-[12.5px] text-app-fg opacity-0 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.8)]"
          >
            <ExternalLink className="size-3.5 text-app-muted" />
            Opened in your editor
            <span className="font-mono text-[11.5px] text-app-muted">relay/client.ts:80</span>
          </div>
        </div>
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
      <div
        ref={fit}
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: STAGE_W, height: STAGE_H }}
      >
        <div data-s="cam" className="h-full w-full origin-top-left will-change-transform">
          <Window />
        </div>
      </div>
    </div>
  );
});
