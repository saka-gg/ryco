import {
  type ContextHandoffExportFormat,
  type ContextHandoffInspectionEntriesPage,
  type ContextHandoffInspectionScope,
  type ContextHandoffInspectionSection,
  type ContextHandoffInspectionSummary,
  type EnvironmentId,
  type ThreadId,
} from "@ryco/contracts";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderInputIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import {
  CWD_RELOCATION_HANDOFF_COPY,
  isCwdRelocationHandoff,
  type ContextHandoffTimelineEntry,
} from "../../session-logic";
import {
  readVerifiedContextHandoffExport,
  readVerifiedContextHandoffText,
  startContextHandoffDownload,
} from "../../context-handoff/export";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { ContextHandoffEndpointLabel } from "./ContextHandoffEndpointLabel";

const SECTION_LABELS: Record<ContextHandoffInspectionSection, string> = {
  messages: "Messages",
  plans: "Plans",
  tools: "Tools and terminal results",
  checkpoints: "Checkpoints and changed files",
  notices: "Notices and pending questions",
  subagents: "Subagents",
  priorHandoffs: "Prior handoffs",
  triggeringMessage: "Triggering user message",
};

const DELIVERY_LABELS = {
  sent: "Sent to model",
  "prepared-not-sent": "Prepared, not sent",
  "prepared-not-accepted": "Prepared payload, not accepted",
  "delivery-uncertain": "Attempted payload; delivery uncertain",
} as const;

interface SectionState {
  readonly entries: ContextHandoffInspectionEntriesPage["entries"];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The context artifact could not be loaded.";
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function readableEntry(section: ContextHandoffInspectionSection, value: unknown) {
  if (!value || typeof value !== "object") {
    return <pre className="whitespace-pre-wrap break-words text-xs">{String(value)}</pre>;
  }
  const entry = value as Record<string, unknown>;
  const text = typeof entry.text === "string" ? entry.text : null;
  const summary = typeof entry.summary === "string" ? entry.summary : null;
  const command = typeof entry.command === "string" ? entry.command : null;
  const output = typeof entry.output === "string" ? entry.output : null;
  if (section === "messages" || section === "triggeringMessage") {
    return (
      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {typeof entry.role === "string" ? entry.role : "Message"}
        </p>
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{text}</p>
      </div>
    );
  }
  if (section === "tools") {
    return (
      <div className="space-y-2">
        {summary ? <p className="text-sm font-medium">{summary}</p> : null}
        {command ? (
          <pre className="overflow-x-auto rounded-md bg-muted/55 p-2 text-xs">{command}</pre>
        ) : null}
        {output ? (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted/35 p-2 text-xs">
            {output}
          </pre>
        ) : null}
      </div>
    );
  }
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/35 p-2 text-xs leading-5">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ContextHandoffInspectionPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly marker: ContextHandoffTimelineEntry;
  readonly onClose: () => void;
}) {
  const api = useMemo(
    () => ensureEnvironmentApi(props.environmentId).contextHandoff,
    [props.environmentId],
  );
  const generationRef = useRef(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [summary, setSummary] = useState<ContextHandoffInspectionSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [scope, setScope] = useState<ContextHandoffInspectionScope>("sent");
  const [view, setView] = useState<"readable" | "raw">("readable");
  const [sections, setSections] = useState<Record<string, SectionState>>({});
  const [raw, setRaw] = useState<{
    readonly text: string;
    readonly digest: string;
  } | null>(null);
  const [rawState, setRawState] = useState<"idle" | "loading" | "error">("idle");
  const [rawError, setRawError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ContextHandoffExportFormat | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    const generation = ++generationRef.current;
    setSummaryError(null);
    setSummary(null);
    try {
      const next = await api.getInspectionSummary({
        threadId: props.threadId,
        handoffId: props.marker.handoffId,
      });
      if (generationRef.current !== generation) return;
      setSummary(next);
      setScope(next.status === "consumed" && next.sent.available ? "sent" : "complete");
    } catch (error) {
      if (generationRef.current === generation) setSummaryError(errorMessage(error));
    }
  }, [api, props.marker.handoffId, props.threadId]);

  useEffect(() => {
    void loadSummary();
    closeButtonRef.current?.focus();
    return () => {
      generationRef.current += 1;
    };
  }, [loadSummary]);

  useEffect(() => {
    setSections({});
    setRaw(null);
    setRawState("idle");
    setRawError(null);
    setExportError(null);
  }, [scope]);

  const loadSection = useCallback(
    async (section: ContextHandoffInspectionSection, cursor: string | null = null) => {
      const key = `${scope}:${section}`;
      const generation = generationRef.current;
      setSections((current) => ({
        ...current,
        [key]: {
          entries: cursor ? (current[key]?.entries ?? []) : [],
          nextCursor: cursor,
          loading: true,
          error: null,
        },
      }));
      try {
        const page = await api.listInspectionEntries({
          threadId: props.threadId,
          handoffId: props.marker.handoffId,
          scope,
          section,
          ...(cursor ? { cursor } : {}),
        });
        if (generationRef.current !== generation || page.artifactDigest !== summary?.[scope].digest)
          return;
        setSections((current) => ({
          ...current,
          [key]: {
            entries: cursor ? [...(current[key]?.entries ?? []), ...page.entries] : page.entries,
            nextCursor: page.nextCursor,
            loading: false,
            error: null,
          },
        }));
      } catch (error) {
        if (generationRef.current !== generation) return;
        setSections((current) => ({
          ...current,
          [key]: {
            entries: current[key]?.entries ?? [],
            nextCursor: cursor,
            loading: false,
            error: errorMessage(error),
          },
        }));
      }
    },
    [api, props.marker.handoffId, props.threadId, scope, summary],
  );

  const loadRaw = useCallback(async () => {
    const generation = generationRef.current;
    setRawState("loading");
    setRawError(null);
    try {
      const result = await readVerifiedContextHandoffText({
        read: (offset) =>
          api.readRawPayloadChunk({
            threadId: props.threadId,
            handoffId: props.marker.handoffId,
            scope,
            offset,
          }),
      });
      if (generationRef.current !== generation) return;
      setRaw({ text: result.text, digest: result.digest });
      setRawState("idle");
    } catch (error) {
      if (generationRef.current !== generation) return;
      setRawState("error");
      setRawError(errorMessage(error));
    }
  }, [api, props.marker.handoffId, props.threadId, scope]);

  useEffect(() => {
    if (
      view === "raw" &&
      summary?.[scope].available === true &&
      raw === null &&
      rawState === "idle"
    ) {
      void loadRaw();
    }
  }, [loadRaw, raw, rawState, scope, summary, view]);

  const exportArtifact = useCallback(
    async (format: ContextHandoffExportFormat) => {
      setExporting(format);
      setExportProgress(0);
      setExportError(null);
      try {
        const exported = await readVerifiedContextHandoffExport({
          read: (offset) =>
            api.readExportChunk({
              threadId: props.threadId,
              handoffId: props.marker.handoffId,
              scope,
              format,
              offset,
            }),
          expectedExtension: format === "markdown" ? "md" : "json",
          onProgress: (received, total) =>
            setExportProgress(total === 0 ? 1 : Math.min(1, received / total)),
        });
        startContextHandoffDownload(exported.blob, exported.filename);
      } catch (error) {
        setExportError(errorMessage(error));
      } finally {
        setExporting(null);
      }
    },
    [api, props.marker.handoffId, props.threadId, scope],
  );

  const activeScope = summary?.[scope] ?? null;
  const sourceEndpoints = summary?.sources ?? props.marker.sources;
  const targetEndpoint = summary?.target ?? props.marker.target;
  const relocation = isCwdRelocationHandoff(props.marker);

  return (
    <section
      aria-label="Context handoff inspector"
      className="flex min-h-0 w-full flex-1 flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Context handoff
            </p>
            {relocation ? (
              <div
                className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium"
                data-context-handoff-reason="cwd-relocation"
              >
                <FolderInputIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span>{CWD_RELOCATION_HANDOFF_COPY.attempted}</span>
                <span className="text-muted-foreground/45" aria-hidden>
                  ·
                </span>
                <ContextHandoffEndpointLabel endpoint={targetEndpoint} className="max-w-44" />
              </div>
            ) : (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium">
                {sourceEndpoints.map((endpoint) => (
                  <ContextHandoffEndpointLabel
                    key={`${endpoint.providerInstanceId}:${endpoint.modelSlug}`}
                    endpoint={endpoint}
                    className="max-w-44"
                  />
                ))}
                <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                <ContextHandoffEndpointLabel endpoint={targetEndpoint} className="max-w-44" />
              </div>
            )}
            {relocation ? (
              <p className="mt-1.5 text-xs leading-4 text-muted-foreground">
                {CWD_RELOCATION_HANDOFF_COPY.explanation}
              </p>
            ) : null}
          </div>
          <Button
            ref={closeButtonRef}
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Close context handoff inspector"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
        </div>
        {summary ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 text-foreground">
              <CheckCircle2Icon className="size-3.5" />
              {DELIVERY_LABELS[summary.deliveryLabel]}
            </span>
            <span>{new Date(summary.updatedAt).toLocaleString()}</span>
          </div>
        ) : null}
      </header>

      {summaryError ? (
        <div className="m-4 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm">
          <p>{summaryError}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => void loadSummary()}>
            <RefreshCwIcon /> Retry
          </Button>
        </div>
      ) : !summary ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> Loading context artifact…
        </div>
      ) : (
        <>
          <div className="shrink-0 space-y-3 border-b border-border px-4 py-3">
            <div className="grid grid-cols-2 rounded-lg bg-muted/55 p-1">
              {(["sent", "complete"] as const).map((candidate) => {
                const available = summary[candidate].available;
                return (
                  <button
                    key={candidate}
                    type="button"
                    disabled={!available}
                    onClick={() => setScope(candidate)}
                    className={cn(
                      "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                      scope === candidate
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                      !available && "cursor-not-allowed opacity-45",
                    )}
                  >
                    {candidate === "sent" ? "Sent to model" : "Complete artifact"}
                  </button>
                );
              })}
            </div>
            {activeScope?.available ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{activeScope.entryCount} context entries</span>
                <span>{formatBytes(activeScope.byteCount)}</span>
                {scope === "sent" && summary?.maxInputChars != null ? (
                  <span>
                    Budget: {summary.maxInputChars.toLocaleString()} characters (
                    {summary.budgetSource ?? "unknown"}
                    {summary.contextWindowTokens != null
                      ? `, ${summary.contextWindowTokens.toLocaleString()} token window`
                      : ""}
                    )
                  </span>
                ) : null}
                {activeScope.truncated ? <span>Trimmed to the target input budget</span> : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Exact sent payload unavailable for this handoff. The complete artifact remains
                available when it was prepared.
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <div className="flex rounded-md border border-border p-0.5">
                {(["readable", "raw"] as const).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    disabled={!activeScope?.available}
                    onClick={() => setView(candidate)}
                    className={cn(
                      "rounded px-2 py-1 text-xs",
                      view === candidate ? "bg-muted font-medium" : "text-muted-foreground",
                    )}
                  >
                    {candidate === "readable" ? "Readable" : "Raw payload"}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!activeScope?.available || exporting !== null}
                  onClick={() => void exportArtifact("markdown")}
                >
                  {exporting === "markdown" ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : (
                    <FileTextIcon />
                  )}
                  Markdown
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!activeScope?.available || exporting !== null}
                  onClick={() => void exportArtifact("json")}
                >
                  {exporting === "json" ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : (
                    <FileJsonIcon />
                  )}
                  JSON
                </Button>
              </div>
            </div>
            <p className="flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground">
              <ShieldAlertIcon className="mt-0.5 size-3 shrink-0" />
              Exports may contain conversation text, commands, tool output, and repository paths.
            </p>
            {exporting ? (
              <p className="text-xs text-muted-foreground">
                Verifying export… {Math.round(exportProgress * 100)}%
              </p>
            ) : null}
            {exportError ? <p className="text-xs text-destructive">{exportError}</p> : null}
          </div>

          <ScrollArea>
            <div className="space-y-2 p-4">
              {view === "raw" ? (
                rawState === "loading" ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircleIcon className="size-4 animate-spin" /> Loading and verifying raw
                    payload…
                  </p>
                ) : rawState === "error" ? (
                  <div className="text-sm text-destructive">
                    <p>{rawError}</p>
                    <Button
                      className="mt-2"
                      size="sm"
                      variant="outline"
                      onClick={() => void loadRaw()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : raw ? (
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      Verified SHA-256 ·{" "}
                      <span className="font-mono">{raw.digest.slice(0, 16)}…</span>
                    </p>
                    <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-xs leading-5">
                      {raw.text}
                    </pre>
                  </div>
                ) : null
              ) : activeScope?.available ? (
                activeScope.sections.map((section) => {
                  const key = `${scope}:${section.section}`;
                  const state = sections[key];
                  return (
                    <details
                      key={key}
                      className="group rounded-lg border border-border bg-card/35"
                      onToggle={(event) => {
                        if (event.currentTarget.open && !state) void loadSection(section.section);
                      }}
                    >
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium">
                        <span>{SECTION_LABELS[section.section]}</span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          {section.entryCount}
                          <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
                        </span>
                      </summary>
                      <div className="space-y-3 border-t border-border px-3 py-3">
                        {state?.entries.map((entry) => (
                          <article key={entry.id} className="rounded-md bg-muted/25 p-2.5">
                            {readableEntry(section.section, entry.value)}
                          </article>
                        ))}
                        {state?.loading ? (
                          <p className="flex items-center gap-2 text-xs text-muted-foreground">
                            <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading…
                          </p>
                        ) : null}
                        {state?.error ? (
                          <p className="text-xs text-destructive">{state.error}</p>
                        ) : null}
                        {state?.nextCursor && !state.loading ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void loadSection(section.section, state.nextCursor)}
                          >
                            Load more
                          </Button>
                        ) : null}
                      </div>
                    </details>
                  );
                })
              ) : null}
            </div>
          </ScrollArea>
        </>
      )}
    </section>
  );
}
