import { useSyncExternalStore } from "react";

import { mobileKV } from "../../platform/kv";
import {
  DEFAULT_TASKS_TAB_STATE,
  sanitizeTasksTabState,
  TASKS_TAB_STATE_KEY,
  type TasksTabState,
} from "./tasksMachinesModel";

// One copy for the app, outliving the tab: the machine and project picked, and
// whether Done is expanded. Display preferences only.

let current: TasksTabState = DEFAULT_TASKS_TAB_STATE;
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
    .getItem(TASKS_TAB_STATE_KEY)
    .then((raw) => {
      // A change made before the saved state arrived wins over it.
      if (!loaded) current = sanitizeTasksTabState(parseSaved(raw));
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

const snapshot = (): TasksTabState => current;
const loadedSnapshot = (): boolean => loaded;

export function updateTasksTabState(update: (state: TasksTabState) => TasksTabState): void {
  const next = update(current);
  loaded = true;
  if (next === current) return;
  current = next;
  emit();
  void mobileKV.setItem(TASKS_TAB_STATE_KEY, JSON.stringify(next)).catch(() => undefined);
}

export function useTasksTabState(): TasksTabState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether the saved state has been read (the machine picker waits for it). */
export function useTasksTabStateLoaded(): boolean {
  return useSyncExternalStore(subscribe, loadedSnapshot, loadedSnapshot);
}
