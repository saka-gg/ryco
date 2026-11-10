import { describe, expect, it } from "vite-plus/test";

import { CHANGELOG_RELEASES } from "./releaseNotes.ts";
import {
  compareReleaseVersions,
  parseReleaseVersion,
  resolveWhatsNewLaunch,
  selectReleasesBetween,
} from "./releaseVersion.ts";

describe("compareReleaseVersions", () => {
  it("orders by major, minor and patch numerically", () => {
    expect(compareReleaseVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(compareReleaseVersions("0.2.0", "0.1.44")).toBe(1);
    expect(compareReleaseVersions("v0.1.44", "0.1.44")).toBe(0);
  });

  it("puts a pre-release before its release and orders nightlies", () => {
    expect(compareReleaseVersions("0.1.45-nightly.20261109.1", "0.1.45")).toBe(-1);
    expect(compareReleaseVersions("0.1.45-nightly.20261109.1", "0.1.44")).toBe(1);
    expect(compareReleaseVersions("0.1.45-nightly.20261109.2", "0.1.45-nightly.20261109.10")).toBe(
      -1,
    );
  });

  it("returns null for anything that is not a version", () => {
    expect(compareReleaseVersions("dev", "0.1.0")).toBeNull();
    expect(parseReleaseVersion("0.1")).toBeNull();
  });
});

describe("selectReleasesBetween", () => {
  const releases = [{ version: "0.1.44" }, { version: "0.1.43" }, { version: "0.1.42" }];

  it("keeps the releases after the last seen one, up to the running one", () => {
    expect(
      selectReleasesBetween(releases, { sinceVersion: "0.1.42", currentVersion: "0.1.43" }),
    ).toEqual([{ version: "0.1.43" }]);
  });

  it("covers every release up to the running one without a last seen version", () => {
    expect(
      selectReleasesBetween(releases, { sinceVersion: null, currentVersion: "0.1.43" }),
    ).toEqual([{ version: "0.1.43" }, { version: "0.1.42" }]);
  });

  it("includes the latest release in a nightly built after it", () => {
    expect(
      selectReleasesBetween(releases, {
        sinceVersion: "0.1.43",
        currentVersion: "0.1.45-nightly.20261110.1",
      }),
    ).toEqual([{ version: "0.1.44" }]);
  });
});

describe("resolveWhatsNewLaunch", () => {
  it("records quietly on a fresh install", () => {
    expect(
      resolveWhatsNewLaunch({
        currentVersion: "0.1.44",
        lastSeenVersion: undefined,
        showAfterUpdate: true,
      }),
    ).toEqual({ kind: "record" });
  });

  it("shows after an update", () => {
    expect(
      resolveWhatsNewLaunch({
        currentVersion: "0.1.44",
        lastSeenVersion: "0.1.42",
        showAfterUpdate: true,
      }),
    ).toEqual({ kind: "show", sinceVersion: "0.1.42" });
  });

  it("records without showing when the setting is off or after a downgrade", () => {
    expect(
      resolveWhatsNewLaunch({
        currentVersion: "0.1.44",
        lastSeenVersion: "0.1.42",
        showAfterUpdate: false,
      }),
    ).toEqual({ kind: "record" });
    expect(
      resolveWhatsNewLaunch({
        currentVersion: "0.1.43",
        lastSeenVersion: "0.1.44",
        showAfterUpdate: true,
      }),
    ).toEqual({ kind: "record" });
  });

  it("does nothing on the same version or a development build", () => {
    expect(
      resolveWhatsNewLaunch({
        currentVersion: "0.1.44",
        lastSeenVersion: "0.1.44",
        showAfterUpdate: true,
      }),
    ).toEqual({ kind: "none" });
    expect(
      resolveWhatsNewLaunch({
        currentVersion: "0.0.0",
        lastSeenVersion: "0.1.44",
        showAfterUpdate: true,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("CHANGELOG_RELEASES", () => {
  it("lists parseable versions newest first, each once", () => {
    const versions = CHANGELOG_RELEASES.map((release) => release.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let index = 1; index < versions.length; index += 1) {
      expect(compareReleaseVersions(versions[index - 1]!, versions[index]!)).toBe(1);
    }
  });

  it("dates each release and links its GitHub release", () => {
    for (const release of CHANGELOG_RELEASES) {
      expect(release.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.releaseUrl.endsWith(`/v${release.version}`)).toBe(true);
      expect(release.highlights.length).toBeGreaterThan(0);
    }
  });
});
