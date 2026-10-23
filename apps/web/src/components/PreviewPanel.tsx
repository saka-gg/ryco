import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { File as DiffsFile } from "@pierre/diffs/react";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  formatFileReferenceTitle,
  normalizeFileReferencePath,
} from "@ryco/client-runtime/state/composer";
import { useParams, useSearch } from "@tanstack/react-router";
import { Schema } from "effect";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  TextWrapIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { parsePreviewRouteSearch } from "../previewRouteSearch";
import {
  fnv1a32,
  GUTTER_UTILITY_UNSAFE_CSS,
  NEUTRAL_LINE_SELECTION_UNSAFE_CSS,
  PLAIN_ANNOTATION_UNSAFE_CSS,
  resolveDiffThemeName,
  SYNTAX_TOKENIZE_MAX_LINE_LENGTH,
} from "../lib/diffRendering";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useProjectListEntries, useProjectReadFile } from "~/rpc/useProjectPreview";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef } from "../threadRoutes";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { TurnDiffSummary } from "../types";
import { useEvent } from "../hooks/useEvent";
import { endWorkspaceFileDrag, startWorkspaceFileDrag } from "../workspaceFileDrag";
import type { WorkspaceFileReveal } from "../workspaceRouteSearch";
import { ChangedFilesTree } from "./chat/ChangedFilesTree";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import {
  fileContentsReference,
  fileLineSelection,
  fileLineSelectionRange,
} from "./fileReferences/fileReferenceSelection";
import { FileReferenceNoteComposer } from "./fileReferences/FileReferenceNoteComposer";
import { useFileReferencePicker } from "./fileReferences/useFileReferencePicker";
import { revealFileLine, waitForDiffLayout } from "./pullRequests/files/diffReveal";
import { PreviewFileEditor } from "./PreviewFileEditor";
import { PREVIEW_FILE_UNSAFE_CSS } from "./PreviewFileStyles";
import { createPreviewFileDocument, isPreviewFileSessionDirty } from "./PreviewFileEditSession";
import {
  getPreviewFileSession,
  readPreviewFileSession,
  retainedPreviewFilePath,
} from "./previewFileSessions";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { cn } from "~/lib/utils";
import {
  detectPreviewFileKind,
  filterPreviewProjectEntries,
  inferPreviewLanguage,
  resolvePreviewImageSource,
} from "./PreviewPanel.logic";
import { PreviewImage } from "./PreviewImage";

const subscribeNoSession = () => () => {};
const readNoSession = () => null;

const PREVIEW_TREE_WIDTH_STORAGE_KEY = "chat_preview_tree_width";
const PREVIEW_TREE_MIN_WIDTH = 220;
const PREVIEW_TREE_DEFAULT_WIDTH = 280;
const PREVIEW_TREE_MAX_RATIO = 0.55;
const PREVIEW_CODE_CSS = `
.preview-panel-diffs-file {
  display: block;
  min-height: 100%;
  padding: 0.75rem;
  background-color: color-mix(in srgb, var(--card) 90%, var(--background));
}

.preview-panel-file-card {
  container-type: inline-size;
}

@container (max-width: 360px) {
  .preview-panel-file-toolbar {
    flex-wrap: wrap;
    gap: 0.25rem;
    padding-block: 0.375rem;
  }

  .preview-panel-file-identity {
    flex-basis: 100%;
  }

  .preview-panel-file-actions {
    margin-left: auto;
  }
}
`;

function clampTreeWidth(width: number, containerWidth: number): number {
  const maxWidth = Math.max(
    PREVIEW_TREE_MIN_WIDTH,
    Math.floor(containerWidth * PREVIEW_TREE_MAX_RATIO),
  );
  return Math.max(PREVIEW_TREE_MIN_WIDTH, Math.min(width, maxWidth));
}

function getResizedTreeWidth(
  resizeState: { startWidth: number; startX: number },
  containerWidth: number,
  pointerClientX: number,
): number {
  const delta = resizeState.startX - pointerClientX;
  return clampTreeWidth(resizeState.startWidth + delta, containerWidth);
}

function isMissingWorkspaceFileError(message: string | null): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes("enoent") ||
    normalized.includes("no such file") ||
    normalized.includes("file not found") ||
    normalized.includes("cannot find the file")
  );
}

function buildPreviewFileCacheKey(filePath: string, contents: string): string {
  return `preview:${filePath}:${contents.length}:${fnv1a32(contents).toString(36)}`;
}

const EMPTY_TURN_DIFF_SUMMARIES: readonly TurnDiffSummary[] = [];
const NO_FILE_ANNOTATIONS: LineAnnotation[] = [];

/** The line a deep link marks in its file; `token` lets the same link reveal again. */
interface PreviewLineReveal {
  readonly path: string;
  readonly line: number;
  readonly token: number;
}

/** The scrolling element between a rendered file and the card that holds it. */
function scrollParentWithin(element: Element, boundary: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== boundary; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

function PreviewTreeMotionFrame(props: {
  children: ReactNode;
  open: boolean;
  resizing: boolean;
  width: number;
}) {
  const [entered, setEntered] = useState(props.open);

  useEffect(() => {
    if (!props.open) {
      setEntered(false);
      return;
    }
    const frameId = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frameId);
  }, [props.open]);

  const active = props.open && entered;

  return (
    <div
      data-preview-file-rail
      aria-hidden={props.open ? undefined : true}
      inert={props.open ? undefined : true}
      className={cn(
        "min-h-0 shrink-0 overflow-hidden bg-card/20",
        props.open ? "border-l border-border/70" : "border-l-0",
        props.resizing
          ? "transition-none"
          : "transition-[width,opacity] duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
        props.open ? "opacity-100" : "opacity-0",
      )}
      style={{
        width: props.open ? `${props.width}px` : "0px",
        maxWidth: "55%",
      }}
    >
      <div
        className={cn(
          "h-full min-h-0 transition-[translate,opacity] duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-transform motion-reduce:transition-none",
          props.resizing ? "transition-none" : null,
          active ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0",
        )}
        style={{ width: `${props.width}px`, maxWidth: "100%" }}
      >
        {props.children}
      </div>
    </div>
  );
}

function PreviewOpenFileEmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center px-5 text-center">
      <div className="flex max-w-xs flex-col items-center gap-3">
        <FolderOpenIcon className="size-8 text-muted-foreground/65" />
        <div className="space-y-1.5">
          <div className="text-sm font-semibold text-foreground">Open file</div>
          <div className="text-xs leading-5 text-muted-foreground/70">
            Select a file from the workspace tree.
          </div>
        </div>
      </div>
    </div>
  );
}

interface PreviewPanelProps {
  mode?: DiffPanelMode;
  /** A one-shot deep link (an agent's file link): open this file, at a line when it names one. */
  reveal?: WorkspaceFileReveal | null | undefined;
  /** The reveal was acted on; the caller clears it so a repeat link fires again. */
  onRevealHandled?: (() => void) | undefined;
}

export default function PreviewPanel({
  mode = "inline",
  reveal = null,
  onRevealHandled,
}: PreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  // Phone work surface: the two-pane tree+preview split becomes a single-pane
  // push — the tree renders full-width and selecting a file pushes a
  // full-width file view with a back-to-tree affordance. Tree data, filter,
  // and file loading logic are shared with the desktop presentations.
  const isPhonePresentation = mode === "phone";
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeDraftId = useParams({
    strict: false,
    select: (params) => (typeof params.draftId === "string" ? DraftId.make(params.draftId) : null),
  });
  const previewSearch = useSearch({
    strict: false,
    select: (search) => parsePreviewRouteSearch(search),
  });
  const serverThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const draftThread = useComposerDraftStore((store) => {
    if (serverThread) return null;
    if (routeDraftId) return store.getDraftSession(routeDraftId);
    if (routeThreadRef) return store.getDraftThreadByRef(routeThreadRef);
    return null;
  });
  const activeThread = useMemo(() => {
    if (serverThread) {
      return {
        id: serverThread.id,
        environmentId: serverThread.environmentId,
        projectId: serverThread.projectId,
        worktreePath: serverThread.worktreePath,
        turnDiffSummaries: serverThread.turnDiffSummaries,
      };
    }
    if (draftThread) {
      return {
        id: draftThread.threadId,
        environmentId: draftThread.environmentId,
        projectId: draftThread.projectId,
        worktreePath: draftThread.worktreePath,
        turnDiffSummaries: EMPTY_TURN_DIFF_SUMMARIES,
      };
    }
    return undefined;
  }, [serverThread, draftThread]);
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeThread && activeProjectId
      ? selectProjectByRef(store, {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        })
      : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const activeEnvironmentId = activeThread?.environmentId ?? null;
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadRef = useMemo(
    () =>
      activeEnvironmentId && activeThreadId
        ? scopeThreadRef(activeEnvironmentId, activeThreadId)
        : null,
    [activeEnvironmentId, activeThreadId],
  );
  // "Add to chat" from the gutter; the frozen phone tier does not get it.
  const fileReferencePicker = useFileReferencePicker(isPhonePresentation ? null : activeThreadRef);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  // The thread and folder the selection below was last reset for. A deep
  // link waits until the reset for its own thread has applied: the panel is
  // not keyed per thread, and opening against the previous thread's
  // selection would find its file "already open" and never open it.
  const selectionScopeKey =
    activeEnvironmentId && activeThreadId && activeCwd
      ? `${isPhonePresentation ? "phone" : "wide"}\u0000${activeEnvironmentId}\u0000${activeThreadId}\u0000${activeCwd}`
      : null;
  const [selectionScope, setSelectionScope] = useState<string | null>(null);
  // The file a deep link opened. The listing leaves files out (ignored and
  // gitignored folders, past its entry cap, untracked files while it is still
  // the quick build), so for this file the read decides whether it exists.
  const linkedFilePathRef = useRef<string | null>(null);
  // Set only as its file opens, and replaced by every later open: a deep
  // link marks its line while that file stays open, never on a return to it.
  const [lineReveal, setLineReveal] = useState<PreviewLineReveal | null>(null);
  const fileCardRef = useRef<HTMLDivElement | null>(null);
  const [recoveryAction, setRecoveryAction] = useState<"reload" | "discard" | "overwrite" | null>(
    null,
  );
  // A file waiting on the unsaved-draft prompt, with the line a deep link
  // asked for; cancelling drops both.
  const [pendingNavigation, setPendingNavigation] = useState<{
    readonly path: string;
    readonly lineReveal: PreviewLineReveal | null;
  } | null>(null);
  const pendingFilePath = pendingNavigation?.path ?? null;
  const [fileFilterQuery, setFileFilterQuery] = useState("");
  const [isTreeVisible, setIsTreeVisible] = useState(true);
  // Same readability rationale as the phone diff surface: 320-430px columns
  // are unreadable with horizontal code scroll, so wrap defaults on for the
  // phone presentation only; desktop keeps the settings-driven default.
  const [wrapPreviewLines, setWrapPreviewLines] = useState(
    isPhonePresentation ? true : settings.diffWordWrap,
  );
  const splitLayoutRef = useRef<HTMLDivElement | null>(null);
  const [treeWidth, setTreeWidth] = useState(() => {
    if (typeof window === "undefined") {
      return PREVIEW_TREE_DEFAULT_WIDTH;
    }
    return (
      getLocalStorageItem(PREVIEW_TREE_WIDTH_STORAGE_KEY, Schema.Finite) ??
      PREVIEW_TREE_DEFAULT_WIDTH
    );
  });
  const [isTreeResizing, setIsTreeResizing] = useState(false);
  const resizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const previousPreviewOpenRef = useRef(previewSearch.preview === "1");
  // A deep link opens its file once: the route key is cleared as soon as it
  // is read.
  const handledRevealRef = useRef<WorkspaceFileReveal | null>(null);
  const previousProjectFilesRefreshKeyRef = useRef<string | null>(null);
  const previousSelectedFileRefreshKeyRef = useRef<string | null>(null);
  const missingFileRefreshKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setWrapPreviewLines(isPhonePresentation ? true : settings.diffWordWrap);
  }, [isPhonePresentation, settings.diffWordWrap]);

  useEffect(() => {
    setSelectedFilePath(
      !isPhonePresentation && activeThread?.environmentId && activeCwd
        ? retainedPreviewFilePath({ environmentId: activeThread.environmentId, cwd: activeCwd })
        : null,
    );
    setLineReveal(null);
    setPendingNavigation(null);
    setRecoveryAction(null);
    setIsTreeVisible(true);
    linkedFilePathRef.current = null;
    setSelectionScope(selectionScopeKey);
  }, [
    activeCwd,
    activeThread?.environmentId,
    activeThread?.id,
    isPhonePresentation,
    selectionScopeKey,
  ]);

  const latestProjectFilesRefreshKey = useMemo(() => {
    const latestChangedSummary = (activeThread?.turnDiffSummaries ?? [])
      .toReversed()
      .find((summary) => summary.files.length > 0);
    return latestChangedSummary
      ? `${latestChangedSummary.turnId}:${latestChangedSummary.completedAt}`
      : null;
  }, [activeThread?.turnDiffSummaries]);

  const latestSelectedFileRefreshKey = useMemo(() => {
    if (!selectedFilePath) return null;
    const latestSelectedFileSummary = (activeThread?.turnDiffSummaries ?? [])
      .toReversed()
      .find((summary) => summary.files.some((file) => file.path === selectedFilePath));
    return latestSelectedFileSummary
      ? `${latestSelectedFileSummary.turnId}:${latestSelectedFileSummary.completedAt}`
      : null;
  }, [activeThread?.turnDiffSummaries, selectedFilePath]);

  const projectFilesQuery = useProjectListEntries({
    environmentId: activeThread?.environmentId ?? null,
    cwd: activeCwd,
    enabled: Boolean(activeThread?.environmentId && activeCwd && previewSearch.preview === "1"),
  });
  const projectFilesError =
    projectFilesQuery.error instanceof Error
      ? projectFilesQuery.error.message
      : projectFilesQuery.error
        ? "Failed to load the workspace tree."
        : null;
  const projectFiles = projectFilesQuery.data;
  const projectFilesTruncated = projectFilesQuery.data?.truncated === true;
  const projectFilesIsFetching = projectFilesQuery.isFetching;
  const refetchProjectFiles = projectFilesQuery.refetch;
  const filteredProjectFiles = useMemo(
    () => filterPreviewProjectEntries(projectFiles?.entries ?? [], fileFilterQuery),
    [fileFilterQuery, projectFiles?.entries],
  );
  const isFilteringProjectFiles = fileFilterQuery.trim().length > 0;

  useEffect(() => {
    if (!projectFiles || !selectedFilePath) return;
    const entry = projectFiles.entries.find((file) => file.path === selectedFilePath);
    // A deep link can name a folder: the tree shows it, a read would only fail.
    if (entry?.kind === "directory") {
      setSelectedFilePath(null);
      setFileFilterQuery(selectedFilePath);
      setIsTreeVisible(true);
      return;
    }
    if (entry || selectedFilePath === linkedFilePathRef.current) return;
    const retained =
      activeThread?.environmentId && activeCwd
        ? readPreviewFileSession(
            { environmentId: activeThread.environmentId, cwd: activeCwd },
            selectedFilePath,
          )
        : null;
    if (!retained?.unsaved) setSelectedFilePath(null);
  }, [activeCwd, activeThread?.environmentId, projectFiles, selectedFilePath]);

  useEffect(() => {
    if (previewSearch.preview !== "1") {
      previousProjectFilesRefreshKeyRef.current = latestProjectFilesRefreshKey;
      return;
    }
    if (previousProjectFilesRefreshKeyRef.current === null) {
      previousProjectFilesRefreshKeyRef.current = latestProjectFilesRefreshKey;
      return;
    }
    if (previousProjectFilesRefreshKeyRef.current === latestProjectFilesRefreshKey) {
      return;
    }
    previousProjectFilesRefreshKeyRef.current = latestProjectFilesRefreshKey;
    void refetchProjectFiles();
  }, [latestProjectFilesRefreshKey, previewSearch.preview, refetchProjectFiles]);

  useEffect(() => {
    const previewOpen = previewSearch.preview === "1";
    // Reopening starts at the tree, unless a link opened the panel: the link
    // picks the file, and it would find the file left open before the panel
    // closed "already open" against this reset and land on the tree.
    const linkPending =
      !isPhonePresentation && reveal !== null && handledRevealRef.current !== reveal;
    if (previewOpen && !previousPreviewOpenRef.current && !linkPending) {
      setSelectedFilePath(null);
    }
    previousPreviewOpenRef.current = previewOpen;
  }, [isPhonePresentation, previewSearch.preview, reveal]);

  // Raster images read through the binary API; the text read would always be
  // rejected for them. Oversized files are refused by the server with a
  // message, since workspace entries carry no size metadata.
  const selectedImageSource = selectedFilePath ? resolvePreviewImageSource(selectedFilePath) : null;

  const selectedFileQuery = useProjectReadFile({
    environmentId: activeThread?.environmentId ?? null,
    cwd: activeCwd,
    relativePath: selectedFilePath,
    enabled: Boolean(
      activeThread?.environmentId &&
      activeCwd &&
      selectedFilePath &&
      previewSearch.preview === "1" &&
      selectedImageSource !== "raster",
    ),
  });
  const selectedFileData =
    selectedFileQuery.data?.relativePath === selectedFilePath ? selectedFileQuery.data : null;
  const selectedFileKind = selectedFilePath
    ? detectPreviewFileKind({ filePath: selectedFilePath })
    : "text";
  const selectedFileError =
    selectedFileQuery.error instanceof Error
      ? selectedFileQuery.error.message
      : selectedFileQuery.error
        ? "Failed to load file preview."
        : null;
  const refetchSelectedFile = selectedFileQuery.refetch;

  useEffect(() => {
    if (!selectedFilePath || previewSearch.preview !== "1") {
      previousSelectedFileRefreshKeyRef.current = latestSelectedFileRefreshKey;
      return;
    }
    if (previousSelectedFileRefreshKeyRef.current === null) {
      previousSelectedFileRefreshKeyRef.current = latestSelectedFileRefreshKey;
      return;
    }
    if (previousSelectedFileRefreshKeyRef.current === latestSelectedFileRefreshKey) {
      return;
    }
    previousSelectedFileRefreshKeyRef.current = latestSelectedFileRefreshKey;
    void refetchSelectedFile();
  }, [latestSelectedFileRefreshKey, previewSearch.preview, refetchSelectedFile, selectedFilePath]);

  const selectedFileDocument = useMemo(() => {
    if (
      !activeThread?.environmentId ||
      !activeCwd ||
      !selectedFileData ||
      selectedFileData.relativePath !== selectedFilePath
    ) {
      return null;
    }
    return createPreviewFileDocument(
      { environmentId: activeThread.environmentId, cwd: activeCwd },
      selectedFileData,
    );
  }, [activeCwd, activeThread?.environmentId, selectedFileData, selectedFilePath]);

  const sessionOwner = useMemo(() => {
    if (isPhonePresentation || !activeThread?.environmentId || !activeCwd || !selectedFilePath)
      return null;
    const scope = { environmentId: activeThread.environmentId, cwd: activeCwd };
    const existing = readPreviewFileSession(scope, selectedFilePath);
    if (existing) return existing;
    return selectedFileDocument && selectedFileKind === "text"
      ? getPreviewFileSession(scope, selectedFileDocument)
      : null;
  }, [
    activeCwd,
    activeThread?.environmentId,
    isPhonePresentation,
    selectedFileDocument,
    selectedFileKind,
    selectedFilePath,
  ]);
  const currentEditSession = useSyncExternalStore(
    sessionOwner?.subscribe ?? subscribeNoSession,
    sessionOwner?.getSnapshot ?? readNoSession,
  );
  useEffect(() => {
    if (selectedFileDocument) sessionOwner?.load(selectedFileDocument);
  }, [sessionOwner, selectedFileDocument]);
  const hasUnsavedChanges = isPreviewFileSessionDirty(currentEditSession);
  const isSelectedFileEditable = Boolean(
    !isPhonePresentation &&
    selectedFileKind === "text" &&
    currentEditSession &&
    currentEditSession.lineEnding !== "mixed" &&
    currentEditSession.diskState === "known",
  );
  const selectionGeneration = useRef(0);
  useEffect(() => {
    selectionGeneration.current++;
    return () => {
      selectionGeneration.current++;
    };
  }, [sessionOwner]);

  // Opens a file the way a tree click does: an unsaved draft asks first. A
  // deep link's line is marked only once its file is the one open.
  const openFile = useCallback(
    async (filePath: string, nextLineReveal: PreviewLineReveal | null) => {
      if (filePath === selectedFilePath) {
        setLineReveal(nextLineReveal);
        return;
      }
      const generation = ++selectionGeneration.current;
      if (sessionOwner?.unsaved && !(await sessionOwner.flush())) {
        if (generation === selectionGeneration.current) {
          setPendingNavigation({ path: filePath, lineReveal: nextLineReveal });
        }
        return;
      }
      if (generation !== selectionGeneration.current) return;
      setSelectedFilePath(filePath);
      setLineReveal(nextLineReveal);
    },
    [selectedFilePath, sessionOwner],
  );
  // Every other open drops the mark, so coming back does not replay the link.
  const onSelectFile = useCallback((filePath: string) => openFile(filePath, null), [openFile]);

  const revealTokenRef = useRef(0);
  useEffect(() => {
    if (!reveal || handledRevealRef.current === reveal) return;
    if (previewSearch.preview !== "1" || !activeThread?.environmentId || !activeCwd) return;
    // Wait for the selection of the thread the link opened, so `openFile`
    // compares against that thread's open file.
    if (selectionScopeKey === null || selectionScope !== selectionScopeKey) return;
    handledRevealRef.current = reveal;
    onRevealHandled?.();
    // The frozen phone tier keeps landing on the tree.
    if (isPhonePresentation) return;
    if (
      projectFiles?.entries.some(
        (entry) => entry.path === reveal.path && entry.kind === "directory",
      )
    ) {
      // A folder shows in the tree; the open file stays as it is.
      setFileFilterQuery(reveal.path);
      setIsTreeVisible(true);
      return;
    }
    revealTokenRef.current += 1;
    linkedFilePathRef.current = reveal.path;
    void openFile(
      reveal.path,
      reveal.line === undefined
        ? null
        : { path: reveal.path, line: reveal.line, token: revealTokenRef.current },
    );
  }, [
    activeCwd,
    activeThread?.environmentId,
    isPhonePresentation,
    onRevealHandled,
    openFile,
    previewSearch.preview,
    projectFiles,
    reveal,
    selectionScope,
    selectionScopeKey,
  ]);

  const onEditContentsChange = useCallback(
    (contents: string) => sessionOwner?.change(contents),
    [sessionOwner],
  );
  const onDiscardFileChanges = useCallback(() => setRecoveryAction("discard"), []);
  const reloadSelectedFile = useCallback(() => setRecoveryAction("reload"), []);
  const saveSelectedFile = useCallback(
    () => sessionOwner?.flush(true) ?? Promise.resolve(false),
    [sessionOwner],
  );

  useEffect(() => {
    if (!selectedFilePath || !isMissingWorkspaceFileError(selectedFileError)) {
      missingFileRefreshKeyRef.current = null;
      return;
    }
    const refreshKey = `${activeCwd}\u0000${selectedFilePath}\u0000${selectedFileError}`;
    if (missingFileRefreshKeyRef.current === refreshKey) return;
    missingFileRefreshKeyRef.current = refreshKey;
    const generation = selectionGeneration.current;
    void refetchProjectFiles()
      .then((result) => {
        if (generation !== selectionGeneration.current) return;
        if (!result.data?.entries.some((entry) => entry.path === selectedFilePath)) {
          if (sessionOwner?.unsaved) sessionOwner.markDeleted();
          else setSelectedFilePath(null);
        }
      })
      .catch(() => undefined);
  }, [activeCwd, refetchProjectFiles, selectedFileError, selectedFilePath, sessionOwner]);

  const saveIsBlocked =
    currentEditSession?.saveStatus === "conflict" ||
    currentEditSession?.errorReason === "unsupported";
  const canSaveSelectedFile = Boolean(
    isSelectedFileEditable &&
    sessionOwner?.unsaved &&
    currentEditSession?.saveStatus !== "saving" &&
    !saveIsBlocked,
  );

  useEffect(() => {
    if (!isSelectedFileEditable || !hasUnsavedChanges) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (canSaveSelectedFile) void saveSelectedFile();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [canSaveSelectedFile, hasUnsavedChanges, isSelectedFileEditable, saveSelectedFile]);

  const previewTextFile = useMemo(() => {
    const contents = currentEditSession?.contents ?? selectedFileData?.contents;
    if (!selectedFilePath || selectedFileKind !== "text" || contents === undefined) {
      return null;
    }

    return {
      name: selectedFilePath,
      contents,
      lang: inferPreviewLanguage(selectedFilePath),
      cacheKey: buildPreviewFileCacheKey(selectedFilePath, contents),
    };
  }, [
    currentEditSession?.contents,
    selectedFileData?.contents,
    selectedFileKind,
    selectedFilePath,
  ]);
  // Offered only for a file a reference can name.
  const canPickLines =
    fileReferencePicker.available &&
    selectedFilePath !== null &&
    normalizeFileReferencePath(selectedFilePath) !== null;
  // Stable, so the renderer's options change only when the `+` comes or goes.
  const onGutterPick = useEvent((range: SelectedLineRange) => {
    if (!selectedFilePath) return;
    // The pick's range takes over from a deep link's mark.
    setLineReveal(null);
    fileReferencePicker.open(selectedFilePath, fileLineSelection(selectedFilePath, range));
  });
  const previewFileOptions = useMemo(
    () => ({
      disableFileHeader: true,
      overflow: wrapPreviewLines ? ("wrap" as const) : ("scroll" as const),
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      unsafeCSS: `${PREVIEW_FILE_UNSAFE_CSS}${NEUTRAL_LINE_SELECTION_UNSAFE_CSS}${PLAIN_ANNOTATION_UNSAFE_CSS}${GUTTER_UTILITY_UNSAFE_CSS}`,
      tokenizeMaxLineLength: SYNTAX_TOKENIZE_MAX_LINE_LENGTH,
      ...(canPickLines ? { enableGutterUtility: true, onGutterUtilityClick: onGutterPick } : {}),
    }),
    [canPickLines, onGutterPick, resolvedTheme, wrapPreviewLines],
  );
  const filePick =
    fileReferencePicker.pick && fileReferencePicker.pick.fileKey === selectedFilePath
      ? fileReferencePicker.pick
      : null;
  const revealedLine = lineReveal && lineReveal.path === selectedFilePath ? lineReveal : null;
  // An open pick shows its range; otherwise a deep link's line stays marked.
  const previewSelectedLines = useMemo<SelectedLineRange | null>(
    () =>
      filePick
        ? fileLineSelectionRange(filePick.selection)
        : revealedLine
          ? { start: revealedLine.line, end: revealedLine.line }
          : null,
    [filePick, revealedLine],
  );
  const previewLineAnnotations = useMemo(
    () => (filePick ? [{ lineNumber: filePick.selection.lineEnd }] : NO_FILE_ANNOTATIONS),
    [filePick],
  );
  const renderPreviewAnnotation = () =>
    filePick ? (
      <FileReferenceNoteComposer
        key={filePick.id}
        title={formatFileReferenceTitle(filePick.selection)}
        restoreComment={fileReferencePicker.restoreComment}
        onCommentChange={fileReferencePicker.rememberComment}
        onCancel={fileReferencePicker.cancel}
        onAdd={(comment) =>
          fileReferencePicker.add(
            fileContentsReference({
              // What the view shows, unsaved edits included.
              contents: currentEditSession?.contents ?? selectedFileData?.contents ?? "",
              selection: filePick.selection,
              comment,
            }),
          )
        }
      />
    ) : null;

  // Scroll a deep link's line into view once its file has rendered.
  const fileViewReady = previewTextFile !== null || isSelectedFileEditable;
  const revealedTokenRef = useRef<number | null>(null);
  useEffect(() => {
    const card = fileCardRef.current;
    if (!revealedLine || !fileViewReady || !card) return;
    if (revealedTokenRef.current === revealedLine.token) return;
    const controller = new AbortController();
    void (async () => {
      if (!(await waitForDiffLayout(card, controller.signal))) return;
      const container = card.querySelector("diffs-container");
      const scroller = container ? scrollParentWithin(container, card) : null;
      if (!scroller || controller.signal.aborted) return;
      const element = await revealFileLine({
        scroller,
        fileElement: card,
        line: revealedLine.line,
        signal: controller.signal,
      });
      if (element) revealedTokenRef.current = revealedLine.token;
    })();
    return () => controller.abort();
  }, [fileViewReady, revealedLine]);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !isTreeVisible) return;
      const renderedTreeWidth =
        splitLayoutRef.current
          ?.querySelector<HTMLElement>("[data-preview-file-rail]")
          ?.getBoundingClientRect().width ?? treeWidth;
      resizeStateRef.current = {
        pointerId: event.pointerId,
        startWidth: renderedTreeWidth,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsTreeResizing(true);
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
    },
    [isTreeVisible, treeWidth],
  );

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;
    const container = splitLayoutRef.current;
    if (!resizeState || !container || resizeState.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const nextWidth = getResizedTreeWidth(resizeState, container.clientWidth, event.clientX);
    setTreeWidth(nextWidth);
  }, []);

  const onResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    const container = splitLayoutRef.current;
    const nextWidth = container
      ? getResizedTreeWidth(resizeState, container.clientWidth, event.clientX)
      : resizeState.startWidth;
    resizeStateRef.current = null;
    setIsTreeResizing(false);
    setTreeWidth(nextWidth);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    if (typeof window !== "undefined") {
      setLocalStorageItem(PREVIEW_TREE_WIDTH_STORAGE_KEY, nextWidth, Schema.Finite);
    }
  }, []);

  useEffect(
    () => () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [],
  );

  const onRefreshProjectFiles = useCallback(() => {
    void refetchProjectFiles();
  }, [refetchProjectFiles]);

  const onToggleTreeVisibility = useCallback(() => {
    if (isTreeVisible) {
      resizeStateRef.current = null;
      setIsTreeResizing(false);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    }
    setIsTreeVisible((current) => !current);
  }, [isTreeVisible]);

  const unsavedDialogOpen = pendingFilePath !== null;
  const cancelUnsavedNavigation = useCallback(() => setPendingNavigation(null), []);
  const finishUnsavedNavigation = useCallback(() => {
    setSelectedFilePath(pendingNavigation?.path ?? null);
    setLineReveal(pendingNavigation?.lineReveal ?? null);
    setPendingNavigation(null);
  }, [pendingNavigation]);
  const continueUnsavedNavigation = useCallback(async () => {
    const generation = selectionGeneration.current;
    if (sessionOwner && !(await sessionOwner.discard())) return;
    if (generation !== selectionGeneration.current) return;
    finishUnsavedNavigation();
  }, [finishUnsavedNavigation, sessionOwner]);
  const saveAndContinueNavigation = useCallback(async () => {
    const generation = selectionGeneration.current;
    if (!(await saveSelectedFile()) || generation !== selectionGeneration.current) return;
    finishUnsavedNavigation();
  }, [finishUnsavedNavigation, saveSelectedFile]);
  const confirmRecovery = async () => {
    const owner = sessionOwner;
    const generation = selectionGeneration.current;
    const action = recoveryAction;
    setRecoveryAction(null);
    if (!owner) return;
    if (action === "reload") await owner.reload();
    else if (action === "overwrite") await owner.flush(true, true);
    else if (action === "discard") {
      const deleted = owner.getSnapshot().errorReason === "deleted";
      if ((await owner.discard()) && deleted && generation === selectionGeneration.current)
        setSelectedFilePath(null);
    }
  };

  // Tree rows drag out as workspace files; the composer takes them as mentions.
  const onTreeFileDragStart = useMemo(() => {
    if (isPhonePresentation || !activeEnvironmentId || !activeCwd) return undefined;
    return (path: string, transfer: DataTransfer) =>
      startWorkspaceFileDrag(transfer, {
        environmentId: activeEnvironmentId,
        workspaceRoot: activeCwd,
        path,
      });
  }, [activeCwd, activeEnvironmentId, isPhonePresentation]);

  const headerRow = (
    <>
      <div className="min-w-0 flex-1 px-1 [-webkit-app-region:no-drag]">
        <div className="truncate text-sm font-medium text-foreground">File Preview</div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Workspace tree</span>
          {projectFilesTruncated ? (
            <Badge variant="warning" size="sm" className="rounded-md px-1.5 py-0 text-[9px]">
              Truncated
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {/* Single-pane phone push has no side-by-side tree to hide. */}
        {isPhonePresentation ? null : (
          <Button
            aria-label={isTreeVisible ? "Hide workspace tree" : "Show workspace tree"}
            aria-pressed={isTreeVisible}
            title={isTreeVisible ? "Hide workspace tree" : "Show workspace tree"}
            variant="outline"
            size="icon-xs"
            className="shrink-0"
            onClick={onToggleTreeVisibility}
          >
            {isTreeVisible ? (
              <PanelRightCloseIcon className="size-3" />
            ) : (
              <PanelRightOpenIcon className="size-3" />
            )}
          </Button>
        )}
        <Button
          aria-label="Refresh workspace tree"
          title="Refresh workspace tree"
          variant="outline"
          size="icon-xs"
          className="shrink-0"
          disabled={!activeThread?.environmentId || !activeCwd || projectFilesIsFetching}
          onClick={onRefreshProjectFiles}
        >
          <RefreshCwIcon className={cn("size-3", projectFilesIsFetching && "animate-spin")} />
        </Button>
        <Toggle
          aria-label={
            wrapPreviewLines ? "Disable preview line wrapping" : "Enable preview line wrapping"
          }
          title={wrapPreviewLines ? "Disable line wrapping" : "Enable line wrapping"}
          variant="outline"
          size="xs"
          pressed={wrapPreviewLines}
          onPressedChange={(pressed) => {
            setWrapPreviewLines(Boolean(pressed));
          }}
        >
          <TextWrapIcon className="size-3" />
        </Toggle>
      </div>
    </>
  );

  const selectedFileView =
    selectedFileQuery.isLoading && !selectedFileData && !currentEditSession ? (
      <DiffPanelLoadingState label="Loading file preview..." />
    ) : selectedFileError && !selectedFileData && !currentEditSession ? (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        {selectedFileError}
      </div>
    ) : (
      <div className="min-h-0 flex-1 p-2">
        <style>{PREVIEW_CODE_CSS}</style>
        <div
          ref={fileCardRef}
          className="preview-panel-file-card flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/70 bg-[color:color-mix(in_srgb,var(--card)_90%,var(--background))]"
        >
          <div className="preview-panel-file-toolbar flex min-h-10 shrink-0 items-center gap-3 border-b border-border/70 bg-[color:color-mix(in_srgb,var(--card)_94%,var(--foreground))] px-3 py-1.5 text-foreground">
            <div className="preview-panel-file-identity flex min-w-0 flex-1 items-center gap-2">
              <div className="truncate font-mono text-[12px] font-medium">{selectedFilePath}</div>
              {hasUnsavedChanges ? (
                <span
                  aria-label="Unsaved changes"
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                  title="Unsaved changes"
                />
              ) : null}
              {currentEditSession?.saveStatus === "saving" ? (
                <span
                  aria-live="polite"
                  className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
                >
                  <LoaderCircleIcon className="size-3 animate-spin" /> Saving
                </span>
              ) : null}
              {!isPhonePresentation && selectedFileDocument?.lineEnding === "mixed" ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  Read-only · mixed line endings
                </span>
              ) : null}
            </div>
            {!isPhonePresentation &&
            currentEditSession &&
            (isSelectedFileEditable || sessionOwner?.unsaved) ? (
              <div className="preview-panel-file-actions flex shrink-0 items-center gap-1">
                <Button
                  aria-label="Discard file changes"
                  disabled={!sessionOwner?.unsaved}
                  onClick={onDiscardFileChanges}
                  size="xs"
                  variant="ghost"
                >
                  Discard
                </Button>
                <Button
                  aria-label="Save file"
                  disabled={!canSaveSelectedFile}
                  onClick={() => void saveSelectedFile()}
                  size="xs"
                  title="Save file (Ctrl/⌘ S)"
                >
                  {currentEditSession.saveStatus === "saving" ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : (
                    <SaveIcon />
                  )}
                  Save
                  <span className="ml-0.5 text-[9px] opacity-70">⌘S</span>
                </Button>
              </div>
            ) : null}
          </div>
          {currentEditSession?.diskState === "unknown" ? (
            <div
              role="status"
              className="flex items-center gap-2 border-b border-border p-3 text-xs"
            >
              Draft discarded. Reload to read the current disk contents.
              <Button size="xs" variant="outline" onClick={reloadSelectedFile}>
                Reload
              </Button>
            </div>
          ) : null}
          {currentEditSession?.errorMessage ? (
            <div className="shrink-0 border-b border-border/60 p-2">
              <Alert
                variant={currentEditSession.saveStatus === "conflict" ? "warning" : "error"}
                className="rounded-lg px-3 py-2 text-[11px]"
              >
                {currentEditSession.saveStatus === "conflict" ? (
                  <TriangleAlertIcon className="size-3.5" />
                ) : (
                  <CircleAlertIcon className="size-3.5" />
                )}
                <AlertTitle className="text-[11px]">
                  {currentEditSession.errorReason === "deleted"
                    ? "File removed on disk"
                    : currentEditSession.saveStatus === "conflict"
                      ? "File changed on disk"
                      : "Couldn’t save file"}
                </AlertTitle>
                <AlertDescription className="gap-2 text-[11px] leading-4">
                  <span>{currentEditSession.errorMessage}</span>
                  <Button
                    className="self-start"
                    onClick={
                      currentEditSession.errorReason === "deleted"
                        ? onDiscardFileChanges
                        : () => void reloadSelectedFile()
                    }
                    size="xs"
                    variant="outline"
                  >
                    {currentEditSession.errorReason === "deleted" ? "Close file" : "Reload"}
                  </Button>

                  {currentEditSession.saveStatus === "conflict" &&
                  currentEditSession.errorReason !== "deleted" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setRecoveryAction("overwrite")}
                    >
                      Overwrite
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            </div>
          ) : selectedFileError ? (
            <div className="shrink-0 border-b border-border/60 px-3 py-2 text-[11px] text-destructive">
              Refresh failed: {selectedFileError}
            </div>
          ) : null}
          {selectedFileKind === "image" && selectedImageSource && selectedFilePath ? (
            <PreviewImage
              environmentId={activeThread?.environmentId ?? null}
              cwd={activeCwd}
              relativePath={selectedFilePath}
              source={selectedImageSource}
              svgContents={selectedFileData?.contents}
              refreshKey={latestSelectedFileRefreshKey}
            />
          ) : isSelectedFileEditable && currentEditSession ? (
            <PreviewFileEditor
              cacheKey={currentEditSession.key}
              className="preview-panel-diffs-file"
              contents={currentEditSession.contents}
              filePath={currentEditSession.relativePath}
              language={inferPreviewLanguage(currentEditSession.relativePath)}
              onChange={onEditContentsChange}
              options={previewFileOptions}
              lineAnnotations={previewLineAnnotations}
              renderAnnotation={renderPreviewAnnotation}
              selectedLines={previewSelectedLines}
            />
          ) : currentEditSession?.diskState === "unknown" ? null : previewTextFile ? (
            <div className="min-h-0 flex-1 overflow-auto">
              {/* Only this read-only view highlights through the worker pool;
                  the editor tokenizes on the main thread. */}
              <DiffWorkerPoolProvider>
                <DiffsFile
                  file={previewTextFile}
                  className="preview-panel-diffs-file"
                  options={previewFileOptions}
                  lineAnnotations={previewLineAnnotations}
                  renderAnnotation={renderPreviewAnnotation}
                  selectedLines={previewSelectedLines}
                />
              </DiffWorkerPoolProvider>
            </div>
          ) : (
            <pre
              className={cn(
                "min-h-0 flex-1 bg-transparent p-3 font-mono text-[11px] leading-5 text-muted-foreground/90",
                wrapPreviewLines
                  ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                  : "overflow-auto",
              )}
            >
              {selectedFileData?.contents ?? ""}
            </pre>
          )}
        </div>
      </div>
    );

  const treePane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 p-2">
        <label className="relative block">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/65" />
          <input
            type="text"
            value={fileFilterQuery}
            onChange={(event) => setFileFilterQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setFileFilterQuery("");
                event.currentTarget.blur();
              }
            }}
            placeholder="Filter files..."
            aria-label="Filter files"
            className="h-8 w-full rounded-md border border-border/70 bg-background/65 pl-8 pr-3 text-xs text-foreground outline-none transition-[border-color,background-color,box-shadow] placeholder:text-muted-foreground/55 focus:border-ring/60 focus:bg-background focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_18%,transparent)]"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {projectFilesError || projectFilesTruncated ? (
          <Alert
            variant={projectFilesError ? "error" : "warning"}
            className="mb-2 rounded-lg border-border/70 px-3 py-2 text-[11px]"
          >
            {projectFilesError ? (
              <CircleAlertIcon className="size-3.5" />
            ) : (
              <TriangleAlertIcon className="size-3.5" />
            )}
            <AlertTitle className="text-[11px]">
              {projectFilesError ? "Workspace tree refresh failed" : "Workspace tree is truncated"}
            </AlertTitle>
            <AlertDescription className="gap-1 text-[11px] leading-4">
              {projectFilesError ? (
                <span>{projectFilesError}</span>
              ) : (
                <span>
                  Only the first indexed workspace entries are shown here, so some files may be
                  omitted from preview.
                </span>
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        {filteredProjectFiles.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs leading-5 text-muted-foreground/70">
            No files match this filter.
          </div>
        ) : (
          <ChangedFilesTree
            files={filteredProjectFiles}
            allDirectoriesExpanded={isFilteringProjectFiles}
            resolvedTheme={resolvedTheme}
            onSelectFile={onSelectFile}
            selectedFilePath={selectedFilePath}
            showStats={false}
            onFileDragStart={onTreeFileDragStart}
            onFileDragEnd={endWorkspaceFileDrag}
          />
        )}
      </div>
    </div>
  );

  return (
    <>
      <DiffPanelShell mode={mode} header={headerRow}>
        {!activeThread ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            Select a thread to preview files.
          </div>
        ) : projectFilesQuery.isLoading && !projectFilesQuery.data ? (
          <DiffPanelLoadingState label="Loading project tree..." />
        ) : projectFilesError && !projectFilesQuery.data ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            {projectFilesError}
          </div>
        ) : (projectFilesQuery.data?.entries.length ?? 0) === 0 ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            No project files available yet.
          </div>
        ) : isPhonePresentation ? (
          // Single-pane phone arrangement: tree full-width, tapping a file
          // pushes a full-width file view with back-to-tree. A `preview=1` deep
          // link lands on the tree (the preview params carry no file path), so
          // the surface is never empty.
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {selectedFilePath ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border/60 px-1.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Back to workspace tree"
                    className="shrink-0"
                    onClick={() => setSelectedFilePath(null)}
                  >
                    <ArrowLeftIcon />
                  </Button>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {selectedFilePath}
                  </span>
                </div>
                {selectedFileView}
              </div>
            ) : (
              treePane
            )}
          </div>
        ) : (
          <div ref={splitLayoutRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <div
              data-preview-content-panel
              className="flex min-h-0 min-w-0 flex-1 flex-col transition-[min-width] duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
            >
              {!selectedFilePath ? <PreviewOpenFileEmptyState /> : selectedFileView}
            </div>
            <button
              type="button"
              aria-label="Resize workspace tree"
              aria-hidden={isTreeVisible ? undefined : true}
              className={cn(
                "group relative shrink-0 overflow-hidden bg-transparent transition-[width,opacity,background-color] duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent/40 motion-reduce:transition-none",
                isTreeVisible ? "w-2 cursor-ew-resize opacity-100" : "w-0 opacity-0",
              )}
              disabled={!isTreeVisible}
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerEnd}
              onPointerCancel={onResizePointerEnd}
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80 group-hover:bg-border" />
            </button>
            <PreviewTreeMotionFrame
              width={treeWidth}
              open={isTreeVisible}
              resizing={isTreeResizing}
            >
              {treePane}
            </PreviewTreeMotionFrame>
          </div>
        )}
      </DiffPanelShell>
      <AlertDialog
        open={recoveryAction !== null}
        onOpenChange={(open) => {
          if (!open) setRecoveryAction(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {recoveryAction === "overwrite"
                ? "Overwrite the disk file?"
                : recoveryAction === "reload"
                  ? "Reload from disk?"
                  : "Discard file changes?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {recoveryAction === "overwrite"
                ? "Replace the current disk contents with your draft. Another external edit will stop the write."
                : recoveryAction === "reload"
                  ? "Replace your draft with the latest disk contents. This cannot be undone."
                  : "Abandon your unsaved edits without writing the file. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setRecoveryAction(null)}>
              Cancel
            </Button>
            <Button variant="destructive-outline" onClick={() => void confirmRecovery()}>
              Confirm {recoveryAction}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={unsavedDialogOpen}
        onOpenChange={(open) => {
          if (!open) cancelUnsavedNavigation();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Save changes before continuing?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedFilePath
                ? `${selectedFilePath} has unsaved changes.`
                : "This file has unsaved changes."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button onClick={cancelUnsavedNavigation} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={currentEditSession?.saveStatus === "saving"}
              onClick={continueUnsavedNavigation}
              variant="destructive-outline"
            >
              {pendingFilePath ? "Discard & Open" : "Discard & Continue"}
            </Button>
            <Button
              disabled={!canSaveSelectedFile}
              onClick={() => void saveAndContinueNavigation()}
            >
              {currentEditSession?.saveStatus === "saving" ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <SaveIcon />
              )}
              {pendingFilePath ? "Save & Open" : "Save & Continue"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
