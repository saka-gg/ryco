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
import { useDebouncedValue } from "@tanstack/react-pacer";
import { DateTime } from "effect";
import { useCallback, useMemo } from "react";

import type { ComposerTrigger } from "../../composer-logic";
import type { DraftId } from "../../composerDraftStore";
import { useProjectSearchEntries } from "~/rpc/useProject";
import {
  fetchSourceControlChangeRequestDetail,
  fetchSourceControlIssueDetail,
  useSourceControlChangeRequestList,
  useSourceControlIssueList,
} from "~/rpc/useSourceControl";
import { buildScopedSourceControlComposerItems } from "./composerSourceControlItems";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { searchProviderSkills } from "../../providerSkillSearch";
import { basenameOfPath } from "../../pathEntry";
import { randomUUID } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
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
  composerMenuEmptyState: string;
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
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const workspaceEntriesQuery = useProjectSearchEntries({
    environmentId,
    cwd: gitCwd,
    query: effectivePathQuery,
    enabled: isPathTrigger,
    limit: 80,
  });
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  const isSourceControlTrigger = composerTriggerKind === "source-control";
  const issueListQuery = useSourceControlIssueList({
    environmentId,
    cwd: gitCwd,
    state: "open",
    limit: 50,
    enabled: isSourceControlTrigger,
  });
  const changeRequestListQuery = useSourceControlChangeRequestList({
    environmentId,
    cwd: gitCwd,
    state: "open",
    limit: 50,
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
    (composerTriggerKind === "path" &&
      ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching)) ||
    (composerTriggerKind === "source-control" &&
      (issueListQuery.isLoading || changeRequestListQuery.isLoading));

  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    if (composerTriggerKind === "source-control") {
      return "No matching issues or pull requests.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  }, [composerTriggerKind]);

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

/**
 * Owns fetch-and-attach for the `#` source-control context picker. Resolves
 * issue / PR detail on selection and appends it to the composer draft, with
 * duplicate detection and error toasts. Behavior-preserving extraction from
 * `ChatComposer`.
 */
export function useComposerSourceControlContextSelection(
  params: UseComposerSourceControlContextSelectionParams,
): ComposerSourceControlContextSelection {
  const { environmentId, gitCwd, composerDraftTarget, addSourceControlContext } = params;

  const handleSelectIssue = useCallback(
    async (issue: SourceControlIssueSummary) => {
      if (!environmentId || !gitCwd) return;
      const reference = `${issue.provider}#${issue.number}`;
      try {
        const detail = await fetchSourceControlIssueDetail({
          environmentId,
          cwd: gitCwd,
          reference: String(issue.number),
        });
        const now = DateTime.fromDateUnsafe(new Date());
        const staleAfter = DateTime.fromDateUnsafe(new Date(Date.now() + 5 * 60 * 1000));
        const context: ComposerSourceControlContext = {
          id: randomUUID(),
          kind: "issue",
          provider: issue.provider,
          reference,
          detail,
          fetchedAt: now,
          staleAfter,
        };
        const result = addSourceControlContext(composerDraftTarget, context);
        if (!result.added && result.reason === "duplicate") {
          toastManager.add({ type: "info", title: "Already attached." });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        toastManager.add({
          type: "error",
          title: `Couldn't fetch ${reference}: ${message}`,
        });
      }
    },
    [environmentId, gitCwd, composerDraftTarget, addSourceControlContext],
  );

  const handleSelectChangeRequest = useCallback(
    async (cr: ChangeRequest) => {
      if (!environmentId || !gitCwd) return;
      const reference = `${cr.provider}#${cr.number}`;
      try {
        const detail = await fetchSourceControlChangeRequestDetail({
          environmentId,
          cwd: gitCwd,
          reference: String(cr.number),
        });
        const now = DateTime.fromDateUnsafe(new Date());
        const staleAfter = DateTime.fromDateUnsafe(new Date(Date.now() + 5 * 60 * 1000));
        const context: ComposerSourceControlContext = {
          id: randomUUID(),
          kind: "change-request",
          provider: cr.provider,
          reference,
          detail,
          fetchedAt: now,
          staleAfter,
        };
        const result = addSourceControlContext(composerDraftTarget, context);
        if (!result.added && result.reason === "duplicate") {
          toastManager.add({ type: "info", title: "Already attached." });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        toastManager.add({
          type: "error",
          title: `Couldn't fetch ${reference}: ${message}`,
        });
      }
    },
    [environmentId, gitCwd, composerDraftTarget, addSourceControlContext],
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
  emptyStateText: string;
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
        emptyStateText={props.emptyStateText}
        activeItemId={props.activeItemId}
        onHighlightedItemChange={props.onHighlightedItemChange}
        onSelect={props.onSelect}
      />
    </div>
  );
}
