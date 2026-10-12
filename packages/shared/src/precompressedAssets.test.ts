import { describe, expect, it } from "vite-plus/test";

import {
  hasPrecompressibleAssetExtension,
  PRECOMPRESSED_ASSET_ENCODINGS,
} from "./precompressedAssets.ts";

describe("precompressed assets", () => {
  it("prefers brotli, then gzip", () => {
    expect(PRECOMPRESSED_ASSET_ENCODINGS.map((variant) => variant.suffix)).toEqual([".br", ".gz"]);
  });

  it("covers every asset kind the web build compresses", () => {
    for (const fileName of [
      "/srv/assets/main-abc.js",
      "/srv/assets/main-abc.CSS",
      "/srv/assets/worker-abc.mjs",
      "/srv/index.html",
      "/srv/favicon.svg",
      "/srv/site.webmanifest",
      "/srv/assets/quickjs-eval-abc.wasm",
      "/srv/assets/LiberationSans-Regular-abc.ttf",
      "/srv/assets/78-EUC-H-abc.bcmap",
      "/srv/assets/FoxitSans-abc.pfb",
      "C:\\srv\\assets\\main-abc.json",
    ]) {
      expect(hasPrecompressibleAssetExtension(fileName), fileName).toBe(true);
    }
  });

  it("skips binary formats and names without an extension", () => {
    for (const fileName of [
      "/srv/icon.png",
      "/srv/font.woff2",
      "/srv/LICENSE",
      "/srv/.js",
      "/srv/assets.js/LICENSE",
    ]) {
      expect(hasPrecompressibleAssetExtension(fileName), fileName).toBe(false);
    }
  });
});
