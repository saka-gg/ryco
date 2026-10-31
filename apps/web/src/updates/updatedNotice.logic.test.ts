import { describe, expect, it } from "vite-plus/test";

import { selectUpdatedNotice } from "./updatedNotice.logic";

describe("selectUpdatedNotice", () => {
  it("says Updated to X on the first launch after an install", () => {
    expect(
      selectUpdatedNotice({ currentVersion: "0.1.37", updatedFromVersion: "0.1.36" }, null),
    ).toEqual({
      version: "0.1.37",
      title: "Updated to 0.1.37",
      description: "Ryco was on 0.1.36 before.",
    });
    // A notice shown for an older version does not hide this one.
    expect(
      selectUpdatedNotice({ currentVersion: "0.1.37", updatedFromVersion: "0.1.36" }, "0.1.36")
        ?.title,
    ).toBe("Updated to 0.1.37");
  });

  it("says nothing without an install, or once the notice for this version was shown", () => {
    expect(selectUpdatedNotice(null, null)).toBeNull();
    expect(selectUpdatedNotice({ currentVersion: "0.1.37" }, null)).toBeNull();
    expect(
      selectUpdatedNotice({ currentVersion: "0.1.37", updatedFromVersion: null }, null),
    ).toBeNull();
    expect(
      selectUpdatedNotice({ currentVersion: "0.1.37", updatedFromVersion: "0.1.37" }, null),
    ).toBeNull();
    expect(
      selectUpdatedNotice({ currentVersion: "0.1.37", updatedFromVersion: "0.1.36" }, "0.1.37"),
    ).toBeNull();
  });
});
