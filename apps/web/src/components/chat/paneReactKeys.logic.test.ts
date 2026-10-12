import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { paneGeometry, paneKey, type PaneLeafGeometry, type PaneNode } from "../../chatPanes.logic";
import { nextPaneReactKeys } from "./paneReactKeys.logic";

const environmentId = EnvironmentId.make("pane-keys");
const ref = (id: string): ScopedThreadRef => ({ environmentId, threadId: ThreadId.make(id) });
const lone = (id: string): PaneNode => ({ kind: "thread", ref: ref(id) });
const split = (first: PaneNode, second: PaneNode): PaneNode => ({
  kind: "split",
  axis: "horizontal",
  ratio: 0.5,
  first,
  second,
});

interface State {
  readonly root: PaneNode;
  readonly leaves: ReadonlyArray<PaneLeafGeometry>;
  readonly leaving: ReadonlyArray<PaneLeafGeometry>;
  readonly reactKeys: ReadonlyMap<string, string>;
}

function step(
  previous: State,
  root: PaneNode,
  options: { reuseLonePane?: boolean; leaving?: PaneNode } = {},
): State {
  const next = {
    root,
    leaves: paneGeometry(root).leaves,
    leaving: options.leaving ? paneGeometry(options.leaving).leaves : [],
  };
  return { ...next, reactKeys: nextPaneReactKeys(previous, next, options.reuseLonePane ?? true) };
}

/** The leaving panes' exit ended (ChatPanes drops them from `leaving`). */
const exitEnded = (state: State): State => ({ ...state, leaving: [] });

const keyOf = (state: { reactKeys: ReadonlyMap<string, string> }, id: string) =>
  state.reactKeys.get(paneKey(ref(id)));

describe("nextPaneReactKeys", () => {
  const initial: State = {
    root: lone("a"),
    leaves: paneGeometry(lone("a")).leaves,
    leaving: [],
    reactKeys: new Map([[paneKey(ref("a")), paneKey(ref("a"))]]),
  };

  it("hands a lone pane's key to the next lone thread", () => {
    const next = step(step(initial, lone("b")), lone("c"));
    expect(keyOf(next, "c")).toBe(paneKey(ref("a")));
    expect(next.reactKeys.size).toBe(1);
  });

  it("remounts on lone navigation when reuse is off", () => {
    const next = step(initial, lone("b"), { reuseLonePane: false });
    expect(keyOf(next, "b")).toBe(paneKey(ref("b")));
  });

  it("keeps keys through a split and its close, and never duplicates a reused key", () => {
    const navigated = step(initial, lone("c"));
    // Splitting the reused pane with the thread whose key it carries.
    const splitView = step(navigated, split(lone("c"), lone("a")));
    expect(keyOf(splitView, "c")).toBe(paneKey(ref("a")));
    expect(keyOf(splitView, "a")).toBe(`${paneKey(ref("a"))}#1`);
    expect(new Set(splitView.reactKeys.values()).size).toBe(2);

    // Closing a pane keeps the survivor and the leaving pane on their keys.
    const closed = step(splitView, lone("a"), { leaving: lone("c") });
    expect(keyOf(closed, "a")).toBe(`${paneKey(ref("a"))}#1`);
    expect(keyOf(closed, "c")).toBe(paneKey(ref("a")));
  });

  it("hands the lone key on to a thread whose pane closed earlier", () => {
    const splitView = step(initial, split(lone("a"), lone("c")));
    const closed = exitEnded(step(splitView, lone("a"), { leaving: lone("c") }));

    // c's pane is gone, so navigating to c is plain lone navigation.
    const navigated = step(closed, lone("c"));
    expect(keyOf(navigated, "c")).toBe(keyOf(closed, "a"));
    expect(navigated.reactKeys.size).toBe(1);
  });
});
