// FILE: ProjectSelectorBody.tsx
// Purpose: The project selector's list: one row per logical project with its checkout on every
//          node, node chips, `@node` and path search, and the footer actions. Loaded on demand
//          by `ProjectSwitcher`, which keeps only the trigger and the search field in the chat
//          route.
// Layer: Web UI. Rows come from `ProjectSwitcher.logic.ts`; moving the draft goes through the
//        composer draft store, or the hosted draft-target controller for another Hub node.

import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { CheckIcon, CopyIcon, PlusIcon, type LucideIcon } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  buildChatDraftTarget,
  CHAT_PROJECT_LABEL,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import { useNodeCatalog } from "../environments/nodeCatalog";
import { useChatsAvailability } from "../hooks/useChatsAvailability";
import type { hostedDraftTargetController } from "../hooks/useHostedDraftExecutionTarget";
import { usePresentationTier } from "../hooks/usePresentationTier";
import { useProjectGroupingSettings } from "../hooks/useProjectGroupingSettings";
import { disclosureChevronClassName } from "../lib/disclosureMotion";
import { useGitStatus } from "../lib/gitStatusState";
import { newProjectId } from "../lib/utils";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  buildProjectSelectorRows,
  checkoutStatusMeta,
  countProjectsByNode,
  parseProjectSelectorQuery,
  projectRowSubline,
  projectSelectorParentIndex,
  projectSelectorValue,
  stripNodeTokens,
  type ProjectSelectorCheckout,
  type ProjectSelectorProject,
  type ProjectSelectorRow,
} from "./ProjectSwitcher.logic";
import { HighlightedText } from "./projectNodes/HighlightedText";
import { NodeBadge, NodePicker } from "./projectNodes/NodePicker";
import {
  openCopyProject,
  preloadProjectNodesDialogs,
} from "./projectNodes/projectNodesDialogStore";
import { ComboboxEmpty, ComboboxItem, ComboboxList, moveComboboxHighlight } from "./ui/combobox";
import { useHostedWorkspaceStatus, useProjectSelectorProjects } from "./useProjectSelectorProjects";

const NO_EXPANSION_TOGGLES: ReadonlyMap<string, boolean> = new Map();
const CLOSED_LIST: ProjectSelectorList = { items: [], value: null };
/** Never a catalog id: an `@` token that names no node checks no chip. */
const NO_NODE_VALUE = "\u0000no-node" as EnvironmentId;

export type ProjectSelectorKeyHandler = (event: KeyboardEvent<HTMLInputElement>) => void;

/** What the combobox around the body needs for its keyboard model and checked row. */
export interface ProjectSelectorList {
  /** The rows' values, top to bottom. */
  readonly items: ReadonlyArray<string>;
  /** The draft's own row (`projectSelectorValue`). */
  readonly value: string | null;
}

/**
 * Icons the list draws that live in the app shell's shared lucide chunks.
 * `ProjectSwitcher` hands them in: imported here, they would add this lazy
 * chunk to their importers, and the bundler would regroup those shared icon
 * chunks into one more file on the app shell's path (measured 2026-10-22).
 */
export interface ProjectSelectorIcons {
  readonly expand: LucideIcon;
  readonly branch: LucideIcon;
  readonly noProject: LucideIcon;
}

export interface ProjectSelectorBodyProps {
  readonly activeProjectId: ProjectId;
  readonly activeProjectEnvironmentId: EnvironmentId;
  readonly draftId: DraftId;
  readonly isChatDraft: boolean;
  /** The draft's checkout name, for "Copy <name> to another node…"; null hides copying. */
  readonly copyName: string | null;
  /** The search field's text; the field itself belongs to `ProjectSwitcher`. */
  readonly query: string;
  readonly onQueryChange: (update: (previous: string) => string) => void;
  readonly onListChange: (list: ProjectSelectorList) => void;
  /** Receives the search field's ←/→ handling while the body is mounted. */
  readonly keyHandlerRef: RefObject<ProjectSelectorKeyHandler | null>;
  readonly onClose: () => void;
  /**
   * `hostedDraftTargetController.beginProject`, handed in by `ProjectSwitcher`
   * (which the chat route already loads with the controller) so this lazy chunk
   * does not split the controller's module out of the route.
   */
  readonly beginHostedProjectMove: (typeof hostedDraftTargetController)["beginProject"];
  readonly icons: ProjectSelectorIcons;
}

/**
 * The selector's rows, node chips and footer. Mounted while the popup is open,
 * so its filters and expanded rows start fresh on every open, with the draft's
 * own project expanded.
 */
export function ProjectSelectorBody(props: ProjectSelectorBodyProps) {
  const {
    activeProjectId,
    activeProjectEnvironmentId,
    draftId,
    isChatDraft,
    query,
    onQueryChange,
    onListChange,
    keyHandlerRef,
    onClose,
    beginHostedProjectMove,
  } = props;
  const moveDraftThreadToProject = useComposerDraftStore((store) => store.moveDraftThreadToProject);
  const chatsAvailability = useChatsAvailability(activeProjectEnvironmentId);
  // A chat draft keeps its own entry even if the node stopped offering chats.
  const showNoProject = chatsAvailability.available || isChatDraft;
  const footerActions = usePresentationTier() !== "phone";
  const hostedStatus = useHostedWorkspaceStatus();
  const groupingSettings = useProjectGroupingSettings();
  const [chipNode, setChipNode] = useState<EnvironmentId | null>(null);
  // What the user expanded or collapsed this time; the draft's own project starts expanded.
  const [expansionToggles, setExpansionToggles] = useState(NO_EXPANSION_TOGGLES);

  const projects = useProjectSelectorProjects({
    enabled: true,
    currentEnvironmentId: activeProjectEnvironmentId,
  });
  const nodes = useNodeCatalog();
  const active = useMemo(
    () =>
      isChatDraft
        ? null
        : { environmentId: activeProjectEnvironmentId, projectId: activeProjectId },
    [activeProjectEnvironmentId, activeProjectId, isChatDraft],
  );
  const currentProjectKey = useMemo(
    () =>
      active === null
        ? null
        : (projects.find((project) =>
            project.checkouts.some(
              (checkout) =>
                checkout.environmentId === active.environmentId &&
                checkout.projectId === active.projectId,
            ),
          )?.key ?? null),
    [active, projects],
  );

  const parsedQuery = useMemo(() => parseProjectSelectorQuery(query, nodes), [nodes, query]);
  const nodeFilter = parsedQuery.node ?? chipNode;
  const expanded = useMemo(() => {
    const keys = new Set<string>();
    if (currentProjectKey !== null && expansionToggles.get(currentProjectKey) !== false) {
      keys.add(currentProjectKey);
    }
    for (const [key, isExpanded] of expansionToggles) if (isExpanded) keys.add(key);
    return keys;
  }, [currentProjectKey, expansionToggles]);
  const rows = useMemo(
    () =>
      buildProjectSelectorRows({
        projects,
        text: parsedQuery.text,
        nodeFilter,
        expanded,
        active,
        showNoProject,
      }),
    [active, expanded, nodeFilter, parsedQuery.text, projects, showNoProject],
  );
  const indexByItem = useMemo(
    () => new Map(rows.map((row, index) => [row.item, index] as const)),
    [rows],
  );
  useLayoutEffect(() => {
    onListChange({
      items: rows.map((row) => row.item),
      value: projectSelectorValue(rows, isChatDraft),
    });
  }, [isChatDraft, onListChange, rows]);
  // Closed, the combobox lists nothing. The next open builds its rows afresh,
  // so a selected index kept from these rows would put that open's first
  // highlight on another row.
  useLayoutEffect(() => () => onListChange(CLOSED_LIST), [onListChange]);
  const projectCountByNode = useMemo(() => countProjectsByNode(projects), [projects]);
  const chipExtras = useMemo(
    () =>
      Object.fromEntries(
        nodes.map((node) => [
          node.environmentId,
          { projectCount: projectCountByNode.get(node.environmentId) ?? 0 },
        ]),
      ),
    [nodes, projectCountByNode],
  );

  const toggleExpanded = useCallback((key: string, next: boolean) => {
    setExpansionToggles((previous) => new Map(previous).set(key, next));
  }, []);
  const moveToCheckout = useCallback(
    (project: ProjectSelectorProject, checkout: ProjectSelectorCheckout) => {
      if (checkout.unavailableReason !== null) return;
      onClose();
      if (
        !isChatDraft &&
        checkout.environmentId === activeProjectEnvironmentId &&
        checkout.projectId === activeProjectId
      ) {
        return;
      }
      if (hostedStatus !== "signed-out" && checkout.environmentId !== activeProjectEnvironmentId) {
        // Another Hub node: the controller routes there and commits the move
        // under that node's fresh mutation lease (its dialog shows progress).
        beginHostedProjectMove({
          draftId,
          sourceEnvironmentId: activeProjectEnvironmentId,
          sourceProjectId: activeProjectId,
          environmentId: checkout.environmentId,
          projectId: checkout.projectId,
          label: checkout.node.label,
          logicalKey: (target) => deriveLogicalProjectKeyFromSettings(target, groupingSettings),
        });
        return;
      }
      moveDraftThreadToProject(draftId, {
        projectRef: scopeProjectRef(checkout.environmentId, checkout.projectId),
        logicalProjectKey: project.key,
      });
    },
    [
      activeProjectEnvironmentId,
      activeProjectId,
      beginHostedProjectMove,
      draftId,
      groupingSettings,
      hostedStatus,
      isChatDraft,
      moveDraftThreadToProject,
      onClose,
    ],
  );
  const selectItem = useCallback(
    (item: string) => {
      const index = indexByItem.get(item);
      const row = index === undefined ? undefined : rows[index];
      if (!row) return;
      if (row.kind === "no-project") {
        onClose();
        if (!isChatDraft) {
          moveDraftThreadToProject(
            draftId,
            buildChatDraftTarget(activeProjectEnvironmentId, newProjectId()),
          );
        }
        return;
      }
      moveToCheckout(row.project, row.kind === "project" ? row.preferred : row.checkout);
    },
    [
      activeProjectEnvironmentId,
      draftId,
      indexByItem,
      isChatDraft,
      moveDraftThreadToProject,
      moveToCheckout,
      onClose,
      rows,
    ],
  );

  // → shows a project's checkout on every node, ← folds them (also from one of
  // its checkout rows, moving the highlight up to the project row first); only
  // at the matching end of the text, so the caret still moves through what was
  // typed.
  const handleInputKeyDown = useCallback<ProjectSelectorKeyHandler>(
    (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const input = event.currentTarget;
      const atEnd = input.selectionStart === input.value.length;
      const atStart = input.selectionEnd === 0;
      const highlighted = input
        .closest('[data-slot="combobox-popup"]')
        ?.querySelector<HTMLElement>("[data-highlighted][data-selector-item]")
        ?.getAttribute("data-selector-item");
      const index = highlighted ? indexByItem.get(highlighted) : undefined;
      const row = index === undefined ? undefined : rows[index];
      if (index === undefined || !row || row.kind === "no-project") return;
      if (event.key === "ArrowRight" && atEnd && row.kind === "project" && row.expandable) {
        if (row.expanded) return;
        event.preventDefault();
        toggleExpanded(row.project.key, true);
        return;
      }
      if (event.key === "ArrowLeft" && atStart) {
        const parentExpanded = row.kind === "checkout" || (row.expandable && row.expanded);
        if (!parentExpanded) return;
        event.preventDefault();
        const parentIndex = projectSelectorParentIndex(rows, index);
        if (parentIndex !== null) moveComboboxHighlight(input, parentIndex - index);
        toggleExpanded(row.project.key, false);
      }
    },
    [indexByItem, rows, toggleExpanded],
  );
  useLayoutEffect(() => {
    keyHandlerRef.current = handleInputKeyDown;
    return () => {
      if (keyHandlerRef.current === handleInputKeyDown) keyHandlerRef.current = null;
    };
  }, [handleInputKeyDown, keyHandlerRef]);

  const openAddProjectFromSelector = useCallback(() => {
    onClose();
    const environmentId = nodeFilter === "none" ? null : nodeFilter;
    useCommandPaletteStore.getState().openAddProject(environmentId ? { environmentId } : {});
  }, [nodeFilter, onClose]);
  const copyActiveProject = useCallback(() => {
    onClose();
    openCopyProject({
      source: scopeProjectRef(activeProjectEnvironmentId, activeProjectId),
      origin: "selector",
    });
  }, [activeProjectEnvironmentId, activeProjectId, onClose]);

  const showChips = nodes.length > 1;
  // Copying needs a real project and somewhere to copy it to.
  const showCopy = !isChatDraft && props.copyName !== null && nodes.length > 1;
  const highlightText = parsedQuery.text;

  return (
    <>
      {showChips ? (
        <div
          className="border-b px-2 py-[7px]"
          // A chip click keeps the caret in the search field.
          onMouseDownCapture={(event) => event.preventDefault()}
        >
          <NodePicker
            variant="chip"
            aria-label="Filter by node"
            nodes={nodes}
            extras={chipExtras}
            requirements={{ requireMutate: false, allowOffline: true }}
            value={nodeFilter === "none" ? NO_NODE_VALUE : nodeFilter}
            onValueChange={(environmentId) => {
              setChipNode(environmentId);
              onQueryChange(stripNodeTokens);
            }}
            allOption={{
              count: projects.length,
              onSelect: () => {
                setChipNode(null);
                onQueryChange(stripNodeTokens);
              },
            }}
          />
        </div>
      ) : null}
      <ComboboxEmpty className="not-empty:px-[18px] not-empty:py-[18px] text-[12.5px]">
        <SelectorEmptyState
          text={parsedQuery.text}
          nodeLabel={
            nodeFilter && nodeFilter !== "none"
              ? (nodes.find((node) => node.environmentId === nodeFilter)?.label ?? null)
              : null
          }
          onAddProject={footerActions ? openAddProjectFromSelector : null}
        />
      </ComboboxEmpty>
      <ComboboxList className="max-h-[300px] not-empty:p-1">
        {rows.map((row, index) => (
          <SelectorRow
            key={row.item}
            row={row}
            index={index}
            highlightText={highlightText}
            icons={props.icons}
            onSelect={selectItem}
            onToggleExpanded={toggleExpanded}
          />
        ))}
      </ComboboxList>
      {footerActions ? (
        <div className="flex gap-0.5 border-t p-1">
          <FooterAction icon={PlusIcon} label="Add project…" onClick={openAddProjectFromSelector} />
          {showCopy ? (
            <FooterAction
              icon={CopyIcon}
              label={`Copy ${props.copyName} to another node…`}
              onClick={copyActiveProject}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function SelectorEmptyState(props: {
  readonly text: string;
  readonly nodeLabel: string | null;
  readonly onAddProject: (() => void) | null;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5">
      <span>
        No project matches{props.text ? ` “${props.text}”` : ""}
        {props.nodeLabel ? ` on ${props.nodeLabel}` : ""}.
      </span>
      {props.onAddProject ? (
        <button
          type="button"
          className="inline-flex items-center gap-[5px] rounded-lg border border-border px-[9px] py-[3px] font-medium text-[11.5px] text-foreground transition-colors hover:bg-accent"
          onPointerEnter={preloadProjectNodesDialogs}
          onClick={props.onAddProject}
        >
          <PlusIcon aria-hidden className="size-3" />
          Add one from a node…
        </button>
      ) : null}
    </div>
  );
}

function FooterAction(props: {
  readonly icon: typeof PlusIcon;
  readonly label: string;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-center gap-[7px] rounded-[7px] px-2 py-[7px] text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onPointerEnter={preloadProjectNodesDialogs}
      onFocus={preloadProjectNodesDialogs}
      onClick={props.onClick}
    >
      <Icon aria-hidden className="size-[13px] shrink-0" />
      <span className="truncate">{props.label}</span>
    </button>
  );
}

// The draft's project (or "No project") row is the combobox value, so Base UI
// marks it selected for assistive tech; on screen only its bold name says
// "current". The item's selected tint would sit at rest like a keyboard
// highlight, and highlighted it would differ from every other row's.
const ROW_CLASS_NAME = cn(
  "min-h-0 cursor-pointer rounded-[8px] py-1.5 ps-2 pe-1 text-[13px] sm:min-h-0 sm:text-[13px]",
  "data-selected:bg-transparent [&[data-highlighted][data-selected]]:bg-accent/80",
  "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:hover:bg-transparent",
);

function SelectorRow(props: {
  readonly row: ProjectSelectorRow;
  readonly index: number;
  readonly highlightText: string;
  readonly icons: ProjectSelectorIcons;
  readonly onSelect: (item: string) => void;
  readonly onToggleExpanded: (key: string, expanded: boolean) => void;
}) {
  const { row, index, highlightText, onSelect } = props;
  if (row.kind === "no-project") {
    return (
      <ComboboxItem
        hideIndicator
        index={index}
        value={row.item}
        data-selector-item={row.item}
        data-testid="project-switcher-no-project"
        className={ROW_CLASS_NAME}
        contentClassName="flex min-w-0 items-center gap-[9px]"
        onClick={() => onSelect(row.item)}
      >
        <span className="grid size-[18px] shrink-0 place-items-center text-muted-foreground">
          <props.icons.noProject aria-hidden className="size-[15px]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{CHAT_PROJECT_LABEL}</span>
          <span className="truncate text-[11.5px] text-muted-foreground">
            A chat in its own folder · turn it into a project later
          </span>
        </span>
        <span aria-hidden className="w-[22px] shrink-0" />
      </ComboboxItem>
    );
  }
  if (row.kind === "checkout") return <CheckoutRow {...props} row={row} />;
  const { project, preferred } = row;
  const subline = projectRowSubline(row);
  const disabledReason =
    row.checkouts.every((checkout) => checkout.unavailableReason !== null) &&
    preferred.unavailableReason !== null
      ? preferred.unavailableReason
      : null;
  return (
    <ComboboxItem
      hideIndicator
      index={index}
      value={row.item}
      data-selector-item={row.item}
      disabled={disabledReason !== null}
      title={disabledReason ?? undefined}
      // → and ← (or the chevron) show and fold the project's checkout on each node.
      aria-expanded={row.expandable ? row.expanded : undefined}
      data-current={row.current ? "" : undefined}
      className={ROW_CLASS_NAME}
      contentClassName="flex min-w-0 items-center gap-[9px]"
      onClick={() => {
        if (disabledReason === null) onSelect(row.item);
      }}
    >
      <ProjectFavicon
        environmentId={project.favicon.environmentId}
        cwd={project.favicon.cwd}
        projectId={project.favicon.projectId}
        customAvatarContentHash={project.favicon.customAvatarContentHash}
        fallbackName={project.name}
        className="size-[18px] shrink-0 rounded-[5px]"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate", row.current && "font-semibold")}>
          <HighlightedText text={project.name} query={highlightText} />
        </span>
        <span className="truncate text-[11.5px] text-muted-foreground">
          {subline.lead}
          <span className="font-mono text-[11.5px]">
            <HighlightedText text={subline.path} query={highlightText} />
          </span>
        </span>
      </span>
      <span className="flex shrink-0 gap-[3px]">
        {uniqueCheckoutNodes(row.checkouts).map((checkout) => (
          <span key={checkout.environmentId} title={`${checkout.node.label} · ${checkout.path}`}>
            <NodeBadge node={checkout.node} size="sm" />
          </span>
        ))}
      </span>
      {row.expandable ? (
        <span
          aria-hidden
          data-testid="project-selector-expand"
          title={row.expanded ? "Hide paths on each node" : "Show paths on each node"}
          className="inline-grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleExpanded(project.key, !row.expanded);
          }}
        >
          <props.icons.expand className={disclosureChevronClassName(row.expanded, "size-3.5")} />
        </span>
      ) : (
        <span aria-hidden className="w-[22px] shrink-0" />
      )}
    </ComboboxItem>
  );
}

/** One badge per node, in checkout order. */
function uniqueCheckoutNodes(
  checkouts: ReadonlyArray<ProjectSelectorCheckout>,
): ProjectSelectorCheckout[] {
  const seen = new Set<EnvironmentId>();
  return checkouts.filter((checkout) => {
    if (seen.has(checkout.environmentId)) return false;
    seen.add(checkout.environmentId);
    return true;
  });
}

function CheckoutRow(props: {
  readonly row: Extract<ProjectSelectorRow, { kind: "checkout" }>;
  readonly index: number;
  readonly highlightText: string;
  readonly icons: ProjectSelectorIcons;
  readonly onSelect: (item: string) => void;
}) {
  const { row, index, highlightText, onSelect } = props;
  const { checkout } = row;
  const unavailable = checkout.unavailableReason !== null;
  return (
    <ComboboxItem
      hideIndicator
      index={index}
      value={row.item}
      data-selector-item={row.item}
      disabled={unavailable}
      title={checkout.unavailableReason ?? checkout.cwd}
      data-testid="project-selector-checkout"
      className={cn(
        "relative ms-[30px] me-1 mb-px min-h-0 cursor-pointer rounded-[7px] px-2 py-[5px] text-[12px] sm:min-h-0 sm:text-[12px]",
        "before:pointer-events-none before:absolute before:-start-3 before:-top-px before:-bottom-px before:border-border before:border-s",
        "data-selected:bg-primary/10 data-selected:text-foreground dark:data-selected:bg-primary/16 [&[data-highlighted][data-selected]]:bg-primary/14 dark:[&[data-highlighted][data-selected]]:bg-primary/22",
        "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:hover:bg-transparent",
      )}
      contentClassName="grid min-w-0 grid-cols-[16px_92px_minmax(84px,1fr)_auto_14px] items-center gap-2 max-sm:grid-cols-[16px_minmax(0,1fr)_auto_14px]"
      onClick={() => {
        if (!unavailable) onSelect(row.item);
      }}
    >
      <NodeBadge node={checkout.node} size="sm" />
      <span className="truncate">{checkout.node.label}</span>
      <span
        className={cn(
          "truncate font-mono text-[11.5px] text-muted-foreground max-sm:hidden",
          row.current && "text-inherit opacity-80",
        )}
      >
        <HighlightedText text={checkout.path} query={highlightText} />
      </span>
      <CheckoutMeta checkout={checkout} current={row.current} branchIcon={props.icons.branch} />
      {row.current ? <CheckIcon aria-hidden className="size-[13px]" /> : <span aria-hidden />}
    </ComboboxItem>
  );
}

/** Reads the status atom without watching it: no status stream opens, no scope is retained. */
const LOADED_FULL_STATUS = { enabled: false } as const;
const LOADED_SUMMARY_STATUS = { enabled: false, view: "summary" } as const;

/**
 * Branch, uncommitted changes and commits behind, from VCS status some other
 * surface already loaded for this checkout (its full view, else its summary
 * view). It never starts a status watch, so listing many checkouts on many
 * nodes asks no node for anything.
 */
function CheckoutMeta(props: {
  readonly checkout: ProjectSelectorCheckout;
  readonly current: boolean;
  readonly branchIcon: LucideIcon;
}) {
  const { checkout } = props;
  const target = { environmentId: checkout.environmentId, cwd: checkout.cwd };
  const full = useGitStatus(target, LOADED_FULL_STATUS);
  const summary = useGitStatus(target, LOADED_SUMMARY_STATUS);
  const meta = full.data
    ? checkoutStatusMeta(full.data, { view: "full", remoteKnown: full.remotePending !== true })
    : summary.data
      ? checkoutStatusMeta(summary.data, { view: "summary", remoteKnown: false })
      : null;
  const offline = checkout.node.presence === "offline";
  return (
    <span
      className={cn(
        "flex max-w-[190px] items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground",
        props.current && "text-inherit",
      )}
    >
      {offline ? <span className="shrink-0">offline</span> : null}
      {meta?.branch ? (
        // The branch gives way first: the counts stay whole.
        <span className="inline-flex min-w-0 max-w-[104px] items-center gap-[3px] font-mono">
          <props.branchIcon aria-hidden className="size-2.5 shrink-0" />
          <span className="truncate">{meta.branch}</span>
        </span>
      ) : null}
      {meta?.changed ? <span className="shrink-0 text-warning">{meta.changed} changed</span> : null}
      {meta?.behind ? <span className="shrink-0">↓{meta.behind}</span> : null}
    </span>
  );
}
