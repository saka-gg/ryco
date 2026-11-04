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
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  GitCommitHorizontalIcon,
  LinkIcon,
  SearchIcon,
} from "lucide-react";
import { Fragment, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { hostedCapabilityCopy } from "../../hostedHub/switchTarget";
import { useSourceControlDiscovery } from "../../lib/sourceControlDiscoveryState";
import { cn } from "../../lib/utils";
import { useSourceControlRepositorySearch } from "../../rpc/useSourceControl";
import type { Project } from "../../types";
import { ClaudeAI, OpenAI } from "../icons/ProviderIcons";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  openSessionImportDialog,
  preloadSessionImportDialog,
} from "../sessionImport/sessionImportDialogStore";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import {
  buildCloneSourceChips,
  buildRepositorySuggestions,
  detectCloneSourceFromUrl,
  isGitRemoteUrlInput,
  splitRepositoryLabel,
  type AddProjectCopySource,
  type AddProjectSourceKind,
  type CloneSourceChip,
} from "./addProjectDialog.logic";
import {
  ADD_PROJECT_SETUP_REQUIRED_FALLBACK_HINT,
  ADD_PROJECT_SETUP_REQUIRED_LABEL,
  buildAddProjectRemoteSourceReadiness,
  cloneUrlForRemoteProjectSource,
  lookupRemoteRepository,
  REMOTE_PROJECT_SOURCES,
  remoteProjectSourceIcon,
  remoteProjectSourceLabel,
  remoteProjectSourceProvider,
  remoteRepositoryItemValue,
  resolveRemoteRepositoryInput,
  type AddProjectRemoteSource,
  type ResolvedRemoteRepository,
} from "./addProjectSources";
import { displayProjectPath } from "../../lib/projectPaths";
import { NodeBadge } from "./NodePicker";
import { NodePathText } from "./NodePathText";
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

/** A source card: icon tile, title and one line, what it leads to, and a chevron. */
function SourceOption(props: {
  readonly selected: boolean;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly onClick: () => void;
  /** Set for a source that opens a panel under its card. */
  readonly expanded?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** Starts loading what the card opens. */
  readonly onIntent?: (() => void) | undefined;
  /** Marks before the chevron (provider logos, other nodes). */
  readonly trailing?: ReactNode;
  /** The panel the source opens, rendered inside the card while expanded. */
  readonly panel?: ReactNode;
}) {
  const expanded = props.expanded === true;
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border",
        "transition-[border-color,box-shadow] duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
        props.selected && !expanded && "border-primary shadow-[0_0_0_1px_var(--primary)]",
        expanded && "border-foreground/16 shadow-xs/5",
      )}
    >
      <button
        type="button"
        aria-pressed={props.selected}
        aria-expanded={props.expanded}
        disabled={props.disabled}
        onClick={props.onClick}
        onPointerEnter={props.onIntent}
        onFocus={props.onIntent}
        className={cn(
          "group/source flex w-full cursor-pointer items-center gap-3.5 px-3.5 py-3 text-left outline-none",
          "transition-colors duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
          "hover:not-disabled:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          "disabled:cursor-not-allowed disabled:opacity-55",
        )}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] border border-border/70 bg-muted/60 text-foreground [&_svg]:size-[18px]">
          {props.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-[13.5px] text-foreground leading-5">
            {props.title}
          </span>
          <span className="block truncate text-[12px] text-muted-foreground leading-[18px]">
            {props.description}
          </span>
        </span>
        {props.trailing}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground/70 transition-transform duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
            "group-hover/source:text-foreground",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded ? props.panel : null}
    </div>
  );
}

/** The panel a source opens inside its card. */
function SourcePanel(props: { readonly children: ReactNode; readonly label: string }) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="border-border border-t bg-foreground/[0.015] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
    >
      {props.children}
    </div>
  );
}

const PANEL_ROW_CLASS = cn(
  "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-[7px] text-left text-[13px] outline-none",
  "transition-colors duration-(--app-motion-duration-chip) hover:not-disabled:bg-accent/60 focus-visible:bg-accent/60",
  "disabled:cursor-default",
);

/** A row's leading mark on a small tile (a provider logo, a project's favicon). */
function RowMark(props: { readonly children: ReactNode; readonly muted?: boolean | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md border border-border/60 bg-background [&_svg]:size-3.5",
        props.muted && "opacity-60 grayscale",
      )}
    >
      {props.children}
    </span>
  );
}

function PanelEmpty(props: { readonly children: ReactNode }) {
  return (
    <div className="px-4 py-5 text-center text-[12.5px] text-muted-foreground">
      {props.children}
    </div>
  );
}

/** A few small marks overlapping one another, e.g. the nodes a copy can come from. */
function MarkStack(props: { readonly children: ReactNode; readonly label?: string }) {
  return (
    <span
      aria-hidden={props.label === undefined}
      aria-label={props.label}
      className="flex shrink-0 items-center -space-x-1 [&>*]:ring-2 [&>*]:ring-popover"
    >
      {props.children}
    </span>
  );
}

const CLONE_CARD_PROVIDERS = ["github", "gitlab", "forgejo", "bitbucket", "azure-devops"] as const;

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
  // The nodes the copy source lists projects from, in catalog order.
  const copyNodes = useMemo(() => {
    const ids = new Set(props.copySources.map((entry) => entry.source.environmentId));
    return props.nodes.filter((entry) => ids.has(entry.environmentId)).slice(0, 4);
  }, [props.copySources, props.nodes]);
  return (
    <>
      <p className="m-0 text-muted-foreground">
        What do you want to add on <b className="font-medium text-foreground">{node.label}</b>?
      </p>
      <div className="flex flex-col gap-2">
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
          trailing={
            <span
              aria-hidden
              className="hidden shrink-0 items-center gap-1.5 opacity-70 transition-opacity duration-(--app-motion-duration-chip) group-hover/source:opacity-100 sm:flex [&_svg]:size-3.5"
            >
              {CLONE_CARD_PROVIDERS.map((source) => (
                <Fragment key={source}>{remoteProjectSourceIcon(source, "size-3.5")}</Fragment>
              ))}
            </span>
          }
          panel={<ClonePanel {...props} />}
        />
        <SourceOption
          selected={kind === "copy"}
          expanded={kind === "copy"}
          icon={<CopyIcon />}
          title="Copy from another node"
          description="Bring over a project you already have on another device"
          onClick={() => onKindChange(kind === "copy" ? null : "copy")}
          trailing={
            copyNodes.length > 0 ? (
              <MarkStack>
                {copyNodes.map((entry) => (
                  <NodeBadge key={entry.environmentId} node={entry} size="md" />
                ))}
              </MarkStack>
            ) : null
          }
          panel={<CopyPanel {...props} />}
        />
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
          icon={
            <span className="flex items-center gap-[3px] [&_svg]:size-3.5!">
              <OpenAI aria-hidden />
              <ClaudeAI aria-hidden />
            </span>
          }
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
      </div>
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
  const [chosenSource, setChosenSource] = useState<AddProjectRemoteSource | null>(null);
  // The provider "owner/repo" resolves against: the one picked, else the first ready one in
  // the usual order (GitHub first), else a plain Git URL.
  const providerSource: AddProjectRemoteSource =
    chosenSource ??
    REMOTE_PROJECT_SOURCES.find((source) => source !== "url" && readiness[source].ready) ??
    "url";
  const trimmed = query.trim();
  const typedUrl = trimmed.length > 0 && isGitRemoteUrlInput(trimmed);
  // A URL clones as typed; its host only lights its provider's chip.
  const effectiveSource: AddProjectRemoteSource = typedUrl ? "url" : providerSource;
  const chips = useMemo(
    () =>
      buildCloneSourceChips({
        readiness,
        providerSource,
        typedUrl: typedUrl ? trimmed : null,
      }),
    [providerSource, readiness, trimmed, typedUrl],
  );

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

  const providerLabel = remoteProjectSourceLabel(providerSource);
  const placeholder =
    providerSource === "url"
      ? "Paste a Git URL: https://… or git@…"
      : `owner/repo on ${providerLabel}, or paste a Git URL`;
  const hasRows = searchedRepositories.length > 0 || suggestions.length > 0;
  return (
    <SourcePanel label="Clone a repository">
      <div
        role="group"
        aria-label="Clone source"
        className="flex flex-wrap gap-1 px-3 pt-3 pb-2"
        data-testid="add-project-clone-sources"
      >
        {chips.map((chip) => (
          <CloneSourceChipButton
            key={chip.source}
            chip={chip}
            onSelect={() => {
              setLookupError(null);
              setChosenSource(chip.source);
            }}
            onSetUp={props.onSetUpProvider}
          />
        ))}
      </div>
      <div className="px-3 pb-2">
        <label
          className={cn(
            "flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-muted-foreground shadow-xs/5 dark:bg-input/32",
            "transition-[border-color,box-shadow] duration-(--app-motion-duration-chip) focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24",
          )}
        >
          {typedUrl ? (
            <span aria-hidden className="grid shrink-0 place-items-center [&_svg]:size-3.5">
              {remoteProjectSourceIcon(detectCloneSourceFromUrl(trimmed), "size-3.5")}
            </span>
          ) : (
            <SearchIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- choosing "Clone" opens on this field
            autoFocus
            aria-label="Repository to clone"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
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
          ) : trimmed.length > 0 ? (
            <Kbd className="h-[18px] text-[10.5px]">↵</Kbd>
          ) : null}
        </label>
      </div>
      <div className="max-h-[236px] overflow-y-auto px-1.5 pb-1.5">
        {lookupError ? (
          <div role="alert" className="px-2 py-1.5 text-[12px] text-destructive-foreground">
            {lookupError}
          </div>
        ) : null}
        {hasRows ? (
          <div className="px-2 pt-1 pb-1 font-medium text-[11px] text-muted-foreground">
            {searchedRepositories.length > 0 ? `On ${providerLabel}` : "Your repositories"}
          </div>
        ) : null}
        {searchedRepositories.map((repository) => (
          <button
            key={remoteRepositoryItemValue(repository)}
            type="button"
            className={PANEL_ROW_CLASS}
            onClick={() => chooseRepository(repository)}
          >
            <RowMark>{remoteProjectSourceIcon(effectiveSource, "size-3.5")}</RowMark>
            <RepositoryName label={repository.nameWithOwner} />
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
            <RowMark muted={suggestion.onThisNode}>
              {remoteProjectSourceIcon(detectCloneSourceFromUrl(suggestion.remoteUrl), "size-3.5")}
            </RowMark>
            <RepositoryName label={suggestion.label} muted={suggestion.onThisNode} />
            {suggestion.onThisNode ? (
              <span className="whitespace-nowrap rounded-full bg-muted px-2 py-px font-medium text-[10.5px] text-muted-foreground">
                already on {node.label}
              </span>
            ) : suggestion.otherNodeIds.length > 0 ? (
              <span className="flex shrink-0 items-center gap-1.5">
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
              </span>
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

/** "owner/" muted, the repository's own name in full colour. */
function RepositoryName(props: { readonly label: string; readonly muted?: boolean | undefined }) {
  const { owner, name } = splitRepositoryLabel(props.label);
  return (
    <span className={cn("min-w-0 flex-1 truncate", props.muted && "text-muted-foreground")}>
      {owner ? <span className="text-muted-foreground">{owner}/</span> : null}
      <span
        className={cn("font-medium", props.muted ? "text-muted-foreground" : "text-foreground")}
      >
        {name}
      </span>
    </span>
  );
}

const CLONE_SOURCE_CHIP_CLASS = cn(
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-2.5 text-[12px] text-muted-foreground outline-none",
  "transition-[background-color,border-color,color] duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
  "hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
  "data-active:border-border data-active:bg-background data-active:text-foreground data-active:shadow-xs/5",
  "data-popup-open:bg-accent/60 data-popup-open:text-foreground",
);

/**
 * One clone source: its logo and name. A provider the node can't use yet stays visible,
 * dimmed; it opens a small menu that says why and leads to Settings → Source Control.
 */
function CloneSourceChipButton(props: {
  readonly chip: CloneSourceChip;
  readonly onSelect: () => void;
  readonly onSetUp: () => void;
}) {
  const { chip } = props;
  const shared = {
    "data-source": chip.source,
    "data-active": chip.active ? "" : undefined,
    "data-detected": chip.detected ? "" : undefined,
    className: CLONE_SOURCE_CHIP_CLASS,
  };
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "grid place-items-center [&_svg]:size-3.5",
          !chip.ready && "opacity-55 grayscale",
        )}
      >
        {remoteProjectSourceIcon(chip.source, "size-3.5")}
      </span>
      {chip.label}
      {!chip.ready ? (
        <span aria-hidden className="text-[10.5px] text-muted-foreground/80">
          Set up
        </span>
      ) : null}
    </>
  );
  if (chip.ready) {
    return (
      <button
        type="button"
        aria-pressed={chip.active}
        title={chip.detected ? "Detected from the URL" : undefined}
        data-ready=""
        onClick={props.onSelect}
        {...shared}
      >
        {content}
      </button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${chip.label}: ${ADD_PROJECT_SETUP_REQUIRED_LABEL}`}
        title={chip.hint ?? ADD_PROJECT_SETUP_REQUIRED_FALLBACK_HINT}
        {...shared}
      >
        {content}
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-72">
        <div className="px-2 pt-1.5 pb-1 text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">{chip.label}</span> isn't set up on this
          node yet. {chip.hint ?? ADD_PROJECT_SETUP_REQUIRED_FALLBACK_HINT}
        </div>
        <MenuItem onClick={props.onSetUp}>Set up in Settings…</MenuItem>
      </MenuPopup>
    </Menu>
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
      <div className="max-h-[236px] overflow-y-auto p-1.5">
        {props.copySources.length > 0 ? (
          props.copySources.map((entry) => {
            const sourceNode = nodeById.get(entry.source.environmentId);
            const sourcePath = displayProjectPath(entry.source.cwd);
            return (
              <button
                key={entry.key}
                type="button"
                className={cn(PANEL_ROW_CLASS, "group/copy")}
                onClick={() => props.onCopy(entry)}
              >
                <ProjectFavicon
                  environmentId={entry.source.environmentId}
                  cwd={entry.source.cwd}
                  projectId={entry.source.id}
                  customAvatarContentHash={entry.source.customAvatarContentHash ?? null}
                  fallbackName={entry.name}
                  className="size-5 shrink-0 rounded-[6px]"
                />
                <span className="min-w-0 max-w-[45%] shrink-0 truncate font-medium text-foreground">
                  {entry.name}
                </span>
                <span
                  className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-[11.5px] text-muted-foreground"
                  data-testid="add-project-copy-where"
                >
                  {sourceNode ? <NodeBadge node={sourceNode} size="sm" /> : null}
                  <span className="max-w-[120px] shrink-0 truncate whitespace-pre">
                    {`${sourceNode?.label ?? "Another node"} · `}
                  </span>
                  <NodePathText
                    path={sourcePath}
                    title={entry.source.cwd}
                    className="font-mono text-[11px]"
                  />
                </span>
                <ChevronRightIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground/70 group-hover/copy:text-foreground"
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
