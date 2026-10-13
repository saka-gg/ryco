import type { HtmlTagDescriptor, Plugin } from "vite";

import { bundleGraphEntries, resolveBootAssets, type BundleGraphEntry } from "./bundleGraph";

/**
 * `build.modulePreload.resolveDependencies` for the web build.
 *
 * - Dynamic imports (`hostType: "js"`) preload their whole static closure the
 *   moment the import starts: the chunk graph behind `main`, `RootAppShell`, a
 *   route body or a dialog downloads in one parallel round instead of being
 *   discovered level by level (it was 3-5 sequential rounds per phase). The
 *   boot loader's `import(main)` also fetches main's JS in parallel with its
 *   stylesheet instead of after it, because the preload helper only waits for
 *   CSS dependencies.
 * - The HTML entry (`hostType: "html"`) gets nothing from Vite: the boot chain
 *   it needs is the entry's imports plus the app module behind the entry's
 *   dynamic import, which Vite does not list for HTML. `createBootPreloadPlugin`
 *   writes exactly that chain into `index.html`, and nothing for later phases
 *   (preloading every phase at document start delayed the root `beforeLoad` by
 *   contention).
 */
export function resolveWebModulePreloadDependencies(
  _filename: string,
  deps: string[],
  context: { readonly hostId: string; readonly hostType: "html" | "js" },
): string[] {
  return context.hostType === "js" ? deps : [];
}

/**
 * The `index.html` hints for the boot chain: a `modulepreload` for every chunk
 * evaluated before the app renders (other than the entry script, which the
 * document already loads) and a style `preload` for the stylesheet the entry's
 * preload helper awaits. Each URL is one the boot requests anyway, with the
 * same CORS mode (the helper inserts its stylesheet with `crossorigin`), so a
 * hint only moves a request to document start and never adds one.
 */
export function bootPreloadTags(
  entries: ReadonlyArray<BundleGraphEntry>,
  base: string,
): HtmlTagDescriptor[] {
  const boot = resolveBootAssets(entries);
  const entryFiles = new Set(boot.entries);
  return [
    ...boot.modules
      .filter((fileName) => !entryFiles.has(fileName))
      .map((fileName): HtmlTagDescriptor => ({
        tag: "link",
        attrs: { rel: "modulepreload", crossorigin: "", href: `${base}${fileName}` },
        injectTo: "head",
      })),
    ...boot.styles.map((fileName): HtmlTagDescriptor => ({
      tag: "link",
      attrs: { rel: "preload", as: "style", crossorigin: "", href: `${base}${fileName}` },
      injectTo: "head",
    })),
  ];
}

/**
 * Starts the whole boot chain with the document. Without it the browser found
 * the chain one level at a time — the entry, then the chunks it imports (which
 * hold the preload helper), and only once those ran the app module, its other
 * imports and its stylesheet: one extra round trip each, measured at -0.47 s
 * to the hosted sign-in on a 150 ms / 1.6 Mbps link.
 */
export function createBootPreloadPlugin(): Plugin {
  let base = "/";
  return {
    name: "ryco-boot-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context): HtmlTagDescriptor[] {
        if (!context.bundle) return [];
        return bootPreloadTags(bundleGraphEntries(context.bundle), base);
      },
    },
  };
}
