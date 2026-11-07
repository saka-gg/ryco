// Wires the composer's autocomplete to the node: the caret decides the trigger
// (`detectComposerTrigger`), the selected provider instance supplies commands
// and skills (plus the project's own, read on the first `/` or `$` like the web
// composer does), and `@` searches the workspace and this node's threads.
import {
  detectComposerTrigger,
  ensureProjectProviderCommands,
  mergeProjectProviderCommands,
  projectProviderCommandsKey,
  projectProviderCommandsSupported,
  readProjectProviderCommands,
  subscribeProjectProviderCommands,
  type ComposerTrigger,
} from "@ryco/client-runtime/state/composer";
import type {
  EnvironmentId,
  ProjectEntry,
  ServerConfig,
  ServerProvider,
  ThreadId,
} from "@ryco/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import { readEnvironmentApi } from "../../connection/environmentApi";
import type { ComposerEditorSelection } from "../../native/ComposerEditor";
import { useProjectListEntries, useProjectSearchEntries } from "../../rpc/useProjectFiles";
import { useHomeWorkspaceData } from "../../state/homeData";
import {
  buildComposerCommandItems,
  resolveComposerCommandSelection,
  type ComposerCommandAction,
  type ComposerCommandItem,
  type ComposerCommandOffers,
} from "./composerCommandMenuModel";

/** Top-level workspace rows a bare `@` lists before the user types a name. */
const BARE_MENTION_MAX_ENTRIES = 30;
const EMPTY_ENTRIES: ReadonlyArray<ProjectEntry> = [];

export interface ComposerCommandMenuContext {
  readonly environmentId: EnvironmentId;
  /** The directory the agent works in; `@` files are searched there. */
  readonly workspaceRoot: string | null;
  readonly serverConfig: ServerConfig | null;
  /** The provider instance the next message goes to. */
  readonly providerInstanceId: string | null;
  /** The thread being written in, left out of its own `@` thread rows. */
  readonly currentThreadId: ThreadId | null;
}

export interface ComposerCommandMenu {
  readonly selection: ComposerEditorSelection;
  readonly onSelectionChange: (selection: ComposerEditorSelection) => void;
  readonly trigger: ComposerTrigger | null;
  readonly items: ReadonlyArray<ComposerCommandItem>;
  readonly isLoading: boolean;
  readonly skills: ServerProvider["skills"];
  /** This node's thread titles by id, for the chips of `@thread:` mentions. */
  readonly threadTitles: ReadonlyMap<string, string>;
  readonly onSelect: (item: ComposerCommandItem) => void;
}

export function useComposerCommandMenu(input: {
  readonly text: string;
  readonly onChangeText: (text: string) => void;
  readonly context: ComposerCommandMenuContext | null;
  readonly offers: ComposerCommandOffers;
  readonly enabled: boolean;
  readonly onAction: (action: ComposerCommandAction) => void;
}): ComposerCommandMenu {
  const { text, context } = input;
  const [rawSelection, setSelection] = useState<ComposerEditorSelection>(() => ({
    start: text.length,
    end: text.length,
  }));
  // A draft replaced from outside (a queued message pulled back, a send that
  // cleared it) can leave the caret past its end.
  const selection = {
    start: Math.min(rawSelection.start, text.length),
    end: Math.min(rawSelection.end, text.length),
  };

  const trigger =
    input.enabled && context && selection.start === selection.end
      ? detectComposerTrigger(text, selection.end)
      : null;

  const environmentId = context?.environmentId ?? null;
  const workspaceRoot = context?.workspaceRoot ?? null;
  const instanceId = context?.providerInstanceId ?? null;
  const serverConfig = context?.serverConfig ?? null;
  const provider = instanceId
    ? (serverConfig?.providers.find((entry) => entry.instanceId === instanceId) ?? null)
    : null;

  const wantsProjectCommands = trigger?.kind === "slash-command" || trigger?.kind === "skill";
  const commandsSupported = projectProviderCommandsSupported(serverConfig);
  useEffect(() => {
    if (!wantsProjectCommands || !environmentId || !workspaceRoot || !provider) return;
    ensureProjectProviderCommands({
      api: readEnvironmentApi(environmentId),
      supported: commandsSupported,
      environmentId,
      instanceId: provider.instanceId,
      cwd: workspaceRoot,
    });
  }, [commandsSupported, environmentId, provider, wantsProjectCommands, workspaceRoot]);
  const projectCommandsKey =
    environmentId && workspaceRoot && provider
      ? projectProviderCommandsKey({
          environmentId,
          instanceId: provider.instanceId,
          cwd: workspaceRoot,
        })
      : null;
  const projectCommands = useSyncExternalStore(subscribeProjectProviderCommands, () =>
    projectCommandsKey ? readProjectProviderCommands(projectCommandsKey) : undefined,
  );
  const commands = mergeProjectProviderCommands(
    { skills: provider?.skills ?? [], slashCommands: provider?.slashCommands ?? [] },
    projectCommands,
  );

  const pathQuery = trigger?.kind === "path" ? trigger.query : "";
  const wantsPaths = trigger?.kind === "path";
  const listing = useProjectListEntries({
    environmentId,
    cwd: workspaceRoot,
    enabled: wantsPaths && pathQuery.trim().length === 0,
  });
  const search = useProjectSearchEntries({
    environmentId,
    cwd: workspaceRoot,
    query: pathQuery,
    enabled: wantsPaths,
  });
  const pathEntries = !wantsPaths
    ? EMPTY_ENTRIES
    : pathQuery.trim().length === 0
      ? (listing.data?.entries ?? EMPTY_ENTRIES)
          .filter((entry) => !entry.path.includes("/"))
          .slice(0, BARE_MENTION_MAX_ENTRIES)
      : (search.data?.entries ?? EMPTY_ENTRIES);

  const { threads: allThreads } = useHomeWorkspaceData();
  const threads = allThreads.filter((thread) => thread.environmentId === environmentId);
  const threadTitles = new Map(threads.map((thread) => [String(thread.id), thread.title]));

  const items = buildComposerCommandItems({
    trigger,
    slashCommands: commands.slashCommands,
    skills: commands.skills,
    offers: input.offers,
    threads: wantsPaths ? threads : [],
    currentThreadId: context?.currentThreadId ?? null,
    pathEntries,
  });

  const isLoading = wantsPaths
    ? pathQuery.trim().length === 0
      ? listing.isLoading
      : search.isLoading || search.isDebouncing
    : false;

  const onSelect = (item: ComposerCommandItem) => {
    if (!trigger) return;
    const result = resolveComposerCommandSelection({ draft: text, trigger, item });
    setSelection({ start: result.cursor, end: result.cursor });
    input.onChangeText(result.text);
    if (result.action) input.onAction(result.action);
  };

  return {
    selection,
    onSelectionChange: setSelection,
    trigger,
    items,
    isLoading,
    skills: commands.skills,
    threadTitles,
    onSelect,
  };
}
