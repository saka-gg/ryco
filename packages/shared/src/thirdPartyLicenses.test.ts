// Adapted from pingdotgg/t3code (`packages/shared/src/thirdPartyLicenses.test.ts`, MIT).
import { describe, expect, it } from "vite-plus/test";

import {
  decodeThirdPartyLicenseManifest,
  encodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  findThirdPartyLicenseEntry,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "./thirdPartyLicenses.ts";

const ENTRIES: ReadonlyArray<ThirdPartyLicenseEntry> = [
  {
    bundles: ["mobile"],
    kind: "package",
    license: "MIT",
    name: "react",
    noticeText: "React license",
    sourceUrl: "https://react.dev",
    version: "19.2.3",
  },
  {
    bundles: ["mobile"],
    kind: "package",
    license: "MIT",
    name: "react-native",
    noticeText: "React license",
    sourceUrl: null,
    version: "0.86.3",
  },
  {
    bundles: ["ios"],
    kind: "custom",
    license: "BSD-3-Clause",
    name: "SocketRocket",
    noticeText: "SocketRocket license",
    sourceUrl: null,
    version: null,
  },
];
const MANIFEST = { schemaVersion: 1, entries: ENTRIES } as const;

describe("third-party license manifests", () => {
  it("round-trips through the compact form, storing each notice text once", () => {
    const encoded = encodeThirdPartyLicenseManifest(MANIFEST);

    expect(encoded.notices).toEqual(["React license", "SocketRocket license"]);
    expect(encoded.entries.map((entry) => entry.notice)).toEqual([0, 0, 1]);
    expect(decodeThirdPartyLicenseManifest(JSON.parse(JSON.stringify(encoded)))).toEqual(MANIFEST);
  });

  it("rejects an unsupported format", () => {
    expect(() =>
      decodeThirdPartyLicenseManifest({ schemaVersion: 2, notices: [], entries: [] }),
    ).toThrow("unsupported format");
    expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [] })).toThrow(
      "unsupported format",
    );
  });

  it("rejects unsafe source links, missing notices and duplicates", () => {
    const encoded = encodeThirdPartyLicenseManifest(MANIFEST);
    const withEntry = (entry: object) => ({ ...encoded, entries: [entry] });

    expect(() =>
      decodeThirdPartyLicenseManifest(
        withEntry({ ...encoded.entries[0], sourceUrl: "javascript:alert(1)" }),
      ),
    ).toThrow("invalid shape");
    expect(() =>
      decodeThirdPartyLicenseManifest(withEntry({ ...encoded.entries[0], notice: 9 })),
    ).toThrow("invalid shape");
    expect(() =>
      decodeThirdPartyLicenseManifest({
        ...encoded,
        entries: [encoded.entries[0], encoded.entries[0]],
      }),
    ).toThrow("duplicate entry");
  });

  it("searches names, versions and licenses by every term", () => {
    expect(filterThirdPartyLicenseEntries(ENTRIES, "").map((entry) => entry.name)).toHaveLength(3);
    expect(filterThirdPartyLicenseEntries(ENTRIES, "  REACT ").map((entry) => entry.name)).toEqual([
      "react",
      "react-native",
    ]);
    expect(
      filterThirdPartyLicenseEntries(ENTRIES, "react 0.86").map((entry) => entry.name),
    ).toEqual(["react-native"]);
    expect(filterThirdPartyLicenseEntries(ENTRIES, "bsd").map((entry) => entry.name)).toEqual([
      "SocketRocket",
    ]);
    expect(filterThirdPartyLicenseEntries(ENTRIES, "gpl")).toEqual([]);
  });

  it("labels platforms", () => {
    expect(formatLicenseBundles(["android", "ios"])).toBe("Android, iOS");
    expect(formatLicenseBundles(["mobile", "other"])).toBe("App, other");
  });

  it("finds an entry by a key that survives names and versions containing delimiters", () => {
    const first = thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "a:1", version: null });
    const second = thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "a", version: "1:custom" });
    expect(first).not.toBe(second);

    const key = thirdPartyLicenseEntryKey(ENTRIES[2]!);
    expect(findThirdPartyLicenseEntry(ENTRIES, key)).toBe(ENTRIES[2]);
    expect(findThirdPartyLicenseEntry(ENTRIES, "missing")).toBeUndefined();
  });
});
