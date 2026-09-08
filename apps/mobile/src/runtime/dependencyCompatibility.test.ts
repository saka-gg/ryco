import { createRequire } from "node:module";
import { describe, expect, it } from "vite-plus/test";

const mobileRequire = createRequire(new URL("../../package.json", import.meta.url));

describe("mobile transitive dependency compatibility", () => {
  it("decodes navigation links through the patched CommonJS query-string consumer", () => {
    const nativeRequire = createRequire(mobileRequire.resolve("@react-navigation/native"));
    const navigationRequire = createRequire(nativeRequire.resolve("@react-navigation/core"));
    const queryString = navigationRequire("query-string") as {
      parse(input: string): Record<string, string>;
      stringify(input: Record<string, string>): string;
    };

    expect(queryString.parse("path=%E2%9C%93&value=a%2Bb&broken=%E0%A4%A")).toEqual({
      path: "✓",
      value: "a+b",
      broken: "%E0%A4%A",
    });
    const values = { path: "src/日本語.ts", query: "a+b & c", empty: "" };
    expect(queryString.parse(queryString.stringify(values))).toEqual(values);
  });

  it("generates Xcode project identifiers with the scoped UUID upgrade", () => {
    const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
    const pluginsRequire = createRequire(expoRequire.resolve("@expo/config-plugins"));
    const xcode = pluginsRequire("xcode") as {
      project(path: string): {
        hash: { project: { objects: Record<string, unknown> } };
        generateUuid(): string;
      };
    };
    const project = xcode.project("compatibility.pbxproj");
    project.hash = { project: { objects: {} } };
    const identifiers = Array.from({ length: 32 }, () => project.generateUuid());
    expect(new Set(identifiers).size).toBe(identifiers.length);
    for (const identifier of identifiers) {
      expect(identifier).toMatch(/^[A-F0-9]{24}$/);
    }
  });
});
