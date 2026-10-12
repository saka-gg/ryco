import { describe, expect, it } from "vite-plus/test";

import {
  createWebViteConfig,
  REACT_COMPILER_EXCLUDE,
  REACT_COMPILER_INCLUDE,
  shouldEnableHostedPwaBuild,
} from "../vite.config";
import { resolveWebModulePreloadDependencies } from "./viteBuild/modulePreload";

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

function collectPluginNames(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) return value.flatMap(collectPluginNames);
  if (value && typeof value === "object" && "name" in value && typeof value.name === "string") {
    return [value.name];
  }
  return [];
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
