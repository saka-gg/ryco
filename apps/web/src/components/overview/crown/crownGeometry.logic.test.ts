import { assert, describe, it } from "vite-plus/test";

import { computeCrownSize, computeFlyoutPlacement } from "./crownGeometry.logic";

const MEASURED = {
  alertContentWidth: 220,
  availableWidth: 1000,
  railHeight: 400,
  cardContentHeight: 300,
  capHeight: 700,
};

describe("computeCrownSize", () => {
  it("is a 48px dot", () => {
    assert.deepEqual(computeCrownSize({ ...MEASURED, mode: "dot" }), {
      width: 48,
      height: 48,
      detailMax: 636,
    });
  });

  it("widens by the alert content next to the face", () => {
    const size = computeCrownSize({ ...MEASURED, mode: "alert" });
    assert.equal(size.width, 268);
    assert.equal(size.height, 48);
  });

  it("is at least as tall as the rail it swallows", () => {
    const size = computeCrownSize({ ...MEASURED, mode: "card" });
    assert.equal(size.width, 372);
    assert.equal(size.height, 456);
  });

  it("grows with taller content", () => {
    const size = computeCrownSize({ ...MEASURED, mode: "card", cardContentHeight: 600 });
    assert.equal(size.height, 602);
  });

  it("is capped by the available height", () => {
    const size = computeCrownSize({ ...MEASURED, mode: "card", cardContentHeight: 900 });
    assert.equal(size.height, 700);
    assert.equal(size.detailMax, 636);
  });

  it("narrows the card and alert to the room in the chat row", () => {
    assert.equal(computeCrownSize({ ...MEASURED, mode: "card", availableWidth: 300 }).width, 300);
    assert.equal(computeCrownSize({ ...MEASURED, mode: "alert", availableWidth: 200 }).width, 200);
    // Never narrower than the face itself.
    assert.equal(computeCrownSize({ ...MEASURED, mode: "card", availableWidth: 20 }).width, 48);
  });

  it("never collapses below the face", () => {
    const size = computeCrownSize({ ...MEASURED, mode: "card", capHeight: 20 });
    assert.equal(size.height, 48);
    assert.equal(size.detailMax, 0);
  });
});

describe("computeFlyoutPlacement", () => {
  it("aligns just above the anchor and grows out of its centre", () => {
    assert.deepEqual(
      computeFlyoutPlacement({
        anchorTop: 100,
        anchorHeight: 40,
        contentHeight: 200,
        boundsHeight: 800,
      }),
      { top: 94, height: 200, maxHeight: 776, originY: 26 },
    );
  });

  it("shifts up to stay inside the bounds", () => {
    const placement = computeFlyoutPlacement({
      anchorTop: 700,
      anchorHeight: 40,
      contentHeight: 200,
      boundsHeight: 800,
    });
    assert.equal(placement.top, 588);
    assert.equal(placement.originY, 132);
  });

  it("keeps the top padding near the top edge", () => {
    const placement = computeFlyoutPlacement({
      anchorTop: 4,
      anchorHeight: 40,
      contentHeight: 200,
      boundsHeight: 800,
    });
    assert.equal(placement.top, 12);
  });

  it("clamps tall content to the bounds", () => {
    const placement = computeFlyoutPlacement({
      anchorTop: 300,
      anchorHeight: 40,
      contentHeight: 2000,
      boundsHeight: 600,
      padding: 10,
    });
    assert.equal(placement.height, 580);
    assert.equal(placement.maxHeight, 580);
    assert.equal(placement.top, 10);
  });

  it("stays below the header band even for tall content at the bottom icon", () => {
    const placement = computeFlyoutPlacement({
      anchorTop: 520,
      anchorHeight: 36,
      contentHeight: 2000,
      boundsHeight: 600,
      topInset: 56,
    });
    assert.equal(placement.top, 56);
    assert.equal(placement.maxHeight, 532);
    assert.equal(placement.height, 532);
    assert.equal(placement.top + placement.height, 588);
  });
});
