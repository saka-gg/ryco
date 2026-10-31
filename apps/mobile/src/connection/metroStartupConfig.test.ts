import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_APP_DIR,
  MOBILE_BABEL_CONFIG,
  metroBabelCaller,
  requireFromBabelPreset,
  requireFromExpoMetroConfig,
} from "../../test/metroBabel";

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

interface BabelCore {
  readonly transformFileSync: (filename: string, options: object) => { ast?: unknown } | null;
  readonly transformFromAstSync: (
    ast: unknown,
    code: string,
    options: object,
  ) => { code?: string | null } | null;
}

/**
 * `index.ts` as Expo's Metro worker emits it for an iOS release: the app's Babel config with
 * static ES modules left in place (`experimentalImportSupport`), then the worker's
 * import/export and inline-requires plugins, with this config's eager modules.
 */
async function transformEntryLikeMetro(): Promise<string> {
  const babel = requireFromBabelPreset("@babel/core") as BabelCore;
  const { importExportLiveBindingsPlugin } = requireFromExpoMetroConfig("./transform-plugins") as {
    readonly importExportLiveBindingsPlugin: unknown;
  };
  const { inlineRequiresPlugin } = requireFromExpoMetroConfig(
    "@expo/metro/metro-transform-plugins",
  ) as { readonly inlineRequiresPlugin: unknown };
  const { transform } = await config.transformer.getTransformOptions();
  const entry = APP_ENTRY.pathname;
  const babelResult = babel.transformFileSync(entry, {
    cwd: MOBILE_APP_DIR,
    babelrc: false,
    configFile: MOBILE_BABEL_CONFIG,
    caller: { ...metroBabelCaller(false), supportsStaticESM: transform.experimentalImportSupport },
    ast: true,
    code: false,
  });
  if (!babelResult?.ast) throw new Error("Babel produced no AST for index.ts");
  const names = { importDefault: "_$$_IMPORT_DEFAULT", importAll: "_$$_IMPORT_ALL" };
  const inlineableCalls = [names.importDefault, names.importAll];
  return (
    babel.transformFromAstSync(babelResult.ast, "", {
      filename: entry,
      babelrc: false,
      configFile: false,
      plugins: [
        [importExportLiveBindingsPlugin, { ...names, inlineableCalls }],
        [
          inlineRequiresPlugin,
          { ...names, inlineableCalls, ignoredRequires: transform.nonInlinedRequires },
        ],
      ],
    })?.code ?? ""
  );
}

describe("mobile Metro startup configuration", () => {
  it("inlines requires and keeps React eager", async () => {
    const { transform } = await config.transformer.getTransformOptions();
    expect(transform.inlineRequires).toBe(true);
    expect(transform.experimentalImportSupport).toBe(true);
    expect(transform.nonInlinedRequires).toEqual(
      expect.arrayContaining(["react", "react/compiler-runtime", "react-native"]),
    );
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

  it("installs the crash recorder right after the polyfills, before any other app module", async () => {
    // Imports are hoisted above the entry's own statements, so a recorder installed by a
    // statement in index.ts would run after every module it imports.
    const code = await transformEntryLikeMetro();
    const evaluated = Array.from(code.matchAll(/require\("([^"]+)"\)/gu), (match) => match[1]);
    // The walk must have produced the entry, or an empty result proves nothing.
    expect(evaluated).toContain("./src/App");
    expect(evaluated.slice(0, 2)).toEqual([
      "./polyfills",
      "./src/diagnostics/fatalErrorRecorderEntry",
    ]);
  });
});
