import { describe, expect, it } from "vite-plus/test";

import { workItemStateLabel } from "./workItemState.ts";

describe("workItemStateLabel", () => {
  it("prefers Jira's exact status name over the normalized category label", () => {
    expect(workItemStateLabel({ state: "open", stateName: "Next to come" })).toBe("Next to come");
  });

  it("falls back to the normalized category label", () => {
    expect(workItemStateLabel({ state: "in_progress" })).toBe("In progress");
  });
});
