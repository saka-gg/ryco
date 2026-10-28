import {
  createWorkspaceContentSearch,
  DEFAULT_CONTENT_SEARCH_OPTIONS,
  normalizeWorkspaceFileSearchQuery,
  selectProjectContentSearchSupported,
  type ContentSearchOptions,
  type HighlightSegment,
  type WorkspaceContentSearch,
  type WorkspaceContentSearchSnapshot,
} from "@ryco/client-runtime/state/files";
import { WS_METHODS, type KeybindingCommand, type ServerConfig } from "@ryco/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useAppKeybindings } from "../../appKeybindings";
import { useCommandPaletteStore, type WorkspaceSearchMode } from "../../commandPaletteStore";
import { useComposerHandleContext } from "../../composerHandleContext";
import { ensureEnvironmentApi } from "../../environmentApi";
import { useEnvironmentServerConfigSelector } from "../../hooks/useChatsAvailability";
import { useRouteWorkspaceTarget } from "../../hooks/useRouteWorkspaceTarget";
import { useTheme } from "../../hooks/useTheme";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedHubStore } from "../../hostedHub/state";
import { hostedCapabilityCopy, hostedSwitchTargetLabel } from "../../hostedHub/switchTarget";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { useWorkspacePathSearch } from "../../rpc/useProject";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { buildOpenFilesSearch, type WorkspaceFileReveal } from "../../workspaceRouteSearch";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Button } from "../ui/button";
import {
  Command,
  CommandDialogPopup,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "../ui/command";
import { Kbd, KbdGroup } from "../ui/kbd";
import {
  buildContentSearchResults,
  buildQuickOpenRows,
  CONTENT_SEARCH_RENDER_WINDOW,
  contentSearchWorkspaceKey,
  recallContentSearch,
  rememberContentSearch,
  resolveContentSearchStatus,
  resolveContentSearchUnavailable,
  resolveQuickOpenStatus,
  type ContentSearchResultGroup,
  type ContentSearchResultRow,
  type ContentSearchWorkspace,
  type QuickOpenRow,
  type RememberedContentSearch,
} from "./WorkspaceSearchDialog.logic";

/**
 * The palette's searches of the routed thread's workspace, shown in place of
 * its command list. They ship in the palette's chunk: as a lazy entry of their
 * own they would regroup the shared icon chunks and add a file to the shell's
 * budgeted closures.
 */
export function WorkspaceSearchDialog() {
  const mode = useCommandPaletteStore((store) => store.workspaceSearchMode);
  return mode === null ? null : <OpenWorkspaceSearch mode={mode} />;
}

interface WorkspaceSearchPresentation {
  readonly label: string;
  readonly testId: string;
  readonly className?: string;
}

const MODE_PRESENTATION: Record<WorkspaceSearchMode, WorkspaceSearchPresentation> = {
  files: { label: "Go to file", testId: "quick-open" },
  content: {
    label: "Find in files",
    testId: "find-in-files",
    // Wider and taller: lines of code need the room.
    className: "max-h-[min(44rem,80vh)] max-w-3xl",
  },
};

/** One popup for both searches, so switching between them keeps it in place. */
function OpenWorkspaceSearch(props: { mode: WorkspaceSearchMode }) {
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const composerHandleRef = useComposerHandleContext();
  // Quick open's query, kept while the popup switches to find in files and
  // back; find in files keeps its own per workspace.
  const [fileQuery, setFileQuery] = useState("");
  const presentation = MODE_PRESENTATION[props.mode];

  return (
    <CommandDialogPopup
      aria-label={presentation.label}
      className={cn("project-glass-surface overflow-hidden p-0", presentation.className)}
      data-testid={presentation.testId}
      surface="glass"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <QuickOpen query={fileQuery} onQueryChange={setFileQuery} />
      ) : (
        <FindInFiles />
      )}
    </CommandDialogPopup>
  );
}

/**
 * Closes the palette and opens a file in the routed thread's Files panel, at
 * a line when the reveal names one. The routed thread's case of
 * `createWorkspaceFileOpener` (workspaceFileNavigation.ts), which sits in a
 * chat chunk this one must not pull in.
 */
function useOpenWorkspaceFile(): (reveal: WorkspaceFileReveal) => void {
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const navigate = useNavigate();
  return (reveal) => {
    setOpen(false);
    if (!routeTarget) return;
    const nextSearch = (previous: Record<string, unknown>) =>
      buildOpenFilesSearch(previous, reveal);
    if (routeTarget.kind === "draft") {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId: routeTarget.draftId },
        replace: true,
        search: nextSearch,
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(routeTarget.threadRef),
      replace: true,
      search: nextSearch,
    });
  };
}

/** Quick open: a file of the routed thread's workspace, by name, into its Files panel. */
function QuickOpen(props: { query: string; onQueryChange: (query: string) => void }) {
  const { query } = props;
  const { resolvedTheme } = useTheme();
  const { activeThread, activeCwd } = useRouteWorkspaceTarget();
  const environmentId = activeThread?.environmentId ?? null;
  const capability = useHostedRpcCapability(WS_METHODS.projectsSearchEntries, environmentId);
  const nodeLabel = useHostedHubStore((state) => hostedSwitchTargetLabel(state, environmentId));
  const openFile = useOpenWorkspaceFile();
  const inputRef = useSelectedInputRef();
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);

  // The node takes a trimmed query: "  " searches nothing rather than failing.
  const searchQuery = normalizeWorkspaceFileSearchQuery(query);
  const search = useWorkspacePathSearch({
    environmentId,
    cwd: activeCwd,
    query: searchQuery,
    enabled: activeCwd !== null && capability.allowed,
  });
  const rows = useMemo(
    () => buildQuickOpenRows(search.results?.entries ?? [], searchQuery),
    [search.results, searchQuery],
  );
  // Handed to the list so it highlights the first row of results that arrive
  // after the query changed, too.
  const rowPaths = useMemo(() => rows.map((row) => row.path), [rows]);
  const status = resolveQuickOpenStatus({
    hasWorkspace: activeCwd !== null,
    access: { allowed: capability.allowed, reason: hostedCapabilityCopy(capability, nodeLabel) },
    requestsSearch: search.requestsSearch,
    isLoading: search.isLoading,
    hasResults: search.hasResults,
    error: search.error,
    partial: search.results?.partial === true,
  });

  return (
    <Command
      aria-label="Go to file"
      items={rowPaths}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedPath(typeof value === "string" ? value : null);
      }}
      onValueChange={props.onQueryChange}
      value={query}
    >
      <CommandInput ref={inputRef} placeholder="Go to file" />
      <CommandPanel className="max-h-[min(28rem,70vh)] bg-transparent">
        {rows.length > 0 ? (
          <CommandList>
            {rows.map((row) => (
              <QuickOpenResultRow
                key={row.path}
                row={row}
                isActive={highlightedPath === row.path}
                resolvedTheme={resolvedTheme}
                onOpen={(path) => {
                  openFile({ path });
                }}
              />
            ))}
          </CommandList>
        ) : (
          <div
            aria-live="polite"
            className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground text-sm"
          >
            <p role={status.failed ? "alert" : undefined}>{status.text}</p>
            {status.failed ? (
              <Button size="xs" variant="outline" onClick={search.retry}>
                Retry
              </Button>
            ) : null}
          </div>
        )}
        {rows.length > 0 && status.failed ? (
          <div className="flex items-center justify-between gap-2 border-t px-4 py-1.5">
            <p role="alert" className="text-destructive text-xs">
              {status.text}
            </p>
            <Button size="xs" variant="ghost" onClick={search.retry}>
              Retry
            </Button>
          </div>
        ) : null}
        {status.footnote ? <Footnote>{status.footnote}</Footnote> : null}
      </CommandPanel>
      <WorkspaceSearchFooter mode="files" />
    </Command>
  );
}

function QuickOpenResultRow(props: {
  row: QuickOpenRow;
  isActive: boolean;
  resolvedTheme: "light" | "dark";
  onOpen: (path: string) => void;
}) {
  const { row } = props;
  return (
    <CommandItem
      value={row.path}
      className={cn(RESULT_ROW_CLASS, "gap-2", props.isActive && ACTIVE_RESULT_ROW_CLASS)}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onOpen(row.path);
      }}
    >
      <VscodeEntryIcon pathValue={row.path} kind="file" theme={props.resolvedTheme} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-foreground text-sm">
          <HighlightedText segments={row.name} markClassName={NAME_MATCH_CLASS} />
        </span>
        {row.parentPath ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/70 text-xs">
            <HighlightedText segments={row.parentPath} markClassName={NAME_MATCH_CLASS} />
          </span>
        ) : null}
      </span>
    </CommandItem>
  );
}

// The row's own highlight; the list's is turned off so a hovered row and the
// keyboard's row never both show.
const RESULT_ROW_CLASS =
  "cursor-pointer hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit";
const ACTIVE_RESULT_ROW_CLASS = "bg-accent! text-accent-foreground!";
const NAME_MATCH_CLASS = "bg-transparent font-semibold text-foreground";

const selectContentSearchSupport = (config: ServerConfig | null): boolean | null =>
  config === null ? null : selectProjectContentSearchSupported(config);

/** Find in files: lines of the routed thread's workspace, opened at their line in its Files panel. */
function FindInFiles() {
  const { activeThread, activeProject, activeCwd } = useRouteWorkspaceTarget();
  const environmentId = activeThread?.environmentId ?? null;
  const supported = useEnvironmentServerConfigSelector(environmentId, selectContentSearchSupport);
  const capability = useHostedRpcCapability(WS_METHODS.projectsSearchContent, environmentId);
  const nodeLabel = useHostedHubStore((state) => hostedSwitchTargetLabel(state, environmentId));
  const workspace = useMemo(
    () => (environmentId !== null && activeCwd !== null ? { environmentId, cwd: activeCwd } : null),
    [activeCwd, environmentId],
  );
  const unavailable = resolveContentSearchUnavailable({
    hasWorkspace: workspace !== null,
    access: { allowed: capability.allowed, reason: hostedCapabilityCopy(capability, nodeLabel) },
    supported,
  });

  return (
    <ContentSearch
      // Each workspace starts from its own last search.
      key={workspace ? contentSearchWorkspaceKey(workspace) : ""}
      workspace={workspace}
      unavailable={unavailable}
      projectName={activeProject?.name ?? null}
    />
  );
}

const NO_SEARCH: WorkspaceContentSearchSnapshot = {
  query: "",
  options: DEFAULT_CONTENT_SEARCH_OPTIONS,
  status: "idle",
  matches: [],
  hasMore: false,
  loadingMore: false,
  timedOut: false,
  stoppedEarly: false,
  partial: false,
  capped: false,
  error: null,
};

/**
 * One workspace's search while the dialog shows it. Its controller starts from
 * the workspace's last search when React subscribes and is disposed when React
 * unsubscribes, so StrictMode's second subscription starts a clean one.
 */
interface ContentSearchSource {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => WorkspaceContentSearchSnapshot;
  /** The running controller, for event handlers. */
  readonly current: () => WorkspaceContentSearch | null;
}

const NO_SOURCE: ContentSearchSource = {
  subscribe: () => () => undefined,
  getSnapshot: () => NO_SEARCH,
  current: () => null,
};

function createContentSearchSource(workspace: ContentSearchWorkspace): ContentSearchSource {
  let controller: WorkspaceContentSearch | null = null;
  let subscribers = 0;
  return {
    subscribe: (listener) => {
      if (controller === null) {
        // Every edit is remembered, so this is also what was typed while the
        // workspace could not be searched yet.
        const last = recallContentSearch(workspace);
        controller = createWorkspaceContentSearch({
          cwd: workspace.cwd,
          search: (request, options) =>
            ensureEnvironmentApi(workspace.environmentId).projects.searchContent(request, options),
          ...(last ? { query: last.query, options: last.options } : {}),
        });
      }
      subscribers += 1;
      const unsubscribe = controller.subscribe(listener);
      return () => {
        unsubscribe();
        subscribers -= 1;
        if (subscribers > 0) return;
        controller?.dispose();
        controller = null;
      };
    },
    getSnapshot: () => controller?.getSnapshot() ?? NO_SEARCH,
    current: () => controller,
  };
}

function ContentSearch(props: {
  workspace: ContentSearchWorkspace | null;
  /** Why the workspace can't be searched, or null when it can. */
  unavailable: string | null;
  projectName: string | null;
}) {
  const { workspace, unavailable } = props;
  const { resolvedTheme } = useTheme();
  const openFile = useOpenWorkspaceFile();
  const inputRef = useSelectedInputRef();
  const [input, setInput] = useState<RememberedContentSearch>(
    () =>
      (workspace ? recallContentSearch(workspace) : undefined) ?? {
        query: "",
        options: DEFAULT_CONTENT_SEARCH_OPTIONS,
      },
  );
  const searchable = unavailable === null ? workspace : null;
  const source = useMemo(
    () => (searchable ? createContentSearchSource(searchable) : NO_SOURCE),
    [searchable],
  );
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);

  // A new search renders from its first window again.
  const searchKey = `${snapshot.query}\0${snapshot.options.caseSensitive}\0${snapshot.options.wholeWord}`;
  const [rendered, setRendered] = useState({ searchKey, limit: CONTENT_SEARCH_RENDER_WINDOW });
  const renderLimit =
    rendered.searchKey === searchKey ? rendered.limit : CONTENT_SEARCH_RENDER_WINDOW;
  const results = useMemo(
    () => buildContentSearchResults(snapshot.matches, renderLimit),
    [renderLimit, snapshot.matches],
  );
  const status = resolveContentSearchStatus({ snapshot, fileCount: results.fileCount });

  const edit = (next: RememberedContentSearch) => {
    setInput(next);
    if (workspace) rememberContentSearch(workspace, next);
  };
  const setOption = (option: keyof ContentSearchOptions, pressed: boolean) => {
    edit({ ...input, options: { ...input.options, [option]: pressed } });
    source.current()?.setOptions({ [option]: pressed });
  };
  // Renders the next window of loaded matches, then pages once all are shown.
  const showMore = () => {
    if (renderLimit < snapshot.matches.length) {
      setRendered({ searchKey, limit: renderLimit + CONTENT_SEARCH_RENDER_WINDOW });
    } else {
      source.current()?.loadMore();
    }
  };
  const runAction = () => {
    const search = source.current();
    if (status.action === "retry") search?.retry();
    else search?.keepSearching();
  };
  const announcement =
    unavailable ?? status.message ?? [status.summary, status.notice].filter(Boolean).join(" ");

  return (
    <Command
      aria-label="Find in files"
      items={results.values}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(query) => {
        edit({ ...input, query });
        source.current()?.setQuery(query);
      }}
      value={input.query}
    >
      <div className="relative">
        <CommandInput
          ref={inputRef}
          className="pe-20"
          placeholder={props.projectName ? `Search in ${props.projectName}` : "Search in files"}
        />
        <div className="absolute inset-e-4 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          <SearchOptionToggle
            label="Match case"
            pressed={input.options.caseSensitive}
            onPressedChange={(pressed) => {
              setOption("caseSensitive", pressed);
            }}
          >
            Aa
          </SearchOptionToggle>
          <SearchOptionToggle
            label="Match whole word"
            pressed={input.options.wholeWord}
            onPressedChange={(pressed) => {
              setOption("wholeWord", pressed);
            }}
          >
            <span className="underline decoration-1 underline-offset-[3px]">ab</span>
          </SearchOptionToggle>
        </div>
      </div>
      {/* The status for screen readers; the visible copies below are hidden from them. */}
      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>
      <CommandPanel className="flex max-h-[min(36rem,64vh)] flex-col bg-transparent">
        {unavailable !== null || status.message !== null ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground text-sm">
            <p aria-hidden="true">{unavailable ?? status.message}</p>
            {unavailable === null && status.action ? (
              <StatusActionButton action={status.action} variant="outline" onRun={runAction} />
            ) : null}
            {/* Pages on when the node has more although none matched yet. */}
            {unavailable === null && snapshot.hasMore ? (
              <ListEndSentinel onVisible={showMore} />
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex min-h-8 items-center gap-2 border-b px-4 py-1 text-muted-foreground text-xs">
              <span aria-hidden="true" className="tabular-nums">
                {status.summary}
              </span>
              {status.notice ? (
                <span aria-hidden="true" className={cn(status.failed && "text-destructive")}>
                  {status.notice}
                </span>
              ) : null}
              {status.action ? (
                <StatusActionButton
                  action={status.action}
                  className="ms-auto"
                  variant="ghost"
                  onRun={runAction}
                />
              ) : null}
            </div>
            <CommandList scrollFade={false}>
              {results.groups.map((group) => (
                <ContentSearchResultGroupView
                  key={group.path}
                  group={group}
                  highlightedValue={highlightedValue}
                  resolvedTheme={resolvedTheme}
                  onOpen={openFile}
                />
              ))}
              {snapshot.loadingMore ? (
                <p aria-hidden="true" className="px-2 py-1.5 text-muted-foreground text-xs">
                  Loading more…
                </p>
              ) : null}
              <ListEndSentinel onVisible={showMore} />
            </CommandList>
          </>
        )}
        {unavailable === null
          ? status.footnotes.map((footnote) => <Footnote key={footnote}>{footnote}</Footnote>)
          : null}
      </CommandPanel>
      <WorkspaceSearchFooter mode="content" />
    </Command>
  );
}

/**
 * A pressed-or-not search option. A button with `aria-pressed` rather than
 * the Toggle primitive, which would regroup the shell's shared vendor chunks.
 */
function SearchOptionToggle(props: {
  label: string;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Button
      aria-label={props.label}
      aria-pressed={props.pressed}
      className="min-w-7 px-1 font-mono sm:min-w-6"
      data-pressed={props.pressed ? "" : undefined}
      size="xs"
      title={props.label}
      variant="ghost"
      // Keeps the caret in the search field.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onPressedChange(!props.pressed);
      }}
    >
      {props.children}
    </Button>
  );
}

function StatusActionButton(props: {
  action: "retry" | "keepSearching";
  className?: string;
  variant: "outline" | "ghost";
  onRun: () => void;
}) {
  return (
    <Button
      className={props.className}
      size="xs"
      variant={props.variant}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={props.onRun}
    >
      {props.action === "retry" ? "Retry" : "Keep searching"}
    </Button>
  );
}

function ContentSearchResultGroupView(props: {
  group: ContentSearchResultGroup;
  highlightedValue: string | null;
  resolvedTheme: "light" | "dark";
  onOpen: (reveal: WorkspaceFileReveal) => void;
}) {
  const { group } = props;
  return (
    <CommandGroup>
      {/* The popup's own color: the rows scroll under it. Its height (h-8) is the rows' scroll-mt-8. */}
      <CommandGroupLabel className="sticky top-0 z-10 flex h-8 items-center gap-2 bg-popover font-normal">
        <VscodeEntryIcon pathValue={group.path} kind="file" theme={props.resolvedTheme} />
        <span className="shrink-0 text-foreground text-sm">{group.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{group.parentPath}</span>
        <span className="shrink-0 tabular-nums">{group.matchCount}</span>
      </CommandGroupLabel>
      {group.rows.map((row) => (
        <ContentSearchResultRowView
          key={row.value}
          row={row}
          isActive={props.highlightedValue === row.value}
          onOpen={props.onOpen}
        />
      ))}
    </CommandGroup>
  );
}

function ContentSearchResultRowView(props: {
  row: ContentSearchResultRow;
  isActive: boolean;
  onOpen: (reveal: WorkspaceFileReveal) => void;
}) {
  const { row } = props;
  return (
    <CommandItem
      value={row.value}
      aria-label={row.label}
      // scroll-mt-8 = the sticky file header's height: arrowing up scrolls the row in below the
      // header instead of under it (list navigation uses scrollIntoView({ block: "nearest" })).
      className={cn(
        RESULT_ROW_CLASS,
        "scroll-mt-8 gap-3 ps-3",
        props.isActive && ACTIVE_RESULT_ROW_CLASS,
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onOpen({ path: row.path, line: row.lineNumber });
      }}
    >
      <span className="w-9 shrink-0 text-right font-mono text-muted-foreground/70 text-xs tabular-nums">
        {row.lineNumber}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre font-mono text-xs">
        <HighlightedText segments={row.preview} markClassName="thread-message-search-highlight" />
      </span>
    </CommandItem>
  );
}

/** Calls `onVisible` when the end of a list comes into view, and again after each change of it. */
function ListEndSentinel(props: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onVisible } = props;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisible();
      },
      // A little ahead of the end, so the next rows are there before they are reached.
      {
        root: element.closest('[data-slot="scroll-area-viewport"]'),
        rootMargin: "0px 0px 240px 0px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible]);
  return <div ref={ref} aria-hidden="true" className="h-px shrink-0" />;
}

/** The search field's ref; a query the field opens with is selected, so typing replaces it. */
function useSelectedInputRef() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return ref;
}

function Footnote(props: { children: ReactNode }) {
  return (
    <p className="border-t px-4 py-1.5 text-[11px] text-muted-foreground/70">{props.children}</p>
  );
}

const OTHER_MODE = {
  files: { command: "workspace.findInFiles", label: "Find in files" },
  content: { command: "workspace.quickOpen", label: "Go to file" },
} satisfies Record<WorkspaceSearchMode, { command: KeybindingCommand; label: string }>;

function WorkspaceSearchFooter(props: { mode: WorkspaceSearchMode }) {
  const keybindings = useAppKeybindings();
  const other = OTHER_MODE[props.mode];
  const otherShortcut = shortcutLabelForCommand(keybindings, other.command);
  return (
    <CommandFooter className="gap-3 pointer-coarse:hidden">
      <div className="flex items-center gap-3">
        <KbdGroup className="items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span className="text-muted-foreground/80">Navigate</span>
        </KbdGroup>
        <KbdGroup className="items-center gap-1.5">
          <Kbd>Enter</Kbd>
          <span className="text-muted-foreground/80">Open</span>
        </KbdGroup>
        {otherShortcut ? (
          <KbdGroup className="items-center gap-1.5">
            <Kbd>{otherShortcut}</Kbd>
            <span className="text-muted-foreground/80">{other.label}</span>
          </KbdGroup>
        ) : null}
        <KbdGroup className="items-center gap-1.5">
          <Kbd>Esc</Kbd>
          <span className="text-muted-foreground/80">Close</span>
        </KbdGroup>
      </div>
    </CommandFooter>
  );
}

function HighlightedText(props: { segments: readonly HighlightSegment[]; markClassName: string }) {
  // Runs are keyed by where they start in the text.
  let start = 0;
  return props.segments.map((segment) => {
    const key = start;
    start += segment.text.length;
    return segment.highlighted ? (
      <mark key={key} className={props.markClassName}>
        {segment.text}
      </mark>
    ) : (
      <span key={key}>{segment.text}</span>
    );
  });
}
