// FILE: FolderPicker.tsx
// Purpose: Picks a folder on one node: search across the node's code roots, Places (home and
//          code roots), its Git repositories, and a breadcrumb listing with an Up button. Git
//          repositories (with their branch) and existing projects (with their icon and name)
//          are marked, and a status bar shows the selected folder's full path over what it is
//          and whether it can be used. Nodes without `capabilities.projectCopy` get a
//          browse-only picker: the field filters the listing or browses to a typed path.
// Layer: Web UI. Reads go through `filesystem.browse` and the project-copy reads in
//        `nodePathQueries.ts`; the selection is controlled by the dialog that hosts it.

import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import type { FilesystemDirectoryMatch } from "@ryco/contracts/project-copy";
import { useDebouncedValue } from "@tanstack/react-pacer";
// Lucide icons are chunked by the set of entries that import them: icons other surfaces use
// stay within those the add-project dialog already imported (or boot's), so adding one here
// does not regroup the shared icon chunks the chat route loads.
import {
  ChevronRightIcon,
  ChevronUpIcon,
  FolderGitIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderSearchIcon,
  FolderSymlinkIcon,
  GitBranchIcon,
  HomeIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  ensureBrowseDirectoryPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  isSameFilesystemPath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@ryco/shared/projectPaths";
import { cn } from "~/lib/utils";
import { requestFilesystemBrowse } from "~/rpc/projectAtoms";
import { useFilesystemBrowse } from "~/rpc/useProject";

import { filterBrowseEntries } from "../CommandPalette.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { getEnvironmentBrowsePlatform } from "./addProjectSources";
import { HighlightedText, highlightMatch } from "./HighlightedText";
import { NodePathText } from "./NodePathText";
import {
  buildFolderCrumbs,
  buildFolderPlaces,
  describeFolderSelection,
  folderSearchNote,
  folderSelectionStatusKey,
  folderStatusPath,
  formatNodePath,
  nodePathLeaf,
  resolveFolderDestination,
  type FolderCrumb,
  type FolderPickerMode,
  type FolderSelectionStatus,
} from "@ryco/client-runtime/projectCopy/folderPicker";
import {
  FOLDER_SEARCH_LIMIT,
  useNodeDestinationPreview,
  useNodeEnvironmentApi,
  useNodeFolderSearch,
  useNodeGitRepositories,
  useNodeListingAnnotations,
  useNodePathHints,
} from "./nodePathQueries";
import { nodeOsLabel } from "@ryco/client-runtime/projectCopy/nodePicker";

const SEARCH_DEBOUNCE_MS = 200;
const PREVIEW_DEBOUNCE_MS = 150;
const BROWSE_STALE_TIME_MS = 30_000;
const GIT_REPOSITORY_PLACES = 5;
const GIT_REPOSITORY_PLACES_LARGE = 8;

/** A project already on the node, so its folder is marked and named. */
export interface FolderPickerProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly cwd: string;
}

export interface FolderPickerProps {
  readonly environmentId: EnvironmentId;
  readonly nodeLabel: string;
  /** The node's `platform.os`, for its path rules and the field's OS tag. */
  readonly platformOs: string | null;
  /**
   * The node advertises `capabilities.projectCopy`: search, Places from its code
   * roots, its Git repositories and the destination preview. Without it the
   * picker only browses.
   */
  readonly supportsProjectCopy: boolean;
  readonly mode: FolderPickerMode;
  /** The selected folder (the parent folder in `parent` mode). */
  readonly value: string | null;
  readonly onValueChange: (path: string) => void;
  /** Where the listing starts; defaults to the node's code directory, else home. */
  readonly initialDirectory?: string | null | undefined;
  /** Search text to start with (link mode: the repository's name). */
  readonly initialQuery?: string | undefined;
  /** `parent` mode: the folder created inside the chosen parent. */
  readonly childName?: string | null | undefined;
  /** `link` mode: the repository the checkout must belong to; null for one without a remote. */
  readonly expectedRepositoryCanonicalKey?: string | null | undefined;
  /** Projects already on this node. */
  readonly projects?: ReadonlyArray<FolderPickerProject> | undefined;
  /** Enter on the selected folder. */
  readonly onSubmit?: ((path: string) => void) | undefined;
  /** Every change of what the status line says, for the host's primary button. */
  readonly onStatusChange?: ((status: FolderSelectionStatus) => void) | undefined;
  /** Offers the node's free alternative when the destination is taken. */
  readonly onUseSuggestedPath?: ((path: string) => void) | undefined;
  /**
   * `folder` mode: Enter on a typed path selects that folder, one that does not exist yet
   * included (adding the project creates it), instead of browsing into it. A path that ends
   * in a separator still browses.
   */
  readonly allowNewFolder?: boolean | undefined;
  /**
   * Rewords the status line for the host's flow ("Clones <remote> into <path>"). The status
   * the host hears through `onStatusChange` is the reworded one.
   */
  readonly describeStatus?: ((status: FolderSelectionStatus) => FolderSelectionStatus) | undefined;
  /** A control at the end of the status line, e.g. "Open" for a folder that already is a project. */
  readonly statusAction?: ReactNode;
  readonly autoFocus?: boolean | undefined;
  /**
   * `large` for a dialog that gives the picker room (the add-project dialog): a taller
   * listing that follows the viewport, wider Places and roomier rows. Defaults to `compact`.
   */
  readonly size?: "compact" | "large" | undefined;
  readonly className?: string | undefined;
}

interface FolderRow {
  readonly path: string;
  readonly name: string;
  readonly isSymlink: boolean;
  readonly isGitRepository: boolean;
  readonly gitBranch: string | null;
  /** A project is rooted here; `projectName` is null when only its id is known. */
  readonly isProject: boolean;
  readonly projectName: string | null;
  readonly projectId: ProjectId | null;
  readonly repositoryCanonicalKey: string | null;
}

type FolderRowProject = Pick<FolderRow, "isProject" | "projectName" | "projectId">;

function folderRowFromMatch(match: FilesystemDirectoryMatch, project: FolderRowProject): FolderRow {
  return {
    path: match.path,
    name: match.name,
    isSymlink: false,
    isGitRepository: match.isGitRepository,
    gitBranch: match.gitBranch,
    isProject: project.isProject,
    projectName: project.projectName,
    projectId: project.projectId,
    repositoryCanonicalKey: match.repositoryCanonicalKey,
  };
}

const SECTION_LABEL_CLASS =
  "px-1.5 pt-2 pb-[3px] font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]";

function SectionLabel(props: { readonly children: ReactNode; readonly id?: string }) {
  return (
    <div id={props.id} className={SECTION_LABEL_CLASS}>
      {props.children}
    </div>
  );
}

/** A centred state inside the listing: what happened, an optional detail and action. */
function PickerNotice(props: {
  readonly children: ReactNode;
  readonly icon?: ReactNode;
  readonly detail?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-6 py-5 text-center"
    >
      {props.icon ? (
        <span
          aria-hidden
          className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4"
        >
          {props.icon}
        </span>
      ) : null}
      <span className="flex flex-col gap-0.5">
        <span className="text-[12.5px] text-foreground">{props.children}</span>
        {props.detail ? (
          <span className="text-[11.5px] text-muted-foreground">{props.detail}</span>
        ) : null}
      </span>
      {props.action}
    </div>
  );
}

export function FolderPicker(props: FolderPickerProps) {
  const {
    environmentId,
    nodeLabel,
    platformOs,
    supportsProjectCopy: copy,
    mode,
    value,
    onValueChange,
    onSubmit,
    onStatusChange,
    onUseSuggestedPath,
  } = props;
  const listId = useId();
  const api = useNodeEnvironmentApi(environmentId);
  const platform = getEnvironmentBrowsePlatform(platformOs);

  /* ── Where we are ── */
  const hints = useNodePathHints({ environmentId, supported: copy });
  const hintsData = copy ? (hints.data ?? null) : null;
  const hintsSettled =
    !copy || hints.isSuccess || hints.isError || api?.projects.pathHints === undefined;
  const homeDirectory = hintsData?.homeDirectory ?? null;
  const [directory, setDirectory] = useState<string | null>(props.initialDirectory ?? null);
  const startDirectory =
    props.initialDirectory ?? hintsData?.defaultProjectDirectory ?? (hintsSettled ? "~" : null);
  const currentDirectory = directory ?? startDirectory;

  /* ── The field ── */
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const trimmedQuery = query.trim();
  const isPathQuery =
    trimmedQuery.length > 0 &&
    isFilesystemBrowseQuery(trimmedQuery, platform) &&
    !isExplicitRelativeProjectPath(trimmedQuery);
  // A transport without the search member (older build) filters the listing instead.
  const searchable = copy && api?.filesystem.searchDirectories !== undefined;
  const searching = searchable && trimmedQuery.length > 0;
  const [debouncedQuery] = useDebouncedValue(trimmedQuery, { wait: SEARCH_DEBOUNCE_MS });
  const search = useNodeFolderSearch({
    environmentId,
    api,
    query: debouncedQuery,
    enabled: searching,
  });
  const searchSettling = searching && (debouncedQuery !== trimmedQuery || search.isFetching);

  /* ── The listing ── */
  // Browse-only: a typed path browses there, filtered by its last segment; other text filters.
  const browsedDirectory =
    !searchable && isPathQuery ? getBrowseDirectoryPath(trimmedQuery) : currentDirectory;
  const browseFilter = searchable
    ? ""
    : isPathQuery
      ? hasTrailingPathSeparator(trimmedQuery)
        ? ""
        : getBrowseLeafPathSegment(trimmedQuery)
      : trimmedQuery;
  const browseInput = {
    environmentId,
    partialPath: browsedDirectory ? ensureBrowseDirectoryPath(browsedDirectory) : "",
    staleTime: BROWSE_STALE_TIME_MS,
    enabled: !searching && browsedDirectory !== null,
  };
  const browse = useFilesystemBrowse(browseInput);
  const listedDirectory = browse.data?.parentPath ?? null;
  // A restricted node reports its access root with every listing; nothing above it lists.
  const accessRoot = hintsData?.workspaceAccessRoot ?? browse.data?.workspaceAccessRoot ?? null;
  const annotations = useNodeListingAnnotations({
    environmentId,
    api,
    directory: listedDirectory,
    enabled: copy && !searching,
  });
  const repositories = useNodeGitRepositories({ environmentId, api, enabled: copy });

  const projectByPath = useMemo(
    () =>
      new Map(
        (props.projects ?? []).map(
          (project) => [normalizeProjectPathForComparison(project.cwd), project] as const,
        ),
      ),
    [props.projects],
  );
  const projectNameById = useMemo(
    () => new Map((props.projects ?? []).map((project) => [project.id, project.name] as const)),
    [props.projects],
  );
  const projectAt = useCallback(
    (path: string, projectId: ProjectId | null): FolderRowProject => {
      const known = projectByPath.get(normalizeProjectPathForComparison(path)) ?? null;
      const name = known?.name ?? (projectId ? (projectNameById.get(projectId) ?? null) : null);
      return {
        isProject: name !== null || projectId !== null,
        projectName: name,
        projectId: known?.id ?? projectId,
      };
    },
    [projectByPath, projectNameById],
  );

  const { filteredEntries, exactEntry } = useMemo(
    () =>
      filterBrowseEntries({
        browseEntries: browse.data?.entries ?? [],
        browseFilterQuery: browseFilter,
        highlightedItemValue: null,
      }),
    [browse.data?.entries, browseFilter],
  );
  const rows = useMemo<FolderRow[]>(() => {
    if (searching) {
      return (search.data?.matches ?? []).map((match) =>
        folderRowFromMatch(match, projectAt(match.path, match.projectId)),
      );
    }
    return filteredEntries.map((entry) => {
      const annotation = annotations.get(normalizeProjectPathForComparison(entry.fullPath));
      const project = projectAt(entry.fullPath, annotation?.projectId ?? null);
      return {
        path: entry.fullPath,
        name: entry.name,
        isSymlink: entry.isSymlink === true || entry.isAlias === true,
        isGitRepository: annotation?.isGitRepository ?? false,
        gitBranch: annotation?.gitBranch ?? null,
        isProject: project.isProject,
        projectName: project.projectName,
        projectId: project.projectId,
        repositoryCanonicalKey: annotation?.repositoryCanonicalKey ?? null,
      };
    });
  }, [annotations, filteredEntries, projectAt, search.data?.matches, searching]);

  /* ── Keyboard focus within the list ── */
  const [activeIndex, setActiveIndex] = useState(-1);
  const listKey = searching
    ? `search\u0000${debouncedQuery}`
    : `browse\u0000${browseInput.partialPath}\u0000${browseFilter}`;
  const [activeListKey, setActiveListKey] = useState(listKey);
  if (activeListKey !== listKey) {
    setActiveListKey(listKey);
    setActiveIndex(-1);
  }
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const optionId = (index: number) => `${listId}-option-${index}`;
  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(`${listId}-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId]);

  /* ── Selection ── */
  const [lastSelectedRow, setLastSelectedRow] = useState<FolderRow | null>(null);
  const selectedRow =
    value === null
      ? null
      : (rows.find((row) => isSameFilesystemPath(row.path, value)) ??
        (lastSelectedRow && isSameFilesystemPath(lastSelectedRow.path, value)
          ? lastSelectedRow
          : null));
  const destinationPath = resolveFolderDestination(mode, value, props.childName);
  const [debouncedDestination] = useDebouncedValue(destinationPath, { wait: PREVIEW_DEBOUNCE_MS });
  const preview = useNodeDestinationPreview({
    environmentId,
    api,
    path: debouncedDestination,
    enabled: copy,
  });
  const previewCurrent =
    preview.data !== null && destinationPath !== null && debouncedDestination === destinationPath;
  const destinationAnnotation =
    destinationPath === null
      ? undefined
      : annotations.get(normalizeProjectPathForComparison(destinationPath));
  const destinationIsSelection =
    destinationPath !== null && value !== null && isSameFilesystemPath(destinationPath, value);
  const destinationProjectName =
    destinationPath === null
      ? null
      : (projectByPath.get(normalizeProjectPathForComparison(destinationPath))?.name ?? null);
  const destinationProject =
    destinationProjectName !== null
      ? { name: destinationProjectName }
      : destinationIsSelection && selectedRow?.isProject
        ? { name: selectedRow.projectName }
        : destinationAnnotation?.projectId
          ? { name: null }
          : null;
  // A node that is not connected cannot judge the folder; say so instead of checking forever.
  const disconnectedError = useMemo(
    () => (api === undefined ? new Error(`${nodeLabel} is not connected.`) : null),
    [api, nodeLabel],
  );
  // A typed folder its parent's listing lacks (`allowNewFolder`): it does not exist yet.
  const [typedNewFolder, setTypedNewFolder] = useState<string | null>(null);
  const baseStatus = describeFolderSelection({
    mode,
    nodeLabel,
    homeDirectory,
    selectedPath: value,
    destinationPath,
    supportsPreview: copy && (api === undefined || api.projects.previewDestination !== undefined),
    preview: previewCurrent ? preview.data : null,
    previewError:
      disconnectedError ?? (debouncedDestination === destinationPath ? preview.error : null),
    existingProject: destinationProject,
    isGitRepository: destinationIsSelection
      ? (selectedRow?.isGitRepository ?? null)
      : (destinationAnnotation?.isGitRepository ?? null),
    gitBranch: destinationIsSelection
      ? (selectedRow?.gitBranch ?? null)
      : (destinationAnnotation?.gitBranch ?? null),
    expectedRepositoryCanonicalKey: props.expectedRepositoryCanonicalKey,
    knownMissing:
      typedNewFolder !== null &&
      destinationPath !== null &&
      isSameFilesystemPath(typedNewFolder, destinationPath),
  });
  const status = props.describeStatus ? props.describeStatus(baseStatus) : baseStatus;
  // Reported on real changes only, so an inline handler that sets state cannot loop.
  const statusKey = folderSelectionStatusKey(status);
  const reportStatus = useEffectEvent((_statusKey: string) => onStatusChange?.(status));
  useEffect(() => {
    reportStatus(statusKey);
  }, [statusKey]);

  /* ── Actions ── */
  const navigate = (path: string) => {
    setDirectory(normalizeTypedDirectory(path));
    setQuery("");
    setActiveIndex(-1);
  };
  const select = (row: FolderRow) => {
    setLastSelectedRow(row);
    onValueChange(row.path);
  };
  /**
   * `allowNewFolder`: the typed folder becomes the selection and the listing moves to its
   * parent. Without a node preview, the parent's listing tells whether it exists yet.
   */
  const selectTypedPath = (typed: string) => {
    const path = normalizeTypedDirectory(typed);
    const listed = !searchable && exactEntry !== null;
    const row = rows.find((candidate) => isSameFilesystemPath(candidate.path, path));
    setTypedNewFolder(searchable || listed || row ? null : path);
    const parent = getBrowseParentPath(path);
    if (parent !== null) navigate(parent);
    else setQuery("");
    if (row) {
      select(row);
      return;
    }
    setLastSelectedRow(null);
    onValueChange(listed && exactEntry ? normalizeTypedDirectory(exactEntry.fullPath) : path);
  };
  const open = (row: FolderRow) => navigate(row.path);
  const canGoUp =
    !searching &&
    listedDirectory !== null &&
    !(accessRoot !== null && isSameFilesystemPath(listedDirectory, accessRoot)) &&
    getBrowseParentPath(listedDirectory) !== null;
  const goUp = () => {
    if (!canGoUp || listedDirectory === null) return;
    const parent = getBrowseParentPath(listedDirectory);
    if (parent !== null) navigate(parent);
  };

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown": {
        if (rows.length === 0) return;
        event.preventDefault();
        setActiveIndex((index) => Math.min(rows.length - 1, index + 1));
        return;
      }
      case "ArrowUp": {
        if (rows.length === 0) return;
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        return;
      }
      case "ArrowRight": {
        const caretAtEnd = event.currentTarget.selectionStart === query.length;
        if (!activeRow || !caretAtEnd) return;
        event.preventDefault();
        open(activeRow);
        return;
      }
      case "ArrowLeft":
      case "Backspace": {
        if (query.length > 0 || !canGoUp) return;
        event.preventDefault();
        goUp();
        return;
      }
      case "Enter": {
        event.preventDefault();
        if (activeRow) {
          if (value !== null && isSameFilesystemPath(activeRow.path, value)) {
            onSubmit?.(activeRow.path);
          } else {
            select(activeRow);
          }
          return;
        }
        if (isPathQuery) {
          if (
            props.allowNewFolder &&
            mode === "folder" &&
            !hasTrailingPathSeparator(trimmedQuery)
          ) {
            selectTypedPath(trimmedQuery);
            return;
          }
          navigate(trimmedQuery);
          return;
        }
        if (value !== null && status.usable) onSubmit?.(value);
        return;
      }
      case "Escape": {
        if (query.length === 0) return;
        // Clear the field first; a second Escape reaches the dialog.
        event.preventDefault();
        event.stopPropagation();
        setQuery("");
        return;
      }
    }
  }

  /* ── Rendering ── */
  const large = props.size === "large";
  const osLabel = nodeOsLabel(platformOs);
  const places = buildFolderPlaces(hintsData, startDirectory);
  const crumbs =
    listedDirectory !== null || browsedDirectory !== null
      ? buildFolderCrumbs(listedDirectory ?? browsedDirectory ?? "~", { homeDirectory, accessRoot })
      : [];
  const placeholder = searchable
    ? `Search folders on ${nodeLabel}, e.g. “tap” or “/srv”`
    : `Filter this folder, or type a path on ${nodeLabel}`;
  const rowClass = large
    ? "gap-2.5 px-2 py-1.5 text-[13px]"
    : "gap-2 px-1.5 py-[5px] text-[12.5px]";

  const renderRow = (row: FolderRow, index: number, display: "name" | "path") => {
    const selected = value !== null && isSameFilesystemPath(row.path, value);
    const sameRepository =
      mode === "link" &&
      row.isGitRepository &&
      props.expectedRepositoryCanonicalKey !== undefined &&
      row.repositoryCanonicalKey === props.expectedRepositoryCanonicalKey;
    const Icon = row.isGitRepository
      ? FolderGitIcon
      : row.isSymlink
        ? FolderSymlinkIcon
        : FolderIcon;
    const shownPath = formatNodePath(row.path, homeDirectory);
    const parentPath = getBrowseParentPath(row.path);
    const shownParent = parentPath === null ? null : formatNodePath(parentPath, homeDirectory);
    // A search shows the folder's name first; the query is marked where it matched.
    const nameMatches = highlightMatch(row.name, debouncedQuery).some((segment) => segment.match);
    return (
      <div
        key={row.path}
        id={optionId(index)}
        role="option"
        aria-selected={selected}
        data-active={index === activeIndex ? "" : undefined}
        data-path={row.path}
        title={row.path}
        className={cn(
          "group/row flex w-full cursor-pointer items-center rounded-md",
          rowClass,
          "transition-colors duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
          "hover:bg-accent/60 data-active:bg-accent/60",
          selected &&
            "bg-primary/10 text-foreground hover:bg-primary/14 data-active:bg-primary/14 dark:bg-primary/16 dark:data-active:bg-primary/22 dark:hover:bg-primary/22",
        )}
        // Keeps focus in the field, which owns the keyboard.
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => {
          if (index !== activeIndex) setActiveIndex(index);
        }}
        onClick={() => select(row)}
        onDoubleClick={() => open(row)}
      >
        <Icon
          aria-hidden
          className={cn(
            "shrink-0 text-muted-foreground",
            large ? "size-4" : "size-[13px]",
            selected && "text-foreground",
          )}
        />
        {display === "path" ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="min-w-0 max-w-[65%] shrink-0 truncate">
              <HighlightedText text={row.name} query={nameMatches ? debouncedQuery : ""} />
            </span>
            {shownParent !== null ? (
              <NodePathText
                path={shownParent}
                title={row.path}
                className="flex-1 font-mono text-[11px] text-muted-foreground"
              >
                <HighlightedText text={shownParent} query={nameMatches ? "" : debouncedQuery} />
              </NodePathText>
            ) : (
              <span className="sr-only">{shownPath}</span>
            )}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
        )}
        {sameRepository ? (
          <span className="whitespace-nowrap rounded-full bg-success/12 px-1.5 py-px font-medium text-[10.5px] text-success-foreground">
            same repository
          </span>
        ) : null}
        {row.isProject ? (
          <span
            className="inline-flex min-w-0 max-w-[40%] items-center gap-1 whitespace-nowrap rounded-full border border-border/70 bg-background py-px ps-[3px] pe-1.5 font-medium text-[10.5px] text-foreground"
            data-slot="folder-picker-project"
          >
            <ProjectFavicon
              environmentId={environmentId}
              cwd={row.path}
              {...(row.projectId ? { projectId: row.projectId } : {})}
              customAvatarContentHash={null}
              fallbackName={row.projectName ?? row.name}
              className="size-3.5 shrink-0 rounded-[4px]"
            />
            <span className="truncate">{row.projectName ?? "project"}</span>
          </span>
        ) : row.gitBranch ? (
          <span
            className={cn(
              "inline-flex min-w-0 max-w-[35%] items-center gap-1 whitespace-nowrap rounded-full bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground",
              selected && "bg-background/70 text-foreground",
            )}
          >
            <GitBranchIcon aria-hidden className="size-2.5 shrink-0" />
            <span className="truncate">{row.gitBranch}</span>
          </span>
        ) : null}
        <span
          aria-hidden
          title="Open folder"
          data-slot="folder-picker-open"
          className="inline-grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground group-hover/row:text-muted-foreground"
          onClick={(event) => {
            event.stopPropagation();
            open(row);
          }}
        >
          <ChevronRightIcon className="size-[13px]" />
        </span>
      </div>
    );
  };

  const listbox = (label: string, display: "name" | "path") => (
    <div role="listbox" id={listId} aria-label={label}>
      {rows.map((row, index) => renderRow(row, index, display))}
    </div>
  );

  const bodyHeight = large ? LARGE_BODY_HEIGHT_CLASS : "h-[212px]";
  let body: ReactNode;
  if (searching) {
    const matches = search.data?.matches ?? [];
    const searchNote = search.data ? folderSearchNote(search.data, FOLDER_SEARCH_LIMIT) : null;
    body = (
      <div className={cn(bodyHeight, "overflow-y-auto p-1")} data-slot="folder-picker-results">
        {matches.length > 0 ? (
          <>
            <SectionLabel>
              {matches.length} folder{matches.length === 1 ? "" : "s"} on {nodeLabel}
            </SectionLabel>
            {listbox(`Folders matching ${trimmedQuery}`, "path")}
            {searchNote ? (
              <div
                className="px-1.5 pt-1.5 pb-1 text-[11px] text-muted-foreground"
                data-testid="folder-picker-search-note"
              >
                {searchNote === "more-matches"
                  ? "Showing the best matches. Type more to narrow them down."
                  : `${nodeLabel} stopped searching before it looked everywhere. Type more of the name, or a path.`}
              </div>
            ) : null}
          </>
        ) : search.error && !searchSettling ? (
          <PickerNotice
            icon={<TriangleAlertIcon className="text-warning" />}
            action={
              <Button size="xs" variant="outline" onClick={search.retry}>
                Try again
              </Button>
            }
          >
            Couldn't search {nodeLabel}: {search.error.message}
          </PickerNotice>
        ) : searchSettling || search.data === null ? (
          <PickerSkeleton label={`Searching ${nodeLabel}…`} rows={large ? 7 : 4} path />
        ) : (
          <PickerNotice icon={<FolderSearchIcon />}>
            No folder matches “{trimmedQuery}” on {nodeLabel}.
          </PickerNotice>
        )}
      </div>
    );
  } else {
    const listing =
      browsedDirectory === null || (browse.isPending && browse.data === null) ? (
        <PickerSkeleton label="Loading folders…" rows={large ? 8 : 5} />
      ) : browse.error && browse.data === null ? (
        <PickerNotice
          icon={<TriangleAlertIcon className="text-warning" />}
          action={
            <Button
              size="xs"
              variant="outline"
              onClick={() => requestFilesystemBrowse(browseInput, { force: true })}
            >
              Try again
            </Button>
          }
        >
          Couldn't open this folder: {browse.error.message}
        </PickerNotice>
      ) : rows.length === 0 ? (
        browseFilter ? (
          <PickerNotice icon={<FolderSearchIcon />}>
            No folder starts with “{browseFilter}”.
          </PickerNotice>
        ) : (
          <PickerNotice
            icon={<FolderOpenIcon />}
            detail={
              props.allowNewFolder
                ? "Select it as it is, or type a path to create a new folder."
                : "There are no folders in here."
            }
          >
            Empty folder
          </PickerNotice>
        )
      ) : (
        listbox(
          `Folders in ${formatNodePath(listedDirectory ?? browsedDirectory, homeDirectory)}`,
          "name",
        )
      );
    const listedPath = listedDirectory ?? browsedDirectory;
    const repositoryPlaces = (repositories.data ?? []).slice(
      0,
      large ? GIT_REPOSITORY_PLACES_LARGE : GIT_REPOSITORY_PLACES,
    );
    const placeClass = large ? PLACE_CLASS_LARGE : PLACE_CLASS;
    body = (
      <div
        className={cn(
          "grid grid-cols-1",
          bodyHeight,
          large ? "sm:grid-cols-[188px_minmax(0,1fr)]" : "sm:grid-cols-[150px_minmax(0,1fr)]",
        )}
      >
        <nav
          aria-label="Places"
          className="hidden min-h-0 flex-col gap-px overflow-y-auto border-border border-e bg-foreground/[0.015] px-1.5 pt-0.5 pb-2 sm:flex"
        >
          <SectionLabel>Places</SectionLabel>
          {copy && !hintsSettled ? (
            <div role="status" aria-label="Loading places" className="flex flex-col gap-1.5 p-1.5">
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : (
            places.map((place) => (
              <button
                key={place.path}
                type="button"
                title={formatNodePath(place.path, homeDirectory)}
                aria-current={
                  listedPath !== null && isSameFilesystemPath(place.path, listedPath)
                    ? "location"
                    : undefined
                }
                className={placeClass}
                onClick={() => navigate(place.path)}
              >
                {place.kind === "home" ? (
                  <HomeIcon aria-hidden className="shrink-0" />
                ) : (
                  <FolderIcon aria-hidden className="shrink-0" />
                )}
                <span className="truncate">{place.label}</span>
              </button>
            ))
          )}
          {copy && repositoryPlaces.length > 0 ? (
            <>
              <SectionLabel>Git repos</SectionLabel>
              {repositoryPlaces.map((repository) => (
                <button
                  key={repository.path}
                  type="button"
                  title={formatNodePath(repository.path, homeDirectory)}
                  aria-current={
                    value !== null && isSameFilesystemPath(repository.path, value)
                      ? "true"
                      : undefined
                  }
                  className={placeClass}
                  onClick={() => {
                    navigate(repository.parentPath);
                    select(
                      folderRowFromMatch(
                        repository,
                        projectAt(repository.path, repository.projectId),
                      ),
                    );
                  }}
                >
                  <FolderGitIcon aria-hidden className="shrink-0" />
                  <span className="truncate">{repository.name}</span>
                </button>
              ))}
            </>
          ) : null}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-col">
          <nav
            aria-label="Folder path"
            className="flex h-9 shrink-0 items-center gap-1 border-border border-b ps-1.5 pe-2"
          >
            <button
              type="button"
              aria-label="Up one folder"
              title="Up one folder"
              disabled={!canGoUp}
              onClick={goUp}
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-(--app-motion-duration-chip) hover:not-disabled:bg-accent hover:not-disabled:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-35"
            >
              <ChevronUpIcon aria-hidden className="size-3.5" />
            </button>
            <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
            <FolderCrumbs crumbs={crumbs} onNavigate={navigate} />
            {browse.isFetching && browse.data !== null ? (
              <Spinner className="ms-1 size-3 shrink-0" />
            ) : null}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-1" data-slot="folder-picker-listing">
            {listing}
          </div>
        </div>
      </div>
    );
  }

  const suggestedPath = status.suggestedPath;
  const statusPath = folderStatusPath(status, homeDirectory);
  const statusFullPath = status.destinationPath ?? status.selectedPath;
  const destinationProjectId =
    destinationPath === null
      ? null
      : (projectByPath.get(normalizeProjectPathForComparison(destinationPath))?.id ??
        (destinationIsSelection ? selectedRow?.projectId : destinationAnnotation?.projectId) ??
        preview.data?.existingProjectId ??
        null);
  const statusIcon =
    status.kind === "checking" ? (
      <Spinner className="size-3.5" />
    ) : status.kind === "existing-project" && destinationPath !== null ? (
      <ProjectFavicon
        environmentId={environmentId}
        cwd={destinationPath}
        {...(destinationProjectId ? { projectId: destinationProjectId } : {})}
        customAvatarContentHash={null}
        fallbackName={destinationProject?.name ?? nodePathLeaf(destinationPath)}
        className="size-4 rounded-[4px]"
      />
    ) : (
      <FolderStatusIcon status={status} />
    );

  return (
    <div className={cn("flex flex-col", props.className)} data-slot="folder-picker">
      <div className="overflow-hidden rounded-xl border border-border">
        <label
          className={cn(
            "flex items-center gap-2 border-border border-b text-muted-foreground",
            large ? "h-11 px-3.5" : "px-3 py-[9px]",
          )}
        >
          <SearchIcon aria-hidden className={cn("shrink-0", large ? "size-3.5" : "size-[13px]")} />
          <input
            role="combobox"
            aria-expanded
            aria-controls={rows.length > 0 ? listId : undefined}
            aria-activedescendant={activeRow ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            aria-label={`Search folders on ${nodeLabel}`}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog step opens on this field
            autoFocus={props.autoFocus}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(-1);
            }}
            onKeyDown={handleKeyDown}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/72"
            data-testid="folder-picker-input"
          />
          {searchSettling ? <Spinner className="size-3.5" /> : null}
          {osLabel ? (
            <span className="whitespace-nowrap rounded border border-border px-[5px] py-px font-mono text-[10.5px] text-muted-foreground">
              {osLabel}
            </span>
          ) : null}
        </label>
        {body}
        <div
          aria-live="polite"
          data-testid="folder-picker-status"
          data-state={status.kind}
          data-tone={status.tone}
          className={cn(
            "flex items-center gap-2.5 border-border border-t bg-muted/50 transition-colors duration-(--app-motion-duration-chip)",
            large ? "min-h-[52px] px-3 py-2" : "min-h-[40px] px-2.5 py-1.5",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "grid shrink-0 place-items-center rounded-md border border-border/70 bg-background [&_svg]:size-3.5",
              large ? "size-7" : "size-6",
              STATUS_TONE_ICON_CLASS[status.tone],
              status.kind === "empty-selection" && "text-muted-foreground",
            )}
          >
            {statusIcon}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            {statusPath !== null ? (
              <span className="min-w-0" data-testid="folder-picker-status-path">
                <NodePathText
                  path={statusPath}
                  title={statusFullPath ?? statusPath}
                  className="font-mono text-[12px] text-foreground leading-[18px]"
                />
              </span>
            ) : null}
            <span
              className={cn(
                "[overflow-wrap:anywhere]",
                statusPath !== null ? "text-[11.5px] leading-4" : "text-[12px]",
                status.kind === "empty-selection" || status.tone === "neutral"
                  ? "text-muted-foreground"
                  : STATUS_TONE_TEXT_CLASS[status.tone],
              )}
              data-testid="folder-picker-status-line"
            >
              {status.segments.map((segment, index) =>
                segment.path ? (
                  // oxlint-disable-next-line react/no-array-index-key -- segments are positional
                  <span key={index} className="font-mono text-[11px]">
                    {segment.text}
                  </span>
                ) : (
                  // oxlint-disable-next-line react/no-array-index-key -- segments are positional
                  <Fragment key={index}>{segment.text}</Fragment>
                ),
              )}
            </span>
          </span>
          {large && status.kind === "empty-selection" && rows.length > 0 ? (
            <span
              aria-hidden
              className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:flex"
            >
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span className="me-1.5">move</span>
              <Kbd>→</Kbd>
              <span className="me-1.5">open</span>
              <Kbd>↵</Kbd>
              <span>select</span>
            </span>
          ) : null}
          {suggestedPath && onUseSuggestedPath ? (
            <Button
              size="xs"
              variant="outline"
              className="shrink-0 font-mono text-[11px]"
              onClick={() => onUseSuggestedPath(suggestedPath)}
            >
              Use {nodePathLeaf(suggestedPath)}
            </Button>
          ) : null}
          {props.statusAction}
        </div>
      </div>
    </div>
  );
}

const STATUS_TONE_ICON_CLASS: Record<FolderSelectionStatus["tone"], string> = {
  neutral: "text-muted-foreground",
  positive: "text-success",
  caution: "text-warning",
  negative: "text-destructive",
};

const STATUS_TONE_TEXT_CLASS: Record<FolderSelectionStatus["tone"], string> = {
  neutral: "text-muted-foreground",
  positive: "text-success-foreground",
  caution: "text-warning-foreground",
  negative: "text-destructive-foreground",
};

/** The mark before the status line: what kind of folder the selection is. */
function FolderStatusIcon(props: { readonly status: FolderSelectionStatus }) {
  const { status } = props;
  if (status.tone === "negative" || status.tone === "caution") {
    return <TriangleAlertIcon />;
  }
  switch (status.kind) {
    case "clone-destination":
      return <FolderInputIcon />;
    case "git-repository":
    case "same-repository":
      return <FolderGitIcon />;
    case "new-folder":
    case "missing-folder":
      return <PlusIcon />;
    case "empty-selection":
      return <FolderIcon />;
    default:
      return <FolderOpenIcon />;
  }
}

/** The listed folder's crumbs; the row keeps its end (the current folder) in view. */
function FolderCrumbs(props: {
  readonly crumbs: ReadonlyArray<FolderCrumb>;
  readonly onNavigate: (path: string) => void;
}) {
  const { crumbs } = props;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const lastPath = crumbs.at(-1)?.path ?? "";
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new folder scrolls again
  }, [lastPath]);
  return (
    <div
      ref={scrollerRef}
      className="flex min-w-0 flex-1 items-center gap-px overflow-x-auto whitespace-nowrap font-mono text-[11.5px] text-muted-foreground [scrollbar-width:none]"
    >
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <Fragment key={crumb.path}>
            {index > 0 && !crumbs[index - 1]!.isRoot ? (
              <span aria-hidden className="px-px opacity-45">
                /
              </span>
            ) : null}
            <button
              type="button"
              aria-current={last ? "location" : undefined}
              title={crumb.path}
              className={cn(
                "shrink-0 cursor-pointer rounded px-1 py-0.5 outline-none transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                last && "font-medium text-foreground",
              )}
              onClick={() => props.onNavigate(crumb.path)}
            >
              {crumb.label}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Placeholder rows while the node lists or searches. */
function PickerSkeleton(props: {
  readonly label: string;
  readonly rows: number;
  readonly path?: boolean;
}) {
  return (
    <div role="status" aria-label={props.label} className="flex flex-col gap-0.5 p-0.5">
      <span className="sr-only">{props.label}</span>
      {Array.from({ length: props.rows }, (_, index) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- placeholder rows are positional
          key={index}
          aria-hidden
          className="flex items-center gap-2.5 px-2 py-[9px]"
          style={{ opacity: 1 - index * (0.7 / props.rows) }}
        >
          <Skeleton className="size-3.5 shrink-0 rounded-[4px]" />
          <Skeleton
            className="h-2.5 rounded-full"
            style={{ width: `${SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]}%` }}
          />
          {props.path ? <Skeleton className="ms-auto h-2.5 w-1/4 rounded-full" /> : null}
        </div>
      ))}
    </div>
  );
}

const SKELETON_WIDTHS = [34, 52, 28, 44, 38, 58, 30, 46] as const;

/** The same tall listing in the add-project dialog: as much as the viewport leaves, 240–420 px. */
const LARGE_BODY_HEIGHT_CLASS = "h-[clamp(240px,calc(100dvh-372px),420px)]";

const PLACE_CLASS = cn(
  "flex shrink-0 items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground [&_svg]:size-3",
  "transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/60 hover:text-foreground",
  "aria-[current=location]:bg-foreground/10 aria-[current=location]:text-foreground aria-[current=true]:text-foreground",
);

const PLACE_CLASS_LARGE = cn(
  "flex shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-[5px] text-left text-[12.5px] text-muted-foreground [&_svg]:size-3.5",
  "transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/60 hover:text-foreground",
  "aria-[current=location]:bg-foreground/10 aria-[current=location]:text-foreground aria-[current=true]:text-foreground",
);

/** A typed or listed directory as the listing state keeps it ("~/Code/" → "~/Code", "C:\\" kept). */
function normalizeTypedDirectory(path: string): string {
  return normalizeProjectPathForDispatch(path) || path.trim();
}
