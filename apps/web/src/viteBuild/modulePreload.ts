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
 * - The HTML entry (`hostType: "html"`) preloads nothing: `index.html` paints
 *   the boot shell first and nothing is fetched speculatively for phases that
 *   have not started (preloading every phase at document start delayed the
 *   root `beforeLoad` by contention).
 */
export function resolveWebModulePreloadDependencies(
  _filename: string,
  deps: string[],
  context: { readonly hostId: string; readonly hostType: "html" | "js" },
): string[] {
  return context.hostType === "js" ? deps : [];
}
