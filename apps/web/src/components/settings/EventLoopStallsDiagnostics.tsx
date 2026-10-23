import type { DiagnosticsSnapshot } from "@ryco/contracts";
import { useMemo } from "react";

import { Badge } from "../ui/badge";
import { SettingsSection } from "./settingsLayout";
import { stallRows, summarizeEventLoopHistory } from "./EventLoopStallsDiagnostics.logic";

/**
 * The server's event-loop stall history (`event-loop-stalls.ndjson`), newest first. Rendered only
 * by the desktop Diagnostics page, inside its lazy chunk.
 */
export function EventLoopStallsDiagnostics({
  snapshot,
  nowMs,
}: {
  readonly snapshot: DiagnosticsSnapshot | null;
  readonly nowMs: number;
}) {
  const history = snapshot?.eventLoop;
  const summary = useMemo(
    () => (snapshot === null ? null : summarizeEventLoopHistory(history, nowMs)),
    [snapshot, history, nowMs],
  );
  const rows = useMemo(() => stallRows(history, nowMs), [history, nowMs]);

  return (
    <SettingsSection title="Event-loop stalls">
      <div className="border-border/60 border-b px-4 py-3 sm:px-5">
        <div className="text-[13px] font-medium text-foreground">
          {summary?.headline ?? "Waiting for snapshot"}
        </div>
        {summary?.detail ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{summary.detail}</div>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <div className="divide-y divide-border/60">
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_6rem_5rem] sm:items-start sm:px-5"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{row.label}</span>
                  {row.countLabel ? (
                    <Badge size="sm" variant="warning">
                      {row.countLabel}
                    </Badge>
                  ) : null}
                  {row.duringStartup ? (
                    <Badge size="sm" variant="outline">
                      during startup
                    </Badge>
                  ) : null}
                </div>
                {row.hint ? (
                  <div className="mt-1 text-[11px] text-foreground">{row.hint}</div>
                ) : null}
                {row.evidence ? (
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {row.evidence}
                  </div>
                ) : null}
                {row.phases.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
                      Overlapping phases ({row.phases.length})
                    </summary>
                    <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                      {row.phases.map((phase) => (
                        <li key={phase} className="truncate">
                          {phase}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
              <div className="font-mono text-[11px] text-muted-foreground sm:text-right">
                {row.duration}
              </div>
              <div className="font-mono text-[11px] text-muted-foreground sm:text-right">
                {row.relativeTime}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {history ? (
        <p className="border-border/60 border-t px-4 py-2.5 text-[11px] text-muted-foreground sm:px-5">
          Time the computer spent asleep is not counted. History:{" "}
          <span className="break-all font-mono">{history.historyFilePaths.join(", ")}</span>
        </p>
      ) : null}
    </SettingsSection>
  );
}
