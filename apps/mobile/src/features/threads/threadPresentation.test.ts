import { describe, expect, it } from "vite-plus/test";

import { proposedPlanPresentation, threadMessagePresentation } from "./threadPresentation";

describe("thread presentation", () => {
  it("uses the semantic graphite user-message surface", () => {
    const presentation = threadMessagePresentation("user");

    expect(presentation).toEqual({
      bubbleClassName: "bg-user-bubble",
      textClassName: "text-user-bubble-foreground",
    });
    expect(presentation.bubbleClassName).not.toContain("primary");
  });

  it("keeps assistant messages on the quiet card surface", () => {
    expect(threadMessagePresentation("assistant")).toEqual({
      bubbleClassName: "border border-border bg-card",
      textClassName: "text-foreground",
    });
  });

  it("uses semantic plan tokens instead of a raw palette", () => {
    const presentation = proposedPlanPresentation();

    expect(presentation.containerClassName).not.toContain("border");
    expect(presentation.containerClassName).toContain("bg-plan-bg");
    expect(presentation.labelClassName).toBe("text-plan");
    expect(JSON.stringify(presentation)).not.toMatch(/violet|purple/);
  });
});
