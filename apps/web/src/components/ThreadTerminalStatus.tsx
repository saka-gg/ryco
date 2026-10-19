import type { ScopedThreadRef } from "@ryco/contracts";
import { TerminalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  resolveThreadTerminalStatus,
  type ThreadTerminalStatus,
} from "./ThreadTerminalStatus.logic";

/** The sky blue every running-terminal mark shares. */
export const TERMINAL_RUNNING_TONE = "text-sky-600 dark:text-sky-400";

/**
 * Reads only the three numbers a row shows, so terminal output and resizes do
 * not re-render the row.
 */
export function useThreadTerminalStatus(threadRef: ScopedThreadRef): ThreadTerminalStatus | null {
  const open = useTerminalStateStore(
    (state) => selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).terminalOpen,
  );
  const count = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).terminalIds.length,
  );
  const runningCount = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds
        .length,
  );
  return resolveThreadTerminalStatus({ open, count, runningCount });
}

/** Pulsing corner dot over a terminal icon while a process runs. */
export function TerminalRunningDot({ className }: { className?: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -right-0.5 -top-0.5 size-[5px] animate-pulse rounded-full bg-current ring-[1.5px] ring-sidebar motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/**
 * Row mark: a muted icon while terminals sit open and idle, sky blue with a
 * pulsing dot while a process runs, and the count from two terminals on.
 */
export function ThreadTerminalIndicator({
  status,
  className,
  dotClassName,
  withTitle = false,
}: {
  status: ThreadTerminalStatus;
  className?: string;
  /** The dot's ring matches the surface behind the row (sidebar by default). */
  dotClassName?: string;
  /** Native tooltip, for rows without their own hint layer. */
  withTitle?: boolean;
}) {
  const running = status.runningCount > 0;
  return (
    <span
      role="img"
      aria-label={status.label}
      title={withTitle ? status.label : undefined}
      data-terminal-count={status.count}
      data-terminal-running={status.runningCount}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5",
        running ? TERMINAL_RUNNING_TONE : "text-muted-foreground/70",
        className,
      )}
    >
      <span className="relative inline-flex">
        <TerminalIcon aria-hidden className="size-3" />
        {running ? <TerminalRunningDot className={dotClassName} /> : null}
      </span>
      {status.count >= 2 ? (
        <span aria-hidden className="text-[10.5px] font-semibold tabular-nums leading-none">
          {status.count}
        </span>
      ) : null}
    </span>
  );
}
