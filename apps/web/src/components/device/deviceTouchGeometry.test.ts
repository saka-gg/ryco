import { describe, expect, it } from "vitest";

import { clientPointToLayoutPoint } from "./deviceTouchGeometry";

// A 100×200 element, drawn at half size, centred at (500, 300).
const layout = { layoutWidth: 100, layoutHeight: 200 };
const rectFor = (rotationDegrees: number) => {
  const sideways = Math.abs(rotationDegrees % 180) === 90;
  const width = (sideways ? 200 : 100) / 2;
  const height = (sideways ? 100 : 200) / 2;
  return { left: 500 - width / 2, top: 300 - height / 2, width, height };
};
const point = (rotationDegrees: number, clientX: number, clientY: number) =>
  clientPointToLayoutPoint(
    { ...layout, rect: rectFor(rotationDegrees), rotationDegrees },
    clientX,
    clientY,
  );

describe("clientPointToLayoutPoint", () => {
  it("maps the centre to the centre whatever the rotation", () => {
    for (const rotation of [0, 90, -90, 180, 270, 360]) {
      expect(point(rotation, 500, 300)).toEqual({ x: 50, y: 100 });
    }
  });

  it("undoes scale without rotation", () => {
    // The top-left corner on screen is the element's own top-left.
    expect(point(0, 475, 250)).toEqual({ x: 0, y: 0 });
  });

  it("undoes a clockwise quarter turn", () => {
    // Turned clockwise, the element's top edge faces right: its top-left
    // corner is drawn at the top-right of the box.
    expect(point(90, 550, 275)).toEqual({ x: 0, y: 0 });
  });

  it("undoes a counterclockwise quarter turn", () => {
    // Turned counterclockwise, its top-left corner is drawn at the bottom-left.
    expect(point(-90, 450, 325)).toEqual({ x: 0, y: 0 });
    expect(point(270, 450, 325)).toEqual({ x: 0, y: 0 });
  });

  it("undoes a half turn", () => {
    expect(point(180, 525, 350)).toEqual({ x: 0, y: 0 });
  });

  it("reports positions off the element outside its box", () => {
    const outside = point(0, 400, 300)!;
    expect(outside.x).toBeLessThan(0);
  });
});
