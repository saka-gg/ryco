import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type GitManagerServiceError,
  type VcsStatusResult,
  type VcsStatusView,
} from "@ryco/contracts";
import type { GitStatusPollIntervalMs } from "@ryco/contracts/settings";
import type * as Cause from "effect/Cause";
import * as Atom from "effect/reactivity/Atom";
import { useEffect } from "react";

import { appAtomRegistry } from "@ryco/client-runtime/rpc";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import type { VcsStatusStreamMeta, WsRpcClient } from "@ryco/client-runtime/rpc";
import { useSettings } from "~/hooks/useSettings";
import { webAppLifecycle } from "../platform/appLifecycle";

export interface GitStatusState {
  readonly data: VcsStatusResult | null;
  readonly error: GitManagerServiceError | null;
  readonly cause: Cause.Cause<GitManagerServiceError> | null;
  readonly isPending: boolean;
  /**
   * Set while `data` carries local status only: its remote half (upstream,
   * ahead / behind, change request) is a placeholder the stream has not
   * filled in yet. Absent once the remote half is known.
   */
  readonly remotePending?: true;
}

type GitStatusClient = Pick<WsRpcClient["vcs"], "onStatus" | "refreshStatus">;
interface ResolvedGitStatusClient {
  readonly clientIdentity: string;
  readonly client: GitStatusClient;
}

interface WatchedGitStatus {
  refCount: number;
  /** Opens the status stream; returns its close. */
  readonly subscribe: () => () => void;
  /** Closes the open stream; null while paused in a hidden window. */
  unsubscribe: (() => void) | null;
  /** Closes the stream once nobody watched it again for a while. */
  linger: ReturnType<typeof setTimeout> | null;
}

export interface GitStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

interface GitStatusWatchOptions {
  readonly automaticRemoteRefreshIntervalMs?: GitStatusPollIntervalMs | undefined;
  readonly enabled?: boolean | undefined;
  /**
   * `summary` watches only what a branch badge shows (`refName`, `pr`,
   * `sourceControlProvider`): the server skips git status, diffs and fetches,
   * so lists of many folders stay cheap. Its working tree and ahead / behind
   * read as empty. Kept apart from the full status of the same folder.
   */
  readonly view?: VcsStatusView | undefined;
  /**
   * Keep the stream {@link GIT_STATUS_UNWATCH_LINGER_MS} after the last release (default).
   * One-off reads pass `false`; a stream another watcher keeps lingers anyway.
   */
  readonly linger?: boolean | undefined;
}

const EMPTY_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  data: null,
  error: null,
  cause: null,
  isPending: false,
});
const INITIAL_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  ...EMPTY_GIT_STATUS_STATE,
  isPending: true,
});
const EMPTY_GIT_STATUS_ATOM = Atom.make(EMPTY_GIT_STATUS_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-status:null"),
);

const NOOP: () => void = () => undefined;
const watchedGitStatuses = new Map<string, WatchedGitStatus>();
const knownGitStatusKeys = new Set<string>();
const gitStatusRefreshInFlight = new Map<string, Promise<VcsStatusResult>>();
const gitStatusLastRefreshAtByKey = new Map<string, number>();

const GIT_STATUS_REFRESH_DEBOUNCE_MS = 1_000;
/**
 * A stream outlives its last watcher this long: sidebar rows scrolled out and back, and
 * components remounting, keep it instead of closing and reopening it on the server.
 */
export const GIT_STATUS_UNWATCH_LINGER_MS = 20_000;
/**
 * A window hidden this long closes its status streams (the server stops polling those
 * folders for it); they reopen when it is shown again, the last status shown meanwhile.
 */
export const GIT_STATUS_HIDDEN_PAUSE_MS = 60_000;
const LOCAL_GIT_REF_READ_TIMEOUT_MS = 5_000;

const gitStatusStateAtom = Atom.family((key: string) => {
  knownGitStatusKeys.add(key);
  return Atom.make(INITIAL_GIT_STATUS_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-status:${key}`),
  );
});

function getGitStatusTargetKey(target: GitStatusTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }

  return `${target.environmentId}:${target.cwd}`;
}

/** The state key of a target's view; the full view keeps the bare target key. */
function getGitStatusViewKey(targetKey: string, view: VcsStatusView | undefined): string {
  return view === "summary" ? `${targetKey}#summary` : targetKey;
}

function getGitStatusWatchKeyPrefix(targetKey: string): string {
  return `${targetKey}:remote-poll=`;
}

function getGitStatusWatchKey(targetKey: string, options?: GitStatusWatchOptions): string {
  return `${getGitStatusWatchKeyPrefix(getGitStatusViewKey(targetKey, options?.view))}${options?.automaticRemoteRefreshIntervalMs ?? 0}`;
}

function readResolvedGitStatusClient(target: GitStatusTarget): ResolvedGitStatusClient | null {
  if (target.environmentId === null) {
    return null;
  }
  const connection = readEnvironmentConnection(target.environmentId);
  return connection
    ? { clientIdentity: connection.environmentId, client: connection.client.vcs }
    : null;
}

export function getGitStatusSnapshot(
  target: GitStatusTarget,
  view?: VcsStatusView,
): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return EMPTY_GIT_STATUS_STATE;
  }

  return appAtomRegistry.get(gitStatusStateAtom(getGitStatusViewKey(targetKey, view)));
}

export function watchGitStatus(
  target: GitStatusTarget,
  client?: GitStatusClient,
  options?: GitStatusWatchOptions,
): () => void {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) {
    return NOOP;
  }
  if (options?.enabled === false) {
    return NOOP;
  }

  const watchKey = getGitStatusWatchKey(targetKey, options);
  const watched = watchedGitStatuses.get(watchKey);
  if (watched) {
    watched.refCount += 1;
    if (watched.linger !== null) {
      clearTimeout(watched.linger);
      watched.linger = null;
    }
    // Asked for while paused (hidden): this watcher wants it now.
    watched.unsubscribe ??= watched.subscribe();
    return () => unwatchGitStatus(watchKey, true);
  }

  const subscribe = () =>
    subscribeToGitStatusTarget(
      getGitStatusViewKey(targetKey, options?.view),
      target,
      client,
      options,
    );
  watchedGitStatuses.set(watchKey, {
    refCount: 1,
    subscribe,
    unsubscribe: subscribe(),
    linger: null,
  });
  watchGitStatusLifecycle();

  return () => unwatchGitStatus(watchKey, options?.linger !== false);
}

let hiddenPauseTimer: ReturnType<typeof setTimeout> | null = null;
let stopWatchingLifecycle: (() => void) | null = null;

/** Pauses every status stream once the window stayed hidden, and reopens them when shown. */
function watchGitStatusLifecycle(): void {
  if (stopWatchingLifecycle !== null) return;
  stopWatchingLifecycle = webAppLifecycle.subscribe((event) => {
    if (event === "background") {
      hiddenPauseTimer ??= setTimeout(() => {
        hiddenPauseTimer = null;
        if (webAppLifecycle.isForeground()) return;
        for (const watched of watchedGitStatuses.values()) {
          watched.unsubscribe?.();
          watched.unsubscribe = null;
        }
      }, GIT_STATUS_HIDDEN_PAUSE_MS);
      return;
    }
    if ((event === "foreground" || event === "resume") && webAppLifecycle.isForeground()) {
      if (hiddenPauseTimer !== null) {
        clearTimeout(hiddenPauseTimer);
        hiddenPauseTimer = null;
      }
      for (const watched of watchedGitStatuses.values()) {
        watched.unsubscribe ??= watched.subscribe();
      }
    }
  });
}

export function refreshGitStatus(
  target: GitStatusTarget,
  client?: GitStatusClient,
): Promise<VcsStatusResult | null> {
  return requestGitStatusRefresh(target, client).then((status) => {
    const targetKey = getGitStatusTargetKey(target);
    if (targetKey !== null && status !== null) {
      commitGitStatusRefresh(targetKey, status);
    }
    return status;
  });
}

/**
 * The ref checked out in `target.cwd`, read from local status only: the live
 * snapshot when the cwd is already watched (full or summary view), otherwise the first snapshot of a
 * short-lived status subscription, which the server answers from its local
 * `git status`. Never `vcs.refreshStatus`, which also refreshes the remote and
 * change-request state and fails offline or without provider auth. Resolves the
 * ref name (null when detached or not a repository), or undefined when it could
 * not be read within the timeout.
 */
export function readLocalGitRefName(
  target: GitStatusTarget,
  options?: { readonly client?: GitStatusClient; readonly timeoutMs?: number },
): Promise<string | null | undefined> {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null) return Promise.resolve(undefined);
  const atom = gitStatusStateAtom(targetKey);
  const current = appAtomRegistry.get(atom);
  // A watched cwd's atom is streamed live, whatever its remote-poll interval.
  if (isGitStatusTargetWatched(targetKey) && !current.isPending && current.data !== null) {
    return Promise.resolve(current.data.refName ?? null);
  }
  // So is its summary view (sidebar rows, the pull request page), whose ref
  // comes from the checkout's HEAD: reuse that stream instead of opening a
  // full-status one (git status and diffs on the server) just for the ref.
  const summaryKey = getGitStatusViewKey(targetKey, "summary");
  const summary = appAtomRegistry.get(gitStatusStateAtom(summaryKey));
  if (isGitStatusTargetWatched(summaryKey) && !summary.isPending && summary.data !== null) {
    return Promise.resolve(summary.data.refName ?? null);
  }
  // A new subscription marks the atom pending until its first snapshot lands,
  // so stale data from an earlier watch never counts.
  const release = watchGitStatus(target, options?.client, { linger: false });
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: () => void = NOOP;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (refName: string | null | undefined) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      release();
      resolve(refName);
    };
    const read = (state: GitStatusState) => {
      if (!state.isPending && state.data !== null) finish(state.data.refName ?? null);
    };
    read(appAtomRegistry.get(atom));
    if (done) return;
    unsubscribe = appAtomRegistry.subscribe(atom, read);
    timer = setTimeout(
      () => finish(undefined),
      options?.timeoutMs ?? LOCAL_GIT_REF_READ_TIMEOUT_MS,
    );
  });
}

/** A stream of the target is open (watched or lingering, not paused): its atom is live. */
function isGitStatusTargetWatched(targetKey: string): boolean {
  const prefix = getGitStatusWatchKeyPrefix(targetKey);
  for (const [watchKey, watched] of watchedGitStatuses) {
    if (watchKey.startsWith(prefix) && watched.unsubscribe !== null) return true;
  }
  return false;
}

function requestGitStatusRefresh(
  target: GitStatusTarget,
  client?: GitStatusClient,
): Promise<VcsStatusResult | null> {
  const targetKey = getGitStatusTargetKey(target);
  if (targetKey === null || target.cwd === null) {
    return Promise.resolve(null);
  }

  const resolvedClient = client ?? readResolvedGitStatusClient(target)?.client;
  if (!resolvedClient) {
    return Promise.resolve(getGitStatusSnapshot(target).data);
  }

  const currentInFlight = gitStatusRefreshInFlight.get(targetKey);
  if (currentInFlight) {
    return currentInFlight;
  }

  const lastRequestedAt = gitStatusLastRefreshAtByKey.get(targetKey) ?? 0;
  if (Date.now() - lastRequestedAt < GIT_STATUS_REFRESH_DEBOUNCE_MS) {
    return Promise.resolve(getGitStatusSnapshot(target).data);
  }

  gitStatusLastRefreshAtByKey.set(targetKey, Date.now());
  const refreshPromise = resolvedClient.refreshStatus({ cwd: target.cwd }).finally(() => {
    gitStatusRefreshInFlight.delete(targetKey);
  });
  gitStatusRefreshInFlight.set(targetKey, refreshPromise);
  return refreshPromise;
}

function commitGitStatusRefresh(targetKey: string, status: VcsStatusResult): void {
  appAtomRegistry.set(gitStatusStateAtom(targetKey), {
    data: status,
    error: null,
    cause: null,
    isPending: false,
  });
}

export function resetGitStatusStateForTests(): void {
  for (const watched of watchedGitStatuses.values()) {
    if (watched.linger !== null) clearTimeout(watched.linger);
    watched.unsubscribe?.();
  }
  watchedGitStatuses.clear();
  if (hiddenPauseTimer !== null) clearTimeout(hiddenPauseTimer);
  hiddenPauseTimer = null;
  stopWatchingLifecycle?.();
  stopWatchingLifecycle = null;
  gitStatusRefreshInFlight.clear();
  gitStatusLastRefreshAtByKey.clear();

  for (const key of knownGitStatusKeys) {
    appAtomRegistry.set(gitStatusStateAtom(key), INITIAL_GIT_STATUS_STATE);
  }
  knownGitStatusKeys.clear();
}

export function useGitStatus(
  target: GitStatusTarget,
  options?: Pick<GitStatusWatchOptions, "enabled" | "view">,
): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  const view = options?.view;
  const automaticRemoteRefreshIntervalMs = useSettings((s) => s.gitStatusPollIntervalMs);
  useEffect(
    () =>
      watchGitStatus({ environmentId: target.environmentId, cwd: target.cwd }, undefined, {
        automaticRemoteRefreshIntervalMs,
        enabled: options?.enabled,
        view,
      }),
    [automaticRemoteRefreshIntervalMs, options?.enabled, target.environmentId, target.cwd, view],
  );

  const state = useAtomValue(
    targetKey !== null
      ? gitStatusStateAtom(getGitStatusViewKey(targetKey, view))
      : EMPTY_GIT_STATUS_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_STATUS_STATE : state;
}

function unwatchGitStatus(targetKey: string, linger: boolean): void {
  const watched = watchedGitStatuses.get(targetKey);
  if (!watched) {
    return;
  }

  watched.refCount -= 1;
  if (watched.refCount > 0 || watched.linger !== null) {
    return;
  }

  const close = () => {
    if (watchedGitStatuses.get(targetKey) !== watched || watched.refCount > 0) return;
    watched.unsubscribe?.();
    watchedGitStatuses.delete(targetKey);
  };
  if (!linger) {
    close();
    return;
  }
  watched.linger = setTimeout(() => {
    watched.linger = null;
    close();
  }, GIT_STATUS_UNWATCH_LINGER_MS);
}

function subscribeToGitStatusTarget(
  targetKey: string,
  target: GitStatusTarget,
  providedClient?: GitStatusClient,
  options?: GitStatusWatchOptions,
): () => void {
  if (target.cwd === null) {
    return NOOP;
  }

  const cwd = target.cwd;
  let currentClientIdentity: string | null = null;
  let currentUnsubscribe = NOOP;

  const syncClientSubscription = () => {
    const resolved = providedClient
      ? {
          clientIdentity: `provided:${targetKey}`,
          client: providedClient,
        }
      : readResolvedGitStatusClient(target);

    if (!resolved) {
      if (currentClientIdentity !== null) {
        currentUnsubscribe();
        currentUnsubscribe = NOOP;
        currentClientIdentity = null;
      }
      markGitStatusPending(targetKey);
      return;
    }

    if (currentClientIdentity === resolved.clientIdentity) {
      return;
    }

    currentUnsubscribe();
    currentClientIdentity = resolved.clientIdentity;
    currentUnsubscribe = subscribeToGitStatus(targetKey, cwd, resolved.client, options);
  };

  const unsubscribeRegistry = providedClient
    ? NOOP
    : subscribeEnvironmentConnections(syncClientSubscription);
  syncClientSubscription();

  return () => {
    unsubscribeRegistry();
    currentUnsubscribe();
  };
}

function subscribeToGitStatus(
  targetKey: string,
  cwd: string,
  client: GitStatusClient,
  options?: GitStatusWatchOptions,
): () => void {
  markGitStatusPending(targetKey);
  const automaticRemoteRefreshIntervalMs = options?.automaticRemoteRefreshIntervalMs ?? 0;
  return client.onStatus(
    {
      cwd,
      ...(automaticRemoteRefreshIntervalMs > 0 ? { automaticRemoteRefreshIntervalMs } : {}),
      ...(options?.view === "summary" ? { view: "summary" as const } : {}),
    },
    // Without the meta (status-only doubles) the remote half counts as known.
    (status: VcsStatusResult, meta?: VcsStatusStreamMeta) => {
      appAtomRegistry.set(gitStatusStateAtom(targetKey), {
        data: status,
        error: null,
        cause: null,
        isPending: false,
        ...(meta?.remoteKnown === false ? { remotePending: true } : {}),
      });
    },
    {
      onResubscribe: () => {
        markGitStatusPending(targetKey);
      },
    },
  );
}

function markGitStatusPending(targetKey: string): void {
  const atom = gitStatusStateAtom(targetKey);
  const current = appAtomRegistry.get(atom);
  const next =
    current.data === null
      ? INITIAL_GIT_STATUS_STATE
      : {
          ...current,
          error: null,
          cause: null,
          isPending: true,
        };

  if (
    current.data === next.data &&
    current.error === next.error &&
    current.cause === next.cause &&
    current.isPending === next.isPending
  ) {
    return;
  }

  appAtomRegistry.set(atom, next);
}
