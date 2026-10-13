import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);
const METRO_CONFIG = new URL("../../metro.config.js", import.meta.url);
const APP_ENTRY = new URL("../../index.ts", import.meta.url);

interface MetroConfigShape {
  readonly transformer: {
    readonly getTransformOptions: () => Promise<{
      readonly transform: {
        readonly inlineRequires: boolean;
        readonly experimentalImportSupport: boolean;
        readonly nonInlinedRequires: ReadonlyArray<string>;
      };
    }>;
  };
  readonly resolver: {
    readonly resolveRequest: (
      context: { readonly originModulePath: string; readonly isESMImport?: boolean } & Record<
        string,
        unknown
      >,
      moduleName: string,
      platform: string,
    ) => unknown;
  };
}

const config = require(METRO_CONFIG.pathname) as MetroConfigShape;

describe("mobile Metro startup configuration", () => {
  it("inlines requires and keeps React eager", async () => {
    const { transform } = await config.transformer.getTransformOptions();
    expect(transform.inlineRequires).toBe(true);
    expect(transform.experimentalImportSupport).toBe(true);
    expect(transform.nonInlinedRequires).toEqual(expect.arrayContaining(["react", "react-native"]));
  });

  it("resolves workspace packages through their import conditions", () => {
    const seen: Array<{ readonly moduleName: string; readonly isESMImport: unknown }> = [];
    const context = {
      originModulePath: "/app/src/App.tsx",
      // An inlined require is recorded as a CommonJS dependency.
      isESMImport: false,
      resolveRequest: (
        next: { readonly isESMImport?: boolean },
        moduleName: string,
      ): { readonly type: "empty" } => {
        seen.push({ moduleName, isESMImport: next.isESMImport });
        return { type: "empty" };
      },
    };

    config.resolver.resolveRequest(context, "@ryco/client-runtime/state/workspace", "ios");
    config.resolver.resolveRequest(context, "react-native", "ios");

    expect(seen).toEqual([
      { moduleName: "@ryco/client-runtime/state/workspace", isESMImport: true },
      { moduleName: "react-native", isESMImport: false },
    ]);
  });

  it("registers the lazy runtime configurators with bare imports, which are never inlined", () => {
    const entry = readFileSync(APP_ENTRY, "utf8");
    const bareImports = Array.from(entry.matchAll(/^import\s+"([^"]+)";$/gm), (match) => match[1]);
    const appImport = entry.indexOf('import App from "./src/App"');

    expect(bareImports).toEqual(
      expect.arrayContaining(["./src/state/threadsRuntime", "./src/hostedHub/state"]),
    );
    for (const specifier of ["./src/state/threadsRuntime", "./src/hostedHub/state"]) {
      expect(entry.indexOf(`import "${specifier}";`)).toBeLessThan(appImport);
    }
  });
});
