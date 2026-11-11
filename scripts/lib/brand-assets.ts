export const BRAND_ASSET_PATHS = {
  productionMacIconPng: "assets/prod/ryco-macos-1024.png",
  productionMacIconset: "assets/prod/ryco-macos.iconset",
  /** The Liquid Glass app icon, compiled by scripts/generate-app-icon-variants.py. */
  productionMacAssetCatalog: "assets/prod/ryco-macos-Assets.car",
  productionLinuxIconPng: "assets/prod/ryco-linux-1024.png",
  productionWindowsIconIco: "assets/prod/ryco-windows.ico",
  productionWebFaviconIco: "assets/prod/favicon/favicon.ico",
  productionWebFaviconSvg: "assets/prod/favicon/favicon.svg",
  productionWebFavicon96Png: "assets/prod/favicon/favicon-96x96.png",
  productionWebAppleTouchIconPng: "assets/prod/favicon/apple-touch-icon.png",
  productionWebManifest192Png: "assets/prod/favicon/web-app-manifest-192x192.png",
  productionWebManifest512Png: "assets/prod/favicon/web-app-manifest-512x512.png",
  productionWebSiteManifest: "assets/prod/favicon/site.webmanifest",

  nightlyMacIconPng: "assets/nightly/ryco-macos-1024.png",
  nightlyMacIconset: "assets/nightly/ryco-macos.iconset",
  nightlyLinuxIconPng: "assets/nightly/ryco-linux-1024.png",
  nightlyWindowsIconIco: "assets/nightly/ryco-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/favicon/favicon.ico",
  nightlyWebFaviconSvg: "assets/nightly/favicon/favicon.svg",
  nightlyWebFavicon96Png: "assets/nightly/favicon/favicon-96x96.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/favicon/apple-touch-icon.png",
  nightlyWebManifest192Png: "assets/nightly/favicon/web-app-manifest-192x192.png",
  nightlyWebManifest512Png: "assets/nightly/favicon/web-app-manifest-512x512.png",
  nightlyWebSiteManifest: "assets/nightly/favicon/site.webmanifest",

  developmentDesktopIconPng: "assets/dev/ryco-macos-1024.png",
  developmentMacIconset: "assets/dev/ryco-macos.iconset",
  developmentLinuxIconPng: "assets/dev/ryco-linux-1024.png",
  developmentWindowsIconIco: "assets/dev/ryco-windows.ico",
  developmentWebFaviconIco: "assets/dev/favicon/favicon.ico",
  developmentWebFaviconSvg: "assets/dev/favicon/favicon.svg",
  developmentWebFavicon96Png: "assets/dev/favicon/favicon-96x96.png",
  developmentWebAppleTouchIconPng: "assets/dev/favicon/apple-touch-icon.png",
  developmentWebManifest192Png: "assets/dev/favicon/web-app-manifest-192x192.png",
  developmentWebManifest512Png: "assets/dev/favicon/web-app-manifest-512x512.png",
  developmentWebSiteManifest: "assets/dev/favicon/site.webmanifest",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const PRODUCTION_WEB_ICON_OVERRIDE_FILES = [
  { source: BRAND_ASSET_PATHS.productionWebFaviconIco, filename: "favicon.ico" },
  { source: BRAND_ASSET_PATHS.productionWebFaviconSvg, filename: "favicon.svg" },
  { source: BRAND_ASSET_PATHS.productionWebFavicon96Png, filename: "favicon-96x96.png" },
  { source: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng, filename: "apple-touch-icon.png" },
  {
    source: BRAND_ASSET_PATHS.productionWebManifest192Png,
    filename: "web-app-manifest-192x192.png",
  },
  {
    source: BRAND_ASSET_PATHS.productionWebManifest512Png,
    filename: "web-app-manifest-512x512.png",
  },
  { source: BRAND_ASSET_PATHS.productionWebSiteManifest, filename: "site.webmanifest" },
] as const;

const DEVELOPMENT_WEB_ICON_OVERRIDE_FILES = [
  { source: BRAND_ASSET_PATHS.developmentWebFaviconIco, filename: "favicon.ico" },
  { source: BRAND_ASSET_PATHS.developmentWebFaviconSvg, filename: "favicon.svg" },
  { source: BRAND_ASSET_PATHS.developmentWebFavicon96Png, filename: "favicon-96x96.png" },
  { source: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng, filename: "apple-touch-icon.png" },
  {
    source: BRAND_ASSET_PATHS.developmentWebManifest192Png,
    filename: "web-app-manifest-192x192.png",
  },
  {
    source: BRAND_ASSET_PATHS.developmentWebManifest512Png,
    filename: "web-app-manifest-512x512.png",
  },
  { source: BRAND_ASSET_PATHS.developmentWebSiteManifest, filename: "site.webmanifest" },
] as const;

const NIGHTLY_WEB_ICON_OVERRIDE_FILES = [
  { source: BRAND_ASSET_PATHS.nightlyWebFaviconIco, filename: "favicon.ico" },
  { source: BRAND_ASSET_PATHS.nightlyWebFaviconSvg, filename: "favicon.svg" },
  { source: BRAND_ASSET_PATHS.nightlyWebFavicon96Png, filename: "favicon-96x96.png" },
  { source: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng, filename: "apple-touch-icon.png" },
  {
    source: BRAND_ASSET_PATHS.nightlyWebManifest192Png,
    filename: "web-app-manifest-192x192.png",
  },
  {
    source: BRAND_ASSET_PATHS.nightlyWebManifest512Png,
    filename: "web-app-manifest-512x512.png",
  },
  { source: BRAND_ASSET_PATHS.nightlyWebSiteManifest, filename: "site.webmanifest" },
] as const;

const WEB_ICON_OVERRIDE_FILES_BY_BRAND = {
  development: DEVELOPMENT_WEB_ICON_OVERRIDE_FILES,
  nightly: NIGHTLY_WEB_ICON_OVERRIDE_FILES,
  production: PRODUCTION_WEB_ICON_OVERRIDE_FILES,
} as const satisfies Record<
  WebAssetBrand,
  ReadonlyArray<{ readonly source: string; readonly filename: string }>
>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  return WEB_ICON_OVERRIDE_FILES_BY_BRAND[brand].map((override) => ({
    sourceRelativePath: override.source,
    targetRelativePath: `${targetDirectory}/${override.filename}`,
  }));
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const NIGHTLY_ICON_OVERRIDES = resolveWebIconOverrides("nightly", "dist/client");

export const PUBLISH_ICON_OVERRIDES = resolveWebIconOverrides("production", "dist/client");
