import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const WORKSPACE_INDEX = new URL(
  "../../../../packages/client-runtime/src/state/workspace/index.ts",
  import.meta.url,
);
const METRO_CONFIG = new URL("../../metro.config.js", import.meta.url);

describe("client-runtime workspace Metro boundary", () => {
  it("uses source-resolvable local exports", () => {
    const source = readFileSync(WORKSPACE_INDEX, "utf8");
    const metroConfig = readFileSync(METRO_CONFIG, "utf8");
    const specifiers = Array.from(
      source.matchAll(/from\s+["'](\.\/[^"']+)["']/g),
      (match) => match[1]!,
    );

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.endsWith(".js"), specifier).toBe(true);
      expect(existsSync(new URL(`${specifier.slice(0, -3)}.ts`, WORKSPACE_INDEX)), specifier).toBe(
        true,
      );
    }
    expect(metroConfig).toContain("context.originModulePath.startsWith(clientRuntimeSourceRoot)");
    expect(metroConfig).toContain('moduleName.endsWith(".js")');
  });

  it("maps parent-relative `.js` specifiers too (the nodes barrel re-exports the workspace catalog)", () => {
    const nodesIndex = new URL(
      "../../../../packages/client-runtime/src/state/nodes/index.ts",
      import.meta.url,
    );
    const source = readFileSync(nodesIndex, "utf8");
    const metroConfig = readFileSync(METRO_CONFIG, "utf8");
    const parentSpecifiers = Array.from(
      source.matchAll(/from\s+["'](\.\.\/[^"']+)["']/g),
      (match) => match[1]!,
    );

    expect(parentSpecifiers.length).toBeGreaterThan(0);
    for (const specifier of parentSpecifiers) {
      expect(existsSync(new URL(`${specifier.slice(0, -3)}.ts`, nodesIndex)), specifier).toBe(true);
    }
    expect(metroConfig).toContain('moduleName.startsWith("../")');
  });
});
