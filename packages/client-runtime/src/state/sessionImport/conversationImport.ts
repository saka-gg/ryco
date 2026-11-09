// Conversation-level import of Codex and Claude Code history from one node:
// choose the source and its store, search a page at a time, select
// conversations, choose the project and who continues them, run the import
// one conversation at a time, and recover quarantined items by inspecting the
// copies the node already holds and adopting the one it proves. The web
// Settings panel and the phone's per-machine screen share this one flow; each
// only renders the snapshot and the view below.
//
// Every request belongs to a generation. Changing the source or store, losing
// (or regaining) access, or disposing starts a new one, and an answer from an
// older generation changes nothing.

import type {
  SessionImportCandidate,
  SessionImportRecovery,
  SessionImportSource,
  SessionImportStore,
} from "@ryco/contracts";
import { ProjectId } from "@ryco/contracts/base-schemas";
import { ProviderInstanceId } from "@ryco/contracts/provider-instance";

import type { WsRpcClient } from "../../rpc/wsRpcClient.ts";
import {
  resolveSessionImportContinuation,
  sessionImportContinuationProviders,
  type SessionImportContinuationProvider,
} from "./continuation.ts";

/** A node's import calls. */
export type SessionImportClient = WsRpcClient["sessionImport"];

/** A project on the node that can receive imported conversations. */
export interface ConversationImportProject {
  readonly id: string;
  readonly name: string;
}

export interface ConversationImportState {
  readonly source: SessionImportSource;
  /** The source's stores on the node, as it last answered. */
  readonly stores: readonly SessionImportStore[];
  /** The explicitly chosen store, or "" for the node's default store. */
  readonly storeKey: string;
  readonly search: string;
  readonly includeArchived: boolean;
  /** Every page found so far. */
  readonly items: readonly SessionImportCandidate[];
  readonly selected: ReadonlySet<string>;
  /** The chosen destination project, or "" before one is chosen. */
  readonly projectId: string;
  /** The chosen continuation instance and model; "" falls back to the first offered. */
  readonly instanceId: string;
  readonly model: string;
  /** Where the next page starts, or null when there is none. */
  readonly nextOffset: number | null;
  /** A request of the current generation is in flight. */
  readonly busy: boolean;
  /** The node's notices about the last search, or the last failure to read it. */
  readonly notices: readonly string[];
  /** Per conversation: "Importing…", "Imported" or the reason it failed. */
  readonly statuses: Readonly<Record<string, string>>;
  /** Per quarantined conversation: the last inspection of its existing copies. */
  readonly recovery: Readonly<Record<string, SessionImportRecovery>>;
}

/** What the view reads of the presentation: access, projects and providers. */
export interface ConversationImportContext {
  /** This client may read the node's history and import it now (a connected owner). */
  readonly allowed: boolean;
  readonly projects: readonly ConversationImportProject[];
  /** The node's providers (`ServerConfig.providers`). */
  readonly providerOptions: readonly SessionImportContinuationProvider[];
}

/** What the controller reads of the presentation: its context and the node's calls. */
export interface ConversationImportInput extends ConversationImportContext {
  /**
   * The node's import calls, read for every call. Throws when they are unavailable (no
   * connection, owner access lost); the controller refuses every call itself while `allowed`
   * is false, so an import already running cannot outlive that access either way.
   */
  readonly client: () => SessionImportClient;
}

/** What a call says once this client is no longer the node's connected owner. */
export const SESSION_IMPORT_RECONNECT = "Reconnect with owner access before importing.";
export const SESSION_IMPORT_STATUS_IMPORTING = "Importing…";
export const SESSION_IMPORT_STATUS_IMPORTED = "Imported";
export const SESSION_IMPORT_STATUS_ALREADY_IMPORTED = "Already imported";
export const SESSION_IMPORT_STATUS_QUARANTINED = "Import outcome uncertain — item quarantined";
export const SESSION_IMPORT_NO_PROVIDER =
  "Enable a matching provider instance to import and continue these conversations.";
export const SESSION_IMPORT_NO_MODEL = "No available models — refresh Providers settings.";

export const SESSION_IMPORT_SOURCES: ReadonlyArray<{
  readonly value: SessionImportSource;
  readonly label: string;
}> = [
  { value: "codex", label: "Codex" },
  { value: "claudeAgent", label: "Claude Code" },
];

/** "1 conversation", "3 conversations". */
export function sessionImportConversationCount(count: number): string {
  return count === 1 ? "1 conversation" : `${count} conversations`;
}

/** A store as a picker lists it: said so when nothing enabled can continue its conversations. */
export function sessionImportStoreLabel(store: SessionImportStore): string {
  return store.instanceIds.length
    ? store.label
    : `${store.label} (no enabled continuation instance)`;
}

export const INITIAL_CONVERSATION_IMPORT_STATE: ConversationImportState = {
  source: "codex",
  stores: [],
  storeKey: "",
  search: "",
  includeArchived: false,
  items: [],
  selected: new Set(),
  projectId: "",
  instanceId: "",
  model: "",
  nextOffset: null,
  busy: false,
  notices: [],
  statuses: {},
  recovery: {},
};

// ---------------------------------------------------------------------------
// The view

export interface ConversationImportItemView {
  readonly item: SessionImportCandidate;
  /** The line under the conversation, or null without one. */
  readonly status: string | null;
  readonly tone: "success" | "warning" | "muted";
  readonly selected: boolean;
  /** It can still be selected: not imported, not quarantined. */
  readonly selectable: boolean;
  /** The last inspection of its existing copies (quarantined items only). */
  readonly recovery: SessionImportRecovery | null;
  readonly canInspectNextPage: boolean;
  /** The node proved exactly one copy and handed out a token to adopt it. */
  readonly canAdopt: boolean;
}

export interface ConversationImportView {
  readonly allowed: boolean;
  readonly busy: boolean;
  /** The chosen store, else the node's default store. */
  readonly activeStore: SessionImportStore | undefined;
  /** Instances that can continue the active store's conversations. */
  readonly providers: readonly SessionImportContinuationProvider[];
  readonly provider: SessionImportContinuationProvider | undefined;
  readonly model: SessionImportContinuationProvider["models"][number] | undefined;
  /** The chosen project while the node still has it, else "". */
  readonly projectId: string;
  /** Found conversations; none while access is missing. */
  readonly items: readonly ConversationImportItemView[];
  readonly selectedCount: number;
  /** Selected conversations a run would still import. */
  readonly importableCount: number;
  readonly hasNextPage: boolean;
  /** A search may start now. */
  readonly canFind: boolean;
  /** A run may start now. */
  readonly canRun: boolean;
  /** Why no one can continue imported conversations, or null when someone can. */
  readonly continuationStatus: string | null;
}

function importable(state: ConversationImportState, item: SessionImportCandidate): boolean {
  return (
    !item.importedThreadId &&
    !item.quarantined &&
    state.statuses[item.key] !== SESSION_IMPORT_STATUS_IMPORTED
  );
}

function activeStoreOf(state: ConversationImportState): SessionImportStore | undefined {
  return state.storeKey
    ? state.stores.find((store) => store.key === state.storeKey)
    : state.stores.find((store) => store.isDefault);
}

function itemView(
  state: ConversationImportState,
  item: SessionImportCandidate,
): ConversationImportItemView {
  const own = state.statuses[item.key];
  const status = item.quarantined
    ? own || SESSION_IMPORT_STATUS_QUARANTINED
    : item.importedThreadId
      ? SESSION_IMPORT_STATUS_ALREADY_IMPORTED
      : own;
  const recovery = state.recovery[item.key] ?? null;
  return {
    item,
    status: status || null,
    tone:
      status === SESSION_IMPORT_STATUS_IMPORTED || status === SESSION_IMPORT_STATUS_ALREADY_IMPORTED
        ? "success"
        : item.quarantined
          ? "warning"
          : "muted",
    selected: state.selected.has(item.key),
    selectable: importable(state, item),
    recovery,
    canInspectNextPage: recovery !== null && recovery.nextCursor !== null,
    canAdopt: recovery !== null && recovery.state === "unique" && !!recovery.adoptionToken,
  };
}

/** Everything a presentation shows, derived from the state and its own input. */
export function buildConversationImportView(
  state: ConversationImportState,
  input: ConversationImportContext,
): ConversationImportView {
  const activeStore = activeStoreOf(state);
  const providers = sessionImportContinuationProviders(
    input.providerOptions,
    state.source,
    activeStore,
  );
  const { provider, model } = resolveSessionImportContinuation(providers, {
    instanceId: state.instanceId,
    model: state.model,
  });
  const projectId = input.projects.some((project) => project.id === state.projectId)
    ? state.projectId
    : "";
  const items = input.allowed ? state.items : [];
  return {
    allowed: input.allowed,
    busy: state.busy,
    activeStore,
    providers,
    provider,
    model,
    projectId,
    items: items.map((item) => itemView(state, item)),
    selectedCount: state.selected.size,
    importableCount: items.filter((item) => state.selected.has(item.key) && importable(state, item))
      .length,
    hasNextPage: state.nextOffset !== null,
    canFind: !state.busy && input.allowed && activeStore !== undefined,
    canRun:
      !state.busy &&
      input.allowed &&
      projectId !== "" &&
      providers.length > 0 &&
      model !== undefined &&
      state.selected.size > 0,
    continuationStatus: !providers.length
      ? SESSION_IMPORT_NO_PROVIDER
      : !model
        ? SESSION_IMPORT_NO_MODEL
        : null,
  };
}

// ---------------------------------------------------------------------------
// The controller

export interface ConversationImportController {
  readonly getSnapshot: () => ConversationImportState;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * The presentation's current access, projects, providers and client. Gaining or losing access
   * starts a new generation; gaining it reads the source's stores.
   */
  readonly setInput: (input: ConversationImportInput) => void;
  readonly setSource: (source: SessionImportSource) => void;
  /** Chooses a store explicitly; clears what the previous store found. */
  readonly setStore: (storeKey: string) => void;
  readonly setSearch: (search: string) => void;
  readonly setIncludeArchived: (includeArchived: boolean) => void;
  readonly setSelected: (key: string, selected: boolean) => void;
  readonly setProject: (projectId: string) => void;
  /** Chooses who continues; the model falls back to that instance's default. */
  readonly setInstance: (instanceId: string) => void;
  readonly setModel: (model: string) => void;
  /** Searches the first page again; clears selection, statuses and inspections. */
  readonly find: () => Promise<void>;
  /** Appends the next page. */
  readonly nextPage: () => Promise<void>;
  /** Imports every selected conversation that is not imported yet, one at a time. */
  readonly run: () => Promise<void>;
  /** Inspects a quarantined conversation's existing copies (the first page). */
  readonly inspect: (key: string) => Promise<void>;
  /** Inspects the next page of its copies. */
  readonly inspectNextPage: (key: string) => Promise<void>;
  /** Adopts the copy the node proved, with the token its inspection handed out. */
  readonly adopt: (key: string) => Promise<void>;
  /** Drops every answer still in flight; a later `setInput` starts over. */
  readonly dispose: () => void;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function without<V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> {
  const updated = { ...record };
  delete updated[key];
  return updated;
}

const NO_CLIENT = (): SessionImportClient => {
  throw new Error(SESSION_IMPORT_RECONNECT);
};

/** One import flow; feed it the presentation's input with `setInput` before anything else. */
export function createConversationImportController(): ConversationImportController {
  let state = INITIAL_CONVERSATION_IMPORT_STATE;
  let input: ConversationImportInput = {
    allowed: false,
    projects: [],
    providerOptions: [],
    client: NO_CLIENT,
  };
  let generation = 0;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ConversationImportState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const current = (attempt: number) => attempt === generation;
  /** The node's calls, refused once access is gone, whatever the presentation's client does. */
  const client = (): SessionImportClient => {
    if (!input.allowed) throw new Error(SESSION_IMPORT_RECONNECT);
    return input.client();
  };
  /** Starts a new generation: nothing in flight may answer, so nothing is busy. */
  const invalidate = () => {
    generation += 1;
    if (state.busy) update({ busy: false });
  };

  function loadSources(): void {
    if (!input.allowed) return;
    const attempt = generation;
    const { source } = state;
    void Promise.resolve()
      .then(() => client().sources({ source }))
      .then(
        (stores) => {
          if (current(attempt)) update({ stores, recovery: {} });
        },
        (error) => {
          if (current(attempt)) update({ notices: [message(error, "Source stores unavailable.")] });
        },
      );
  }

  async function discover(offset: number): Promise<void> {
    if (!input.allowed) return;
    const attempt = generation;
    const activeStore = activeStoreOf(state);
    const { source, search, includeArchived } = state;
    update({ busy: true });
    try {
      const result = await client().discover({
        source,
        ...(activeStore ? { storeKey: activeStore.key } : {}),
        search,
        offset,
        includeArchived,
      });
      if (!current(attempt)) return;
      update({
        items: offset ? [...state.items, ...result.items] : result.items,
        ...(offset ? {} : { recovery: {}, selected: new Set<string>(), statuses: {} }),
        nextOffset: result.nextOffset,
        notices: result.notices,
      });
    } catch (error) {
      if (current(attempt)) update({ notices: [message(error, "Discovery failed.")] });
    } finally {
      if (current(attempt)) update({ busy: false });
    }
  }

  async function run(): Promise<void> {
    const view = buildConversationImportView(state, input);
    if (!view.canRun || !view.provider || !view.model) return;
    const attempt = generation;
    const destination = ProjectId.make(view.projectId);
    const modelSelection = {
      instanceId: ProviderInstanceId.make(view.provider.instanceId),
      model: view.model.slug,
    };
    const storeKey = view.activeStore ? view.activeStore.key : undefined;
    const queue = state.items.filter(
      (item) => state.selected.has(item.key) && importable(state, item),
    );
    update({ busy: true });
    const setStatus = (key: string, status: string) =>
      update({ statuses: { ...state.statuses, [key]: status } });
    for (const item of queue) {
      if (!current(attempt)) break;
      setStatus(item.key, SESSION_IMPORT_STATUS_IMPORTING);
      try {
        await client().run({
          source: item.source,
          key: item.key,
          ...(storeKey ? { storeKey } : {}),
          projectId: destination,
          modelSelection,
        });
        if (!current(attempt)) break;
        setStatus(item.key, SESSION_IMPORT_STATUS_IMPORTED);
      } catch (error) {
        if (!current(attempt)) break;
        setStatus(item.key, message(error, "Import failed. Retry this item."));
      }
    }
    if (current(attempt)) update({ busy: false });
  }

  async function inspect(key: string, cursor: string | undefined): Promise<void> {
    const item = state.items.find((entry) => entry.key === key);
    if (!input.allowed || state.busy || !item || !item.quarantined) return;
    const attempt = generation;
    update({ busy: true });
    try {
      const result = await client().reconcile({
        source: item.source,
        key: item.key,
        ...(cursor ? { cursor } : {}),
      });
      if (current(attempt)) update({ recovery: { ...state.recovery, [key]: result } });
    } catch (error) {
      if (current(attempt))
        update({
          recovery: without(state.recovery, key),
          statuses: {
            ...state.statuses,
            [key]: message(error, "Inspection failed. Import remains paused."),
          },
        });
    } finally {
      if (current(attempt)) update({ busy: false });
    }
  }

  async function adopt(key: string): Promise<void> {
    const item = state.items.find((entry) => entry.key === key);
    const recovery = state.recovery[key];
    if (
      !input.allowed ||
      state.busy ||
      !item ||
      !recovery ||
      recovery.state !== "unique" ||
      !recovery.adoptionToken
    )
      return;
    const attempt = generation;
    update({ busy: true });
    try {
      const result = await client().adopt({
        source: item.source,
        key,
        adoptionToken: recovery.adoptionToken,
      });
      if (current(attempt))
        update({
          items: state.items.map((entry) =>
            entry.key === key
              ? { ...entry, quarantined: false, importedThreadId: result.threadId }
              : entry,
          ),
          recovery: without(state.recovery, key),
          statuses: { ...state.statuses, [key]: SESSION_IMPORT_STATUS_IMPORTED },
        });
    } catch (error) {
      if (current(attempt))
        update({
          recovery: without(state.recovery, key),
          statuses: {
            ...state.statuses,
            [key]: message(error, "Adoption failed. Refresh and retry the saved import."),
          },
        });
    } finally {
      if (current(attempt)) update({ busy: false });
    }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setInput: (next) => {
      const changed = next.allowed !== input.allowed;
      input = next;
      if (!changed) return;
      invalidate();
      loadSources();
    },
    setSource: (source) => {
      if (source === state.source) return;
      invalidate();
      update({
        source,
        stores: [],
        recovery: {},
        storeKey: "",
        items: [],
        nextOffset: null,
        instanceId: "",
        model: "",
        selected: new Set(),
        statuses: {},
      });
      loadSources();
    },
    setStore: (storeKey) => {
      invalidate();
      update({
        storeKey,
        items: [],
        selected: new Set(),
        recovery: {},
        nextOffset: null,
        statuses: {},
      });
    },
    setSearch: (search) => update({ search }),
    setIncludeArchived: (includeArchived) => update({ includeArchived }),
    setSelected: (key, selected) => {
      const item = state.items.find((entry) => entry.key === key);
      if (state.busy || !item || (selected && !importable(state, item))) return;
      const updated = new Set(state.selected);
      if (selected) updated.add(key);
      else updated.delete(key);
      update({ selected: updated });
    },
    setProject: (projectId) => update({ projectId }),
    setInstance: (instanceId) => update({ instanceId, model: "" }),
    setModel: (model) => update({ model }),
    find: () =>
      buildConversationImportView(state, input).canFind ? discover(0) : Promise.resolve(),
    nextPage: () =>
      state.nextOffset !== null && !state.busy ? discover(state.nextOffset) : Promise.resolve(),
    run,
    inspect: (key) => inspect(key, undefined),
    inspectNextPage: (key) => {
      const cursor = state.recovery[key]?.nextCursor;
      return cursor ? inspect(key, cursor) : Promise.resolve();
    },
    adopt,
    dispose: () => {
      invalidate();
      input = { ...input, allowed: false };
    },
  };
}
