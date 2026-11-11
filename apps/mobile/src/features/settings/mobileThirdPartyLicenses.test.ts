import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  encodeThirdPartyLicenseManifest,
  type ThirdPartyLicenseManifest,
} from "@ryco/shared/thirdPartyLicenses";
import { describe, expect, it } from "vite-plus/test";

import { unpackMobileThirdPartyLicenses } from "./mobileThirdPartyLicenses";

const MANIFEST: ThirdPartyLicenseManifest = {
  schemaVersion: 1,
  entries: [
    {
      bundles: ["mobile"],
      kind: "package",
      license: "MIT",
      name: "@xterm/xterm",
      noticeText: "Copyright (c) The xterm.js authors\n\nPermission is hereby granted…",
      sourceUrl: "https://github.com/xtermjs/xterm.js",
      version: "6.0.0",
    },
  ],
};

function pack(manifest: ThirdPartyLicenseManifest) {
  const json = JSON.stringify(encodeThirdPartyLicenseManifest(manifest));
  return { deflateRawBase64: deflateRawSync(Buffer.from(json, "utf8")).toString("base64") };
}

describe("the packed license manifest", () => {
  it("inflates what the generator packs", () => {
    expect(unpackMobileThirdPartyLicenses(pack(MANIFEST))).toEqual(MANIFEST);
  });

  it("refuses a module that is not packed", () => {
    expect(() => unpackMobileThirdPartyLicenses(encodeThirdPartyLicenseManifest(MANIFEST))).toThrow(
      "not packed",
    );
  });

  it("reads the module the last bundle generated, when there is one", () => {
    const generated = join(__dirname, "../../../.generated/third-party-licenses/index.js");
    if (!existsSync(generated)) return;
    const module = { exports: undefined as unknown };
    new Function("module", readFileSync(generated, "utf8"))(module);
    const manifest = unpackMobileThirdPartyLicenses(module.exports);
    expect(manifest.entries.length).toBeGreaterThan(100);
    expect(manifest.entries.some((entry) => entry.name === "react-native")).toBe(true);
  });
});
