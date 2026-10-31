import { describe, expect, it } from "vite-plus/test";

import { describeDesktopUpdateTrack } from "./desktopUpdateTrack";

describe("describeDesktopUpdateTrack", () => {
  it("names the track of each app, with no switch between them", () => {
    expect(describeDesktopUpdateTrack({ channel: "latest", currentVersion: "0.1.37" })).toEqual({
      label: "Stable",
      description: expect.stringContaining("separate app, Ryco Nightly"),
    });
    expect(
      describeDesktopUpdateTrack({
        channel: "nightly",
        currentVersion: "0.1.38-nightly.20261101.4",
      }),
    ).toEqual({ label: "Nightly", description: expect.stringContaining("its own data") });
  });

  it("tells an in-place nightly that it moves to the next stable release", () => {
    expect(
      describeDesktopUpdateTrack({ channel: "latest", currentVersion: "0.1.37-nightly.20261031.2" })
        .description,
    ).toContain("moves to the next stable release");
  });
});
