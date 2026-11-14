// A hunk jump into a file pierre has not drawn yet waits for its first rows, setting the scroll
// position every round. The reader taking over the panel, or the diff changing under the jump,
// must end that wait instead of pulling the scroller back. The section here has no pierre
// shadow root, so it stays blank for the whole test.
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useRef } from "react";
import { render } from "vitest-browser-react";

import { useDiffHunkNavigation } from "../hooks/useDiffHunkNavigation";
import type { DiffHunkAnchor } from "../lib/diffReviewNavigation";

const ANCHORS: readonly DiffHunkAnchor[] = [
  { fileIndex: 0, hunkIndex: 0, side: "additions", line: 1_500, kind: "modified", offset: 0.5 },
];
const NO_ANCHORS: readonly DiffHunkAnchor[] = [];

type Navigation = ReturnType<typeof useDiffHunkNavigation>;

function Harness(props: {
  anchors: readonly DiffHunkAnchor[];
  onNavigation: (navigation: Navigation) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  props.onNavigation(useDiffHunkNavigation({ viewportRef, anchors: props.anchors, enabled: true }));
  return (
    <div ref={viewportRef} style={{ display: "flex", height: 400, width: 400 }}>
      <div className="diff-render-surface" style={{ height: 400, width: 400, overflow: "auto" }}>
        <div style={{ height: 2_000 }} />
        <div data-diff-file-index="0" style={{ height: 3_000 }} />
        <div style={{ height: 2_000 }} />
      </div>
    </div>
  );
}

function scroller(): HTMLElement {
  return document.querySelector<HTMLElement>(".diff-render-surface")!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a jump into the blank file and waits until it has scrolled to its estimate. */
async function startWaitingJump() {
  let navigation!: Navigation;
  const screen = await render(
    <Harness anchors={ANCHORS} onNavigation={(next) => (navigation = next)} />,
  );
  void navigation.reveal(0);
  // The estimate puts the hunk's place in the file (its middle) in the middle of the panel.
  await expect.poll(() => scroller().scrollTop).toBeGreaterThan(3_000);
  // Still waiting for the first draw: the next rounds set the position again.
  await sleep(150);
  expect(scroller().scrollTop).toBeGreaterThan(3_000);
  return screen;
}

describe("hunk jump waiting for a blank file", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const takeovers: ReadonlyArray<readonly [string, () => Event]> = [
    ["the wheel", () => new WheelEvent("wheel", { bubbles: true, deltaY: -400 })],
    ["a touch", () => new Event("touchstart", { bubbles: true })],
    ["a pointer press (the scrollbar)", () => new PointerEvent("pointerdown", { bubbles: true })],
    ["Page Up", () => new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" })],
  ];

  it.each(takeovers)("lets the reader scroll away with %s", async (_name, takeover) => {
    const screen = await startWaitingJump();
    scroller().dispatchEvent(takeover());
    scroller().scrollTop = 0;
    await sleep(400);
    expect(scroller().scrollTop).toBe(0);
    await screen.unmount();
  });

  it("keeps waiting through a hunk key, which is not a scroll", async () => {
    const screen = await startWaitingJump();
    scroller().dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", altKey: true }),
    );
    scroller().scrollTop = 0;
    await expect.poll(() => scroller().scrollTop).toBeGreaterThan(3_000);
    await screen.unmount();
  });

  it("ends the jump when the diff changes under it (the file folded)", async () => {
    const screen = await startWaitingJump();
    await screen.rerender(<Harness anchors={NO_ANCHORS} onNavigation={() => {}} />);
    scroller().scrollTop = 0;
    await sleep(400);
    expect(scroller().scrollTop).toBe(0);
    await screen.unmount();
  });
});
