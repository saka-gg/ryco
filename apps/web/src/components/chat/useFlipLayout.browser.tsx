import { useRef } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { useFlipLayout } from "./useFlipLayout";

function Row({ trigger, words, tick }: { trigger: string; words: string[]; tick: number }) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  useFlipLayout(ref, trigger);
  return (
    <p ref={ref} data-tick={tick} style={{ width: "400px" }}>
      {words.map((word) => (
        <span key={word} data-flip-id={word} style={{ display: "inline-block", padding: 4 }}>
          {word}
        </span>
      ))}
    </p>
  );
}

/** Two frames: ResizeObserver delivers its first notification after the first frame's rAF. */
async function settleFrames(): Promise<void> {
  for (let frame = 0; frame < 2; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("reads no layout on commits that leave the row untouched", async () => {
  const screen = await render(<Row trigger="a" words={["one", "two"]} tick={0} />);
  // Let the observers' initial callbacks settle.
  await settleFrames();
  const rects = vi.spyOn(Element.prototype, "getBoundingClientRect");
  const animations = vi.spyOn(Element.prototype, "getAnimations");

  for (let tick = 1; tick <= 5; tick += 1) {
    await screen.rerender(<Row trigger="a" words={["one", "two"]} tick={tick} />);
  }
  await settleFrames();

  expect(rects).not.toHaveBeenCalled();
  expect(animations).not.toHaveBeenCalled();
  await screen.unmount();
});

it("glides items that moved when the trigger changes", async () => {
  const screen = await render(<Row trigger="a" words={["one", "two"]} tick={0} />);
  await settleFrames();
  const animate = vi.spyOn(Element.prototype, "animate");

  await screen.rerender(<Row trigger="b" words={["zero-long-word", "one", "two"]} tick={0} />);

  const animated = animate.mock.contexts.map((element) =>
    (element as HTMLElement).getAttribute("data-flip-id"),
  );
  expect(animated).toEqual(expect.arrayContaining(["zero-long-word", "one", "two"]));
  await screen.unmount();
});
