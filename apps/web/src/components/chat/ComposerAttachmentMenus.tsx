import { usePresentationTier } from "../../hooks/usePresentationTier";
import type {
  ChangeRequest,
  ComposerSourceControlContext,
  EnvironmentId,
  ProjectEntry,
  ProviderDriverKind,
  ScopedThreadRef,
  ServerProvider,
  SourceControlIssueSummary,
} from "@ryco/contracts";
import { DateTime } from "effect";
import { useCallback, useMemo } from "react";

import type { ComposerTrigger } from "../../composer-logic";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useWorkspacePathSearch } from "~/rpc/useProject";
import {
  fetchSourceControlChangeRequestDetail,
  fetchSourceControlIssueDetail,
  useSourceControlChangeRequestList,
  useSourceControlIssueList,
} from "~/rpc/useSourceControl";
import { buildScopedSourceControlComposerItems } from "./composerSourceControlItems";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { type ComposerMenuEmptyState, resolveComposerPathMenuEmptyState } from "./composerPathMenu";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { searchProviderSkills } from "../../providerSkillSearch";
import { basenameOfPath } from "../../pathEntry";
import { randomUUID } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";

/** The `#` picker shows open issues and PRs from the shared superset list, sliced to this. */
const COMPOSER_SOURCE_CONTROL_LIST_LIMIT = 50;
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];

export interface UseComposerAttachmentMenusParams {
  composerTrigger: ComposerTrigger | null;
  environmentId: EnvironmentId;
  gitCwd: string | null;
  selectedProvider: ProviderDriverKind;
  selectedProviderStatus: ServerProvider | null;
  composerHighlightedItemId: string | null;
  composerHighlightedSearchKey: string | null;
}

export interface ComposerAttachmentMenusState {
  composerMenuItems: ComposerCommandItem[];
  composerMenuOpen: boolean;
  composerMenuSearchKey: string | null;
  activeComposerMenuItem: ComposerCommandItem | null;
  isComposerMenuLoading: boolean;
  composerMenuEmptyState: ComposerMenuEmptyState;
}

/**
 * Owns the inline composer trigger menu derivation: the `@`/path file picker
 * query, the `#` issue/PR source-control queries, and the unified menu item
 * list (paths, slash commands, provider commands, skills, source control).
 *
 * Kept separate from `ChatComposer` so the editor wiring and layout stay
 * focused; this hook is behavior-preserving and returns the same derived
 * values that were previously computed inline.
 */
export function useComposerAttachmentMenus(
  params: UseComposerAttachmentMenusParams,
): ComposerAttachmentMenusState {
  const {
    composerTrigger,
    environmentId,
    gitCwd,
    selectedProvider,
    selectedProviderStatus,
    composerHighlightedItemId,
    composerHighlightedSearchKey,
  } = params;

  const presentationTier = usePresentationTier();
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const {
    results: pathResults,
    requestsSearch: requestsPathSearch,
    isLoading: isPathSearchLoading,
    hasResults: hasPathResults,
    error: pathSearchError,
    retry: retryPathSearch,
  } = useWorkspacePathSearch({
    environmentId,
    cwd: gitCwd,
    query: pathTriggerQuery,
    enabled: composerTriggerKind === "path",
  });
  const workspaceEntries = pathResults?.entries ?? EMPTY_PROJECT_ENTRIES;

  const isSourceControlTrigger = composerTriggerKind === "source-control";
  const issueListQuery = useSourceControlIssueList({
    environmentId,
    cwd: gitCwd,
    state: "open",
    limit: COMPOSER_SOURCE_CONTROL_LIST_LIMIT,
    enabled: isSourceControlTrigger,
  });
  // The menu shows number, title and state: lean rows, not the full list's checks and labels.
  const changeRequestListQuery = useSourceControlChangeRequestList({
    environmentId,
    cwd: gitCwd,
    state: "open",
    limit: COMPOSER_SOURCE_CONTROL_LIST_LIMIT,
    view: "picker",
    enabled: isSourceControlTrigger,
  });

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        ...(window.desktopBridge?.computerBeta && presentationTier !== "phone"
          ? [
              {
                id: "slash:computer-use",
                type: "slash-command" as const,
                command: "computer-use" as const,
                label: "/computer-use",
                description: "Use this Mac for one task",
              },
            ]
          : []),
        ...(presentationTier !== "phone"
          ? [
              {
                id: "slash:btw",
                type: "slash-command" as const,
                command: "btw" as const,
                label: "/btw",
                description: "Ask a read-only side question while the main turn continues",
              },
            ]
          : []),
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        {
          id: "slash:goal",
          type: "slash-command",
          command: "goal",
          label: "/goal",
          description: "Set a persistent goal for this thread",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal build mode",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const providerSlashCommandItems = (selectedProviderStatus?.slashCommands ?? []).map(
        (command) => ({
          id: `provider-slash-command:${selectedProvider}:${command.name}`,
          type: "provider-slash-command" as const,
          provider: selectedProvider,
          command,
          label: `/${command.name}`,
          description: command.description ?? command.input?.hint ?? "Run provider command",
        }),
      );
      const query = composerTrigger.query.trim().toLowerCase();
      const slashCommandItems = [...builtInSlashCommandItems, ...providerSlashCommandItems];
      if (!query) {
        return slashCommandItems;
      }
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderStatus?.skills ?? [], composerTrigger.query).map(
        (skill) => ({
          id: `skill:${selectedProvider}:${skill.name}`,
          type: "skill" as const,
          provider: selectedProvider,
          skill,
          label: formatProviderSkillDisplayName(skill),
          description:
            skill.shortDescription ??
            skill.description ??
            (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
        }),
      );
    }
    if (composerTrigger.kind === "source-control") {
      return [
        ...buildScopedSourceControlComposerItems(composerTrigger.query, {
          issues: issueListQuery.data ?? [],
          prs: changeRequestListQuery.data ?? [],
        }),
      ];
    }
    return [];
  }, [
    presentationTier,
    composerTrigger,
    issueListQuery.data,
    changeRequestListQuery.data,
    selectedProvider,
    selectedProviderStatus,
    workspaceEntries,
  ]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  const isComposerMenuLoading =
    isPathSearchLoading ||
    (composerTriggerKind === "source-control" &&
      (issueListQuery.isLoading || changeRequestListQuery.isLoading));

  const pathResultsArePartial = pathResults?.partial === true;
  const composerMenuEmptyState = useMemo<ComposerMenuEmptyState>(() => {
    if (composerTriggerKind === "skill") {
      return { text: "No skills found. Try / to browse provider commands." };
    }
    if (composerTriggerKind === "source-control") {
      return { text: "No matching issues or pull requests." };
    }
    if (composerTriggerKind !== "path") {
      return { text: "No matching command." };
    }
    return resolveComposerPathMenuEmptyState({
      requestsSearch: requestsPathSearch,
      triggerQuery: pathTriggerQuery,
      hasResults: hasPathResults,
      error: pathSearchError,
      partial: pathResultsArePartial,
      onRetry: retryPathSearch,
    });
  }, [
    composerTriggerKind,
    hasPathResults,
    pathResultsArePartial,
    pathSearchError,
    pathTriggerQuery,
    requestsPathSearch,
    retryPathSearch,
  ]);

  return {
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
    activeComposerMenuItem,
    isComposerMenuLoading,
    composerMenuEmptyState,
  };
}

export interface UseComposerSourceControlContextSelectionParams {
  environmentId: EnvironmentId;
  gitCwd: string | null;
  composerDraftTarget: ScopedThreadRef | DraftId;
  addSourceControlContext: (
    target: ScopedThreadRef | DraftId,
    context: ComposerSourceControlContext,
  ) => { added: boolean; reason?: "duplicate" };
}

export interface ComposerSourceControlContextSelection {
  handleSelectIssue: (issue: SourceControlIssueSummary) => Promise<void>;
  handleSelectChangeRequest: (cr: ChangeRequest) => Promise<void>;
}

const SOURCE_CONTROL_CONTEXT_FRESH_MS = 5 * 60 * 1000;

/**
 * Detail stand-in built from the list summary, so the chip appears at once.
 * Its `staleAfter` is already due: a send before the real detail arrives
 * re-fetches it like any stale context.
 */
function summaryContextDetail(
  summary: SourceControlIssueSummary | ChangeRequest,
): ComposerSourceControlContext["detail"] {
  return { ...summary, body: "", comments: [], truncated: false };
}

/**
 * Owns fetch-and-attach for the `#` source-control context picker. The chip is
 * attached immediately from the picked summary; the issue / PR detail loads in
 * the background and replaces it (the detail cache keeps it warm for sends).
 * Duplicates toast, and a failed detail fetch removes the chip with an error.
 */
export function useComposerSourceControlContextSelection(
  params: UseComposerSourceControlContextSelectionParams,
): ComposerSourceControlContextSelection {
  const { environmentId, gitCwd, composerDraftTarget, addSourceControlContext } = params;
  const updateSourceControlContext = useComposerDraftStore(
    (store) => store.updateSourceControlContext,
  );
  const removeSourceControlContext = useComposerDraftStore(
    (store) => store.removeSourceControlContext,
  );

  const attachSourceControlContext = useCallback(
    async (input: {
      readonly kind: ComposerSourceControlContext["kind"];
      readonly summary: SourceControlIssueSummary | ChangeRequest;
      readonly fetchDetail: () => Promise<ComposerSourceControlContext["detail"]>;
    }) => {
      const { kind, summary } = input;
      const reference = `${summary.provider}#${summary.number}`;
      const attachedAt = DateTime.fromDateUnsafe(new Date());
      const id = randomUUID();
      const result = addSourceControlContext(composerDraftTarget, {
        id,
        kind,
        provider: summary.provider,
        reference,
        detail: summaryContextDetail(summary),
        fetchedAt: attachedAt,
        staleAfter: attachedAt,
      });
      if (!result.added) {
        if (result.reason === "duplicate") {
          toastManager.add({ type: "info", title: "Already attached." });
        }
        return;
      }
      try {
        const detail = await input.fetchDetail();
        updateSourceControlContext(composerDraftTarget, id, {
          detail,
          fetchedAt: DateTime.fromDateUnsafe(new Date()),
          staleAfter: DateTime.fromDateUnsafe(
            new Date(Date.now() + SOURCE_CONTROL_CONTEXT_FRESH_MS),
          ),
        });
      } catch (err) {
        removeSourceControlContext(composerDraftTarget, id);
        const message = err instanceof Error ? err.message : "unknown error";
        toastManager.add({
          type: "error",
          title: `Couldn't fetch ${reference}: ${message}`,
        });
      }
    },
    [
      addSourceControlContext,
      composerDraftTarget,
      removeSourceControlContext,
      updateSourceControlContext,
    ],
  );

  const handleSelectIssue = useCallback(
    async (issue: SourceControlIssueSummary) => {
      if (!environmentId || !gitCwd) return;
      await attachSourceControlContext({
        kind: "issue",
        summary: issue,
        fetchDetail: () =>
          fetchSourceControlIssueDetail({
            environmentId,
            cwd: gitCwd,
            reference: String(issue.number),
          }),
      });
    },
    [attachSourceControlContext, environmentId, gitCwd],
  );

  const handleSelectChangeRequest = useCallback(
    async (cr: ChangeRequest) => {
      if (!environmentId || !gitCwd) return;
      await attachSourceControlContext({
        kind: "change-request",
        summary: cr,
        fetchDetail: () =>
          fetchSourceControlChangeRequestDetail({
            environmentId,
            cwd: gitCwd,
            reference: String(cr.number),
          }),
      });
    },
    [attachSourceControlContext, environmentId, gitCwd],
  );

  return { handleSelectIssue, handleSelectChangeRequest };
}

export interface ComposerCommandMenuOverlayProps {
  open: boolean;
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTrigger["kind"] | null;
  groupSlashCommandSections: boolean;
  emptyState: ComposerMenuEmptyState;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}

/**
 * Floating popover wrapper that anchors the composer command menu above the
 * editor. Returns `null` while closed so callers can render it unconditionally.
 */
export function ComposerCommandMenuOverlay(props: ComposerCommandMenuOverlayProps) {
  if (!props.open) return null;
  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
      <ComposerCommandMenu
        items={props.items}
        resolvedTheme={props.resolvedTheme}
        isLoading={props.isLoading}
        triggerKind={props.triggerKind}
        groupSlashCommandSections={props.groupSlashCommandSections}
        emptyStateText={props.emptyState.text}
        loadingText={props.emptyState.loadingText}
        errorText={props.emptyState.errorText}
        onRetry={props.emptyState.onRetry}
        footnote={props.emptyState.footnote}
        activeItemId={props.activeItemId}
        onHighlightedItemChange={props.onHighlightedItemChange}
        onSelect={props.onSelect}
      />
    </div>
  );
}
