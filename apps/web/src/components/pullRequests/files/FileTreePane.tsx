import { SearchIcon, XIcon } from "lucide-react";
import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { cn } from "../../../lib/utils";
import { KeyHint } from "../primitives";
import { FileStatusLetter, FileThreadCount, StaleViewedDot, ViewedCheckbox } from "./FileMarks";
import {
  buildReviewFileTree,
  filterFilePaths,
  flattenReviewFileTree,
  viewedProgress,
  type ReviewFileTreeNode,
} from "./pullRequestFiles.logic";
import type { FilesViewedModel } from "./useFilesViewed";
import type { PullRequestDiffFiles } from "./usePullRequestDiffFiles";

export interface FileThreadCounts {
  readonly total: number;
  readonly unresolved: number;
}

const ROW_INDENT_PX = 12;
const ROW_BASE_PADDING_PX = 8;

/**
 * The Files tab's tree: a filter (T), viewed progress with a 1px line, then
 * compacted directories and files in reading order. One plate glides to the
 * file being read in the diff (scroll-spy); clicking a file scrolls the diff
 * there. Viewed checkboxes sit at the row's end, where the eye finishes.
 */
export const FileTreePane = memo(function FileTreePane(props: {
  readonly files: PullRequestDiffFiles;
  readonly currentPath: string | null;
  readonly viewed: FilesViewedModel;
  readonly threadCounts: ReadonlyMap<string, FileThreadCounts>;
  readonly onSelectFile: (path: string) => void;
  readonly onToggleViewed: (path: string, viewed: boolean) => void;
  /** Esc in an empty filter closes the tree (overlay); without it the filter just blurs. */
  readonly onDismiss?: (() => void) | undefined;
  readonly filterRef: RefObject<HTMLInputElement | null>;
  readonly className?: string | undefined;
}) {
  const { files, viewed } = props;
  const [query, setQuery] = useState("");
  const visiblePaths = useMemo(() => filterFilePaths(files.paths, query), [files.paths, query]);
  const rows = useMemo(
    () =>
      flattenReviewFileTree(
        query.trim().length === 0 ? files.tree : buildReviewFileTree(visiblePaths),
      ),
    [files.tree, query, visiblePaths],
  );
  const progress = viewedProgress(files.paths, viewed.states);

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query.length > 0) setQuery("");
      else if (props.onDismiss) props.onDismiss();
      else event.currentTarget.blur();
      return;
    }
    if (event.key === "Enter") {
      const first = visiblePaths[0];
      if (first) {
        event.preventDefault();
        props.onSelectFile(first);
      }
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-col", props.className)}>
      <div className="shrink-0 space-y-3 px-3 pt-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-border/60 px-2 transition-colors duration-(--app-motion-duration-chip) focus-within:border-ring/60">
          <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
          <input
            ref={props.filterRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder="Filter files"
            aria-label="Filter files"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => {
                setQuery("");
                props.filterRef.current?.focus();
              }}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="size-3" />
            </button>
          ) : (
            <KeyHint>T</KeyHint>
          )}
        </label>
        {viewed.supported ? (
          <ViewedProgress viewed={progress.viewed} total={progress.total} />
        ) : (
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {files.paths.length} {files.paths.length === 1 ? "file" : "files"}
          </p>
        )}
      </div>
      <TreeRows
        rows={rows}
        currentPath={props.currentPath}
        viewed={viewed}
        threadCounts={props.threadCounts}
        files={files}
        onSelectFile={props.onSelectFile}
        onToggleViewed={props.onToggleViewed}
        emptyLabel={query.length > 0 ? `No files match “${query}”` : null}
      />
    </div>
  );
});

function ViewedProgress(props: { readonly viewed: number; readonly total: number }) {
  const ratio = props.total === 0 ? 0 : props.viewed / props.total;
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground tabular-nums">
        <span className="font-medium text-foreground">{props.viewed}</span> of {props.total} viewed
      </p>
      <div
        role="progressbar"
        aria-label="Files viewed"
        aria-valuemin={0}
        aria-valuemax={props.total}
        aria-valuenow={props.viewed}
        className="h-px overflow-hidden bg-border/70"
      >
        <div
          className="h-full origin-left bg-foreground/70 transition-transform duration-(--app-motion-duration-pane) ease-(--app-motion-spring-gentle)"
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>
    </div>
  );
}

function TreeRows(props: {
  readonly rows: ReadonlyArray<ReviewFileTreeNode>;
  readonly currentPath: string | null;
  readonly viewed: FilesViewedModel;
  readonly threadCounts: ReadonlyMap<string, FileThreadCounts>;
  readonly files: PullRequestDiffFiles;
  readonly onSelectFile: (path: string) => void;
  readonly onToggleViewed: (path: string, viewed: boolean) => void;
  readonly emptyLabel: string | null;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [plate, setPlate] = useState<{ top: number; height: number } | null>(null);
  const [placed, setPlaced] = useState(false);

  // Scroll-spy: one plate moves to the current file's row, and the tree keeps
  // that row in view without scrolling anything outside the tree.
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = scrollerRef.current;
    if (!list || !scroller || props.currentPath === null) {
      setPlate(null);
      return;
    }
    const row = list.querySelector<HTMLElement>(
      `[data-tree-path="${CSS.escape(props.currentPath)}"]`,
    );
    if (!row) {
      setPlate(null);
      return;
    }
    const top = row.offsetTop;
    const height = row.offsetHeight;
    setPlate((current) =>
      current && current.top === top && current.height === height ? current : { top, height },
    );
    const margin = 24;
    if (top - margin < scroller.scrollTop) {
      scroller.scrollTop = Math.max(0, top - margin);
    } else if (top + height + margin > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + height + margin - scroller.clientHeight;
    }
  }, [props.currentPath, props.rows]);

  useLayoutEffect(() => {
    if (plate === null || placed) return;
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, [placed, plate]);

  const plateStyle: CSSProperties = plate
    ? { transform: `translateY(${plate.top}px)`, height: plate.height, opacity: 1 }
    : { opacity: 0, height: 0 };

  return (
    <nav
      aria-label="Changed files"
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-8"
      ref={scrollerRef}
    >
      {props.emptyLabel !== null && props.rows.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">{props.emptyLabel}</p>
      ) : null}
      <ul ref={listRef} className="relative">
        <li
          aria-hidden
          data-placed={placed}
          className="pr-tree-plate pointer-events-none absolute inset-x-0 top-0 rounded-md bg-accent"
          style={plateStyle}
        />
        {props.rows.map((row) =>
          row.kind === "directory" ? (
            <li
              key={`dir:${row.path}`}
              className="relative flex h-7 items-center truncate text-[11.5px] text-muted-foreground/75"
              style={{ paddingLeft: ROW_BASE_PADDING_PX + row.depth * ROW_INDENT_PX }}
              title={row.path}
            >
              <span className="truncate">{row.name}/</span>
            </li>
          ) : (
            <TreeFileRow
              key={`file:${row.path}`}
              path={row.path}
              name={row.name}
              depth={row.depth}
              current={row.path === props.currentPath}
              file={props.files.byPath.get(row.path)}
              viewed={props.viewed}
              threads={props.threadCounts.get(row.path)}
              onSelect={props.onSelectFile}
              onToggleViewed={props.onToggleViewed}
            />
          ),
        )}
      </ul>
    </nav>
  );
}

const TreeFileRow = memo(function TreeFileRow(props: {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly current: boolean;
  readonly file: PullRequestDiffFiles["files"][number] | undefined;
  readonly viewed: FilesViewedModel;
  readonly threads: FileThreadCounts | undefined;
  readonly onSelect: (path: string) => void;
  readonly onToggleViewed: (path: string, viewed: boolean) => void;
}) {
  const state = props.viewed.states.get(props.path);
  return (
    <li
      data-tree-path={props.path}
      className="group/tree-row relative flex h-7 items-center gap-1 pr-0.5"
    >
      <button
        type="button"
        aria-current={props.current ? "true" : undefined}
        title={props.path}
        onClick={() => props.onSelect(props.path)}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-1 text-left outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring",
          !props.current && "hover:bg-accent/60",
        )}
        style={{ paddingLeft: ROW_BASE_PADDING_PX + props.depth * ROW_INDENT_PX }}
      >
        {props.file ? <FileStatusLetter status={props.file.status} /> : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12.5px]",
            state === "viewed"
              ? "text-muted-foreground/70"
              : props.current
                ? "text-foreground"
                : "text-foreground/85",
          )}
        >
          {props.name}
        </span>
        {props.threads ? (
          <FileThreadCount total={props.threads.total} unresolved={props.threads.unresolved} />
        ) : null}
        {state === "stale" ? <StaleViewedDot /> : null}
      </button>
      {props.viewed.supported ? (
        <ViewedCheckbox
          path={props.path}
          state={state}
          disabled={!props.viewed.writable || props.viewed.pendingPaths.has(props.path)}
          onToggle={(next) => props.onToggleViewed(props.path, next)}
        />
      ) : null}
    </li>
  );
});
