import { describe, expect, it } from "vite-plus/test";

import { resolveCatalogOverrides } from "./lib/resolve-catalog.ts";

describe("staged dependency overrides", () => {
  it("retains parent-scoped security fixes alongside resolved catalog pins", () => {
    const overrides = {
      effect: "catalog:",
      xcode: { uuid: "11.1.1" },
      "query-string": { "decode-uri-component": "0.5.0" },
    };
    expect(resolveCatalogOverrides(overrides, { effect: "4.0.0-beta.107" }, "desktop")).toEqual({
      effect: "4.0.0-beta.107",
      xcode: { uuid: "11.1.1" },
      "query-string": { "decode-uri-component": "0.5.0" },
    });
    expect(overrides.effect).toBe("catalog:");
  });

  it("resolves a nested self override using the package name rather than its selector", () => {
    expect(
      resolveCatalogOverrides(
        { "@scope/parent@^1": { ".": "catalog:", child: "catalog:shared" } },
        { "@scope/parent": "1.2.3", shared: "2.3.4" },
        "desktop",
      ),
    ).toEqual({ "@scope/parent@^1": { ".": "1.2.3", child: "2.3.4" } });
  });

  it("rejects unresolved nested catalog pins", () => {
    expect(() => resolveCatalogOverrides({ parent: { child: "catalog:" } }, {}, "desktop")).toThrow(
      "Expected key 'child' in root workspace catalog",
    );
  });
});
