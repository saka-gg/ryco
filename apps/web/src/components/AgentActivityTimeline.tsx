import { FileTextIcon, SearchIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import { useMemo } from "react";
import {
  deriveAgentTimeline,
  type ThreadSubagentView,
  type WorkLogEntry,
} from "../threadWorkspaceViewModel";
import { deriveReadableCommandDisplay } from "../lib/toolCallLabel";
import { resolveWorkEntryStatus, formatWorkEntryElapsed } from "./chat/workEntryActivity";
import ChatMarkdown from "./ChatMarkdown";

function AgentToolRow({ entry, running }: { entry: WorkLogEntry; running: boolean }) {
  const rawCommand = entry.rawCommand ?? entry.command;
  const status = resolveWorkEntryStatus(entry);
  const command = rawCommand
    ? deriveReadableCommandDisplay(rawCommand, status === "running" && running)
    : null;
  const name = entry.toolTitle ?? entry.label;
  const read = /^(read|readfile|read_file)$/i.test(name);
  const search = command?.verb.toLowerCase().includes("search") || /search|grep|glob/i.test(name);
  const Icon = search
    ? SearchIcon
    : read || command?.verb === "Read"
      ? FileTextIcon
      : command
        ? TerminalIcon
        : WrenchIcon;
  const heading = command?.verb ?? (read ? "Read" : name);
  const target = command?.target ?? entry.changedFiles?.join(", ") ?? entry.detail;
  const statusText =
    status === "running"
      ? running
        ? "Running"
        : "No completion received"
      : status === "failed"
        ? "Failed"
        : "Completed";
  const elapsed = formatWorkEntryElapsed(entry);
  return (
    <details data-agent-tool className="group min-w-0 border-b border-border/35 py-1 last:border-0">
      <summary className="flex cursor-pointer list-none items-start gap-2 rounded px-1 py-2 text-xs outline-none hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring">
        <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block break-words font-medium">
            {heading}
            {target && target !== heading ? (
              <span className="font-normal text-muted-foreground"> · {target}</span>
            ) : null}
          </span>
          <span className={status === "failed" ? "text-destructive" : "text-muted-foreground/70"}>
            {statusText}
            {elapsed ? ` · ${elapsed}` : ""}
          </span>
        </span>
        <span
          aria-hidden
          className="text-muted-foreground transition-transform group-open:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="space-y-2 pb-3 pl-6 text-xs">
        {rawCommand ? (
          <pre
            aria-label="Command"
            className="overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono"
          >
            {rawCommand}
          </pre>
        ) : null}
        {entry.detail && entry.detail !== target && entry.detail !== rawCommand ? (
          <p className="whitespace-pre-wrap break-words text-muted-foreground">{entry.detail}</p>
        ) : null}
        {entry.output ? (
          <pre
            aria-label="Tool output"
            className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 font-mono leading-relaxed"
          >
            {entry.output}
          </pre>
        ) : (
          <p className="text-muted-foreground">
            {status === "running" && running
              ? "Waiting for tool output…"
              : "No output was captured for this tool."}
          </p>
        )}
        {entry.exitCode !== undefined ? (
          <p className="font-mono text-muted-foreground">Exit code {entry.exitCode}</p>
        ) : null}
      </div>
    </details>
  );
}

export function AgentActivityTimeline({
  subagent,
  running,
}: {
  subagent: Pick<ThreadSubagentView, "messages" | "entries">;
  running: boolean;
}) {
  const timeline = useMemo(() => deriveAgentTimeline(subagent), [subagent]);
  if (timeline.length === 0)
    return (
      <p className="p-4 text-xs leading-relaxed text-muted-foreground">
        No detailed activity has been captured. Status and usage remain available when the provider
        reports them.
      </p>
    );
  return (
    <div data-agent-timeline className="min-w-0 space-y-2 px-3 py-3">
      {timeline.map((row) =>
        row.kind === "tool" ? (
          <AgentToolRow key={row.id} entry={row.tool} running={running} />
        ) : (
          <article
            key={row.id}
            data-agent-message
            className="min-w-0 border-l-2 border-border/50 py-2 pl-3 text-sm"
          >
            <ChatMarkdown text={row.message.text} cwd={undefined} isStreaming={false} />
          </article>
        ),
      )}
    </div>
  );
}
