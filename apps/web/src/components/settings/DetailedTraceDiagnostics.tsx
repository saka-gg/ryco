import type { DiagnosticsSnapshot } from "@ryco/contracts";
import type { ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";
import { formatDuration, relativeTimeLabel } from "./DiagnosticsSettings.logic";

export function DiagnosticsTraceId({ value }: { readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="break-all text-[11px]">{value}</code>
      <Button
        size="xs"
        variant="ghost"
        aria-label="Copy trace ID"
        onClick={() => copyToClipboard(value, undefined)}
      >
        {isCopied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function FullText({ children }: { readonly children: string }) {
  return children.length > 180 ? (
    <details>
      <summary className="cursor-pointer break-words">{children.slice(0, 180)}…</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">
        {children}
      </pre>
    </details>
  ) : (
    <span className="break-words">{children}</span>
  );
}

function Table({
  headers,
  children,
  empty,
}: {
  readonly headers: ReadonlyArray<string>;
  readonly children: ReactNode;
  readonly empty: boolean;
}) {
  if (empty)
    return <p className="px-4 sm:px-5 py-4 text-sm text-muted-foreground">No retained records.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-xs [&_td]:px-4 [&_td]:py-3 [&_td]:align-top">
        <thead className="border-b text-muted-foreground">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-4 sm:px-5 py-2 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">{children}</tbody>
      </table>
    </div>
  );
}

export function DetailedTraceDiagnostics({
  snapshot,
  nowMs,
}: {
  readonly snapshot: DiagnosticsSnapshot | null;
  readonly nowMs: number;
}) {
  const summary = snapshot?.tracing.summary;
  const names = snapshot?.tracing.topSpanNames ?? [];
  const failures = snapshot?.failures.common ?? [];
  const logs = summary?.latestWarningAndErrorLogs ?? [];
  return (
    <>
      <SettingsSection title="Trace diagnostics">
        <dl className="grid grid-cols-2 gap-4 px-4 sm:px-5 py-4 text-xs lg:grid-cols-4">
          {[
            ["Retained spans", snapshot?.tracing.retainedSpanCount],
            ["Failures", summary?.failureCount],
            ["Interrupted spans", summary?.interruptionCount],
            ["Slow spans", summary?.slowSpanCount],
            ["Parse errors", summary?.parseErrorCount],
            ["Slow threshold", summary ? formatDuration(summary.slowSpanThresholdMs) : undefined],
            [
              "First span",
              summary?.firstSpanAt ? relativeTimeLabel(summary.firstSpanAt, nowMs) : undefined,
            ],
            [
              "Last span",
              summary?.lastSpanAt ? relativeTimeLabel(summary.lastSpanAt, nowMs) : undefined,
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-mono">{value ?? "Unavailable"}</dd>
            </div>
          ))}
        </dl>
        {summary?.partialFailure ? (
          <p className="px-4 sm:px-5 pb-3 text-xs text-warning">
            Some trace files could not be read. These results are incomplete.
          </p>
        ) : null}
        {summary ? (
          <details className="border-t px-4 sm:px-5 py-3 text-xs">
            <summary className="cursor-pointer">Collection details</summary>
            <div className="mt-2 space-y-2">
              <p>
                Log levels:{" "}
                {Object.entries(summary.logLevelCounts)
                  .map(([level, count]) => `${level}: ${count}`)
                  .join(" · ") || "None"}
              </p>
              {summary.scannedFilePaths.map((path) => (
                <p key={path} className="break-all font-mono">
                  {path}
                </p>
              ))}
            </div>
          </details>
        ) : null}
      </SettingsSection>
      <SettingsSection title="Most common failures">
        <Table
          headers={["Source / category", "Count", "Cause", "Last seen"]}
          empty={failures.length === 0}
        >
          {failures.map((failure) => (
            <tr key={`${failure.source}:${failure.signature}`}>
              <td>
                {failure.source}
                <div className="text-muted-foreground">{failure.category}</div>
              </td>
              <td className="font-mono">{failure.count}</td>
              <td className="max-w-96">
                <FullText>{failure.sampleMessage}</FullText>
              </td>
              <td className="whitespace-nowrap">{relativeTimeLabel(failure.latestAt, nowMs)}</td>
            </tr>
          ))}
        </Table>
      </SettingsSection>
      <SettingsSection title="Span warning and error logs">
        <Table headers={["Time", "Level", "Span", "Message", "Trace"]} empty={logs.length === 0}>
          {logs.map((log) => (
            <tr key={`${log.traceId}:${log.spanId}:${log.seenAt}:${log.level}:${log.message}`}>
              <td className="whitespace-nowrap">{relativeTimeLabel(log.seenAt, nowMs)}</td>
              <td>{log.level}</td>
              <td>{log.spanName}</td>
              <td className="max-w-96">
                <FullText>{log.message}</FullText>
              </td>
              <td>
                <DiagnosticsTraceId value={log.traceId} />
              </td>
            </tr>
          ))}
        </Table>
      </SettingsSection>
      <SettingsSection title="Top span names">
        <Table
          headers={["Span", "Count", "Failures", "Average", "Maximum", "Total"]}
          empty={names.length === 0}
        >
          {names.map((span) => (
            <tr key={span.name}>
              <td>{span.name}</td>
              <td>{span.count}</td>
              <td>{span.failureCount}</td>
              <td>{formatDuration(span.averageDurationMs)}</td>
              <td>{formatDuration(span.maxDurationMs)}</td>
              <td>{formatDuration(span.totalDurationMs)}</td>
            </tr>
          ))}
        </Table>
      </SettingsSection>
      <SettingsSection title="Recent spans">
        <Table
          headers={["Span", "Status", "Duration", "Ended", "Trace"]}
          empty={!snapshot?.tracing.recentSpans.length}
        >
          {snapshot?.tracing.recentSpans.map((span) => (
            <tr key={span.id}>
              <td>
                {span.name}
                {span.failureMessage ? (
                  <div className="mt-1 text-destructive">
                    <FullText>{span.failureMessage}</FullText>
                  </div>
                ) : null}
              </td>
              <td>{span.status}</td>
              <td>{formatDuration(span.durationMs)}</td>
              <td className="whitespace-nowrap">{relativeTimeLabel(span.endTime, nowMs)}</td>
              <td>
                <DiagnosticsTraceId value={span.traceId} />
              </td>
            </tr>
          ))}
        </Table>
      </SettingsSection>
    </>
  );
}
