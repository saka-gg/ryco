import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  flavorImportAllowedSourceHome,
  flavorImportRequestPath,
  flavorImportResultPath,
  formatFlavorImportRequest,
  parseFlavorImportResult,
  takeFlavorImportLaunchToken,
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
      token: "launch-token-0123456789abcdef",
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      version: 1,
      requestedAt: "2026-10-31T10:00:00.000Z",
      sourceHomeDir: Path.join(home, ".ryco"),
      token: "launch-token-0123456789abcdef",
    });
  });

  it("takes the launch token out of the environment, and only a well-formed one", () => {
    const env: Record<string, string | undefined> = {
      RYCO_FLAVOR_IMPORT_TOKEN: "launch-token-0123456789abcdef",
      PATH: "/usr/bin",
    };
    expect(takeFlavorImportLaunchToken(env)).toBe("launch-token-0123456789abcdef");
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(takeFlavorImportLaunchToken(env)).toBeNull();
    for (const token of ["short", "has space in it 0123456789", "x".repeat(129), ""]) {
      const malformed: Record<string, string | undefined> = { RYCO_FLAVOR_IMPORT_TOKEN: token };
      expect(takeFlavorImportLaunchToken(malformed), token).toBeNull();
      expect(malformed).toEqual({});
    }
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
