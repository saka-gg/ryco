import { EnvironmentId } from "@ryco/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  captureThreadReadContent,
  decodeThreadReadContent,
  type CachedThreadContent,
} from "@ryco/client-runtime/state/threads";
import {
  isWorkspaceMetadataSnapshot,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import {
  DraftId,
  PersistedDraftThreadState,
  toHydratedDraftThreadState,
  type DraftThreadState,
} from "@ryco/client-runtime/state/composer";
import { useStore } from "../store";
import { useComposerDraftStore } from "../composerDraftStore";
import { useUiStateStore } from "../uiStateStore";
import {
  readWorkspaceMetadataSnapshot,
  workspaceMetadataToCachedShellSnapshot,
} from "../workspaceMetadataProjection";
import { getHostedReadVault, type ReadVaultAccount } from "../persistence/hostedReadVault";
import {
  hostedScrollPositions as scrollPositions,
  configureHostedReadViewState,
} from "../persistence/hostedReadViewState";
import { hostedHubStore } from "./state";
import { clearWebHostedAccountScopedState } from "./environment";

const PREFERENCE_KEY = "ryco:remember-hosted-browser:v1";
const ACCOUNT_KEY = "ryco:hosted-read-account:v1";
const RESET_KEY = "ryco:hosted-read-reset:v1";
interface CachedNode {
  readonly nodeId: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
}
interface CachedEnvironment {
  readonly metadata: WorkspaceMetadataSnapshot;
  readonly content: Record<string, CachedThreadContent>;
  readonly drafts: Record<string, string>;
  readonly draftSessions: Record<string, DraftThreadState>;
  readonly scroll: Record<string, number>;
}
interface ReadCacheState {
  readonly enabled: boolean;
  readonly accountId: string | null;
  readonly nodes: ReadonlyArray<CachedNode>;
  readonly snapshots: ReadonlyArray<WorkspaceMetadataSnapshot>;
}
const readPreference = () => {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
};
let snapshot: ReadCacheState = {
  enabled: readPreference(),
  accountId: null,
  nodes: [],
  snapshots: [],
};
const listeners = new Set<() => void>();
export const readHostedReadCache = () => snapshot;
export const subscribeHostedReadCache = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useHostedReadCache = () =>
  useSyncExternalStore(subscribeHostedReadCache, readHostedReadCache, readHostedReadCache);
function publish(patch: Partial<ReadCacheState>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}
let account: ReadVaultAccount | null = null;
let rememberedAccountId: string | null = null;
let revision = 0;
let bootstrapPending = true;
let started = false;
let invalidatedByAnotherTab = false;
let lastAuthenticatedSession: string | null = null;
let pending: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | null = null;
const environments = new Map<EnvironmentId, CachedEnvironment>();
const queue = (operation: () => Promise<void>) => {
  pending = pending.then(operation).catch(() => undefined);
  return pending;
};
function forgetInMemory(clearUi: boolean) {
  revision++;
  account = null;
  rememberedAccountId = null;
  configureHostedReadViewState(null);
  environments.clear();
  scrollPositions.clear();
  publish({ accountId: null, nodes: [], snapshots: [] });
  if (clearUi) clearWebHostedAccountScopedState();
}

async function purge(clearUi: boolean) {
  let id = account?.id ?? rememberedAccountId ?? snapshot.accountId;
  if (!id) {
    try {
      const pointer = JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) ?? "null");
      if (typeof pointer?.id === "string") id = pointer.id;
    } catch {
      /* Invalid pointer. */
    }
  }
  forgetInMemory(clearUi);
  try {
    window.localStorage.removeItem(ACCOUNT_KEY);
    window.localStorage.setItem(RESET_KEY, crypto.randomUUID());
  } catch {
    /* Storage can be disabled independently of IndexedDB. */
  }
  if (id) await getHostedReadVault().purge(id);
}

function decodeEnvironment(value: unknown, environmentId: EnvironmentId): CachedEnvironment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<CachedEnvironment>;
  if (!isWorkspaceMetadataSnapshot(record.metadata, environmentId)) return null;
  const content: Record<string, CachedThreadContent> = {};
  const drafts: Record<string, string> = {};
  const scroll: Record<string, number> = {};
  const draftSessions: Record<string, DraftThreadState> = {};
  const threadIds = new Set(record.metadata.threads.map((thread) => thread.id as string));
  for (const [key, value] of Object.entries(record.draftSessions ?? {}).slice(0, 32)) {
    const decoded = Schema.decodeUnknownOption(PersistedDraftThreadState)(value);
    if (
      Option.isSome(decoded) &&
      decoded.value.environmentId === environmentId &&
      !decoded.value.promotedTo &&
      record.metadata.projects.some((project) => project.id === decoded.value.projectId)
    )
      draftSessions[key] = toHydratedDraftThreadState(decoded.value);
  }
  for (const [id, value] of Object.entries(record.content ?? {}).slice(0, 32)) {
    const decoded = decodeThreadReadContent(value);
    if (threadIds.has(id) && decoded) content[id] = decoded;
  }
  for (const [key, value] of Object.entries(record.drafts ?? {}).slice(0, 64)) {
    const ref = parseScopedThreadKey(key);
    if (
      ((ref?.environmentId === environmentId && threadIds.has(ref.threadId)) ||
        Object.hasOwn(draftSessions, key)) &&
      typeof value === "string" &&
      value.length <= 100_000
    )
      drafts[key] = value;
  }
  for (const [key, value] of Object.entries(record.scroll ?? {}).slice(0, 64)) {
    if (
      parseScopedThreadKey(key)?.environmentId === environmentId &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    )
      scroll[key] = value;
  }
  return { metadata: record.metadata, content, drafts, draftSessions, scroll };
}

async function restore(): Promise<boolean> {
  if (!snapshot.enabled) return false;
  const generation = revision;
  let pointer: { id?: unknown; epoch?: unknown };
  try {
    pointer = JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) ?? "null");
  } catch {
    return false;
  }
  if (!pointer || typeof pointer.id !== "string" || typeof pointer.epoch !== "string") return false;
  rememberedAccountId = pointer.id;
  const vault = getHostedReadVault();
  const savedAccount = await vault.account(pointer.id, false);
  if (!savedAccount || savedAccount.epoch !== pointer.epoch) return false;
  const value = await vault.read(savedAccount, "catalog");
  if (!value || typeof value !== "object" || !("nodes" in value) || !Array.isArray(value.nodes))
    return false;
  const nodes: CachedNode[] = value.nodes.slice(0, 16).flatMap((node: unknown) => {
    if (!node || typeof node !== "object") return [];
    const n = node as Record<string, unknown>;
    return typeof n.nodeId === "string" &&
      typeof n.environmentId === "string" &&
      typeof n.label === "string"
      ? [{ nodeId: n.nodeId, environmentId: EnvironmentId.make(n.environmentId), label: n.label }]
      : [];
  });
  const records = await Promise.all(
    nodes.map(async (node) => ({
      node,
      record: decodeEnvironment(
        await vault.read(savedAccount, node.environmentId),
        node.environmentId,
      ),
    })),
  );
  const state = hostedHubStore.getState();
  if (
    revision !== generation ||
    !snapshot.enabled ||
    state.accountStatus === "session-expired" ||
    state.accountStatus === "signing-out" ||
    state.accountStatus === "authenticating" ||
    (state.account && state.account.id !== savedAccount.id) ||
    (!bootstrapPending &&
      state.accountStatus !== "authenticated" &&
      state.accountStatus !== "unavailable")
  )
    return false;
  account = savedAccount;
  configureHostedReadViewState(scheduleSave);
  const eligible = nodes.filter(
    (node) =>
      state.directoryStatus !== "ready" ||
      state.nodes.some(
        (live) =>
          live.id === node.nodeId &&
          live.environmentId === node.environmentId &&
          live.revokedAt === null &&
          !live.capabilities?.nativeClientRequired,
      ),
  );
  for (const { node, record } of records) {
    if (!record || !eligible.includes(node)) continue;
    environments.set(node.environmentId, record);
    const shell = workspaceMetadataToCachedShellSnapshot(record.metadata);
    useStore.getState().hydrateEnvironmentStateFromCache(
      {
        ...shell,
        threads: shell.threads.map((thread) =>
          Object.assign(thread, { content: record.content[thread.shell.id] }),
        ),
      },
      node.environmentId,
    );
    useComposerDraftStore.setState((current) => ({
      draftThreadsByThreadKey: { ...record.draftSessions, ...current.draftThreadsByThreadKey },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        ...Object.fromEntries(
          Object.entries(record.draftSessions).map(([key, session]) => [
            session.logicalProjectKey,
            key,
          ]),
        ),
        ...current.logicalProjectDraftThreadKeyByLogicalProjectKey,
      },
    }));
    for (const [key, prompt] of Object.entries(record.drafts)) {
      const ref = parseScopedThreadKey(key);
      const target = ref ?? (Object.hasOwn(record.draftSessions, key) ? DraftId.make(key) : null);
      if (target && !useComposerDraftStore.getState().draftsByThreadKey[key])
        useComposerDraftStore.getState().setPrompt(target, prompt);
    }
    for (const [key, position] of Object.entries(record.scroll)) scrollPositions.set(key, position);
  }
  publish({
    accountId: savedAccount.id,
    nodes: eligible,
    snapshots: [...environments.values()].map((record) => record.metadata),
  });
  return environments.size > 0;
}

async function reconcile() {
  const state = hostedHubStore.getState();
  if (!snapshot.enabled || invalidatedByAnotherTab) return;
  const terminal =
    state.accountStatus === "signing-out" ||
    state.accountStatus === "session-expired" ||
    (!bootstrapPending && state.accountStatus === "signed-out");
  if (
    terminal ||
    (rememberedAccountId && state.account && state.account.id !== rememberedAccountId)
  )
    await purge(true);
  if (state.accountStatus !== "authenticated" || !state.account) return;
  if (!account) {
    const generation = revision;
    const opened = await getHostedReadVault().account(state.account.id, true);
    if (
      generation !== revision ||
      hostedHubStore.getState().account?.id !== state.account.id ||
      !snapshot.enabled
    )
      return;
    account = opened;
    if (!opened) return;
    rememberedAccountId = opened.id;
    configureHostedReadViewState(scheduleSave);
    window.localStorage.setItem(
      ACCOUNT_KEY,
      JSON.stringify({ id: opened.id, epoch: opened.epoch }),
    );
    publish({ accountId: opened.id });
  }
  const owner = account;
  if (!owner) return;
  const current = hostedHubStore.getState();
  if (
    current.accountStatus !== "authenticated" ||
    current.account?.id !== owner.id ||
    current.nodes !== state.nodes
  )
    return;
  const terminalSelection =
    state.selectionStatus === "revoked" ||
    state.selectionStatus === "authorization-removed" ||
    state.selectionStatus === "incompatible";
  if (state.directoryStatus === "ready" || terminalSelection) {
    const nodes = state.nodes
      .filter(
        (node) =>
          node.revokedAt === null &&
          !node.capabilities?.nativeClientRequired &&
          !(terminalSelection && node.id === state.selectedNode?.id),
      )
      .slice(0, 16)
      .map((node) => ({ nodeId: node.id, environmentId: node.environmentId, label: node.label }));
    for (const environmentId of environments.keys()) {
      if (nodes.some((node) => node.environmentId === environmentId)) continue;
      environments.delete(environmentId);
      useStore.getState().removeEnvironmentState(environmentId);
      const composer = useComposerDraftStore.getState();
      for (const [key, draft] of Object.entries(composer.draftThreadsByThreadKey)) {
        if (draft.environmentId === environmentId) composer.clearDraftThread(DraftId.make(key));
      }
      for (const key of Object.keys(composer.draftsByThreadKey)) {
        const ref = parseScopedThreadKey(key);
        if (ref?.environmentId === environmentId) composer.clearDraftThread(ref);
      }
      for (const key of scrollPositions.keys())
        if (parseScopedThreadKey(key)?.environmentId === environmentId) scrollPositions.delete(key);
      await getHostedReadVault().remove(owner, environmentId);
    }
    publish({ nodes, snapshots: [...environments.values()].map((record) => record.metadata) });
    if (owner !== account) return;
    await getHostedReadVault().write(owner, "catalog", { nodes });
    scheduleSave();
  }
}

async function save() {
  const owner = account;
  if (!owner || !snapshot.enabled) return;
  const vault = getHostedReadVault();
  for (const node of snapshot.nodes) {
    const state = useStore.getState().environmentStateById[node.environmentId];
    if (!state) continue;
    const metadata =
      readWorkspaceMetadataSnapshot(node.environmentId, Date.now(), false) ??
      environments.get(node.environmentId)?.metadata;
    if (!metadata) continue;
    const content: Record<string, CachedThreadContent> = {};
    const drafts: Record<string, string> = {};
    const scroll: Record<string, number> = {};
    const draftSessions: Record<string, DraftThreadState> = {};
    for (const [key, draft] of Object.entries(
      useComposerDraftStore.getState().draftThreadsByThreadKey,
    ).slice(-32)) {
      if (draft.environmentId === node.environmentId && !draft.promotedTo)
        draftSessions[key] = draft;
    }
    const routedThreadId = window.location.pathname.split("/").at(-1) ?? "";
    const visits = useUiStateStore.getState().threadLastVisitedAtById;
    for (const id of state.threadIds
      .filter((id) => state.messageIdsByThreadId[id]?.length)
      .toSorted(
        (left, right) =>
          Number(encodeURIComponent(left) === routedThreadId) -
            Number(encodeURIComponent(right) === routedThreadId) ||
          (
            visits[scopedThreadKey({ environmentId: node.environmentId, threadId: left })] ?? ""
          ).localeCompare(
            visits[scopedThreadKey({ environmentId: node.environmentId, threadId: right })] ?? "",
          ),
      )
      .slice(-32)) {
      content[id] = captureThreadReadContent(
        (state.messageIdsByThreadId[id] ?? []).flatMap(
          (messageId) => state.messageByThreadId[id]?.[messageId] ?? [],
        ),
      );
    }
    for (const [key, draft] of Object.entries(useComposerDraftStore.getState().draftsByThreadKey)) {
      if (
        (parseScopedThreadKey(key)?.environmentId === node.environmentId ||
          Object.hasOwn(draftSessions, key)) &&
        draft.prompt.length <= 100_000
      )
        drafts[key] = draft.prompt;
    }
    for (const [key, position] of scrollPositions)
      if (parseScopedThreadKey(key)?.environmentId === node.environmentId) scroll[key] = position;
    const record: CachedEnvironment = { metadata, content, drafts, draftSessions, scroll };
    // Trim display history before allowing a busy workspace to exceed the per-record budget.
    while (
      new TextEncoder().encode(JSON.stringify(record)).byteLength > 1_900_000 &&
      Object.keys(content).length > 0
    )
      delete content[Object.keys(content)[0]!];
    if (owner !== account) return;
    environments.set(node.environmentId, record);
    await vault.write(owner, node.environmentId, record);
  }
}
function scheduleSave() {
  if (timer !== null || !account || !snapshot.enabled) return;
  // Throttle, rather than debounce: continuous token output must still reach disk.
  timer = setTimeout(() => {
    timer = null;
    void queue(save);
  }, 750);
}

export async function setHostedReadCacheEnabled(enabled: boolean): Promise<void> {
  window.localStorage.setItem(PREFERENCE_KEY, String(enabled));
  publish({ enabled });
  if (!enabled) await purge(false);
  else {
    invalidatedByAnotherTab = false;
    await queue(reconcile);
  }
}

export function canShowHostedReadPreview(): boolean {
  const state = hostedHubStore.getState();
  return (
    snapshot.accountId !== null &&
    ((state.accountStatus === "authenticated" && state.account?.id === snapshot.accountId) ||
      state.accountStatus === "unavailable" ||
      (bootstrapPending && state.accountStatus === "signed-out"))
  );
}

/** Race local restore against auth; the local result can only paint a read-only view. */
export async function bootstrapWithHostedReadCache(bootstrap: () => Promise<void>): Promise<void> {
  bootstrapPending = true;
  const local = restore().catch(() => false);
  if (!started) {
    started = true;
    hostedHubStore.subscribe(() => {
      const state = hostedHubStore.getState();
      if (state.accountStatus === "authenticated" && state.account) {
        const session = JSON.stringify([state.account.id, state.session?.id ?? null]);
        if (session !== lastAuthenticatedSession) invalidatedByAnotherTab = false;
        lastAuthenticatedSession = session;
      }
      if (
        state.accountStatus === "signing-out" ||
        state.accountStatus === "session-expired" ||
        (rememberedAccountId && state.account && state.account.id !== rememberedAccountId)
      ) {
        void purge(true).catch(() => undefined);
      }
      void queue(async () => {
        await local;
        await reconcile();
      });
    });
    useStore.subscribe(scheduleSave);
    useComposerDraftStore.subscribe(scheduleSave);
    window.addEventListener("pagehide", () => {
      void queue(save);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void queue(save);
    });
    window.addEventListener("storage", (event) => {
      if (event.key !== RESET_KEY && event.key !== PREFERENCE_KEY) return;
      invalidatedByAnotherTab = true;
      forgetInMemory(true);
      publish({ enabled: readPreference() });
    });
  }
  const network = bootstrap().finally(() => {
    bootstrapPending = false;
    if (hostedHubStore.getState().accountStatus === "signed-out")
      void purge(true).catch(() => undefined);
    void queue(reconcile);
  });
  await Promise.race([network, local.then((restored) => (restored ? undefined : network))]);
}
