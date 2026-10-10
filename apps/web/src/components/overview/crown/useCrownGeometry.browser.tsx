import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useRef } from "react";

import type { CrownMode } from "./crownGeometry.logic";
import { useCrownGeometry } from "./useCrownGeometry";

function Harness({
  mode,
  cardHeight = 200,
  rowWidth = 800,
}: {
  mode: CrownMode;
  cardHeight?: number;
  /** The chat row the slot sits in; it bounds the card's width. */
  rowWidth?: number;
}) {
  const boundsRef = useRef<HTMLDivElement>(null);
  const islandRef = useRef<HTMLDivElement>(null);
  const alertLayerRef = useRef<HTMLDivElement>(null);
  const cardMainRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  useCrownGeometry({ islandRef, alertLayerRef, cardMainRef, railRef, boundsRef, mode });
  return (
    <div style={{ width: rowWidth }}>
      <div ref={boundsRef} style={{ position: "relative", height: 600, width: "100%" }}>
        <div
          ref={islandRef}
          data-testid="island"
          style={{ position: "absolute", top: 20, right: 12, overflow: "hidden" }}
        >
          <div ref={alertLayerRef} style={{ position: "absolute", width: 210, height: 48 }} />
          <div ref={cardMainRef} style={{ position: "absolute", width: 300, height: cardHeight }} />
        </div>
        <div ref={railRef} style={{ position: "absolute", top: 76, height: 320, width: 48 }} />
      </div>
    </div>
  );
}

function islandStyle(screen: { container: HTMLElement }) {
  const island = screen.container.querySelector<HTMLElement>('[data-testid="island"]')!;
  return {
    width: island.style.width,
    height: island.style.height,
    detailMax: island.style.getPropertyValue("--crown-detail-max"),
  };
}

describe("useCrownGeometry", () => {
  it("writes the morph size straight onto the island", async () => {
    const screen = await render(<Harness mode="dot" />);
    // cap = 600 bounds - 20 top - 12 padding.
    expect(islandStyle(screen)).toEqual({ width: "48px", height: "48px", detailMax: "504px" });

    await screen.rerender(<Harness mode="alert" />);
    expect(islandStyle(screen)).toMatchObject({ width: "258px", height: "48px" });

    await screen.rerender(<Harness mode="card" />);
    // max(56 + 320 rail, 200 + 2) = 376.
    expect(islandStyle(screen)).toMatchObject({ width: "372px", height: "376px" });
  });

  it("narrows the card to the chat row", async () => {
    const screen = await render(<Harness mode="card" rowWidth={300} />);
    // The island's right edge sits 12px inside the 300px row; 12px padding on the left.
    expect(islandStyle(screen).width).toBe("276px");
    const island = screen.container.querySelector<HTMLElement>('[data-testid="island"]')!;
    expect(island.style.getPropertyValue("--crown-card-content-w")).toBe("274px");
  });

  it("refits when the card content resizes", async () => {
    const screen = await render(<Harness mode="card" />);
    await screen.rerender(<Harness mode="card" cardHeight={900} />);
    await expect.poll(() => islandStyle(screen).height).toBe("568px");
  });
});
