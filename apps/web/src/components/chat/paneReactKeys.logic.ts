import type { ScopedThreadRef } from "@ryco/contracts";

import { paneKey, type PaneLeafGeometry, type PaneNode } from "../../chatPanes.logic";

interface PaneReactKeysState {
  readonly root: PaneNode;
  readonly leaves: ReadonlyArray<PaneLeafGeometry>;
  readonly leaving: ReadonlyArray<PaneLeafGeometry>;
  readonly reactKeys: ReadonlyMap<string, string>;
}

/**
 * React keys for the panes of the next layout, by pane key.
 *
 * A pane keeps its React key for as long as it is shown (also while it
 * leaves), so rearranging a split never remounts a ChatView. A lone pane that
 * is replaced by another lone pane (plain thread navigation) passes its key
 * on when `reuseLonePane` is set: the ChatView instance, with its composer,
 * editor and subscriptions, then follows the route instead of remounting on
 * every thread switch. A pane that appears gets its own pane key, made unique
 * when a reused key already holds it.
 */
export function nextPaneReactKeys(
  previous: PaneReactKeysState,
  next: {
    readonly root: PaneNode;
    readonly leaves: ReadonlyArray<PaneLeafGeometry>;
    readonly leaving: ReadonlyArray<PaneLeafGeometry>;
  },
  reuseLonePane: boolean,
): ReadonlyMap<string, string> {
  // Only panes that are still rendered hold a key: once a closed pane's exit
  // has ended, its entry is stale and must not decide the next layout.
  const shown = new Map<string, string>();
  for (const leaf of [...previous.leaving, ...previous.leaves]) {
    const key = paneKey(leaf.ref);
    shown.set(key, previous.reactKeys.get(key) ?? key);
  }
  const previousKeyOf = (ref: ScopedThreadRef) => shown.get(paneKey(ref)) ?? paneKey(ref);
  if (
    reuseLonePane &&
    previous.root.kind === "thread" &&
    next.root.kind === "thread" &&
    !shown.has(paneKey(next.root.ref))
  ) {
    return new Map([[paneKey(next.root.ref), previousKeyOf(previous.root.ref)]]);
  }
  const keys = new Map<string, string>();
  const used = new Set<string>();
  const appearing: string[] = [];
  for (const leaf of [...next.leaving, ...next.leaves]) {
    const key = paneKey(leaf.ref);
    const reactKey = shown.get(key);
    if (reactKey === undefined) {
      appearing.push(key);
      continue;
    }
    keys.set(key, reactKey);
    used.add(reactKey);
  }
  for (const key of appearing) {
    let reactKey = key;
    for (let suffix = 1; used.has(reactKey); suffix += 1) reactKey = `${key}#${suffix}`;
    keys.set(key, reactKey);
    used.add(reactKey);
  }
  return keys;
}
