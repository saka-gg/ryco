/** What a thread row says about its terminals: open count and running processes. */
export interface ThreadTerminalStatus {
  readonly count: number;
  readonly runningCount: number;
  readonly label: string;
}

/**
 * Null when there is nothing worth showing: the drawer is closed and no
 * terminal runs a process. A closed drawer with only idle shells is quiet.
 */
export function resolveThreadTerminalStatus(input: {
  readonly open: boolean;
  readonly count: number;
  readonly runningCount: number;
}): ThreadTerminalStatus | null {
  const runningCount = Math.max(0, input.runningCount);
  if (!input.open && runningCount === 0) return null;
  const count = Math.max(1, input.count, runningCount);
  return { count, runningCount, label: formatThreadTerminalLabel(count, runningCount) };
}

function formatThreadTerminalLabel(count: number, runningCount: number): string {
  if (count === 1) return runningCount > 0 ? "Terminal process running" : "Terminal open";
  return runningCount > 0
    ? `${count} terminals open · ${runningCount} running`
    : `${count} terminals open`;
}

/** `Terminal running` or `2 terminals running`. */
export function formatTerminalRunningLine(runningCount: number): string {
  return runningCount === 1 ? "Terminal running" : `${runningCount} terminals running`;
}
