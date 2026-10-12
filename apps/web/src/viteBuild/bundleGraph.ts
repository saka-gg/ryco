/**
 * The emitted chunk and asset graph of a web build, as the build plugins that
 * derive `index.html` preloads and the hosted service-worker precache read it.
 */
export interface BundleGraphEntry {
  readonly dynamicImports?: ReadonlyArray<string>;
  /** The source module a chunk was built for, when it has one (Rollup's `facadeModuleId`). */
  readonly facadeModuleId?: string | null;
  readonly fileName: string;
  readonly importedAssets?: ReadonlyArray<string>;
  readonly importedCss?: ReadonlyArray<string>;
  readonly imports?: ReadonlyArray<string>;
  readonly isEntry?: boolean;
  readonly referencedFiles?: ReadonlyArray<string>;
}

/**
 * The app module `index.html`'s entry script imports. The built entry is the
 * inline module script, which imports the app dynamically through Vite's
 * preload helper, so the app's static closure is not the entry's own.
 */
export const APP_ENTRY_MODULE = "src/main.tsx";

export function bundleGraphEntries(
  bundle: Readonly<Record<string, { readonly fileName: string }>>,
): ReadonlyArray<BundleGraphEntry> {
  return Object.values(bundle).map((entry) => {
    const output = entry as typeof entry & {
      readonly dynamicImports?: ReadonlyArray<string>;
      readonly facadeModuleId?: string | null;
      readonly imports?: ReadonlyArray<string>;
      readonly isEntry?: boolean;
      readonly referencedFiles?: ReadonlyArray<string>;
      readonly viteMetadata?: {
        readonly importedAssets?: ReadonlySet<string>;
        readonly importedCss?: ReadonlySet<string>;
      };
    };
    return {
      dynamicImports: output.dynamicImports ?? [],
      facadeModuleId: output.facadeModuleId ?? null,
      fileName: output.fileName,
      imports: output.imports ?? [],
      isEntry: output.isEntry ?? false,
      referencedFiles: output.referencedFiles ?? [],
      importedAssets: [...(output.viteMetadata?.importedAssets ?? [])],
      importedCss: [...(output.viteMetadata?.importedCss ?? [])],
    };
  });
}

/** Whether a chunk was built for one of `modules` (paths relative to the web package). */
export function isChunkOfModule(
  facadeModuleId: string | null | undefined,
  modules: ReadonlyArray<string>,
): boolean {
  if (!facadeModuleId) return false;
  const normalized = facadeModuleId.replaceAll("\\", "/");
  return modules.some((module) => normalized === module || normalized.endsWith(`/${module}`));
}

/**
 * Every file reachable from `roots`, in discovery order, following static
 * imports, their CSS and the files they reference always, imported assets
 * (fonts, images) only when `followAssets` is set, and dynamic imports only
 * when `followDynamic` is set.
 */
export function reachableFiles(
  entriesByFileName: ReadonlyMap<string, BundleGraphEntry>,
  roots: ReadonlyArray<string>,
  options: { readonly followDynamic: boolean; readonly followAssets?: boolean },
): ReadonlySet<string> {
  const followAssets = options.followAssets ?? true;
  const pendingFileNames = [...roots];
  const reachableFileNames = new Set<string>();
  for (let index = 0; index < pendingFileNames.length; index += 1) {
    const fileName = pendingFileNames[index];
    if (!fileName || reachableFileNames.has(fileName)) continue;
    reachableFileNames.add(fileName);
    const entry = entriesByFileName.get(fileName);
    if (!entry) continue;
    pendingFileNames.push(
      ...(entry.imports ?? []),
      ...(entry.importedCss ?? []),
      ...(followAssets ? (entry.importedAssets ?? []) : []),
      ...(entry.referencedFiles ?? []),
      ...(options.followDynamic ? (entry.dynamicImports ?? []) : []),
    );
  }
  return reachableFileNames;
}

export interface BootAssets {
  /** The HTML entry chunk(s): `index.html` loads these itself. */
  readonly entries: ReadonlyArray<string>;
  /**
   * Every JavaScript chunk evaluated before the app renders: the entries'
   * static imports and the app module with its static closure, entry first.
   */
  readonly modules: ReadonlyArray<string>;
  /** The stylesheets the entry's preload helper awaits before it imports the app. */
  readonly styles: ReadonlyArray<string>;
}

/**
 * The boot chain of a build. Without hints the browser discovers it one level
 * at a time: the entry, then the chunks it imports (which hold the preload
 * helper), and only once those ran the app module, its other imports and its
 * stylesheet.
 */
export function resolveBootAssets(entries: ReadonlyArray<BundleGraphEntry>): BootAssets {
  const entriesByFileName = new Map(entries.map((entry) => [entry.fileName, entry]));
  const entryFileNames = entries.filter((entry) => entry.isEntry).map((entry) => entry.fileName);
  const appFileNames = entries
    .filter((entry) => !entry.isEntry && isChunkOfModule(entry.facadeModuleId, [APP_ENTRY_MODULE]))
    .map((entry) => entry.fileName);
  // The entry's own imports first: they hold the preload helper the app
  // import waits for.
  const options = { followDynamic: false, followAssets: false } as const;
  const files = new Set([
    ...reachableFiles(entriesByFileName, entryFileNames, options),
    ...reachableFiles(entriesByFileName, appFileNames, options),
  ]);
  return {
    entries: entryFileNames,
    modules: [...files].filter((fileName) => /\.m?js$/i.test(fileName)),
    styles: [...files].filter((fileName) => /\.css$/i.test(fileName)),
  };
}
