import { describe, expect, it } from "vite-plus/test";

import {
  desktopUpdateChannelForFlavor,
  isLegacyInPlaceNightly,
  isNightlyVersion,
  parseRycoDesktopFlavor,
  RYCO_DESKTOP_FLAVOR_IDENTITIES,
  releaseChannelForVersion,
} from "./desktopFlavor.ts";

describe("Ryco and Ryco Nightly identities", () => {
  it("share nothing that keys an app's data, profile, lock, scheme or updates", () => {
    const { stable, nightly } = RYCO_DESKTOP_FLAVOR_IDENTITIES;
    for (const key of [
      "appId",
      "productName",
      "userDataDirectoryName",
      "homeDirectoryName",
      "homeEnv",
      "authorizationScheme",
      "appUserModelId",
      "linuxName",
      "updateChannel",
    ] as const) {
      expect(nightly[key], key).not.toBe(stable[key]);
    }
  });

  it("never let Nightly claim the stable `ryco://` scheme or read `RYCO_HOME`", () => {
    expect(RYCO_DESKTOP_FLAVOR_IDENTITIES.nightly.authorizationScheme).toBe("ryco-preview");
    expect(RYCO_DESKTOP_FLAVOR_IDENTITIES.nightly.homeEnv).toBe("RYCO_NIGHTLY_HOME");
    expect(RYCO_DESKTOP_FLAVOR_IDENTITIES.stable.authorizationScheme).toBe("ryco");
  });

  it("read a missing or unknown flavor field as stable", () => {
    expect(parseRycoDesktopFlavor("nightly")).toBe("nightly");
    for (const value of [undefined, null, "stable", "NIGHTLY", 1]) {
      expect(parseRycoDesktopFlavor(value)).toBe("stable");
    }
  });
});

describe("nightly versions", () => {
  it("match only the nightly release shape", () => {
    expect(isNightlyVersion("0.1.38-nightly.20261101.4")).toBe(true);
    for (const version of ["0.1.38", "0.1.38-alpha.1", "0.1.38-nightly.2026110.4", "nightly"]) {
      expect(isNightlyVersion(version), version).toBe(false);
    }
    expect(releaseChannelForVersion("0.1.38-nightly.20261101.4")).toBe("nightly");
    expect(releaseChannelForVersion("0.1.37")).toBe("latest");
  });

  it("send each app to its own channel, and an in-place nightly back to stable releases", () => {
    expect(desktopUpdateChannelForFlavor("stable")).toBe("latest");
    expect(desktopUpdateChannelForFlavor("nightly")).toBe("nightly");
    expect(
      isLegacyInPlaceNightly({ flavor: "stable", appVersion: "0.1.37-nightly.20261031.2" }),
    ).toBe(true);
    expect(
      isLegacyInPlaceNightly({ flavor: "nightly", appVersion: "0.1.38-nightly.20261101.4" }),
    ).toBe(false);
    expect(isLegacyInPlaceNightly({ flavor: "stable", appVersion: "0.1.37" })).toBe(false);
  });
});
