import * as Linking from "expo-linking";
import * as QuickActions from "expo-quick-actions";

import { mobileKV } from "../../platform/kv";
import {
  buildShortcutActions,
  sanitizeRecentThreadShortcuts,
  shortcutPath,
  withRecentThreadShortcut,
  type RecentThreadShortcut,
} from "./appShortcuts";

const STORAGE_KEY = "ryco.recentThreadShortcuts";

export interface RecentThreadShortcutsDependencies {
  readonly load: () => Promise<ReadonlyArray<RecentThreadShortcut>>;
  readonly save: (recents: ReadonlyArray<RecentThreadShortcut>) => Promise<void>;
  readonly publish: (recents: ReadonlyArray<RecentThreadShortcut>) => Promise<void>;
}

/**
 * Keeps the home-screen list of recent threads. Recording waits for the saved
 * list, so the first thread opened after a cold start cannot replace older
 * entries. A failed read never saves over the saved history: each later open
 * reads it again, and only a successful read lets the list be saved.
 */
export function createRecentThreadShortcuts(dependencies: RecentThreadShortcutsDependencies) {
  let recents: ReadonlyArray<RecentThreadShortcut> | null = null;
  let persistable = false;
  let pending: RecentThreadShortcut[] = [];
  let reloading = false;
  // Serialized so an older list never overwrites a newer one.
  let saveQueue: Promise<unknown> = Promise.resolve();

  const commit = (next: ReadonlyArray<RecentThreadShortcut>) => {
    recents = next;
    if (persistable) {
      saveQueue = saveQueue.then(
        () => dependencies.save(next).catch(() => undefined),
        () => undefined,
      );
    }
    void dependencies.publish(next).catch(() => undefined);
  };
  const withPending = (list: ReadonlyArray<RecentThreadShortcut>) => {
    let next = list;
    for (const opened of pending) next = withRecentThreadShortcut(next, opened);
    pending = [];
    return next;
  };
  const read = () =>
    dependencies.load().then(
      (threads) => {
        persistable = true;
        commit(withPending(threads));
      },
      () => {
        // Shown on the icon, never saved: the saved list may still be there.
        commit(withPending(recents ?? []));
      },
    );

  const loaded = read();

  return {
    loaded,
    /** Resolves once every save issued so far has finished. */
    saved: () => saveQueue,
    record(opened: RecentThreadShortcut): Promise<void> {
      if (recents === null || !persistable) {
        pending.push(opened);
        if (recents === null || reloading) return loaded;
        reloading = true;
        return read().finally(() => {
          reloading = false;
        });
      }
      const next = withRecentThreadShortcut(recents, opened);
      if (next !== recents) commit(next);
      return Promise.resolve();
    },
  };
}

let shortcuts: ReturnType<typeof createRecentThreadShortcuts> | null = null;

function recentShortcuts() {
  return (shortcuts ??= createRecentThreadShortcuts({
    load: async () => {
      const raw = await mobileKV.getItem(STORAGE_KEY);
      return raw === null ? [] : sanitizeRecentThreadShortcuts(JSON.parse(raw));
    },
    save: (recents) => mobileKV.setItem(STORAGE_KEY, JSON.stringify(recents)),
    publish: (recents) => QuickActions.setItems(buildShortcutActions(recents)),
  }));
}

/** Puts the quick actions on the app icon (New task, and the recents once read). */
export function installAppShortcuts(): void {
  void recentShortcuts().loaded;
}

/** A thread screen came into view: it leads the recent threads on the app icon. */
export function recordRecentThreadShortcut(thread: RecentThreadShortcut): void {
  void recentShortcuts().record(thread);
}

function shortcutUrl(action: QuickActions.Action | null | undefined): string | null {
  const path = shortcutPath(action);
  return path === null ? null : Linking.createURL(path);
}

/** iOS can also deliver the launch action as an event; it already opened through getInitialURL. */
const LAUNCH_ACTION_ECHO_MS = 3_000;
let launchAction: { readonly id: string; readonly at: number } | null = null;
let launchActionConsumed = false;

/**
 * The navigation container's deep-link source with quick actions in it: an
 * action opens its app path through the same linking config as a `ryco://`
 * link, both from a cold start and while the app runs.
 */
export const shortcutAwareLinking = {
  async getInitialURL(): Promise<string | null> {
    // The launch action opens once; a remounted navigator must not replay it.
    const initial = launchActionConsumed ? null : shortcutUrl(QuickActions.initial);
    launchActionConsumed = true;
    if (initial !== null && QuickActions.initial) {
      launchAction = { id: QuickActions.initial.id, at: Date.now() };
      return initial;
    }
    return Linking.getInitialURL();
  },
  subscribe(listener: (url: string) => void): () => void {
    const links = Linking.addEventListener("url", ({ url }) => listener(url));
    const actions = QuickActions.addListener((action) => {
      const echo =
        launchAction !== null &&
        launchAction.id === action.id &&
        Date.now() - launchAction.at < LAUNCH_ACTION_ECHO_MS;
      launchAction = null;
      if (echo) return;
      const url = shortcutUrl(action);
      if (url !== null) listener(url);
    });
    return () => {
      links.remove();
      actions.remove();
    };
  },
};
