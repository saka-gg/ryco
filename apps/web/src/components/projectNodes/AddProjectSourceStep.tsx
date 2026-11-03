// FILE: AddProjectSourceStep.tsx
// Purpose: The add-project dialog's source step: open a folder, clone a repository (the
//          node's clone sources with their readiness, the user's own repositories, provider
//          lookup and Bitbucket search, any Git URL), copy a project from another node, and,
//          for a link request, link a checkout that is already there. "Import from Codex or
//          Claude Code" hands over to the conversation import dialog for the node.
// Layer: Web UI. Rendered by `AddProjectDialog`, which owns the flow; this step resolves the
//        repository to clone and hands everything else back through callbacks.

import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { type SourceControlRepositoryInfo, WS_METHODS } from "@ryco/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  FolderInputIcon,
  GitCommitHorizontalIcon,
  LinkIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { hostedCapabilityCopy } from "../../hostedHub/switchTarget";
import { useSourceControlDiscovery } from "../../lib/sourceControlDiscoveryState";
import { cn } from "../../lib/utils";
import { useSourceControlRepositorySearch } from "../../rpc/useSourceControl";
import type { Project } from "../../types";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  openSessionImportDialog,
  preloadSessionImportDialog,
} from "../sessionImport/sessionImportDialogStore";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import {
  buildRepositorySuggestions,
  isGitRemoteUrlInput,
  type AddProjectCopySource,
  type AddProjectSourceKind,
} from "./addProjectDialog.logic";
import {
  ADD_PROJECT_SETUP_REQUIRED_FALLBACK_HINT,
  ADD_PROJECT_SETUP_REQUIRED_LABEL,
  buildAddProjectRemoteSourceReadiness,
  cloneUrlForRemoteProjectSource,
  listAddProjectRemoteSources,
  lookupRemoteRepository,
  REMOTE_PROJECT_SOURCES,
  remoteProjectSourceProvider,
  remoteRepositoryItemValue,
  resolveRemoteRepositoryInput,
  type AddProjectRemoteSource,
  type ResolvedRemoteRepository,
} from "./addProjectSources";
import { displayProjectPath } from "../../lib/projectPaths";
import { NodeBadge } from "./NodePicker";
import { closeAddProject } from "./projectNodesDialogStore";

const REPOSITORY_SEARCH_DEBOUNCE_MS = 200;

/** A repository the clone source settled on, and the source it came from. */
export interface AddProjectCloneChoice extends ResolvedRemoteRepository {
  readonly source: AddProjectRemoteSource;
}

export interface AddProjectSourceStepProps {
  readonly node: NodeCatalogEntry;
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  readonly kind: AddProjectSourceKind | null;
  readonly onKindChange: (kind: AddProjectSourceKind | null) => void;
  /** Every node's projects (chats included; the lists leave them out). */
  readonly projects: ReadonlyArray<Project>;
  readonly copySources: ReadonlyArray<AddProjectCopySource>;
  /** The project a link request links; null when the dialog was not asked to link. */
  readonly linkSource: Project | null;
  readonly repositoryQuery: string;
  readonly onRepositoryQueryChange: (query: string) => void;
  readonly onClone: (choice: AddProjectCloneChoice) => void;
  readonly onCopy: (source: AddProjectCopySource) => void;
  /** Opens Settings → Source Control for a provider that needs setting up. */
  readonly onSetUpProvider: () => void;
}

/** The step's option rows: icon tile, title and line, and a chevron. */
function SourceOption(props: {
  readonly selected: boolean;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly onClick: () => void;
  readonly expanded?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** Starts loading what the row opens. */
  readonly onIntent?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      aria-expanded={props.expanded}
      disabled={props.disabled}
      onClick={props.onClick}
      onPointerEnter={props.onIntent}
      onFocus={props.onIntent}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-[10px] border border-border px-3 py-[11px] text-left outline-none",
        "transition-[border-color,background-color,box-shadow] duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
        "hover:not-disabled:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-55",
        props.selected && "border-primary shadow-[0_0_0_1px_var(--primary)]",
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground [&_svg]:size-4">
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[13px] text-foreground">{props.title}</span>
        <span className="block text-[11.5px] text-muted-foreground">{props.description}</span>
      </span>
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The panel a source opens under its row. */
function SourcePanel(props: { readonly children: ReactNode; readonly label: string }) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="-mt-1 mb-0.5 ms-4 overflow-hidden rounded-[10px] border border-border"
    >
      {props.children}
    </div>
  );
}

const PANEL_ROW_CLASS = cn(
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-[5px] text-left text-[12.5px] outline-none",
  "transition-colors duration-(--app-motion-duration-chip) hover:not-disabled:bg-accent/60 focus-visible:bg-accent/60",
  "disabled:cursor-not-allowed disabled:opacity-55",
);

function PanelEmpty(props: { readonly children: ReactNode }) {
  return (
    <div className="px-4 py-[18px] text-center text-[12.5px] text-muted-foreground">
      {props.children}
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

export function AddProjectSourceStep(props: AddProjectSourceStepProps) {
  const { node, kind, onKindChange } = props;
  // Gated on the node as the command palette's import action is.
  const sessionImportCapability = useHostedRpcCapability(
    WS_METHODS.sessionImportRun,
    node.environmentId,
  );
  return (
    <>
      <p className="m-0 text-muted-foreground">
        What do you want to add on <b className="font-medium text-foreground">{node.label}</b>?
      </p>
      <SourceOption
        selected={kind === "folder"}
        icon={<FolderIcon />}
        title="Open a folder"
        description={`A folder that already exists on ${node.label}`}
        onClick={() => onKindChange("folder")}
      />
      <SourceOption
        selected={kind === "clone"}
        expanded={kind === "clone"}
        icon={<GitCommitHorizontalIcon />}
        title="Clone a repository"
        description="GitHub, GitLab, Forgejo or any Git URL"
        onClick={() => onKindChange(kind === "clone" ? null : "clone")}
      />
      {kind === "clone" ? <ClonePanel {...props} /> : null}
      <SourceOption
        selected={kind === "copy"}
        expanded={kind === "copy"}
        icon={<CopyIcon />}
        title="Copy from another node"
        description="Bring over a project you already have on another device"
        onClick={() => onKindChange(kind === "copy" ? null : "copy")}
      />
      {kind === "copy" ? <CopyPanel {...props} /> : null}
      {props.linkSource ? (
        <SourceOption
          selected={kind === "link"}
          icon={<LinkIcon />}
          title={`Link a checkout of ${props.linkSource.name}`}
          description={`A copy of the repository that's already on ${node.label}`}
          onClick={() => onKindChange("link")}
        />
      ) : null}
      <SourceOption
        selected={false}
        icon={<FolderInputIcon />}
        title="Import from Codex or Claude Code…"
        description={
          hostedCapabilityCopy(sessionImportCapability, node.label) ??
          `Your conversations on ${node.label}, grouped into projects by folder`
        }
        disabled={!sessionImportCapability.allowed}
        onIntent={preloadSessionImportDialog}
        onClick={() => {
          closeAddProject();
          openSessionImportDialog({ environmentId: node.environmentId });
        }}
      />
    </>
  );
}

/* ───────── Clone ───────── */

function ClonePanel(props: AddProjectSourceStepProps) {
  const { node, repositoryQuery: query, onRepositoryQueryChange, onClone } = props;
  const environmentId = node.environmentId;
  // Which providers this node can clone from (CLI installed and signed in).
  const discovery = useSourceControlDiscovery({ environmentId });
  const readiness = useMemo(
    () => buildAddProjectRemoteSourceReadiness(discovery.data),
    [discovery.data],
  );
  const sourceOptions = useMemo(() => listAddProjectRemoteSources(readiness), [readiness]);
  const [chosenSource, setChosenSource] = useState<AddProjectRemoteSource | null>(null);
  // The provider "owner/repo" resolves against: the one picked, else the first ready one in
  // the usual order (GitHub first), else a plain Git URL.
  const providerSource: AddProjectRemoteSource =
    chosenSource ??
    REMOTE_PROJECT_SOURCES.find((source) => source !== "url" && readiness[source].ready) ??
    "url";
  const trimmed = query.trim();
  const typedUrl = trimmed.length > 0 && isGitRemoteUrlInput(trimmed);
  const effectiveSource: AddProjectRemoteSource = typedUrl ? "url" : providerSource;
  const effectiveLabel =
    sourceOptions.find((option) => option.source === effectiveSource)?.label ?? "Git URL";

  const [debouncedQuery] = useDebouncedValue(trimmed, { wait: REPOSITORY_SEARCH_DEBOUNCE_MS });
  const searchesProvider = remoteProjectSourceProvider(effectiveSource) === "bitbucket";
  const providerSearch = useSourceControlRepositorySearch({
    environmentId,
    provider: "bitbucket",
    query: debouncedQuery,
    limit: 25,
    enabled: searchesProvider,
  });
  const searchedRepositories = searchesProvider ? (providerSearch.data?.repositories ?? []) : [];

  const suggestions = useMemo(
    () =>
      buildRepositorySuggestions({
        projects: props.projects,
        nodeId: environmentId,
        nodes: props.nodes,
        query: trimmed,
      }),
    [environmentId, props.nodes, props.projects, trimmed],
  );
  const nodeById = useMemo(
    () => new Map(props.nodes.map((entry) => [entry.environmentId, entry] as const)),
    [props.nodes],
  );

  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const chooseRepository = (repository: SourceControlRepositoryInfo) => {
    onClone({
      source: effectiveSource,
      repositoryInput: repository.nameWithOwner,
      repository,
      remoteUrl: cloneUrlForRemoteProjectSource(effectiveSource, repository),
    });
  };

  /** Enter: a URL is cloned as typed; "owner/repo" is looked up with the node's provider. */
  const submit = async () => {
    if (trimmed.length === 0 || lookingUp) return;
    setLookupError(null);
    const resolution = resolveRemoteRepositoryInput({
      source: effectiveSource,
      rawRepository: trimmed,
      searchQuery: debouncedQuery,
      searchedRepositories,
    });
    if (resolution.kind === "resolved") {
      onClone({ source: effectiveSource, ...resolution.resolved });
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setLookupError(`${node.label} is not connected.`);
      return;
    }
    setLookingUp(true);
    try {
      const resolved = await lookupRemoteRepository({
        api,
        provider: resolution.provider,
        rawRepository: trimmed,
      });
      onClone({ source: effectiveSource, ...resolved });
    } catch (error) {
      setLookupError(`Repository lookup failed: ${errorText(error)}`);
    }
    // After the try, not in a `finally`: React Compiler does not lower one.
    setLookingUp(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key === "Escape" && query.length > 0) {
      // Clear the field first; a second Escape reaches the dialog.
      event.preventDefault();
      event.stopPropagation();
      onRepositoryQueryChange("");
    }
  };

  const hasRows = searchedRepositories.length > 0 || suggestions.length > 0;
  return (
    <SourcePanel label="Clone a repository">
      <label className="flex items-center gap-2 border-border border-b px-3 py-[9px] text-muted-foreground">
        <SearchIcon aria-hidden className="size-[13px] shrink-0" />
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- choosing "Clone" opens on this field
          autoFocus
          aria-label="Repository to clone"
          autoComplete="off"
          spellCheck={false}
          placeholder="owner/repo or https://… URL"
          value={query}
          onChange={(event) => {
            setLookupError(null);
            onRepositoryQueryChange(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/72"
          data-testid="add-project-repository-input"
        />
        {lookingUp || (searchesProvider && providerSearch.isFetching) ? (
          <Spinner className="size-3.5" />
        ) : null}
        <Menu>
          <MenuTrigger
            aria-label={`Clone source: ${effectiveLabel}`}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded border border-border px-[5px] py-px font-mono text-[10.5px] text-muted-foreground transition-colors duration-(--app-motion-duration-chip) hover:text-foreground"
          >
            {effectiveLabel}
            <ChevronDownIcon aria-hidden className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-52">
            {sourceOptions.map((option) =>
              option.ready ? (
                <MenuItem
                  key={option.source}
                  onClick={() => setChosenSource(option.source)}
                  className={cn(option.source === providerSource && "font-medium")}
                >
                  {option.title}
                </MenuItem>
              ) : (
                <MenuItem
                  key={option.source}
                  title={option.hint ?? ADD_PROJECT_SETUP_REQUIRED_FALLBACK_HINT}
                  onClick={props.onSetUpProvider}
                  className="justify-between gap-3"
                >
                  <span className="text-muted-foreground">{option.title}</span>
                  <span className="rounded-sm border border-border px-1.5 text-[10px] text-warning-foreground">
                    {ADD_PROJECT_SETUP_REQUIRED_LABEL}
                  </span>
                </MenuItem>
              ),
            )}
          </MenuPopup>
        </Menu>
      </label>
      <div className="max-h-[170px] overflow-y-auto p-1">
        {lookupError ? (
          <div role="alert" className="px-1.5 py-1.5 text-[12px] text-destructive-foreground">
            {lookupError}
          </div>
        ) : null}
        {searchedRepositories.map((repository) => (
          <button
            key={remoteRepositoryItemValue(repository)}
            type="button"
            className={PANEL_ROW_CLASS}
            onClick={() => chooseRepository(repository)}
          >
            <GitCommitHorizontalIcon
              aria-hidden
              className="size-[13px] shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate">{repository.nameWithOwner}</span>
          </button>
        ))}
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.canonicalKey}
            type="button"
            disabled={suggestion.onThisNode}
            className={PANEL_ROW_CLASS}
            onClick={() =>
              onClone({
                source: "url",
                repositoryInput: suggestion.label,
                repository: null,
                remoteUrl: suggestion.remoteUrl,
              })
            }
          >
            <GitCommitHorizontalIcon
              aria-hidden
              className="size-[13px] shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
            {suggestion.onThisNode ? (
              <span className="whitespace-nowrap rounded-full bg-muted px-1.5 py-px font-medium text-[10.5px] text-muted-foreground">
                already on {node.label}
              </span>
            ) : suggestion.otherNodeIds.length > 0 ? (
              <>
                <span className="text-[11.5px] text-muted-foreground">also on</span>
                <span className="inline-flex shrink-0 gap-[3px]">
                  {suggestion.otherNodeIds.map((otherId) => {
                    const other = nodeById.get(otherId);
                    return other ? (
                      <span key={otherId} title={other.label}>
                        <NodeBadge node={other} size="sm" />
                      </span>
                    ) : null;
                  })}
                </span>
              </>
            ) : null}
          </button>
        ))}
        {!hasRows && !lookupError ? (
          <PanelEmpty>
            {trimmed.length > 0
              ? `Press Enter to clone “${trimmed}”.`
              : "Type owner/repo, or paste a Git URL."}
          </PanelEmpty>
        ) : null}
      </div>
    </SourcePanel>
  );
}

/* ───────── Copy ───────── */

function CopyPanel(props: AddProjectSourceStepProps) {
  const nodeById = useMemo(
    () => new Map(props.nodes.map((entry) => [entry.environmentId, entry] as const)),
    [props.nodes],
  );
  return (
    <SourcePanel label="Copy from another node">
      <div className="max-h-[170px] overflow-y-auto p-1">
        {props.copySources.length > 0 ? (
          props.copySources.map((entry) => {
            const sourceNode = nodeById.get(entry.source.environmentId);
            const where = `${sourceNode?.label ?? "Another node"} · ${displayProjectPath(entry.source.cwd)}`;
            return (
              <button
                key={entry.key}
                type="button"
                className={PANEL_ROW_CLASS}
                onClick={() => props.onCopy(entry)}
              >
                <ProjectFavicon
                  environmentId={entry.source.environmentId}
                  cwd={entry.source.cwd}
                  projectId={entry.source.id}
                  customAvatarContentHash={entry.source.customAvatarContentHash ?? null}
                  fallbackName={entry.name}
                  className="size-4 shrink-0 rounded-[5px]"
                />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span
                  className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground"
                  title={where}
                >
                  {where}
                </span>
                <ChevronRightIcon
                  aria-hidden
                  className="size-[13px] shrink-0 text-muted-foreground"
                />
              </button>
            );
          })
        ) : (
          <PanelEmpty>Every project is already here.</PanelEmpty>
        )}
      </div>
    </SourcePanel>
  );
}
