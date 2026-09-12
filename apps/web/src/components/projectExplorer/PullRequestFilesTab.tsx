import type { EnvironmentId, SourceControlChangeRequestFile } from "@ryco/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { resolveChangeRequestPresentationForKind } from "@ryco/shared/sourceControl";
import { ChevronRightIcon, FileIcon } from "lucide-react";
import { useSourceControlChangeRequestDiff } from "~/rpc/useSourceControl";
import { changeRequestDetailBinding, changeRequestDiffBinding } from "~/rpc/sourceControlAtoms";
import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";
import { Button } from "../ui/button";
import { type DiffLine, parseDiffLines } from "./diffLines";
import { splitUnifiedDiffByFile } from "./unifiedDiffSplit";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";

const numberFmt = new Intl.NumberFormat(undefined);

export function PullRequestFilesTab(props: {
  files: ReadonlyArray<SourceControlChangeRequestFile>;
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string;
  headSha: string | null;
  active: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const viewed = usePullRequestFilesViewed(props);
  const diffInput = { ...props, enabled: props.active && expanded.size > 0 };
  const diffQuery = useSourceControlChangeRequestDiff(diffInput);
  const diffByPath = useMemo(
    () => (diffQuery.data ? splitUnifiedDiffByFile(diffQuery.data) : null),
    [diffQuery.data],
  );
  return (
    <PullRequestFilesList
      files={props.files}
      viewed={viewed}
      headSha={props.headSha}
      expanded={expanded}
      onToggle={(path) =>
        setExpanded((previous) => {
          const next = new Set(previous);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        })
      }
      onRefresh={() => {
        void viewed.refresh();
        changeRequestDetailBinding.refresh({ ...props, fullContent: true });
        if (expanded.size > 0) changeRequestDiffBinding.refresh(diffInput);
      }}
      renderDiff={(path) => (
        <FileDiffViewer
          patch={diffByPath?.get(path) ?? null}
          isLoading={diffQuery.isLoading || diffQuery.isFetching}
          error={diffQuery.error?.message ?? null}
        />
      )}
    />
  );
}

export function PullRequestFilesList(props: {
  files: ReadonlyArray<SourceControlChangeRequestFile>;
  viewed: ReturnType<typeof usePullRequestFilesViewed>;
  headSha: string | null;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onRefresh: () => void;
  renderDiff: (path: string) => ReactNode;
}) {
  const [hideViewed, setHideViewed] = useState(false);
  const { viewed } = props;
  const supported = viewed.data != null && viewed.data.capability.storage !== "unsupported";
  const states = new Map(viewed.data?.files.map((file) => [file.path, file.state]));
  const headChanged = supported && viewed.data?.headSha !== props.headSha;
  const totalFiles = viewed.data?.files.length ?? props.files.length;
  const viewedCount = viewed.data?.files.filter((file) => file.state === "viewed").length ?? 0;
  const visibleFiles = props.files.filter(
    (file) => !supported || !hideViewed || headChanged || states.get(file.path) !== "viewed",
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {supported ? (
          <>
            <span role="status">
              {headChanged
                ? "Review progress needs refresh"
                : `${viewedCount}/${totalFiles} files viewed`}
            </span>
            <span>
              {viewed.data?.capability.storage === "host"
                ? `Synced with ${resolveChangeRequestPresentationForKind(viewed.data.provider).providerName}`
                : "Saved in this environment"}
            </span>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={hideViewed}
                onChange={(event) => setHideViewed(event.target.checked)}
              />
              Hide viewed
            </label>
          </>
        ) : viewed.isLoading ? (
          <span>Loading review progress…</span>
        ) : null}
        <Button variant="ghost" size="xs" onClick={props.onRefresh} disabled={viewed.isLoading}>
          Refresh files
        </Button>
      </div>
      {viewed.error ? (
        <p role="alert" className="text-xs text-destructive">
          {viewed.error}
        </p>
      ) : null}
      {headChanged ? (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          The pull request changed. Refresh files before continuing your review.
        </p>
      ) : null}
      {visibleFiles.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {props.files.length === 0
            ? "No file change information available."
            : "All displayed files viewed. Turn off Hide viewed to show them."}
        </p>
      ) : (
        <ol className="overflow-hidden rounded-lg border border-border/60 divide-y divide-border/60">
          {visibleFiles.map((file) => {
            const isOpen = props.expanded.has(file.path);
            const state = states.get(file.path);
            return (
              <li key={file.path} className="bg-muted/12">
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => props.onToggle(file.path)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-xs hover:bg-accent/40"
                  >
                    <ChevronRightIcon
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150",
                        isOpen ? "rotate-90" : "",
                      )}
                    />
                    <FileIcon className="size-3 shrink-0 text-muted-foreground/70" />
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
                      {file.path}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums">
                      <span className="text-emerald-600 dark:text-emerald-400">
                        +{numberFmt.format(file.additions)}
                      </span>
                      <span className="text-muted-foreground/60"> / </span>
                      <span className="text-rose-600 dark:text-rose-400">
                        −{numberFmt.format(file.deletions)}
                      </span>
                    </span>
                  </button>
                  {supported ? (
                    <label className="inline-flex shrink-0 items-center gap-1.5 px-3 text-xs text-muted-foreground">
                      {state === "stale" ? (
                        <span
                          className="text-amber-600 dark:text-amber-400"
                          title="This file changed since you last viewed it"
                        >
                          Changed since viewed
                        </span>
                      ) : null}
                      <input
                        type="checkbox"
                        aria-label={`Viewed ${file.path}`}
                        checked={state === "viewed" && !headChanged}
                        disabled={
                          viewed.pendingPaths.has(file.path) ||
                          headChanged ||
                          !props.headSha ||
                          state === undefined
                        }
                        onChange={(event) => void viewed.setViewed(file.path, event.target.checked)}
                      />
                      Viewed
                    </label>
                  ) : null}
                </div>
                {isOpen ? props.renderDiff(file.path) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function FileDiffViewer(props: { patch: string | null; isLoading: boolean; error: string | null }) {
  if (props.isLoading && props.patch === null) {
    return (
      <div className="flex items-center gap-2 border-border/60 border-t bg-background/40 px-3 py-2 text-muted-foreground text-xs">
        <Spinner className="size-3" />
        Loading diff…
      </div>
    );
  }
  if (props.error !== null) {
    return (
      <div className="border-border/60 border-t bg-background/40 px-3 py-2 text-destructive text-xs">
        {props.error}
      </div>
    );
  }

  const parsedLines = props.patch ? parseDiffLines(props.patch) : [];
  if (parsedLines.length === 0) {
    return (
      <div className="border-border/60 border-t bg-background/40 px-3 py-2 text-muted-foreground/70 text-xs italic">
        No diff available for this file.
      </div>
    );
  }
  const maxLine = parsedLines.reduce((max, line) => {
    const n = Math.max(line.oldLineNumber ?? 0, line.newLineNumber ?? 0);
    return n > max ? n : max;
  }, 0);
  const gutterDigits = Math.max(2, String(maxLine).length);
  const gutterCh = `${gutterDigits}ch`;
  return (
    <div className="overflow-x-auto border-border/60 border-t bg-background/40">
      <pre className="font-mono text-[11px] leading-snug">
        {parsedLines.map((line, index) => (
          <DiffLineRow
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            line={line}
            gutterCh={gutterCh}
          />
        ))}
      </pre>
    </div>
  );
}

function DiffLineRow({ line, gutterCh }: { line: DiffLine; gutterCh: string }) {
  const tone = lineToneForKind(line.kind);
  const oldText = line.oldLineNumber === null ? "" : String(line.oldLineNumber);
  const newText = line.newLineNumber === null ? "" : String(line.newLineNumber);
  return (
    <div className={cn("flex whitespace-pre", tone)}>
      <span
        className="shrink-0 select-none border-border/40 border-r bg-muted/24 px-1.5 text-right text-muted-foreground/60"
        style={{ width: gutterCh }}
      >
        {oldText}
      </span>
      <span
        className="shrink-0 select-none border-border/40 border-r bg-muted/16 px-1.5 text-right text-muted-foreground/60"
        style={{ width: gutterCh }}
      >
        {newText}
      </span>
      <span className="min-w-0 flex-1 px-2">{line.text === "" ? " " : line.text}</span>
    </div>
  );
}

function lineToneForKind(kind: DiffLine["kind"]): string {
  if (kind === "hunk") {
    return "bg-sky-500/8 text-sky-700 dark:text-sky-400";
  }
  if (kind === "add") {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (kind === "remove") {
    return "bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
  return "text-foreground/80";
}
