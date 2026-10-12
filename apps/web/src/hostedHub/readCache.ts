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
import { useStore, type EnvironmentState } from "../store";
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
let authorityPurge: Promise<void> | null = null;
let pending: Promise<void> = Promise.resolve();
/** A save is scheduled: waiting out the throttle, or for an idle period. */
let savePending = false;
const environments = new Map<EnvironmentId, CachedEnvironment>();
/** Bumped by every scroll-position change, which mutates a shared map in place. */
let scrollRevision = 0;
/** The catalog last written for `owner`, so an unchanged catalog is not re-encrypted. */
let writtenCatalog: { readonly owner: ReadVaultAccount; readonly key: string } | null = null;
/**
 * The inputs each environment's record was last written from. A save whose
 * inputs are all the same objects has nothing new to encrypt and write; during
 * streaming that is every environment but the one receiving tokens.
 */
interface SavedEnvironmentInputs {
  readonly owner: ReadVaultAccount;
  readonly environment: unknown;
  readonly fallbackMetadata: unknown;
  readonly draftThreads: unknown;
  readonly drafts: unknown;
  readonly visits: unknown;
  readonly routedThreadId: string;
  readonly scrollRevision: number;
}
const savedInputs = new Map<EnvironmentId, SavedEnvironmentInputs>();
/**
 * Captured display content per thread, kept while the thread's message list is
 * the same object, with the UTF-8 length of its serialized record entry — so a
 * streaming thread is re-captured and re-measured alone, not all 32.
 */
interface CapturedThread {
  readonly messageIds: unknown;
  readonly messages: unknown;
  readonly content: CachedThreadContent;
  readonly entryBytes: number;
}
const capturedThreads = new Map<EnvironmentId, Map<string, CapturedThread>>();
const RECORD_BUDGET_BYTES = 1_900_000;
const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;
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
  savedInputs.clear();
  capturedThreads.clear();
  writtenCatalog = null;
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

/** An authenticated namespace change cannot retain the preceding read model. */
export function purgeHostedReadCacheAuthority(): Promise<void> {
  const previous = authorityPurge;
  const operation = Promise.allSettled([previous, purge(true)]).then(() => undefined);
  authorityPurge = operation;
  void operation
    .finally(() => {
      if (authorityPurge === operation) authorityPurge = null;
    })
    .catch(() => undefined);
  return operation;
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
  configureHostedReadViewState(onScrollChanged);
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
  if (authorityPurge) await authorityPurge;
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
    configureHostedReadViewState(onScrollChanged);
    window.localStorage.setItem(
      ACCOUNT_KEY,
      JSON.stringify({ id: opened.id, epoch: opened.epoch }),
    );
    publish({ accountId: opened.id });
  }
  const owner = account;
  if (!owner) return;
  const generation = revision;
  const isCurrent = () => {
    const latest = hostedHubStore.getState();
    return (
      generation === revision &&
      owner === account &&
      latest.accountStatus === "authenticated" &&
      latest.account?.id === state.account?.id &&
      latest.session?.id === state.session?.id &&
      latest.session?.activeSpaceId === state.session?.activeSpaceId &&
      latest.nodes === state.nodes
    );
  };
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
    for (const environmentId of Array.from(environments.keys())) {
      if (!isCurrent()) return;
      if (nodes.some((node) => node.environmentId === environmentId)) continue;
      environments.delete(environmentId);
      savedInputs.delete(environmentId);
      capturedThreads.delete(environmentId);
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
    if (!isCurrent()) return;
    // A connect alone patches the hosted store a dozen times; only a change to
    // what this cache shows is published (and re-renders its consumers).
    const snapshots = [...environments.values()].map((record) => record.metadata);
    if (!sameCatalog(snapshot.nodes, nodes) || !sameItems(snapshot.snapshots, snapshots)) {
      publish({ nodes, snapshots });
    }
    if (!isCurrent()) return;
    const catalogKey = JSON.stringify(nodes);
    if (writtenCatalog?.owner !== owner || writtenCatalog.key !== catalogKey) {
      await getHostedReadVault().write(owner, "catalog", { nodes });
      if (owner === account) writtenCatalog = { owner, key: catalogKey };
    }
    scheduleSave();
  }
}

function sameCatalog(left: ReadonlyArray<CachedNode>, right: ReadonlyArray<CachedNode>): boolean {
  return (
    left.length === right.length &&
    left.every(
      (node, index) =>
        node.nodeId === right[index]?.nodeId &&
        node.environmentId === right[index]?.environmentId &&
        node.label === right[index]?.label,
    )
  );
}

function sameItems<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function onScrollChanged(): void {
  scrollRevision++;
  scheduleSave();
}

/**
 * The record's display content, re-capturing only threads whose message list
 * changed, and the UTF-8 length of each serialized `"id":content` entry.
 */
function captureContent(
  environmentId: EnvironmentId,
  state: EnvironmentState,
  threadIds: ReadonlyArray<EnvironmentState["threadIds"][number]>,
): Map<string, CapturedThread> {
  const previous = capturedThreads.get(environmentId);
  const next = new Map<string, CapturedThread>();
  for (const id of threadIds) {
    const messageIds = state.messageIdsByThreadId[id];
    const messages = state.messageByThreadId[id];
    const cached = previous?.get(id);
    if (cached && cached.messageIds === messageIds && cached.messages === messages) {
      next.set(id, cached);
      continue;
    }
    const content = captureThreadReadContent(
      (messageIds ?? []).flatMap((messageId) => messages?.[messageId] ?? []),
    );
    next.set(id, {
      messageIds,
      messages,
      content,
      entryBytes: utf8Length(JSON.stringify(id)) + 1 + utf8Length(JSON.stringify(content)),
    });
  }
  capturedThreads.set(environmentId, next);
  return next;
}

async function save() {
  const owner = account;
  if (!owner || !snapshot.enabled) return;
  const vault = getHostedReadVault();
  for (const node of snapshot.nodes) {
    const appState = useStore.getState();
    const state = appState.environmentStateById[node.environmentId];
    if (!state) continue;
    const composer = useComposerDraftStore.getState();
    const visits = useUiStateStore.getState().threadLastVisitedAtById;
    const routedThreadId = window.location.pathname.split("/").at(-1) ?? "";
    const inputs: SavedEnvironmentInputs = {
      owner,
      environment: state,
      fallbackMetadata: environments.get(node.environmentId)?.metadata,
      draftThreads: composer.draftThreadsByThreadKey,
      drafts: composer.draftsByThreadKey,
      visits,
      routedThreadId,
      scrollRevision,
    };
    const saved = savedInputs.get(node.environmentId);
    if (
      saved &&
      (Object.keys(inputs) as Array<keyof SavedEnvironmentInputs>).every(
        (key) => saved[key] === inputs[key],
      )
    )
      continue;
    const metadata =
      readWorkspaceMetadataSnapshot(node.environmentId, Date.now(), false, appState) ??
      environments.get(node.environmentId)?.metadata;
    if (!metadata) continue;
    const content: Record<string, CachedThreadContent> = {};
    const drafts: Record<string, string> = {};
    const scroll: Record<string, number> = {};
    const draftSessions: Record<string, DraftThreadState> = {};
    for (const [key, draft] of Object.entries(composer.draftThreadsByThreadKey).slice(-32)) {
      if (draft.environmentId === node.environmentId && !draft.promotedTo)
        draftSessions[key] = draft;
    }
    const threadIds = state.threadIds
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
      .slice(-32);
    const captured = captureContent(node.environmentId, state, threadIds);
    for (const [key, draft] of Object.entries(composer.draftsByThreadKey)) {
      if (
        (parseScopedThreadKey(key)?.environmentId === node.environmentId ||
          Object.hasOwn(draftSessions, key)) &&
        draft.prompt.length <= 100_000
      )
        drafts[key] = draft.prompt;
    }
    for (const [key, position] of scrollPositions)
      if (parseScopedThreadKey(key)?.environmentId === node.environmentId) scroll[key] = position;
    // Trim display history before allowing a busy workspace to exceed the
    // per-record budget, least recently visited first and the routed thread
    // last. Measured from the cached entry lengths rather than by
    // re-serializing the whole record once per dropped thread: the record's
    // length is its body with an empty `content` plus that object's entries.
    const bodyBytes =
      utf8Length(JSON.stringify({ metadata, content: {}, drafts, draftSessions, scroll })) - 2;
    const kept = threadIds.flatMap((id) => {
      const thread = captured.get(id);
      return thread ? [{ id, thread }] : [];
    });
    let contentBytes =
      2 +
      kept.reduce((total, entry) => total + entry.thread.entryBytes, 0) +
      Math.max(0, kept.length - 1);
    while (kept.length > 0 && bodyBytes + contentBytes > RECORD_BUDGET_BYTES) {
      const dropped = kept.shift()!;
      contentBytes -= dropped.thread.entryBytes + (kept.length > 0 ? 1 : 0);
    }
    for (const { id, thread } of kept) content[id] = thread.content;
    const record: CachedEnvironment = { metadata, content, drafts, draftSessions, scroll };
    if (owner !== account) return;
    environments.set(node.environmentId, record);
    await vault.write(owner, node.environmentId, record);
    if (owner !== account) return;
    // Recorded after the write: a failed write is retried by the next save.
    savedInputs.set(node.environmentId, { ...inputs, fallbackMetadata: record.metadata });
  }
}

/** Run `callback` in an idle period where the browser offers one, bounded by `timeoutMs`. */
function whenIdle(callback: () => void, timeoutMs: number): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout: timeoutMs });
  } else {
    callback();
  }
}

function scheduleSave() {
  if (savePending || !account || !snapshot.enabled) return;
  savePending = true;
  // Throttle, rather than debounce: continuous token output must still reach
  // disk. The encryption and write then wait for an idle period, so a busy
  // stream is not interrupted for them; page hide still flushes at once.
  setTimeout(() => {
    whenIdle(() => {
      savePending = false;
      void queue(save);
    }, 2_000);
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
        const session = JSON.stringify([
          state.account.id,
          state.session?.id ?? null,
          state.session?.activeSpaceId ?? null,
        ]);
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
