// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MOBILE_APP_DIR,
  MOBILE_BABEL_CONFIG,
  metroBabelCaller,
  requireFromBabelPreset,
  requireFromMetro,
} from "../../test/metroBabel";

/**
 * The development-only diagnostics `index.ts` loads (the relay-E2EE vector
 * runner and the render counter) must never reach a release bundle.
 *
 * Both sit behind `if (__DEV__ …)` in `index.ts`. Metro's worker runs the
 * project's Babel config, then replaces `__DEV__` (`inlinePlugin`) and folds
 * the dead branch (`constantFoldingPlugin`) before it collects dependencies,
 * so in a release transform the `require` and the module it names are gone.
 * This reproduces those three steps on the real entry file.
 */

const ENTRY = join(MOBILE_APP_DIR, "index.ts");

interface BabelResult {
  readonly code?: string | null;
  readonly ast?: unknown;
}
interface BabelCore {
  readonly transformFileSync: (filename: string, options: object) => BabelResult | null;
  readonly transformFromAstSync: (
    ast: unknown,
    code: string | undefined,
    options: object,
  ) => BabelResult | null;
}

const babel = requireFromBabelPreset("@babel/core") as BabelCore;
const metroPlugins = requireFromMetro("metro-transform-plugins") as {
  readonly inlinePlugin: unknown;
  readonly constantFoldingPlugin: unknown;
};

/** `index.ts` after the Babel and constant-folding steps of Metro's iOS worker. */
function transformEntry(dev: boolean): string {
  const babelResult = babel.transformFileSync(ENTRY, {
    cwd: MOBILE_APP_DIR,
    babelrc: false,
    configFile: MOBILE_BABEL_CONFIG,
    caller: metroBabelCaller(dev),
    ast: true,
    code: false,
  });
  if (!babelResult?.ast) throw new Error("Babel produced no AST for index.ts");
  const folded = babel.transformFromAstSync(babelResult.ast, undefined, {
    filename: ENTRY,
    babelrc: false,
    configFile: false,
    plugins: [
      [metroPlugins.inlinePlugin, { dev, platform: "ios", inlinePlatform: true }],
      [metroPlugins.constantFoldingPlugin, {}],
    ],
  });
  return folded?.code ?? "";
}

const requiredModules = (code: string) =>
  Array.from(code.matchAll(/require\("(\.\/src\/devtools\/[^"]+)"\)/gu), (match) => match[1]);

describe("development-only diagnostics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves no diagnostic in a release transform, even with the render counter flag set", () => {
    vi.stubEnv("EXPO_PUBLIC_RYCO_RENDER_COUNTER", "1");
    const code = transformEntry(false);
    // The walk must have produced the entry, or an empty result proves nothing.
    expect(code).toContain("registerRootComponent");
    expect(code).not.toContain("renderCounter");
    expect(code).not.toContain("e2eeVectorRunner");
  });

  it("keeps both diagnostics in a development transform", () => {
    expect(requiredModules(transformEntry(true)).toSorted()).toEqual([
      "./src/devtools/e2eeVectorRunner",
      "./src/devtools/renderCounter",
    ]);
  });
});
