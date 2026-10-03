import type { FileDiffContentsLoader, SelectedLineRange } from "@pierre/diffs";
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions } from "@pierre/diffs/react";
import type { ChangeRequestReviewThread } from "@ryco/contracts";
import {
  reviewDraftAnchor,
  type ReviewDraftComment,
  type ReviewThreadAnchorMode,
} from "@ryco/client-runtime/state/pull-request-review";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { resolveDiffThemeName } from "../../../lib/diffRendering";
import { readMotionDurationMs } from "../../../lib/perf/motion";
import { cn } from "../../../lib/utils";
import { ReviewThread } from "../threads/ReviewThread";
import { findDiffLineElement, PULL_REQUEST_DIFF_UNSAFE_CSS } from "./diffReveal";
import { FileHeaderMeta } from "./FileHeaderMeta";
import type { FileThreadCounts } from "./FileTreePane";
import { LineComposer } from "./LineComposer";
import { OutdatedThreads } from "./OutdatedThreads";
import { PendingDraftCard } from "./PendingDraftCard";
import {
  buildFileLineAnnotations,
  lineCommentTarget,
  lineCommentTargetLabel,
  lineCommentTargetRange,
  lineCommentTargetTexts,
  suggestionSourceLines,
  type FileAnnotationMeta,
  type FileViewedState,
  type LineCommentTarget,
} from "./pullRequestFiles.logic";
import { SelectionChip } from "./SelectionChip";
import type { PullRequestDiffFile } from "./usePullRequestDiffFiles";

/** Stable callbacks every file section shares (read through a ref, so sections never re-render for them). */
export interface DiffFileActions {
  toggleOpen(path: string): void;
  toggleViewed(path: string, viewed: boolean): void;
  openComposer(path: string, range: SelectedLineRange): void;
  closeComposer(): void;
  /** What the open composer holds; it outlives the composer remounting. */
  composerBody(): string;
  rememberComposerBody(body: string): void;
  selectLines(path: string, range: SelectedLineRange | null, final: boolean): void;
  addDraft(target: LineCommentTarget, body: string): void;
  commentNow(target: LineCommentTarget, body: string): Promise<void>;
  updateDraft(draftId: string, body: string): void;
  removeDraft(draftId: string): void;
  askAboutLines(target: LineCommentTarget, lines: ReadonlyArray<string>): void;
  copyPath(path: string): void;
  /** The host refused this patch's file contents (truncated or binary): stop offering hunk expansion. */
  expansionUnavailable(renderKey: string): void;
}

/** Per-render settings shared by every file (theme, layout, review capabilities). */
export interface DiffRenderSettings {
  readonly theme: "light" | "dark";
  readonly diffStyle: "unified" | "split";
  readonly loadDiffFiles: FileDiffContentsLoader | undefined;
  readonly commenting: { readonly enabled: boolean; readonly reason: string | undefined };
  readonly ask: { readonly enabled: boolean; readonly reason: string | undefined };
  readonly mode: ReviewThreadAnchorMode;
  readonly headSha: string | null;
  readonly reviewStarted: boolean;
  readonly viewerLogin: string;
  readonly viewerAvatarUrl: string | undefined;
  readonly headUrlFor: (path: string) => string | null;
}

export interface DiffFileSectionProps {
  readonly file: PullRequestDiffFile;
  readonly open: boolean;
  readonly viewedState: FileViewedState | undefined;
  readonly viewedSupported: boolean;
  readonly viewedDisabled: boolean;
  /** Every thread on this path (the anchor mode decides which map onto lines). */
  readonly threads: ReadonlyArray<ChangeRequestReviewThread>;
  /** Threads on this path that no longer map onto the diff. */
  readonly outdatedThreads: ReadonlyArray<ChangeRequestReviewThread>;
  readonly drafts: ReadonlyArray<ReviewDraftComment>;
  readonly threadCounts: FileThreadCounts | undefined;
  readonly composer: LineCommentTarget | null;
  readonly selection: { readonly range: SelectedLineRange; readonly final: boolean } | null;
  readonly expansionBlocked: boolean;
  readonly settings: DiffRenderSettings;
  readonly actionsRef: RefObject<DiffFileActions>;
}

const EMPTY_ANNOTATIONS: DiffLineAnnotation<FileAnnotationMeta>[] = [];

/** Keeps a collapsing body mounted until its close motion ends, then drops the diff. */
function useMountedWhileOpen(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(
      () => setMounted(false),
      readMotionDurationMs("--app-motion-duration-stack", 260) + 40,
    );
    return () => window.clearTimeout(timer);
  }, [open]);
  return open || mounted;
}

/**
 * One file in the diff stream: a sticky header, then (when open) its
 * file-level conversations, the pierre diff with threads, pending drafts and
 * the line composer under their lines, and the outdated conversations last.
 * Collapsing animates the body's rows to zero and only then drops the diff,
 * so a closed file costs nothing while scrolling.
 */
export const DiffFileSection = memo(function DiffFileSection(props: DiffFileSectionProps) {
  const { file, settings, actionsRef } = props;
  const path = file.path;
  const renderKey = file.renderKey;
  const mounted = useMountedWhileOpen(props.open);
  const sectionRef = useRef<HTMLElement>(null);

  const lineThreads = useMemo(
    () => props.threads.filter((thread) => thread.subjectType !== "file"),
    [props.threads],
  );
  const fileThreads = useMemo(
    () => props.threads.filter((thread) => thread.subjectType === "file"),
    [props.threads],
  );
  const lineDrafts = useMemo(
    () => props.drafts.filter((draft) => (reviewDraftAnchor(draft)?.lineNumber ?? 0) > 0),
    [props.drafts],
  );
  const annotations = useMemo(() => {
    if (lineThreads.length === 0 && lineDrafts.length === 0 && props.composer === null) {
      return EMPTY_ANNOTATIONS;
    }
    return buildFileLineAnnotations({
      threads: lineThreads,
      drafts: lineDrafts,
      headSha: settings.headSha,
      composer: props.composer,
      mode: settings.mode,
    });
  }, [lineDrafts, lineThreads, props.composer, settings.headSha, settings.mode]);

  const selectedLines = useMemo<SelectedLineRange | null>(() => {
    if (props.composer) return lineCommentTargetRange(props.composer);
    return props.selection?.range ?? null;
  }, [props.composer, props.selection]);

  const loadDiffFiles = props.expansionBlocked ? undefined : settings.loadDiffFiles;
  const options = useMemo<FileDiffOptions<FileAnnotationMeta, undefined>>(
    () => ({
      disableFileHeader: true,
      diffStyle: settings.diffStyle,
      theme: resolveDiffThemeName(settings.theme),
      themeType: settings.theme,
      unsafeCSS: PULL_REQUEST_DIFF_UNSAFE_CSS,
      lineDiffType: "none",
      overflow: "scroll",
      lineHoverHighlight: "number",
      ...(loadDiffFiles
        ? {
            loadDiffFiles: async (fileDiff) => {
              try {
                return await loadDiffFiles(fileDiff);
              } catch (error) {
                actionsRef.current.expansionUnavailable(renderKey);
                throw error;
              }
            },
          }
        : {}),
      enableGutterUtility: settings.commenting.enabled,
      onGutterUtilityClick: (range) => actionsRef.current.openComposer(path, range),
      enableLineSelection: true,
      onLineSelectionChange: (range) => actionsRef.current.selectLines(path, range, false),
      onLineSelectionEnd: (range) => actionsRef.current.selectLines(path, range, true),
    }),
    [
      actionsRef,
      loadDiffFiles,
      path,
      renderKey,
      settings.commenting.enabled,
      settings.diffStyle,
      settings.theme,
    ],
  );

  const renderAnnotation = (annotation: DiffLineAnnotation<FileAnnotationMeta>) => (
    <AnnotationStack
      key={annotation.metadata.key}
      meta={annotation.metadata}
      file={file}
      settings={settings}
      actionsRef={actionsRef}
    />
  );

  const chip = useSelectionChipPosition(sectionRef, props.selection, props.open);
  const selectionTarget =
    props.selection?.final && props.composer === null
      ? lineCommentTarget(path, props.selection.range)
      : null;

  return (
    <section
      ref={sectionRef}
      data-diff-file-path={path}
      aria-label={path}
      className="relative mt-6 first:mt-0"
    >
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background">
        <FileHeaderMeta
          file={file}
          open={props.open}
          onToggleOpen={() => actionsRef.current.toggleOpen(path)}
          threads={props.threadCounts}
          viewedState={props.viewedState}
          viewedSupported={props.viewedSupported}
          viewedDisabled={props.viewedDisabled}
          onToggleViewed={(viewed) => actionsRef.current.toggleViewed(path, viewed)}
          headUrl={settings.headUrlFor(path)}
          onCopyPath={() => actionsRef.current.copyPath(path)}
        />
      </header>
      <div
        data-diff-file-body
        inert={!props.open}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)",
          props.open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {mounted ? (
            <>
              {fileThreads.length > 0 ? (
                <div className="space-y-2 border-b border-border/60 px-3 py-3">
                  {fileThreads.map((thread) => (
                    <ReviewThread key={thread.id} variant="inline" thread={thread} />
                  ))}
                </div>
              ) : null}
              <FileDiff<FileAnnotationMeta>
                fileDiff={file.fileDiff}
                options={options}
                lineAnnotations={annotations}
                selectedLines={selectedLines}
                renderAnnotation={renderAnnotation}
              />
              <OutdatedThreads threads={props.outdatedThreads} />
            </>
          ) : null}
        </div>
      </div>
      {chip && selectionTarget ? (
        <SelectionChip
          label={lineCommentTargetLabel(selectionTarget)}
          style={chip}
          canComment={settings.commenting.enabled}
          commentUnavailableReason={settings.commenting.reason}
          canAsk={settings.ask.enabled}
          askUnavailableReason={settings.ask.reason}
          onComment={() => {
            if (props.selection) actionsRef.current.openComposer(path, props.selection.range);
          }}
          onAsk={() =>
            actionsRef.current.askAboutLines(
              selectionTarget,
              lineCommentTargetTexts(file.fileDiff, selectionTarget),
            )
          }
        />
      ) : null}
    </section>
  );
});

/** Where the selection chip floats: just under the last selected line, at the code column. */
function useSelectionChipPosition(
  sectionRef: RefObject<HTMLElement | null>,
  selection: DiffFileSectionProps["selection"],
  open: boolean,
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section || !selection?.final || !open) {
      setStyle(null);
      return;
    }
    const side = selection.range.endSide ?? selection.range.side ?? "additions";
    const element = findDiffLineElement(section, side, selection.range.end);
    if (!element) {
      setStyle(null);
      return;
    }
    const sectionRect = section.getBoundingClientRect();
    const lineRect = element.getBoundingClientRect();
    setStyle({
      top: Math.round(lineRect.bottom - sectionRect.top + 4),
      left: Math.max(8, Math.round(lineRect.left - sectionRect.left + 8)),
    });
  }, [open, sectionRef, selection]);
  return style;
}

/** Everything anchored under one line: threads, then pending drafts, then the composer. */
const AnnotationStack = memo(function AnnotationStack(props: {
  readonly meta: FileAnnotationMeta;
  readonly file: PullRequestDiffFile;
  readonly settings: DiffRenderSettings;
  readonly actionsRef: RefObject<DiffFileActions>;
}) {
  const { meta, file, settings, actionsRef } = props;
  return (
    <div className="space-y-2 px-3 py-2.5 font-sans text-[13px] leading-normal whitespace-normal text-foreground">
      {meta.items.map((item) => {
        switch (item.kind) {
          case "thread":
            return <ReviewThread key={item.thread.id} variant="inline" thread={item.thread} />;
          case "draft":
            return (
              <PendingDraftCard
                key={item.draft.id}
                draft={item.draft}
                outdated={item.outdated}
                viewerLogin={settings.viewerLogin}
                viewerAvatarUrl={settings.viewerAvatarUrl}
                onUpdate={(body) => actionsRef.current.updateDraft(item.draft.id, body)}
                onRemove={() => actionsRef.current.removeDraft(item.draft.id)}
              />
            );
          case "composer":
            return (
              <LineComposer
                key={`composer:${item.target.side}:${item.target.startLine ?? ""}:${item.target.line}`}
                target={item.target}
                suggestionLines={suggestionSourceLines(file.fileDiff, item.target)}
                reviewStarted={settings.reviewStarted}
                restoreBody={() => actionsRef.current.composerBody()}
                onBodyChange={(body) => actionsRef.current.rememberComposerBody(body)}
                onCancel={() => actionsRef.current.closeComposer()}
                onAddToReview={(body) => actionsRef.current.addDraft(item.target, body)}
                onCommentNow={(body) => actionsRef.current.commentNow(item.target, body)}
              />
            );
        }
      })}
    </div>
  );
});
