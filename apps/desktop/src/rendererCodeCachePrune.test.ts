import { describe, expect, it } from "vite-plus/test";

import {
  isCodeCachedAsset,
  parseRendererCodeCacheMarker,
  planRendererCodeCachePrune,
  RENDERER_CODE_CACHE_MAX_ORIGINS,
  type RendererCodeCacheMarker,
  serializeRendererCodeCacheMarker,
} from "./rendererCodeCachePrune.ts";

const origin = "http://127.0.0.1:7926";
const current = {
  version: "0.1.32",
  electron: "44.7.0",
  assets: ["boot-vendor-AAAA.js", "boot-BBBB.js", "shiki-CCCC.js"],
  origin,
};
const previous: RendererCodeCacheMarker = {
  version: "0.1.31",
  electron: "44.7.0",
  assets: ["boot-ZZZZ.js", "boot-vendor-AAAA.js", "settings-YYYY.js", "shiki-CCCC.js"],
  origins: [origin],
};

describe("planRendererCodeCachePrune", () => {
  it("keeps the entries of unchanged chunks across an app-only update", () => {
    const plan = planRendererCodeCachePrune(previous, current);
    expect(plan.prune).toEqual({
      kind: "urls",
      urls: [`${origin}/assets/boot-ZZZZ.js`, `${origin}/assets/settings-YYYY.js`],
    });
    expect(plan.marker).toEqual({
      version: "0.1.32",
      electron: "44.7.0",
      assets: ["boot-BBBB.js", "boot-vendor-AAAA.js", "shiki-CCCC.js"],
      origins: [origin],
    });
  });

  it("clears the removed chunks under every origin that may have cached them", () => {
    const flipped = "http://127.0.0.1:7927";
    const plan = planRendererCodeCachePrune(
      { ...previous, assets: ["boot-ZZZZ.js"], origins: [flipped, origin] },
      current,
    );
    expect(plan.prune).toEqual({
      kind: "urls",
      urls: [`${flipped}/assets/boot-ZZZZ.js`, `${origin}/assets/boot-ZZZZ.js`],
    });
    // Retained chunks may still be cached under both origins.
    expect(plan.marker?.origins).toEqual([origin, flipped]);
  });

  it("clears nothing when an update ships the same scripts", () => {
    const plan = planRendererCodeCachePrune({ ...previous, assets: [...current.assets] }, current);
    expect(plan.prune).toEqual({ kind: "none" });
    expect(plan.marker?.version).toBe("0.1.32");
  });

  it("clears everything for an Electron change, an unknown history or unlisted assets", () => {
    expect(planRendererCodeCachePrune({ ...previous, electron: "43.0.0" }, current).prune).toEqual({
      kind: "all",
    });
    expect(planRendererCodeCachePrune(null, current).prune).toEqual({ kind: "all" });
    expect(planRendererCodeCachePrune(previous, { ...current, assets: null }).prune).toEqual({
      kind: "all",
    });
    // The plain version string earlier builds wrote.
    const legacy = parseRendererCodeCacheMarker("0.1.31\n");
    expect(planRendererCodeCachePrune(legacy, current).prune).toEqual({ kind: "all" });
    const cleared = planRendererCodeCachePrune(
      { ...previous, origins: ["http://127.0.0.1:7927", origin] },
      { ...current, electron: "45.0.0" },
    );
    expect(cleared.marker?.origins).toEqual([origin]);
  });

  it("only records a new origin within the same build", () => {
    const same = { ...previous, version: current.version, assets: current.assets.toSorted() };
    expect(planRendererCodeCachePrune(same, current)).toEqual({
      prune: { kind: "none" },
      marker: null,
    });
    const legacy = parseRendererCodeCacheMarker(current.version);
    expect(planRendererCodeCachePrune(legacy, current).prune).toEqual({ kind: "none" });
    expect(planRendererCodeCachePrune(legacy, current).marker?.assets).toEqual(
      current.assets.toSorted(),
    );

    const moved = planRendererCodeCachePrune(same, { ...current, origin: "http://127.0.0.1:7930" });
    expect(moved.prune).toEqual({ kind: "none" });
    expect(moved.marker?.origins).toEqual(["http://127.0.0.1:7930", origin]);
    // A failed listing keeps the assets this build listed before.
    expect(
      planRendererCodeCachePrune(same, { ...current, assets: null, origin: "http://x:1" }).marker
        ?.assets,
    ).toEqual(same.assets);
  });

  it("bounds the remembered origins", () => {
    let marker: RendererCodeCacheMarker | null = { ...previous, version: current.version };
    for (let port = 8000; port < 8010; port += 1) {
      marker =
        planRendererCodeCachePrune(marker, { ...current, origin: `http://127.0.0.1:${port}` })
          .marker ?? marker;
    }
    expect(marker?.origins).toHaveLength(RENDERER_CODE_CACHE_MAX_ORIGINS);
    expect(marker?.origins[0]).toBe("http://127.0.0.1:8009");
  });
});

describe("renderer code cache marker", () => {
  it("round-trips and rejects damaged markers", () => {
    expect(parseRendererCodeCacheMarker(serializeRendererCodeCacheMarker({ ...previous }))).toEqual(
      previous,
    );
    expect(parseRendererCodeCacheMarker(null)).toBeNull();
    expect(parseRendererCodeCacheMarker("")).toBeNull();
    expect(parseRendererCodeCacheMarker("{")).toBeNull();
    expect(parseRendererCodeCacheMarker('{"format":2,"version":"1"}')).toBeNull();
  });

  it("knows which assets V8 caches code for", () => {
    expect(isCodeCachedAsset("boot-AAAA.js")).toBe(true);
    expect(isCodeCachedAsset("worker-AAAA.mjs")).toBe(true);
    expect(isCodeCachedAsset("onig-AAAA.wasm")).toBe(true);
    expect(isCodeCachedAsset("index-AAAA.css")).toBe(false);
    expect(isCodeCachedAsset("boot-AAAA.js.map")).toBe(false);
  });
});
