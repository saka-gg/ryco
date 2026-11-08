import { useSyncExternalStore } from "react";

import { mobileKV } from "../../platform/kv";
import {
  DEFAULT_PULL_REQUEST_TAB_STATE,
  PULL_REQUEST_TAB_STATE_KEY,
  sanitizePullRequestTabState,
  type PullRequestTabState,
} from "./pullRequestTabStateModel";

// One copy for the app: the tab and a pushed per-repository list share it, and
// it outlives the screen so returning to the tab keeps its place.

let current: PullRequestTabState = DEFAULT_PULL_REQUEST_TAB_STATE;
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function parseSaved(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function load(): void {
  if (loaded || loading !== null) return;
  loading = mobileKV
    .getItem(PULL_REQUEST_TAB_STATE_KEY)
    .then((raw) => {
      // A change made before the saved state arrived wins over it.
      if (!loaded) current = sanitizePullRequestTabState(parseSaved(raw));
    })
    .catch(() => undefined)
    .finally(() => {
      loaded = true;
      emit();
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

function snapshot(): PullRequestTabState {
  return current;
}

export function updatePullRequestTabState(
  update: (state: PullRequestTabState) => PullRequestTabState,
): void {
  const next = update(current);
  loaded = true;
  if (next === current) return;
  current = next;
  emit();
  void mobileKV.setItem(PULL_REQUEST_TAB_STATE_KEY, JSON.stringify(next)).catch(() => undefined);
}

export function usePullRequestTabState(): PullRequestTabState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether the saved state has been read (the picker waits for it before choosing). */
export function usePullRequestTabStateLoaded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => loaded,
    () => loaded,
  );
}

/**
 * Back to the defaults, on the device too: the saved state names a repository,
 * so it goes with the cached content of the machines it came from.
 */
export function resetPullRequestTabState(): void {
  loaded = true;
  if (current !== DEFAULT_PULL_REQUEST_TAB_STATE) {
    current = DEFAULT_PULL_REQUEST_TAB_STATE;
    emit();
  }
  void mobileKV.removeItem(PULL_REQUEST_TAB_STATE_KEY).catch(() => undefined);
}
