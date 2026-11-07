import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  COMPUTER_USE_HELPER_PROTOCOL,
  computerUseHelperAppIdentity,
  computerUseHelperInfoPlist,
} from "./computerUseHelperApp.ts";

describe("computerUseHelperAppIdentity", () => {
  it("names the helper after its app and keeps the stage label last", () => {
    expect(
      computerUseHelperAppIdentity({ bundleId: "com.laurinfrank.ryco", productName: "Ryco" }),
    ).toEqual({
      name: "Ryco Computer Use",
      bundleId: "com.laurinfrank.ryco.computer-use",
    });
    expect(
      computerUseHelperAppIdentity({
        bundleId: "com.laurinfrank.ryco.nightly",
        productName: "Ryco Nightly",
      }),
    ).toEqual({
      name: "Ryco Nightly Computer Use",
      bundleId: "com.laurinfrank.ryco.nightly.computer-use",
    });
    expect(
      computerUseHelperAppIdentity({ bundleId: "com.sak0a.ryco.dev", productName: "Ryco (Dev)" }),
    ).toEqual({
      name: "Ryco Computer Use (Dev)",
      bundleId: "com.sak0a.ryco.dev.computer-use",
    });
  });
});

describe("computerUseHelperInfoPlist", () => {
  it("declares an LSUIElement app with usage texts, its protocol and an escaped name", () => {
    const plist = computerUseHelperInfoPlist({
      identity: { name: "Ryco & Co Computer Use", bundleId: "com.example.computer-use" },
      version: "0.1.39",
      iconName: "AppIcon",
      resourcesDirectory: "/tmp/res",
      hostPath: "/Apps/Ryco (Dev).app",
    });
    expect(plist).toContain(
      "<key>RycoComputerUseHostPath</key>\n\t<string>/Apps/Ryco (Dev).app</string>",
    );
    expect(plist).toContain("<key>LSUIElement</key>\n\t<true/>");
    expect(plist).toContain("<string>Ryco &amp; Co Computer Use</string>");
    expect(plist).toContain("<key>NSAccessibilityUsageDescription</key>");
    expect(plist).toContain("<key>NSScreenCaptureUsageDescription</key>");
    expect(plist).toContain(
      `<key>RycoComputerUseProtocol</key>\n\t<integer>${COMPUTER_USE_HELPER_PROTOCOL}</integer>`,
    );
    expect(plist).toContain(
      "<key>RycoComputerUseResourcesDirectory</key>\n\t<string>/tmp/res</string>",
    );
    expect(
      computerUseHelperInfoPlist({
        identity: { name: "R", bundleId: "r" },
        version: "1",
        iconName: "AppIcon",
      }),
    ).not.toContain("RycoComputerUseResourcesDirectory");
  });

  it("matches the protocol the Swift helper speaks", () => {
    const swift = readFileSync(
      join(import.meta.dirname, "../../../apps/desktop/native/computer-use-app/main.swift"),
      "utf8",
    );
    expect(swift).toMatch(new RegExp(`let helperProtocol = ${COMPUTER_USE_HELPER_PROTOCOL}\\b`));
  });
});
