import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  flavorImportAllowedSourceHome,
  flavorImportRequestPath,
  flavorImportResultPath,
  formatFlavorImportRequest,
  parseFlavorImportResult,
} from "./flavorImport.ts";

const home = Path.resolve("/Users/someone");
const nightlyHome = Path.join(home, ".ryco-nightly");

describe("flavorImportAllowedSourceHome", () => {
  it("allows Ryco's default home when Ryco handed none over", () => {
    expect(flavorImportAllowedSourceHome({ env: {}, homeDir: home, nightlyHome })).toBe(
      Path.join(home, ".ryco"),
    );
  });

  it("allows the absolute home Ryco handed over instead", () => {
    const handedOver = Path.resolve("/Volumes/data/ryco-home");
    expect(
      flavorImportAllowedSourceHome({
        env: { RYCO_STABLE_HOME: ` ${handedOver} ` },
        homeDir: home,
        nightlyHome,
      }),
    ).toBe(handedOver);
  });

  it("ignores a relative hand-over and never allows Nightly's own home", () => {
    expect(
      flavorImportAllowedSourceHome({
        env: { RYCO_STABLE_HOME: "relative/home" },
        homeDir: home,
        nightlyHome,
      }),
    ).toBe(Path.join(home, ".ryco"));
    expect(
      flavorImportAllowedSourceHome({
        env: { RYCO_STABLE_HOME: `${nightlyHome}/` },
        homeDir: home,
        nightlyHome,
      }),
    ).toBeNull();
    expect(
      flavorImportAllowedSourceHome({
        env: {},
        homeDir: home,
        nightlyHome: Path.join(home, ".ryco"),
      }),
    ).toBeNull();
  });
});

describe("flavor import files", () => {
  it("puts the request and the result in Ryco Nightly's home", () => {
    expect(flavorImportRequestPath(nightlyHome)).toBe(
      Path.join(nightlyHome, "import-requested.json"),
    );
    expect(flavorImportResultPath(nightlyHome)).toBe(Path.join(nightlyHome, "import-result.json"));
  });

  it("writes a version 1 request with an absolute source home", () => {
    const text = formatFlavorImportRequest({
      sourceHomeDir: Path.join(home, ".ryco", "..", ".ryco"),
      requestedAt: new Date("2026-10-31T10:00:00.000Z"),
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      version: 1,
      requestedAt: "2026-10-31T10:00:00.000Z",
      sourceHomeDir: Path.join(home, ".ryco"),
    });
  });

  it("reads a result and rejects anything else", () => {
    expect(
      parseFlavorImportResult(
        JSON.stringify({ version: 1, completedAt: "2026-10-31T10:00:01.000Z", ok: true }),
      ),
    ).toEqual({ version: 1, completedAt: "2026-10-31T10:00:01.000Z", ok: true });
    expect(
      parseFlavorImportResult(
        JSON.stringify({ version: 1, completedAt: "x", ok: false, error: "Update Ryco Nightly." }),
      ),
    ).toEqual({ version: 1, completedAt: "x", ok: false, error: "Update Ryco Nightly." });
    for (const text of [
      "not json",
      "null",
      JSON.stringify({ version: 2, completedAt: "x", ok: true }),
      JSON.stringify({ version: 1, completedAt: "x", ok: "yes" }),
      JSON.stringify({ version: 1, completedAt: "x", ok: false, error: 3 }),
    ]) {
      expect(parseFlavorImportResult(text), text).toBeNull();
    }
  });
});
