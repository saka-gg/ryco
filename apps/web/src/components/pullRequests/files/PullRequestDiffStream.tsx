import type { SelectedLineRange } from "@pierre/diffs";
import { Virtualizer } from "@pierre/diffs/react";
import type { ChangeRequestReviewThread } from "@ryco/contracts";
import type { ReviewDraftComment } from "@ryco/client-runtime/state/pull-request-review";
import { ExternalLinkIcon, RotateCcwIcon } from "lucide-react";
import type { RefObject } from "react";

import { openExternalLink } from "../../../lib/openExternalLink";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Skeleton } from "../../ui/skeleton";
import { DiffFileSection, type DiffFileActions, type DiffRenderSettings } from "./DiffFileSection";
import type { FileThreadCounts } from "./FileTreePane";
import type { FileViewedState, LineCommentTarget } from "./pullRequestFiles.logic";
import type { FilesViewedModel } from "./useFilesViewed";
import type { PullRequestDiffFiles } from "./usePullRequestDiffFiles";

const EMPTY_THREADS: ReadonlyArray<ChangeRequestReviewThread> = [];
const EMPTY_DRAFTS: ReadonlyArray<ReviewDraftComment> = [];

export interface DiffStreamState {
  readonly isOpen: (path: string) => boolean;
  readonly viewed: FilesViewedModel;
  readonly threadsByPath: ReadonlyMap<string, ReadonlyArray<ChangeRequestReviewThread>>;
  readonly outdatedByPath: ReadonlyMap<string, ReadonlyArray<ChangeRequestReviewThread>>;
  readonly draftsByPath: ReadonlyMap<string, ReadonlyArray<ReviewDraftComment>>;
  readonly threadCounts: ReadonlyMap<string, FileThreadCounts>;
  readonly composer: { readonly path: string; readonly target: LineCommentTarget } | null;
  readonly selection: {
    readonly path: string;
    readonly range: SelectedLineRange;
    readonly final: boolean;
  } | null;
  /** Render keys of patches whose full file contents the host refused. */
  readonly expansionBlocked: ReadonlySet<string>;
}

/**
 * The diff: one pierre `Virtualizer` holding every file of the change request
 * (or of one commit) in reading order, highlighted in the shared worker pool.
 * While the diff loads, a few quiet skeleton rows hold the layout; a diff the
 * host refuses to produce sends the reader to the host instead.
 */
export function PullRequestDiffStream(props: {
  readonly files: PullRequestDiffFiles;
  readonly state: DiffStreamState;
  readonly settings: DiffRenderSettings;
  readonly actionsRef: RefObject<DiffFileActions>;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly filesUrl: string | null;
  readonly commitScoped: boolean;
  readonly onRetry: () => void;
  readonly className?: string | undefined;
}) {
  const { files, state, settings, actionsRef } = props;

  if (files.status === "loading") {
    return (
      <div className={cn("min-h-0 flex-1 overflow-hidden px-6 pt-5", props.className)}>
        <div aria-busy className="space-y-8" aria-label="Loading the diff">
          {[0.62, 0.44, 0.7].map((width) => (
            <div key={width} className="space-y-3">
              <Skeleton className="h-3.5" style={{ width: `${width * 100}%` }} />
              <Skeleton className="h-28 w-full rounded-md opacity-60" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (files.status === "oversized" || files.status === "error" || files.status === "empty") {
    return (
      <div
        className={cn("flex min-h-0 flex-1 items-start justify-center px-6 pt-24", props.className)}
      >
        <div className="max-w-sm space-y-3 text-center">
          <p className="text-[13px] font-medium text-foreground">
            {files.status === "oversized"
              ? "Diff too large to show"
              : files.status === "empty"
                ? props.commitScoped
                  ? "This commit changes no files"
                  : "No file changes"
                : "Couldn’t load the diff"}
          </p>
          <p className="text-xs text-muted-foreground">
            {files.status === "oversized"
              ? "The host won’t produce a diff this size. Review it there instead."
              : files.status === "empty"
                ? "There is nothing to review in this diff."
                : (files.error ?? "Something went wrong while loading the diff.")}
          </p>
          <div className="flex items-center justify-center gap-2 pt-1">
            {files.status === "error" ? (
              <Button size="sm" variant="outline" onClick={props.onRetry}>
                <RotateCcwIcon className="size-3.5" />
                Try again
              </Button>
            ) : null}
            {files.status === "oversized" && props.filesUrl ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  props.filesUrl && openExternalLink(props.filesUrl, "Unable to open the diff")
                }
              >
                <ExternalLinkIcon className="size-3.5" />
                Open on GitHub
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={props.viewportRef}
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", props.className)}
    >
      <Virtualizer
        className="diff-render-surface min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
        contentClassName="px-6 pt-4 pb-40 @max-[640px]/reader:px-3"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        {files.files.map((file) => {
          const viewedState: FileViewedState | undefined = state.viewed.states.get(file.path);
          return (
            <DiffFileSection
              key={`${file.renderKey}:${settings.theme}`}
              file={file}
              open={state.isOpen(file.path)}
              viewedState={viewedState}
              viewedSupported={state.viewed.supported}
              viewedDisabled={!state.viewed.writable || state.viewed.pendingPaths.has(file.path)}
              threads={state.threadsByPath.get(file.path) ?? EMPTY_THREADS}
              outdatedThreads={state.outdatedByPath.get(file.path) ?? EMPTY_THREADS}
              drafts={state.draftsByPath.get(file.path) ?? EMPTY_DRAFTS}
              threadCounts={state.threadCounts.get(file.path)}
              composer={state.composer?.path === file.path ? state.composer.target : null}
              selection={
                state.selection?.path === file.path
                  ? { range: state.selection.range, final: state.selection.final }
                  : null
              }
              expansionBlocked={state.expansionBlocked.has(file.renderKey)}
              settings={settings}
              actionsRef={actionsRef}
            />
          );
        })}
      </Virtualizer>
    </div>
  );
}
