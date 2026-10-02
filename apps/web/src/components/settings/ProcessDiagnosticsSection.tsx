import {
  WS_METHODS,
  type DiagnosticsProcessEntry,
  type DiagnosticsSnapshot,
} from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useDiagnosticsCapability } from "./useDiagnosticsCapability";
import { ensureLocalApi } from "../../localApi";
import { useSettingsTarget } from "../../settingsTarget";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";
import { formatBytes, formatPercent, relativeTimeLabel } from "./DiagnosticsSettings.logic";

export function ProcessDiagnosticsSection({
  snapshot,
  refresh,
}: {
  readonly snapshot: DiagnosticsSnapshot | null;
  readonly refresh: () => Promise<void>;
}) {
  const target = useSettingsTarget();
  const capability = useDiagnosticsCapability(WS_METHODS.serverSignalDiagnosticProcess);
  const [pending, setPending] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const currentRef = useRef({ target, snapshot, allowed: false });
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const allowed = capability.allowed;
  currentRef.current = { target, snapshot, allowed };
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function signal(process: DiagnosticsProcessEntry, action: "SIGINT" | "SIGKILL") {
    if (busyRef.current || !currentRef.current.allowed) return;
    const environmentId = currentRef.current.target?.environmentId;
    busyRef.current = true;
    setPending(process.pid);
    setMessage(null);
    try {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `${action === "SIGKILL" ? "Force kill" : "Interrupt"} process ${process.pid} (${process.command})? ${action === "SIGKILL" ? "Unsaved work may be lost." : "This may stop an active agent or terminal task."}`,
      );
      if (
        !confirmed ||
        !mountedRef.current ||
        !currentRef.current.allowed ||
        currentRef.current.target?.environmentId !== environmentId
      )
        return;
      const currentProcess = currentRef.current.snapshot?.processTree?.processes.find(
        (entry) => entry.pid === process.pid && entry.startTimeMs === process.startTimeMs,
      );
      if (!currentProcess) {
        setMessage("Process already exited or changed. Refresh diagnostics.");
        return;
      }
      const server = environmentId
        ? readEnvironmentApi(environmentId)?.server
        : ensureLocalApi().server;
      if (!server?.signalDiagnosticProcess)
        throw new Error("Process controls are unavailable on this server.");
      const result = await server.signalDiagnosticProcess({
        pid: process.pid,
        startTimeMs: process.startTimeMs,
        signal: action,
      });
      if (!mountedRef.current || currentRef.current.target?.environmentId !== environmentId) return;
      setMessage(
        result.signaled
          ? `${action} sent to process ${process.pid}.`
          : (result.message ?? "Process already exited or is no longer a server child."),
      );
      await refresh();
    } catch (error) {
      if (mountedRef.current && currentRef.current.target?.environmentId === environmentId)
        setMessage(error instanceof Error ? error.message : "Could not signal process.");
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setPending(null);
    }
  }
  const tree = snapshot?.processTree;
  return (
    <SettingsSection title="Live descendant processes">
      <div className="grid grid-cols-2 gap-4 px-4 sm:px-5 py-4 text-xs lg:grid-cols-4">
        <div>
          Child processes
          <div className="mt-1 font-mono">{tree?.processes.length ?? "Unavailable"}</div>
        </div>
        <div>
          Child CPU<div className="mt-1 font-mono">{formatPercent(tree?.totalCpuPercent)}</div>
        </div>
        <div>
          Child RSS
          <div className="mt-1 font-mono">
            {tree ? formatBytes(tree.totalRssBytes) : "Unavailable"}
          </div>
        </div>
        <div>
          Server PID
          <div className="mt-1 font-mono">
            {tree?.serverPid ?? snapshot?.liveProcesses.server.pid ?? "Unavailable"}
          </div>
        </div>
      </div>
      <p className="px-4 sm:px-5 pb-3 text-xs text-muted-foreground">
        Live children of the selected server. The server and desktop shell are excluded.{" "}
        {tree
          ? `Checked ${relativeTimeLabel(tree.readAt)}.`
          : "This server has not supplied process diagnostics."}
      </p>
      {tree?.error ? (
        <p role="alert" className="px-4 sm:px-5 pb-3 text-xs text-destructive">
          {tree.error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="px-4 sm:px-5 pb-3 text-xs">
          {message}
        </p>
      ) : null}
      {!allowed ? (
        <p className="px-4 sm:px-5 pb-3 text-xs text-muted-foreground">
          {capability.reason ?? "Process controls require a connected owner session."}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs [&_td]:px-4 [&_td]:py-3 [&_td]:align-top">
          <thead className="border-y text-muted-foreground">
            <tr>
              {["Process", "PID / Parent", "CPU", "RSS", "Status / Age", "Actions"].map((label) => (
                <th key={label} className="px-4 sm:px-5 py-2 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {tree?.processes.map((process) => (
              <tr key={`${process.pid}:${process.startTimeMs}`}>
                <td className="max-w-96">
                  <details style={{ marginLeft: Math.min(process.depth, 8) * 10 }}>
                    <summary className="cursor-pointer break-all">
                      {process.command.split(/[\\/]/).at(-1) || "Process"}
                    </summary>
                    <div className="mt-2 break-all font-mono">{process.command}</div>
                    <div className="mt-1 text-muted-foreground">
                      {process.childPids.length} children · Started{" "}
                      {new Date(process.startTimeMs).toLocaleString()}
                    </div>
                  </details>
                </td>
                <td className="font-mono">
                  {process.pid} / {process.ppid}
                </td>
                <td>{formatPercent(process.cpuPercent)}</td>
                <td>{formatBytes(process.rssBytes)}</td>
                <td>
                  {process.status}
                  <div className="mt-1 text-muted-foreground">{process.elapsed}</div>
                </td>
                <td>
                  <div className="flex gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!allowed || pending !== null}
                      onClick={() => void signal(process, "SIGINT")}
                    >
                      Interrupt
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!allowed || pending !== null}
                      onClick={() => void signal(process, "SIGKILL")}
                    >
                      Force kill
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tree?.processes.length === 0 ? (
        <p className="px-4 sm:px-5 py-4 text-sm text-muted-foreground">
          No live descendant processes.
        </p>
      ) : null}
    </SettingsSection>
  );
}
