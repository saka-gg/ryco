import { describe, expect, it } from "@effect/vitest";

import { tailOfText } from "./gitProcess.ts";

describe("tailOfText", () => {
  it("keeps the end of long text within the bound", () => {
    expect(tailOfText("  short  ", 10)).toBe("short");
    const tail = tailOfText(`${"x".repeat(50)}the reason`, 20);
    expect(tail.length).toBeLessThanOrEqual(20);
    expect(tail.endsWith("the reason")).toBe(true);
    expect(tail.startsWith("…")).toBe(true);
  });
});
