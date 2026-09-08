import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { TurnId } from "@ryco/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  Columns2Icon,
  PilcrowIcon,
  Rows3Icon,
  SearchIcon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { useGitStatus } from "~/lib/gitStatusState";
import { useCheckpointDiff } from "~/rpc/useProvider";
import { cn } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useDiffLayout, type DiffRenderMode } from "../hooks/useDiffLayout";
import { useTheme } from "../hooks/useTheme";
import { DiffParseCache } from "../lib/diffParseCache";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { usePerfMark } from "../perf/tabSwitchInstrumentation";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import {
  buildDiffSearchIndex,
  deriveDiffSearchFileIndexes,
  doesDiffSearchMatchRenderedLine,
  type DiffSearchMatch,
  findDiffSearchMatches,
  getDiffSearchMatchRenderedLineIndex,
  getNextDiffSearchMatchIndex,
  groupDiffSearchMatchesByFileIndex,
  normalizeDiffSearchQuery,
  parseDiffRenderedLineIndexes,
  resolveDiffFilePath,
} from "./DiffPanel.search.logic";
import { resolveDiffOpenInEditorTarget } from "./DiffPanel.openInEditor.logic";

type DiffThemeType = "light" | "dark";

const DIFF_PANEL_BASE_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}
`;

// Open-in-editor affordances (clickable title, clickable line numbers). These
// fire local RPCs that cannot succeed from a phone, so the phone presentation
// omits them along with the click handlers.
const DIFF_PANEL_EDITOR_OPEN_UNSAFE_CSS = `
[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}

[data-interactive-line-numbers] [data-line-number-content] {
  cursor: pointer;
}
`;

const DIFF_PANEL_SEARCH_UNSAFE_CSS = `
::highlight(ryco-diff-search-match) {
  background-color: color-mix(in srgb, var(--warning) 60%, transparent);
  color: var(--foreground);
}
`;

const DIFF_PANEL_UNSAFE_CSS = `${DIFF_PANEL_BASE_UNSAFE_CSS}${DIFF_PANEL_EDITOR_OPEN_UNSAFE_CSS}${DIFF_PANEL_SEARCH_UNSAFE_CSS}`;
const DIFF_PANEL_PHONE_UNSAFE_CSS = `${DIFF_PANEL_BASE_UNSAFE_CSS}${DIFF_PANEL_SEARCH_UNSAFE_CSS}`;

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return resolveDiffFilePath(fileDiff);
}

function sortRenderableFiles(patch: RenderablePatch | null): FileDiffMetadata[] {
  if (!patch || patch.kind !== "files") {
    return [];
  }
  return patch.files.toSorted((left, right) =>
    resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

interface ParsedDiffContent {
  readonly patch: RenderablePatch | null;
  readonly files: FileDiffMetadata[];
}

// Parsed-diff payloads are cached across turn/file switches so re-opening a
// previously viewed diff is instant, and rapid switching never re-parses (or
// re-queues worker highlight jobs for) identical content. Worker jobs for files
// that scroll out / unmount are cancelled by @pierre/diffs on unmount, so the
// queue does not stack as the selection changes.
const renderablePatchCache = new DiffParseCache<ParsedDiffContent>();

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

const DIFF_SEARCH_HIGHLIGHT_NAME = "ryco-diff-search-match";
const DIFF_SEARCH_DEBOUNCE_MS = 150;
const DIFF_SEARCH_HIGHLIGHT_REFRESH_DELAY_MS = 80;
const DIFF_SEARCH_HIGHLIGHT_VIEWPORT_MARGIN_PX = 1600;

function isCSSHighlightSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof (CSS as unknown as { highlights?: unknown }).highlights !== "undefined" &&
    typeof globalThis.Highlight !== "undefined"
  );
}

function isNearViewport(
  element: Element,
  viewport: Element,
  margin = DIFF_SEARCH_HIGHLIGHT_VIEWPORT_MARGIN_PX,
): boolean {
  const elementRect = element.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  return (
    elementRect.bottom >= viewportRect.top - margin &&
    elementRect.top <= viewportRect.bottom + margin &&
    elementRect.right >= viewportRect.left - margin &&
    elementRect.left <= viewportRect.right + margin
  );
}

function collectDiffLineTextOffsets(lineElement: HTMLElement): {
  readonly textLength: number;
  readonly offsets: readonly {
    readonly node: Text;
    readonly start: number;
    readonly end: number;
  }[];
} {
  const offsets: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent && parent.closest("[data-line-number-content]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current = walker.nextNode();
  let textLength = 0;
  while (current) {
    const textNode = current as Text;
    const nextTextLength = textLength + textNode.data.length;
    offsets.push({
      node: textNode,
      start: textLength,
      end: nextTextLength,
    });
    textLength = nextTextLength;
    current = walker.nextNode();
  }
  return { offsets, textLength };
}

function findTextOffsetPosition(
  offsets: readonly { readonly node: Text; readonly start: number; readonly end: number }[],
  offset: number,
  edge: "start" | "end",
): { readonly node: Text; readonly offset: number } | null {
  for (const info of offsets) {
    if (offset < info.start || offset > info.end) {
      continue;
    }
    if (offset === info.end && edge === "start") {
      continue;
    }
    return {
      node: info.node,
      offset: offset - info.start,
    };
  }
  return null;
}

function appendDiffLineSearchRange(
  lineElement: HTMLElement,
  match: DiffSearchMatch,
  ranges: Range[],
): void {
  const { offsets, textLength } = collectDiffLineTextOffsets(lineElement);
  if (
    offsets.length === 0 ||
    match.start < 0 ||
    match.end > textLength ||
    match.start >= match.end
  ) {
    return;
  }

  const start = findTextOffsetPosition(offsets, match.start, "start");
  const end = findTextOffsetPosition(offsets, match.end, "end");
  if (!start || !end) return;

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  ranges.push(range);
}

function getRenderedLineSearchMatches(input: {
  readonly matches: readonly DiffSearchMatch[];
  readonly renderMode: DiffRenderMode;
  readonly lineIndexAttr: string | null;
  readonly lineType: string | null;
}): DiffSearchMatch[] {
  const lineIndexes = parseDiffRenderedLineIndexes(input.lineIndexAttr);
  if (!lineIndexes) return [];
  return input.matches.filter((match) =>
    doesDiffSearchMatchRenderedLine(match, {
      renderMode: input.renderMode,
      lineIndexes,
      lineType: input.lineType,
    }),
  );
}

function findRenderedDiffLineElement(input: {
  readonly fileElement: HTMLElement;
  readonly match: DiffSearchMatch;
  readonly renderMode: DiffRenderMode;
}): HTMLElement | null {
  const renderedLineIndex = getDiffSearchMatchRenderedLineIndex(input.match, input.renderMode);
  if (renderedLineIndex === null) {
    return null;
  }

  const containers = input.fileElement.querySelectorAll<HTMLElement>("diffs-container");
  for (const container of containers) {
    const candidates = container.shadowRoot?.querySelectorAll<HTMLElement>(
      "[data-line][data-line-index]",
    );
    for (const candidate of candidates ?? []) {
      const lineIndexes = parseDiffRenderedLineIndexes(candidate.getAttribute("data-line-index"));
      if (!lineIndexes) continue;
      if (
        doesDiffSearchMatchRenderedLine(input.match, {
          renderMode: input.renderMode,
          lineIndexes,
          lineType: candidate.getAttribute("data-line-type"),
        })
      ) {
        return candidate;
      }
    }
  }

  return null;
}

function findDiffSearchRanges(input: {
  readonly rootElement: HTMLElement;
  readonly viewportElement: HTMLElement;
  readonly matchesByFileIndex: ReadonlyMap<number, readonly DiffSearchMatch[]>;
  readonly renderMode: DiffRenderMode;
}): Range[] {
  const ranges: Range[] = [];
  const fileElements = input.rootElement.querySelectorAll<HTMLElement>("[data-diff-file-index]");
  for (const fileElement of fileElements) {
    if (!isNearViewport(fileElement, input.viewportElement)) continue;
    const rawFileIndex = fileElement.dataset.diffFileIndex;
    const fileIndex = rawFileIndex ? Number.parseInt(rawFileIndex, 10) : Number.NaN;
    if (!Number.isFinite(fileIndex)) continue;
    const matches = input.matchesByFileIndex.get(fileIndex);
    if (!matches || matches.length === 0) continue;

    const containers = fileElement.querySelectorAll<HTMLElement>("diffs-container");
    for (const container of containers) {
      const lineElements = container.shadowRoot?.querySelectorAll<HTMLElement>(
        "[data-line][data-line-index]",
      );
      for (const lineElement of lineElements ?? []) {
        if (!isNearViewport(lineElement, input.viewportElement)) continue;
        const lineMatches = getRenderedLineSearchMatches({
          matches,
          renderMode: input.renderMode,
          lineIndexAttr: lineElement.getAttribute("data-line-index"),
          lineType: lineElement.getAttribute("data-line-type"),
        });
        for (const match of lineMatches) {
          appendDiffLineSearchRange(lineElement, match, ranges);
        }
      }
    }
  }
  return ranges;
}

function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--diffs-addition-base)]";
    case "deleted":
      return "text-[var(--diffs-deletion-base)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--diffs-modified-base)]";
    default:
      return "text-muted-foreground/80";
  }
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  usePerfMark("DiffPanel");
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  // Phone work surface: word wrap defaults on (320-430px columns are
  // unreadable with horizontal code scroll), open-in-editor taps are
  // suppressed, and the split-view toggle is hidden. The settings-driven
  // desktop defaults are untouched.
  const isPhonePresentation = mode === "phone";
  const [preferredDiffLayout, setDiffRenderMode] = useDiffLayout();
  const diffRenderMode = isPhonePresentation ? "stacked" : preferredDiffLayout;
  const [diffWordWrap, setDiffWordWrap] = useState(
    isPhonePresentation ? true : settings.diffWordWrap,
  );
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [collapsedDiffFileKeys, setCollapsedDiffFileKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [diffSearchQuery, setDiffSearchQuery] = useState("");
  const [debouncedDiffSearchQuery] = useDebouncedValue(diffSearchQuery, {
    wait: DIFF_SEARCH_DEBOUNCE_MS,
  });
  const effectiveDiffSearchQuery =
    diffSearchQuery.trim().length === 0 ? "" : debouncedDiffSearchQuery;
  const [currentDiffMatchIndex, setCurrentDiffMatchIndex] = useState(0);
  const diffSearchInputRef = useRef<HTMLInputElement>(null);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const diffSearch = useSearch({
    strict: false,
    select: (search) => parseDiffRouteSearch(search),
  });
  const diffOpen = diffSearch.diff === "1";
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeThread && activeProjectId
      ? selectProjectByRef(store, {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        })
      : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const gitStatusQuery = useGitStatus({
    environmentId: activeThread?.environmentId ?? null,
    cwd: activeCwd ?? null,
  });
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedTurnId = diffSearch.diffTurnId ?? null;
  const selectedFilePath = selectedTurnId !== null ? (diffSearch.diffFilePath ?? null) : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !selectedTurn && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries, selectedTurn]);
  const activeCheckpointDiffQuery = useCheckpointDiff({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
    fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
    toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
    ignoreWhitespace: diffIgnoreWhitespace,
    cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
    enabled: isGitRepo,
  });
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff = activeCheckpointDiffQuery.isLoading;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;

  const selectedPatch = selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderableContent = useMemo<ParsedDiffContent>(() => {
    const parseScope = `diff-panel:${resolvedTheme}`;
    const normalizedPatch = typeof selectedPatch === "string" ? selectedPatch.trim() : "";
    if (normalizedPatch.length === 0) {
      return { patch: null, files: [] };
    }
    const turnScope = selectedTurn
      ? `turn:${selectedTurn.turnId}`
      : (conversationCacheScope ?? "conversation");
    const cacheKey = {
      turnId: turnScope,
      filePath: parseScope,
      blobSha: buildPatchCacheKey(normalizedPatch),
    };
    const cached = renderablePatchCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const patch = getRenderablePatch(selectedPatch, parseScope);
    const content: ParsedDiffContent = { patch, files: sortRenderableFiles(patch) };
    if (patch) {
      renderablePatchCache.set(cacheKey, content);
    }
    return content;
  }, [conversationCacheScope, resolvedTheme, selectedPatch, selectedTurn]);
  const renderablePatch = renderableContent.patch;
  const renderableFiles = renderableContent.files;

  const diffSearchIndex = useMemo(() => buildDiffSearchIndex(renderableFiles), [renderableFiles]);
  const normalizedDiffSearchQuery = useMemo(
    () => normalizeDiffSearchQuery(effectiveDiffSearchQuery),
    [effectiveDiffSearchQuery],
  );
  const diffSearchMatches = useMemo(
    () => findDiffSearchMatches(diffSearchIndex, effectiveDiffSearchQuery),
    [diffSearchIndex, effectiveDiffSearchQuery],
  );
  const diffSearchMatchesByFileIndex = useMemo(
    () => groupDiffSearchMatchesByFileIndex(diffSearchMatches),
    [diffSearchMatches],
  );
  const renderableFileEntries = useMemo(
    () => renderableFiles.map((fileDiff, fileIndex) => ({ fileDiff, fileIndex })),
    [renderableFiles],
  );
  const filteredFileEntries = useMemo(() => {
    if (!normalizedDiffSearchQuery) return renderableFileEntries;
    return deriveDiffSearchFileIndexes(diffSearchMatches).map((index) => ({
      fileDiff: renderableFiles[index]!,
      fileIndex: index,
    }));
  }, [diffSearchMatches, normalizedDiffSearchQuery, renderableFileEntries, renderableFiles]);

  useEffect(() => {
    setCurrentDiffMatchIndex(0);
  }, [normalizedDiffSearchQuery, renderableFiles]);

  useEffect(() => {
    setCurrentDiffMatchIndex((current) => {
      if (diffSearchMatches.length === 0) return 0;
      return Math.min(current, diffSearchMatches.length - 1);
    });
  }, [diffSearchMatches.length]);

  const goToDiffMatch = useCallback(
    (delta: 1 | -1) => {
      if (diffSearchMatches.length === 0) return;
      const next = getNextDiffSearchMatchIndex(
        currentDiffMatchIndex,
        diffSearchMatches.length,
        delta,
      );
      setCurrentDiffMatchIndex(next);
      const match = diffSearchMatches[next];
      const root = patchViewportRef.current;
      if (!match || !root) return;
      const targetFile = root.querySelector<HTMLElement>(
        `[data-diff-file-index="${match.fileIndex}"]`,
      );
      if (!targetFile) return;

      const targetLine = findRenderedDiffLineElement({
        fileElement: targetFile,
        match,
        renderMode: diffRenderMode,
      });
      (targetLine ?? targetFile).scrollIntoView({ block: "center", behavior: "smooth" });
      if (!targetLine && getDiffSearchMatchRenderedLineIndex(match, diffRenderMode) !== null) {
        window.requestAnimationFrame(() => {
          findRenderedDiffLineElement({
            fileElement: targetFile,
            match,
            renderMode: diffRenderMode,
          })?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      }
    },
    [currentDiffMatchIndex, diffRenderMode, diffSearchMatches],
  );

  useEffect(() => {
    if (!isCSSHighlightSupported()) return;
    const cssHighlights = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights;
    const root = patchViewportRef.current;
    if (!root || !normalizedDiffSearchQuery || diffSearchMatches.length === 0) {
      cssHighlights.delete(DIFF_SEARCH_HIGHLIGHT_NAME);
      return;
    }

    let frameId = 0;
    let refreshTimeoutId = 0;
    const shadowObservers = new Map<ShadowRoot, MutationObserver>();
    const viewport =
      root.querySelector<HTMLElement>(".diff-render-surface") ??
      root.querySelector<HTMLElement>("[data-virtualizer]") ??
      root;
    const refreshHighlights = () => {
      frameId = 0;
      observeNewShadowRoots();
      const ranges = findDiffSearchRanges({
        rootElement: root,
        viewportElement: viewport,
        matchesByFileIndex: diffSearchMatchesByFileIndex,
        renderMode: diffRenderMode,
      });
      if (ranges.length === 0) {
        cssHighlights.delete(DIFF_SEARCH_HIGHLIGHT_NAME);
        return;
      }
      cssHighlights.set(DIFF_SEARCH_HIGHLIGHT_NAME, new Highlight(...ranges));
    };
    const scheduleRefresh = () => {
      if (frameId !== 0 || refreshTimeoutId !== 0) return;
      refreshTimeoutId = window.setTimeout(() => {
        refreshTimeoutId = 0;
        frameId = window.requestAnimationFrame(refreshHighlights);
      }, DIFF_SEARCH_HIGHLIGHT_REFRESH_DELAY_MS);
    };
    const observeNewShadowRoots = () => {
      const fileElements = root.querySelectorAll<HTMLElement>("[data-diff-file-index]");
      for (const fileElement of fileElements) {
        if (!isNearViewport(fileElement, viewport)) continue;
        const containers = fileElement.querySelectorAll<HTMLElement>("diffs-container");
        for (const container of containers) {
          const shadow = container.shadowRoot;
          if (!shadow || shadowObservers.has(shadow)) continue;
          const observer = new MutationObserver(scheduleRefresh);
          observer.observe(shadow, { childList: true, subtree: true });
          shadowObservers.set(shadow, observer);
        }
      }
    };

    const lightObserver = new MutationObserver(scheduleRefresh);
    lightObserver.observe(root, { childList: true, subtree: true });
    viewport.addEventListener("scroll", scheduleRefresh, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleRefresh);
    resizeObserver.observe(viewport);
    scheduleRefresh();

    return () => {
      lightObserver.disconnect();
      viewport.removeEventListener("scroll", scheduleRefresh);
      resizeObserver.disconnect();
      for (const observer of shadowObservers.values()) {
        observer.disconnect();
      }
      shadowObservers.clear();
      if (refreshTimeoutId !== 0) window.clearTimeout(refreshTimeoutId);
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      cssHighlights.delete(DIFF_SEARCH_HIGHLIGHT_NAME);
    };
  }, [
    diffRenderMode,
    diffSearchMatches.length,
    diffSearchMatchesByFileIndex,
    normalizedDiffSearchQuery,
  ]);

  useEffect(() => {
    if (renderableFiles.length === 0) {
      setCollapsedDiffFileKeys((current) => (current.size === 0 ? current : new Set()));
      return;
    }

    const visibleFileKeys = new Set(renderableFiles.map(buildFileDiffRenderKey));
    setCollapsedDiffFileKeys((current) => {
      const next = new Set([...current].filter((fileKey) => visibleFileKeys.has(fileKey)));
      return next.size === current.size ? current : next;
    });
  }, [renderableFiles]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(isPhonePresentation ? true : settings.diffWordWrap);
      setDiffIgnoreWhitespace(settings.diffIgnoreWhitespace);
      setDiffSearchQuery("");
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, isPhonePresentation, settings.diffIgnoreWhitespace, settings.diffWordWrap]);

  useEffect(() => {
    setDiffSearchQuery("");
  }, [selectedTurnId]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const openDiffFileInEditor = useCallback(
    (filePath: string, lineNumber?: number) => {
      const api = readLocalApi();
      if (!api) return;
      const target = resolveDiffOpenInEditorTarget({
        cwd: activeCwd,
        filePath,
        lineNumber,
      });
      void openInPreferredEditor(api, target).catch((error) => {
        console.warn("Failed to open diff in editor.", error);
      });
    },
    [activeCwd],
  );
  const toggleDiffFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedDiffFileKeys((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  }, []);

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  };
  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);
  const scrollTurnStripBy = useCallback((offset: number) => {
    const element = turnStripRef.current;
    if (!element) return;
    element.scrollBy({ left: offset, behavior: "smooth" });
  }, []);
  const onTurnStripWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = turnStripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    element.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedTurnDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [selectedTurn?.turnId, selectedTurnId]);

  const headerRow = (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        {/* The overlaid scroll arrows and the `px-8` gutter they need are a
            fine-pointer affordance. On the phone surface the arrows measured
            24x24 — below the touch floor — and their gutter is what makes the
            strip unusable under text scaling: `px-8` resolves to 64px per side
            at a 32px root, which at 320px left the rail a 16px content window
            for an 87px chip (and, before the toolbar floor below was pinned in
            px rather than rem, no content window at all). The strip is
            touch-scrollable without the arrows. */}
        {isPhonePresentation ? null : (
          <>
            <button
              type="button"
              className={cn(
                "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
                canScrollTurnStripLeft
                  ? "border-border/70 hover:border-border hover:text-foreground"
                  : "cursor-not-allowed border-border/40 text-muted-foreground/40",
              )}
              onClick={() => scrollTurnStripBy(-180)}
              disabled={!canScrollTurnStripLeft}
              aria-label="Scroll turn list left"
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <button
              type="button"
              className={cn(
                "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
                canScrollTurnStripRight
                  ? "border-border/70 hover:border-border hover:text-foreground"
                  : "cursor-not-allowed border-border/40 text-muted-foreground/40",
              )}
              onClick={() => scrollTurnStripBy(180)}
              disabled={!canScrollTurnStripRight}
              aria-label="Scroll turn list right"
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
          </>
        )}
        <div
          ref={turnStripRef}
          className={cn(
            "turn-chip-strip flex gap-1 overflow-x-auto py-0.5",
            isPhonePresentation ? "px-1" : "px-8",
          )}
          style={
            // The fade mask marks the arrow gutters, so it goes with them.
            !isPhonePresentation && (canScrollTurnStripLeft || canScrollTurnStripRight)
              ? {
                  maskImage: `linear-gradient(to right, ${canScrollTurnStripLeft ? "transparent 24px, black 72px" : "black"}, ${canScrollTurnStripRight ? "black calc(100% - 72px), transparent calc(100% - 24px)" : "black"})`,
                }
              : undefined
          }
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className={cn("shrink-0 rounded-md", isPhonePresentation && "min-h-[44px]")}
            onClick={selectWholeConversation}
            data-turn-chip-selected={selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                // The chip is the tap target, so the phone surface sizes the
                // real box to the touch floor. Slop cannot do it here: the
                // strip is `overflow-x: auto`, which forces the block axis to
                // `auto` too and clips anything escaping the chip's border box.
                isPhonePresentation && "flex min-h-[44px] items-center",
                selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">All turns</div>
            </div>
          </button>
          {orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className={cn("shrink-0 rounded-md", isPhonePresentation && "min-h-[44px]")}
              onClick={() => selectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurn?.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  isPhonePresentation && "flex min-h-[44px] items-center",
                  summary.turnId === selectedTurn?.turnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[10px] leading-tight font-medium">
                    Turn{" "}
                    {summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                      "?"}
                  </span>
                  <span className="text-[9px] leading-tight opacity-70">
                    {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {/* Split view is meaningless at phone width: the toolbar reduces to
            wrap and whitespace toggles (the turn strip stays as file nav). */}
        {isPhonePresentation ? null : (
          <ToggleGroup
            className="shrink-0"
            variant="outline"
            size="xs"
            value={[diffRenderMode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "stacked" || next === "split") {
                setDiffRenderMode(next);
              }
            }}
          >
            <Toggle aria-label="Stacked diff view" value="stacked">
              <Rows3Icon className="size-3" />
            </Toggle>
            <Toggle aria-label="Split diff view" value="split">
              <Columns2Icon className="size-3" />
            </Toggle>
          </ToggleGroup>
        )}
        {/* The shared `pointer-coarse` hit slop on `Toggle` does not reach the
            floor here: this row is the flex sibling of an `overflow-x: auto`
            strip, and the measured outward reach from the 28px box was 32px
            wide. The phone surface therefore sizes the real box. */}
        <Toggle
          aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          variant="outline"
          size="xs"
          className={cn(isPhonePresentation && "min-h-[44px] min-w-[44px]")}
          pressed={diffWordWrap}
          onPressedChange={(pressed) => {
            setDiffWordWrap(Boolean(pressed));
          }}
        >
          <TextWrapIcon className="size-3" />
        </Toggle>
        <Toggle
          aria-label={diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          title={diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          variant="outline"
          size="xs"
          className={cn(isPhonePresentation && "min-h-[44px] min-w-[44px]")}
          pressed={diffIgnoreWhitespace}
          onPressedChange={(pressed) => {
            setDiffIgnoreWhitespace(Boolean(pressed));
          }}
        >
          <PilcrowIcon className="size-3" />
        </Toggle>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            {checkpointDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{checkpointDiffError}</p>
              </div>
            )}
            {!renderablePatch ? (
              isLoadingCheckpointDiff ? (
                <DiffPanelLoadingState label="Loading checkpoint diff..." />
              ) : (
                <div className="flex flex-1 items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-border/50 bg-card/40 px-2.5 py-1.5 [-webkit-app-region:no-drag]">
                  <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <input
                    ref={diffSearchInputRef}
                    type="text"
                    value={diffSearchQuery}
                    onChange={(event) => setDiffSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setDiffSearchQuery("");
                        event.currentTarget.blur();
                        return;
                      }
                      if (event.key === "Enter" && normalizedDiffSearchQuery) {
                        event.preventDefault();
                        goToDiffMatch(event.shiftKey ? -1 : 1);
                      }
                    }}
                    placeholder="Search files or hunks..."
                    aria-label="Search diff"
                    className={cn(
                      "min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/55",
                      isPhonePresentation && "min-h-[44px]",
                    )}
                  />
                  {normalizedDiffSearchQuery && (
                    <>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                        {diffSearchMatches.length === 0 ? 0 : currentDiffMatchIndex + 1} of{" "}
                        {diffSearchMatches.length}
                      </span>
                      <div className="flex shrink-0 items-center">
                        <button
                          type="button"
                          onClick={() => goToDiffMatch(-1)}
                          disabled={diffSearchMatches.length === 0}
                          className={cn(
                            "inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/70",
                            isPhonePresentation && "size-[44px]",
                          )}
                          aria-label="Previous match"
                          title="Previous match (Shift+Enter)"
                        >
                          <ChevronUpIcon className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => goToDiffMatch(1)}
                          disabled={diffSearchMatches.length === 0}
                          className={cn(
                            "inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/70",
                            isPhonePresentation && "size-[44px]",
                          )}
                          aria-label="Next match"
                          title="Next match (Enter)"
                        >
                          <ChevronDownIcon className="size-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                  {diffSearchQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setDiffSearchQuery("");
                        diffSearchInputRef.current?.focus();
                      }}
                      className={cn(
                        "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground",
                        isPhonePresentation && "size-[44px]",
                      )}
                      aria-label="Clear search"
                      title="Clear search"
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                </div>
                {filteredFileEntries.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                    <p>No files match &ldquo;{diffSearchQuery}&rdquo;.</p>
                  </div>
                ) : (
                  <Virtualizer
                    className={cn(
                      "diff-render-surface min-h-0 flex-1 overflow-auto px-2 pb-2",
                      // Horizontal diff overflow belongs to the code block the
                      // renderer scrolls itself. On the phone surface the file
                      // list must not become a second horizontal scroller and
                      // must not chain a horizontal swipe outward to the page
                      // (which is a back-navigation gesture on a phone), so it
                      // scrolls on one axis and contains overscroll on the
                      // other. Desktop keeps `overflow: auto` on both axes.
                      isPhonePresentation &&
                        "overflow-x-hidden overflow-y-auto overscroll-x-contain",
                    )}
                    config={{
                      overscrollSize: 600,
                      intersectionObserverMargin: 1200,
                    }}
                  >
                    {filteredFileEntries.map(({ fileDiff, fileIndex }) => {
                      const filePath = resolveFileDiffPath(fileDiff);
                      const fileKey = buildFileDiffRenderKey(fileDiff);
                      const themedFileKey = `${fileKey}:${resolvedTheme}`;
                      const collapsed = collapsedDiffFileKeys.has(fileKey);
                      return (
                        <div
                          key={themedFileKey}
                          data-diff-file-path={filePath}
                          data-diff-file-index={fileIndex}
                          className="diff-render-file group/diff-file mb-2 rounded-md first:mt-2 last:mb-0"
                          // Open-in-editor fires a local RPC that cannot
                          // succeed from a phone; the phone surface renders
                          // the title as plain text instead of a dead tap.
                          onClickCapture={
                            isPhonePresentation
                              ? undefined
                              : (event) => {
                                  const nativeEvent = event.nativeEvent as MouseEvent;
                                  const composedPath = nativeEvent.composedPath?.() ?? [];
                                  const clickedHeader = composedPath.some((node) => {
                                    if (!(node instanceof Element)) return false;
                                    return node.hasAttribute("data-title");
                                  });
                                  if (!clickedHeader) return;
                                  openDiffFileInEditor(filePath);
                                }
                          }
                        >
                          <FileDiff
                            fileDiff={fileDiff}
                            renderHeaderPrefix={() => (
                              <button
                                type="button"
                                className={cn(
                                  "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                                  // Phone: the 44px floor comes from the real
                                  // box, not from hit slop. The previous
                                  // `after:size-11` expansion measured 32x32
                                  // of outward reach here, because
                                  // `.diff-render-file` is `overflow: clip`
                                  // and the file header row clips again — a
                                  // bounding-box or computed-style assertion
                                  // on the pseudo-element cannot see that.
                                  isPhonePresentation && "size-[44px]",
                                  getDiffCollapseIconClassName(fileDiff),
                                )}
                                aria-label={
                                  collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`
                                }
                                aria-expanded={!collapsed}
                                title={collapsed ? "Expand diff" : "Collapse diff"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleDiffFileCollapsed(fileKey);
                                }}
                              >
                                {collapsed ? (
                                  <ChevronRightIcon className="size-4" />
                                ) : (
                                  <ChevronDownIcon className="size-4" />
                                )}
                              </button>
                            )}
                            options={{
                              collapsed,
                              diffStyle: diffRenderMode === "split" ? "split" : "unified",
                              lineDiffType: "none",
                              overflow: diffWordWrap ? "wrap" : "scroll",
                              theme: resolveDiffThemeName(resolvedTheme),
                              themeType: resolvedTheme as DiffThemeType,
                              unsafeCSS: isPhonePresentation
                                ? DIFF_PANEL_PHONE_UNSAFE_CSS
                                : DIFF_PANEL_UNSAFE_CSS,
                              lineHoverHighlight: "number",
                              // Line-number editor-open taps are suppressed on
                              // the phone surface (same RPC constraint as the
                              // title click above).
                              ...(isPhonePresentation
                                ? {}
                                : {
                                    onLineNumberClick: ({ lineNumber }: { lineNumber: number }) => {
                                      openDiffFileInEditor(filePath, lineNumber);
                                    },
                                  }),
                            }}
                          />
                        </div>
                      );
                    })}
                  </Virtualizer>
                )}
              </>
            ) : (
              <div className="flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      diffWordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
