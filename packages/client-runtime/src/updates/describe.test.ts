import { describe, expect, it } from "vite-plus/test";

import { describeUpdateEverythingResult } from "./describe.ts";
import type { UpdateEverythingResult } from "./run.ts";

function result(overrides: Partial<UpdateEverythingResult> = {}): UpdateEverythingResult {
  return {
    updatedNodes: 0,
    updatedProviders: 0,
    failures: [],
    postponed: [],
    unknown: [],
    skipped: [],
    ...overrides,
  };
}

describe("describeUpdateEverythingResult", () => {
  it("says nothing for a run that did nothing", () => {
    expect(describeUpdateEverythingResult(result())).toBeNull();
    const { skipped: _skipped, ...withoutSkipped } = result();
    expect(describeUpdateEverythingResult(withoutSkipped)).toBeNull();
  });

  it("counts what was updated", () => {
    expect(
      describeUpdateEverythingResult(result({ updatedNodes: 2, updatedProviders: 1 })),
    ).toEqual({ type: "success", title: "Updated 2 nodes and 1 provider" });
    expect(describeUpdateEverythingResult(result({ updatedNodes: 1 }))).toEqual({
      type: "success",
      title: "Updated 1 node",
    });
    expect(describeUpdateEverythingResult(result({ updatedProviders: 3 }))?.title).toBe(
      "Updated 3 providers",
    );
  });

  it("is an error when only failures happened", () => {
    expect(
      describeUpdateEverythingResult(result({ failures: ["Server · Ryco: Disk full."] })),
    ).toEqual({
      type: "error",
      title: "An update failed",
      description: "Server · Ryco: Disk full.",
    });
  });

  it("is a warning when some updates landed, listing the rest", () => {
    expect(
      describeUpdateEverythingResult(
        result({
          updatedNodes: 1,
          failures: ["A · Codex: one", "B · Codex: two", "C · Codex: three"],
          postponed: ["Laptop"],
          unknown: ["D · Ryco: The node did not report back in time"],
        }),
      ),
    ).toEqual({
      type: "warning",
      title: "3 updates failed",
      description:
        "Updated 1 node. A · Codex: one; B · Codex: two; and 1 more. " +
        "No result from: D · Ryco: The node did not report back in time. Postponed on Laptop.",
    });
  });

  it("names updates that did not report back", () => {
    expect(
      describeUpdateEverythingResult(
        result({ updatedProviders: 2, unknown: ["Server · Claude: Answer lost"] }),
      ),
    ).toEqual({
      type: "warning",
      title: "Some updates didn't report back",
      description: "Updated 2 providers. Check Server · Claude: Answer lost.",
    });
  });

  it("treats a postponed restart as unfinished, not failed", () => {
    expect(
      describeUpdateEverythingResult(result({ updatedNodes: 1, postponed: ["Laptop", "Studio"] })),
    ).toEqual({
      type: "warning",
      title: "Update postponed on Laptop and Studio",
      description:
        "Updated 1 node. Someone there postponed the restart. The download is kept for later.",
    });
    expect(
      describeUpdateEverythingResult(result({ postponed: ["A", "B", "C", "D", "E"] }))?.title,
    ).toBe("Update postponed on A, B and 3 more");
  });

  it("reports updates that never started", () => {
    expect(
      describeUpdateEverythingResult(
        result({ skipped: ["Server · Ryco: Cancelled before it started."] }),
      ),
    ).toEqual({
      type: "error",
      title: "Some updates didn't start",
      description: "Server · Ryco: Cancelled before it started.",
    });
  });
});
