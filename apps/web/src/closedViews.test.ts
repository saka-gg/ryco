import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@ryco/contracts";

import { closePane, resizePane, splitPane, type PaneNode } from "./chatPanes.logic";
import {
  CLOSED_VIEW_LIMIT,
  handOverClosedTabs,
  moveClosedTabs,
  pickClosedView,
  pushClosedView,
  rememberClosedView,
  resetClosedViewsForTests,
  restoreClosedPaneLayout,
  sameClosedViewOwner,
  takeClosedView,
  type ClosedView,
  type ClosedViewOwner,
} from "./closedViews";
import { DraftId } from "./composerDraftStore";
import type { RightPanelTabTarget } from "./rightPanelTabs.logic";

const ref = (id: string, env = "local") => ({
  environmentId: EnvironmentId.make(env),
  threadId: ThreadId.make(id),
});
const a = ref("a"),
  b = ref("b"),
  c = ref("c");
const threadA: ClosedViewOwner = { kind: "thread", ref: a };
const threadB: ClosedViewOwner = { kind: "thread", ref: b };
const tab = (owner: ClosedViewOwner, target: RightPanelTabTarget): ClosedView => ({
  kind: "tab",
  owner,
  target,
});
const files = (owner: ClosedViewOwner = threadA) => tab(owner, { kind: "tab", mode: "files" });
const review = (owner: ClosedViewOwner = threadA) => tab(owner, { kind: "tab", mode: "review" });
const page = (renderKey: string, owner: ClosedViewOwner = threadA) =>
  tab(owner, { kind: "render", renderKey });
const pair: PaneNode = splitPane({ kind: "thread", ref: a }, a, b, "right");

function push(...views: ClosedView[]): ReadonlyArray<ClosedView> {
  return views.reduce<ReadonlyArray<ClosedView>>(pushClosedView, []);
}

describe("closed views", () => {
  afterEach(() => resetClosedViewsForTests());

  it("keeps the newest first and moves a view closed again to the top", () => {
    expect(push(files(), review())).toEqual([review(), files()]);
    expect(push(files(), review(), files())).toEqual([files(), review()]);
    expect(push(files(threadA), files(threadB))).toEqual([files(threadB), files(threadA)]);
  });

  it("keeps one page tab per owner, the newest", () => {
    expect(push(page("m:first"), review(), page("m:second"))).toEqual([page("m:second"), review()]);
    expect(push(page("m:first", threadA), page("m:second", threadB))).toHaveLength(2);
  });

  it("keeps one entry per pane, with the layout of its last close", () => {
    const wide = resizePane(pair, "", 0.7);
    expect(
      push({ kind: "pane", ref: b, layout: pair }, files(), { kind: "pane", ref: b, layout: wide }),
    ).toEqual([{ kind: "pane", ref: b, layout: wide }, files()]);
  });

  it("forgets the oldest views past the limit", () => {
    const views = Array.from({ length: CLOSED_VIEW_LIMIT + 1 }, (_, index) =>
      tab(threadA, { kind: "agent", agentKey: `subagent:${index}` }),
    );
    const stack = push(...views);
    expect(stack).toHaveLength(CLOSED_VIEW_LIMIT);
    expect(stack[0]).toBe(views.at(-1));
    expect(stack).not.toContain(views[0]);
  });

  it("tells owners apart by kind and identity", () => {
    const draft = DraftId.make("a");
    expect(sameClosedViewOwner(threadA, { kind: "thread", ref: ref("a") })).toBe(true);
    expect(sameClosedViewOwner(threadA, threadB)).toBe(false);
    expect(sameClosedViewOwner(threadA, { kind: "thread", ref: ref("a", "remote") })).toBe(false);
    expect(sameClosedViewOwner(threadA, { kind: "draft", draftId: draft })).toBe(false);
    expect(
      sameClosedViewOwner({ kind: "draft", draftId: draft }, { kind: "draft", draftId: draft }),
    ).toBe(true);
  });

  it("picks the newest reopenable view, drops the gone ones above it and keeps the rest", () => {
    const gone = files(threadB);
    const waiting = review(threadB);
    const stack = push(page("m:older"), files(), waiting, gone);
    const verdicts = new Map<ClosedView, "drop" | "keep">([
      [gone, "drop"],
      [waiting, "keep"],
    ]);
    expect(pickClosedView(stack, (view) => verdicts.get(view) ?? "reopen")).toEqual({
      view: files(),
      stack: [waiting, page("m:older")],
    });
    expect(pickClosedView(stack, (view) => (view === waiting ? "keep" : "drop"))).toEqual({
      view: null,
      stack: [waiting],
    });
    expect(pickClosedView([], () => "reopen")).toEqual({ view: null, stack: [] });
  });

  it("hands a draft's closed tabs to the thread it became, in place", () => {
    const draft: ClosedViewOwner = { kind: "draft", draftId: DraftId.make("d") };
    const pane: ClosedView = { kind: "pane", ref: b, layout: pair };
    const stack = push(files(threadA), review(draft), pane, files(draft));
    expect(moveClosedTabs(stack, draft, threadB)).toEqual([
      files(threadB),
      pane,
      review(threadB),
      files(threadA),
    ]);
    // The thread had closed the same tab itself: the newer entry stays.
    expect(moveClosedTabs(push(review(draft), review(threadB)), draft, threadB)).toEqual([
      review(threadB),
    ]);
    expect(moveClosedTabs(push(review(draft), review(threadB)), threadA, threadB)).toHaveLength(2);

    rememberClosedView(review(draft));
    handOverClosedTabs(draft, threadA);
    expect(takeClosedView(() => "reopen")).toEqual(review(threadA));
  });

  it("takes from the window's stack until it runs out", () => {
    rememberClosedView(files());
    rememberClosedView(review());
    expect(takeClosedView(() => "reopen")).toEqual(review());
    expect(takeClosedView(() => "keep")).toBeNull();
    expect(takeClosedView(() => "reopen")).toEqual(files());
    expect(takeClosedView(() => "reopen")).toBeNull();
  });
});

describe("restoring a closed pane's layout", () => {
  it("restores the exact split while nothing changed since the pane closed", () => {
    const wide = resizePane(pair, "", 0.7);
    expect(restoreClosedPaneLayout({ kind: "thread", ref: ref("a") }, b, wide)).toBe(wide);
    const grid = splitPane(wide, a, c, "bottom");
    expect(restoreClosedPaneLayout(closePane(grid, c)!, c, grid)).toBe(grid);
  });

  it("gives up once the remaining panes were resized, rearranged or joined", () => {
    const grid = splitPane(pair, a, c, "bottom");
    const remaining = closePane(grid, c)!;
    const swapped = splitPane({ kind: "thread", ref: b }, b, a, "right");
    expect(restoreClosedPaneLayout(resizePane(remaining, "", 0.7), c, grid)).toBeNull();
    expect(restoreClosedPaneLayout(swapped, c, grid)).toBeNull();
    expect(
      restoreClosedPaneLayout(splitPane(remaining, b, ref("d"), "bottom"), c, grid),
    ).toBeNull();
    expect(restoreClosedPaneLayout({ kind: "thread", ref: a }, c, grid)).toBeNull();
  });

  it("never restores a pane that is open again", () => {
    const grid = splitPane(pair, a, c, "bottom");
    expect(restoreClosedPaneLayout(grid, c, grid)).toBeNull();
  });
});
