import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { createWebViteConfig, shouldEnableHostedPwaBuild } from "../vite.config";
import { resolveWebModulePreloadDependencies } from "./viteBuild/modulePreload";
import { REACT_COMPILER_EXCLUDE, REACT_COMPILER_INCLUDE } from "./viteBuild/reactCompilerScope";

type ViteConfigWithOptimizeDeps = {
  readonly optimizeDeps?: {
    readonly include?: readonly string[];
  };
  readonly define?: Record<string, string>;
  readonly resolve?: {
    readonly dedupe?: readonly string[];
  };
  readonly test?: {
    readonly maxWorkers?: number;
  };
  readonly build?: {
    readonly modulePreload?:
      | boolean
      | {
          readonly polyfill?: boolean;
          readonly resolveDependencies?: unknown;
        };
    readonly rolldownOptions?: {
      readonly output?: {
        readonly codeSplitting?: unknown;
        readonly chunkFileNames?: unknown;
      };
    };
  };
  readonly worker?: {
    readonly format?: string;
  };
};

type NamedPlugin = { readonly name: string; readonly [key: string]: unknown };

function collectPlugins(value: unknown): ReadonlyArray<NamedPlugin> {
  if (Array.isArray(value)) return value.flatMap(collectPlugins);
  if (value && typeof value === "object" && "name" in value && typeof value.name === "string") {
    return [value as NamedPlugin];
  }
  return [];
}

function collectPluginNames(value: unknown): ReadonlyArray<string> {
  return collectPlugins(value).map((plugin) => plugin.name);
}

type IdFilter = RegExp | ReadonlyArray<RegExp>;

/** plugin-react's `vite:react-compiler` transform hook, as far as these tests use it. */
interface ReactCompilerTransformHook {
  readonly filter: { readonly id: { readonly include: IdFilter; readonly exclude: IdFilter } };
  readonly handler: (
    this: unknown,
    code: string,
    id: string,
  ) => Promise<{ readonly code: string } | undefined>;
}

function reactCompilerTransform(): ReactCompilerTransformHook {
  const plugin = collectPlugins(createWebViteConfig().plugins).find(
    ({ name }) => name === "vite:react-compiler",
  );
  if (!plugin) throw new Error("vite:react-compiler is not configured");
  return plugin.transform as ReactCompilerTransformHook;
}

function matchesIdFilter(filter: IdFilter, id: string): boolean {
  return (Array.isArray(filter) ? filter : [filter]).some((pattern) => pattern.test(id));
}

/**
 * Runs the configured compiler transform on a fixture the way a production
 * client build does. The fixtures live in `test/`, outside the compiler's
 * scope, so each is compiled as if it sat in `src/` (the module id names a
 * directory that does not exist; the transform only reads the code).
 */
async function compileForClientBuild(fixture: string): Promise<string> {
  const code = await readFile(
    new URL(`../test/fixtures/reactCompiler/${fixture}`, import.meta.url),
    "utf8",
  );
  const id = fileURLToPath(new URL(`./reactCompilerFixtures/${fixture}`, import.meta.url));
  const transform = reactCompilerTransform();
  // Calling the handler directly skips the hook filter, so check it here.
  expect(matchesIdFilter(transform.filter.id.include, id), id).toBe(true);
  expect(matchesIdFilter(transform.filter.id.exclude, id), id).toBe(false);
  const context = {
    environment: { config: { consumer: "client", command: "build", build: { sourcemap: false } } },
    error(error: unknown): never {
      throw error instanceof Error ? error : new Error(String(error));
    },
    warn() {},
  };
  const result = await transform.handler.call(context, code, id);
  return result?.code ?? "";
}

describe("web Vite config", () => {
  it("prebundles react-dom/client before browser tests start", () => {
    const config = createWebViteConfig() as ViteConfigWithOptimizeDeps;

    expect(config.optimizeDeps?.include).toContain("react-dom/client");
    expect(config.optimizeDeps?.include).toContain("@tanstack/react-router");
  });

  it("caps unit-test workers to prevent module-graph memory amplification", () => {
    const config = createWebViteConfig() as ViteConfigWithOptimizeDeps;
    expect(config.test?.maxWorkers).toBeGreaterThan(0);
    expect(config.test?.maxWorkers).toBeLessThanOrEqual(4);
  });

  it("deduplicates react and react-dom so workspace deps cannot embed a second runtime", () => {
    for (const clientMode of ["standard", "hosted-hub"] as const) {
      const dedupe = (createWebViteConfig(clientMode) as ViteConfigWithOptimizeDeps).resolve
        ?.dedupe;

      expect(dedupe).toContain("react");
      expect(dedupe).toContain("react-dom");
    }
  });

  it("limits React compiler transforms to web React source", () => {
    expect(REACT_COMPILER_INCLUDE.test("/repo/apps/web/src/components/ChatView.tsx")).toBe(true);
    expect(REACT_COMPILER_INCLUDE.test("/repo/packages/client-runtime/src/state/store.ts")).toBe(
      false,
    );

    const excluded = (path: string) => REACT_COMPILER_EXCLUDE.some((pattern) => pattern.test(path));
    expect(excluded("/repo/apps/web/src/routeTree.gen.ts")).toBe(true);
    expect(excluded("/repo/apps/web/src/workers/example.worker.ts")).toBe(true);
    expect(excluded("/repo/apps/web/src/components/ChatView.logic.ts")).toBe(true);
    expect(excluded("/repo/apps/web/src/components/ChatView.tsx")).toBe(false);
  });

  it("compiles web React source with the Oxc React Compiler", () => {
    const names = collectPluginNames(createWebViteConfig().plugins);

    expect(names).toContain("vite:react-compiler");
    expect(names).not.toContain("ryco:react-compiler");
  });

  it("applies the compiler filters to the compiler transform", () => {
    const { filter } = reactCompilerTransform();
    const compiles = (id: string) =>
      matchesIdFilter(filter.id.include, id) && !matchesIdFilter(filter.id.exclude, id);

    expect(compiles("/repo/apps/web/src/components/ChatView.tsx")).toBe(true);
    expect(compiles("/repo/apps/web/src/components/ChatView.tsx?v=1")).toBe(true);
    expect(compiles("/repo/apps/web/src/components/ChatView.logic.ts")).toBe(false);
    expect(compiles("/repo/packages/client-runtime/src/state/store.ts")).toBe(false);
  });

  it("memoizes components and hooks in TSX and TS modules and honors opt-outs", async () => {
    const counterList = await compileForClientBuild("CounterList.tsx");
    expect(counterList).toContain("react/compiler-runtime");
    expect(counterList).not.toContain("interface CounterListProps");

    const sortedEntries = await compileForClientBuild("useSortedEntries.ts");
    expect(sortedEntries).toContain("react/compiler-runtime");
    expect(sortedEntries).not.toContain("ReadonlyArray<T>");

    const labeledInput = await compileForClientBuild("LabeledInput.tsx");
    expect(labeledInput).toContain("react/compiler-runtime");
    expect(labeledInput).toContain("function OptedOut");
    const optedOut = labeledInput.slice(labeledInput.indexOf("function OptedOut"));
    expect(optedOut.slice(0, optedOut.indexOf("\n}"))).not.toMatch(/_c\d*\(/);
  });

  it("enables PWA artifacts only for production hosted builds", () => {
    expect(shouldEnableHostedPwaBuild({ clientMode: "hosted-hub", command: "build" })).toBe(true);
    expect(shouldEnableHostedPwaBuild({ clientMode: "hosted-hub", command: "serve" })).toBe(false);
    expect(shouldEnableHostedPwaBuild({ clientMode: "standard", command: "build" })).toBe(false);
    expect(shouldEnableHostedPwaBuild({ clientMode: "standard", command: "serve" })).toBe(false);

    const pluginNames = (clientMode: "hosted-hub" | "standard") =>
      collectPluginNames(createWebViteConfig(clientMode).plugins);
    expect(pluginNames("hosted-hub")).toContain("ryco-hosted-pwa");
    expect(pluginNames("standard")).not.toContain("ryco-hosted-pwa");
  });

  it("compiles the requested client mode and wires the standard-build seams", () => {
    for (const clientMode of ["standard", "hosted-hub"] as const) {
      const config = createWebViteConfig(clientMode) as ViteConfigWithOptimizeDeps;
      expect(config.define?.["import.meta.env.VITE_RYCO_CLIENT_MODE"]).toBe(
        JSON.stringify(clientMode),
      );
      expect(collectPluginNames(createWebViteConfig(clientMode).plugins)).toContain(
        "ryco:client-mode-seams",
      );
    }
  });

  it("preloads each dynamic import's closure without eager index.html preloads", () => {
    const build = (createWebViteConfig() as ViteConfigWithOptimizeDeps).build;
    const modulePreload = build?.modulePreload;

    expect(typeof modulePreload).toBe("object");
    if (typeof modulePreload !== "object") return;
    expect(modulePreload.polyfill).toBe(false);
    expect(modulePreload.resolveDependencies).toBe(resolveWebModulePreloadDependencies);
    expect(build?.rolldownOptions?.output?.codeSplitting).toBeTruthy();
    expect(build?.rolldownOptions?.output?.chunkFileNames).toBeTypeOf("function");
  });

  it("groups the cold hosted routes' package modules only in hosted builds", () => {
    const groupCount = (clientMode: "hosted-hub" | "standard") => {
      const codeSplitting = (createWebViteConfig(clientMode) as ViteConfigWithOptimizeDeps).build
        ?.rolldownOptions?.output?.codeSplitting as { readonly groups: ReadonlyArray<unknown> };
      return codeSplitting.groups.length;
    };
    // Standard builds keep their chunk layout.
    expect(groupCount("hosted-hub")).toBe(groupCount("standard") + 1);
  });

  it("builds ES workers so the diff worker stops inlining the Shiki wasm", () => {
    expect((createWebViteConfig() as ViteConfigWithOptimizeDeps).worker?.format).toBe("es");
  });

  it("precompresses and preloads the boot font only for standard builds", () => {
    const pluginNames = (clientMode: "hosted-hub" | "standard") =>
      collectPluginNames(createWebViteConfig(clientMode).plugins);

    expect(pluginNames("standard")).toContain("ryco-precompressed-assets");
    expect(pluginNames("standard")).toContain("ryco-boot-font-preload");
    expect(pluginNames("hosted-hub")).not.toContain("ryco-precompressed-assets");
    expect(pluginNames("hosted-hub")).not.toContain("ryco-boot-font-preload");
  });

  it("normalizes empty phone app interstitial settings to disabled", () => {
    const config = createWebViteConfig("standard", "", "") as ViteConfigWithOptimizeDeps;

    expect(config.define?.["import.meta.env.VITE_RYCO_PHONE_APP_INTERSTITIAL"]).toBe('"disabled"');
    expect(config.define?.["import.meta.env.VITE_RYCO_MOBILE_APP_URL"]).toBe('""');
  });

  it("passes configured phone app interstitial settings into build defines", () => {
    const config = createWebViteConfig(
      "standard",
      "enabled",
      "https://example.com/ryco",
    ) as ViteConfigWithOptimizeDeps;

    expect(config.define?.["import.meta.env.VITE_RYCO_PHONE_APP_INTERSTITIAL"]).toBe('"enabled"');
    expect(config.define?.["import.meta.env.VITE_RYCO_MOBILE_APP_URL"]).toBe(
      '"https://example.com/ryco"',
    );
  });

  it("normalizes unexpected phone app interstitial flag values to disabled", () => {
    const config = createWebViteConfig("standard", "unexpected") as ViteConfigWithOptimizeDeps;

    expect(config.define?.["import.meta.env.VITE_RYCO_PHONE_APP_INTERSTITIAL"]).toBe('"disabled"');
  });
});
