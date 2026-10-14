import {
  isWorktreeLaunchSettingUp,
  resolveWorktreeSetupStages,
  type WorktreeLaunch,
  type WorktreeSetupStageView,
} from "@ryco/client-runtime/state/worktree-setup";
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { visibleSecondTicker } from "../../../lib/perf/ticker";
import type { WorktreeSetupActions } from "./WorktreeSetupTimelineContext";

// Glyphs drawn to the approved prototype, so the card matches it stroke for stroke.
export function SetupPendingGlyph() {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    >
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

export function SetupRunningGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="worktree-setup-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

export function SetupDoneGlyph() {
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function SetupFailedGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function StageGlyph({ status }: { status: WorktreeSetupStageView["status"] }) {
  switch (status) {
    case "running":
      return <SetupRunningGlyph />;
    case "done":
      return <SetupDoneGlyph />;
    case "failed":
      return <SetupFailedGlyph />;
    default:
      return <SetupPendingGlyph />;
  }
}

/** Whole seconds since `startedAt`, ticking with the shared visible-second ticker. */
function LiveSeconds({ startedAt }: { startedAt: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const startMs = Date.parse(startedAt);
  const format = (nowMs: number) => `${Math.max(0, Math.floor((nowMs - startMs) / 1000))}s`;
  useEffect(
    () =>
      visibleSecondTicker.subscribe((nowMs) => {
        if (ref.current) ref.current.textContent = format(nowMs);
      }),
    // `format` closes over `startMs` only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [startMs],
  );
  return <span ref={ref}>{format(Date.now())}</span>;
}

function stageDuration(stage: WorktreeSetupStageView): string | null {
  if (!stage.startedAt || !stage.finishedAt) return null;
  const ms = Date.parse(stage.finishedAt) - Date.parse(stage.startedAt);
  return Number.isFinite(ms) ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : null;
}

function StageMeta({
  stage,
  agentRunning,
}: {
  stage: WorktreeSetupStageView;
  agentRunning: boolean;
}) {
  if (stage.status === "skipped") return <>skipped</>;
  if (stage.detail) return <>{stage.detail}</>;
  if (stage.id === "checkout" && (stage.status === "running" || stage.status === "failed")) {
    return stage.percent === null ? null : <>{stage.percent}%</>;
  }
  if (stage.id === "setup-script" && stage.status === "running") {
    if (agentRunning) return <>in background</>;
    return stage.startedAt ? <LiveSeconds startedAt={stage.startedAt} /> : null;
  }
  if (stage.status === "done" && stage.id !== "agent") return <>{stageDuration(stage)}</>;
  return null;
}

function StageRow({
  stage,
  agentRunning,
}: {
  stage: WorktreeSetupStageView;
  agentRunning: boolean;
}) {
  const dim = stage.status === "pending" || stage.status === "skipped";
  return (
    <div
      className="flex h-[27px] items-center gap-[9px] px-3 text-[12.5px]"
      data-worktree-setup-stage={stage.id}
      data-worktree-setup-status={stage.status}
    >
      <span
        className={cn(
          "grid size-3.5 shrink-0 place-items-center",
          dim && "opacity-40",
          stage.status === "done" && "text-success",
          stage.status === "failed" && "text-destructive",
        )}
      >
        {/* Keyed by status: every change pops the new glyph in. */}
        <span key={stage.status} className="worktree-setup-pop grid place-items-center">
          <StageGlyph status={stage.status} />
        </span>
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          dim && "opacity-40",
          stage.status === "failed" && "text-destructive",
        )}
      >
        {stage.label}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
        <StageMeta stage={stage} agentRunning={agentRunning} />
      </span>
    </div>
  );
}

function CardAction(props: {
  readonly children: React.ReactNode;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean;
  readonly ariaExpanded?: boolean;
}) {
  return (
    <button
      type="button"
      className="cursor-pointer rounded-[5px] px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-expanded={props.ariaExpanded}
    >
      {props.children}
    </button>
  );
}

/**
 * The stages a first send's worktree goes through, every row laid out from the
 * first frame so the card never changes height while it runs. The setup
 * script's output tail is the one exception: it opens once, at its first line,
 * with a fixed four-line height.
 */
export const WorktreeSetupCard = memo(function WorktreeSetupCard(props: {
  readonly launch: WorktreeLaunch;
  readonly actions: WorktreeSetupActions;
}) {
  const { launch, actions } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stages = resolveWorktreeSetupStages(launch);
  const failed = launch.phase === "failed";
  const settingUp = isWorktreeLaunchSettingUp(launch);
  const snapshot = launch.snapshot;
  const agentRunning = stages.some((stage) => stage.id === "agent" && stage.status === "running");
  const checkout = stages.find((stage) => stage.id === "checkout");
  const checkoutPercent =
    checkout?.status === "done"
      ? 100
      : checkout?.status === "pending"
        ? 0
        : (checkout?.percent ?? 0);
  const tail = failed ? [] : (snapshot?.outputTail ?? []);
  const error = failed ? (snapshot?.error ?? launch.error) : null;
  const terminalId = snapshot?.setupTerminalId ?? null;

  return (
    <div
      className="mt-1 mb-1.5 ml-6 rounded-[10px] border border-border bg-background py-1.5"
      data-testid="worktree-setup-card"
    >
      {stages.map((stage) => (
        <div key={stage.id}>
          <StageRow stage={stage} agentRunning={agentRunning} />
          {stage.id === "checkout" ? (
            <div className="mx-3 mb-0.5 ml-[35px] h-0.5 overflow-hidden rounded-[2px] bg-secondary">
              <i
                className={cn(
                  "worktree-setup-bar-fill block h-full",
                  checkout?.status === "failed" ? "bg-destructive" : "bg-foreground opacity-55",
                )}
                style={{ width: `${checkoutPercent}%` }}
              />
            </div>
          ) : null}
          {stage.id === "setup-script" && tail.length > 0 ? (
            <pre className="mx-3 my-1 ml-[35px] h-[76px] overflow-hidden whitespace-pre rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] leading-4 text-foreground opacity-85">
              {tail.join("\n")}
            </pre>
          ) : null}
        </div>
      ))}
      {error ? (
        <p className="mx-3 mt-0.5 mb-1 ml-[35px] font-mono text-[11px] leading-[1.4] text-destructive">
          {error}
        </p>
      ) : null}
      {detailsOpen ? (
        <dl className="mx-3 my-1 ml-[35px] grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          <dt>Branch</dt>
          <dd className="truncate text-foreground">{snapshot?.branch ?? "—"}</dd>
          <dt>Base</dt>
          <dd className="truncate text-foreground">{snapshot?.baseRef ?? launch.baseRef}</dd>
          <dt>Path</dt>
          <dd className="truncate text-foreground" title={snapshot?.worktreePath}>
            {snapshot?.worktreePath ?? "—"}
          </dd>
        </dl>
      ) : null}
      <div className="flex gap-0.5 pt-1 pr-2 pl-[30px]">
        <CardAction onClick={() => setDetailsOpen((open) => !open)} ariaExpanded={detailsOpen}>
          Details {detailsOpen ? "▴" : "▾"}
        </CardAction>
        <CardAction
          disabled={terminalId === null || !actions.onOpenTerminal}
          onClick={terminalId ? () => actions.onOpenTerminal?.(terminalId) : undefined}
        >
          Open terminal
        </CardAction>
        <span className="flex-1" />
        {failed ? (
          <CardAction onClick={actions.onDismiss}>Dismiss</CardAction>
        ) : (
          <CardAction
            onClick={actions.onCancel}
            disabled={!settingUp || launch.phase === "cancelling"}
          >
            Cancel
          </CardAction>
        )}
      </div>
    </div>
  );
});
