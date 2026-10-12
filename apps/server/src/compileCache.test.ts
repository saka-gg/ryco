import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { enableCompileCacheBestEffort, resolveCompileCacheDirectory } from "./compileCache.ts";

const nodeModule = vi.hoisted(() => ({
  enableCompileCache: vi.fn<(directory?: string) => unknown>(),
}));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, enableCompileCache: nodeModule.enableCompileCache };
});

afterEach(() => {
  nodeModule.enableCompileCache.mockReset();
});

describe("resolveCompileCacheDirectory", () => {
  it("uses Ryco Desktop's compile cache directory when inherited", () => {
    expect(
      resolveCompileCacheDirectory({
        RYCO_COMPILE_CACHE_DIR: " /Users/me/Library/Application Support/Ryco/compile-cache/1.2.3 ",
        NODE_COMPILE_CACHE: "/tmp/node-compile-cache",
      }),
    ).toBe("/Users/me/Library/Application Support/Ryco/compile-cache/1.2.3");
  });

  it("leaves the choice to Node otherwise", () => {
    expect(resolveCompileCacheDirectory({})).toBeUndefined();
    expect(resolveCompileCacheDirectory({ RYCO_COMPILE_CACHE_DIR: "  " })).toBeUndefined();
    expect(
      resolveCompileCacheDirectory({ NODE_COMPILE_CACHE: "/tmp/node-compile-cache" }),
    ).toBeUndefined();
  });
});

describe("enableCompileCacheBestEffort", () => {
  it("hands Desktop's directory to Node, else Node's default", () => {
    enableCompileCacheBestEffort({ RYCO_COMPILE_CACHE_DIR: "/cache/1.2.3" });
    enableCompileCacheBestEffort({});
    expect(nodeModule.enableCompileCache.mock.calls).toEqual([["/cache/1.2.3"], [undefined]]);
  });

  it("never fails startup", () => {
    nodeModule.enableCompileCache.mockImplementation(() => {
      throw new Error("unwritable cache directory");
    });
    expect(() => enableCompileCacheBestEffort({ RYCO_COMPILE_CACHE_DIR: "/cache" })).not.toThrow();
  });
});
