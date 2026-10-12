import type { HtmlTagDescriptor, Plugin } from "vite";

/** The default UI face (`index.css` `@font-face "DM Sans"`, latin subset). */
export const BOOT_FONT_SOURCE_NAME = "dm-sans-latin-wght-normal.woff2";

interface BundleAssetLike {
  readonly type: string;
  readonly fileName: string;
  readonly names?: ReadonlyArray<string>;
  readonly originalFileNames?: ReadonlyArray<string>;
}

/** The emitted (hashed) file of the boot font, or null when it was not bundled. */
export function findBootFontAsset(
  bundle: Readonly<Record<string, BundleAssetLike>>,
): string | null {
  for (const output of Object.values(bundle)) {
    if (output.type !== "asset" || !output.fileName.endsWith(".woff2")) continue;
    const sources = [...(output.names ?? []), ...(output.originalFileNames ?? [])];
    if (sources.some((source) => source.endsWith(BOOT_FONT_SOURCE_NAME))) return output.fileName;
  }
  return null;
}

/**
 * Preloads the default UI font from `index.html`. The face was first requested
 * only when the shell committed text, so the sidebar re-laid out right after
 * the first meaningful paint (font-display: swap). The preload starts it
 * alongside the boot loader; the hashed URL is the asset the stylesheet
 * references, so the CSS request hits the preloaded response.
 */
export function createBootFontPreloadPlugin(): Plugin {
  let base = "/";
  return {
    name: "ryco-boot-font-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context): HtmlTagDescriptor[] {
        const fileName = context.bundle ? findBootFontAsset(context.bundle) : null;
        if (!fileName) return [];
        return [
          {
            tag: "link",
            attrs: {
              rel: "preload",
              as: "font",
              type: "font/woff2",
              crossorigin: "",
              href: `${base}${fileName}`,
            },
            injectTo: "head",
          },
        ];
      },
    },
  };
}
