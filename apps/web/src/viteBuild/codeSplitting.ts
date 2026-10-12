/**
 * Rolldown `output.codeSplitting` for the web build.
 *
 * Automatic chunking gives every distinct set of importing entries its own
 * shared chunk. With ~150 lazy entries that produced 90+ JS files under 2 KiB
 * on the way to the composer — single lucide icons, tiny vendor helpers and
 * small application modules — each a separate request on a 6-connection
 * HTTP/1.1 pool.
 *
 * - `boot`: the modules of the static closure of `main` (the boot graph) go
 *   into one chunk instead of ~90 files. The boot graph is evaluated in full
 *   before anything else in the app runs, so regrouping it only changes the
 *   file layout. The one exception is a module of a `sideEffects: false`
 *   workspace package (`@ryco/client-runtime`, `@ryco/shared`,
 *   `@ryco/contracts`) that boot imports only for code the bundler drops: it
 *   now evaluates at boot instead of with its first lazy importer, which those
 *   packages declare to be harmless.
 * - `boot-vendor`: the installed packages the boot graph imports (React, the
 *   router, Effect, Base UI; lucide icons keep their own group). They change
 *   only with dependency upgrades, so an app-only deploy keeps this chunk and
 *   every lazy chunk that imports nothing else from boot: a boot change used to
 *   rename 169 of 198 precached files (1.6 MiB zstd per installed browser) and
 *   now renames 142 (1.1 MiB).
 * - Vendor groups capture modules shared by two or more entries
 *   (`minShareCount: 2`, so no entry chunk loses its own modules) and only
 *   from side-effect-free packages, where loading a module a little early has
 *   no observable effect. `entriesAware` keeps modules grouped by the entries
 *   that import them, and subgroups under the merge threshold fold into their
 *   closest neighbour instead of becoming separate tiny files. Lexical, the
 *   markdown stack and Shiki get their own groups so their chunks keep the same
 *   bytes (and cache entries) across deploys that only change app code.
 *
 * Application modules outside the boot graph keep automatic chunking: their
 * top-level code may have side effects, so they must not be evaluated by
 * entries that never import them. Mermaid is excluded for the same reason (its
 * shared chunks register diagram loaders on evaluation), and so are Shiki's
 * per-language grammars, themes and WASM, which are on-demand entries.
 */
export const CODE_SPLITTING_MERGE_THRESHOLD_BYTES = 12 * 1024;

const SEP = String.raw`[\\/]`;
const NODE_MODULES = String.raw`[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?`;
const LUCIDE_MODULE = new RegExp(`${NODE_MODULES}lucide-react${SEP}`);
const VENDOR_MODULE = new RegExp(`${NODE_MODULES}@base-ui${SEP}`);
const LEXICAL_MODULE = new RegExp(`${NODE_MODULES}(?:lexical|@lexical${SEP}[^\\\\/]+)${SEP}`);
const MARKDOWN_PACKAGES = [
  "react-markdown",
  "remark-[^\\\\/]+",
  "rehype-[^\\\\/]+",
  "micromark(?:-[^\\\\/]+)?",
  "mdast-util-[^\\\\/]+",
  "hast-util-[^\\\\/]+",
  "hastscript",
  "unist-util-[^\\\\/]+",
  "unified",
  "vfile(?:-[^\\\\/]+)?",
  "bail",
  "trough",
  "devlop",
  "ccount",
  "character-entities(?:-[^\\\\/]+)?",
  "character-reference-invalid",
  "decode-named-character-reference",
  "property-information",
  "space-separated-tokens",
  "comma-separated-tokens",
  "html-url-attributes",
  "html-void-elements",
  "zwitch",
  "longest-streak",
  "markdown-table",
  "estree-util-[^\\\\/]+",
  "trim-lines",
  "is-plain-obj",
  "style-to-object",
  "style-to-js",
  "inline-style-parser",
  "parse5",
  "entities",
  "web-namespaces",
  "is-(?:alphabetical|alphanumerical|decimal|hexadecimal)",
] as const;
const MARKDOWN_MODULE = new RegExp(`${NODE_MODULES}(?:${MARKDOWN_PACKAGES.join("|")})${SEP}`);
const SHIKI_MODULE = new RegExp(
  `${NODE_MODULES}(?:shiki|@shikijs${SEP}(?:core|types|primitive|vscode-textmate|engine-javascript|engine-oniguruma|transformers)|oniguruma-to-es|oniguruma-parser|regex|regex-utilities|regex-recursion)${SEP}`,
);
/** Shiki's WASM engine binary loads on demand; it must stay its own chunk. */
const WASM_MODULE = /wasm[^\\/]*$/i;

export function isMergeableIconModule(moduleId: string): boolean {
  return LUCIDE_MODULE.test(moduleId);
}

export function isMergeableVendorModule(moduleId: string): boolean {
  return VENDOR_MODULE.test(moduleId);
}

export function isLexicalModule(moduleId: string): boolean {
  return LEXICAL_MODULE.test(moduleId);
}

export function isMarkdownModule(moduleId: string): boolean {
  return MARKDOWN_MODULE.test(moduleId);
}

export function isShikiModule(moduleId: string): boolean {
  return SHIKI_MODULE.test(moduleId) && !WASM_MODULE.test(moduleId);
}

/** The slice of rolldown's `ChunkingContext` the boot group reads. */
export interface ModuleGraphContext {
  getModuleInfo(moduleId: string): {
    readonly code: string | null;
    readonly importedIds: ReadonlyArray<string>;
  } | null;
}

const normalizeModuleId = (moduleId: string) => moduleId.replaceAll("\\", "/");
const REEXPORT_STATEMENT = /^export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])[^"']+\1$/;

/**
 * Whether `code` only re-exports other modules (`export * from` /
 * `export { … } from`). The bundler resolves imports through such barrels to
 * the modules that define the binding and drops what nothing uses, so a module
 * behind a barrel is not part of the boot graph just because the barrel is.
 */
export function isReexportBarrel(code: string): boolean {
  const statements = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  return (
    statements.length > 0 && statements.every((statement) => REEXPORT_STATEMENT.test(statement))
  );
}

/**
 * Whether `moduleId` belongs in the boot group: an application or workspace
 * module (not an installed package) that `bootEntry` or one of `bootRoots`
 * reaches through static imports, other than the entry itself (which keeps its
 * `main-*` chunk).
 *
 * `bootRoots` are lazily imported modules a build always loads before its first
 * commit anyway (see `HOSTED_BOOT_ROOT_MODULES`): in the boot chunk their
 * import resolves without a request. Their modules then evaluate with boot
 * instead of on first import.
 *
 * The walk does not enter installed packages or re-export barrels. Both are
 * tree-shaken per binding: a lazy surface that imports one lucide icon or one
 * state module through a barrel the boot graph also touches must not drag that
 * module into the boot chunks. Their modules keep automatic (and the vendor
 * groups') chunking. CSS, assets, `?query` modules and virtual modules keep
 * their own handling.
 */
export function createBootGraphMatcher(
  bootEntry: string,
  bootRoots: ReadonlyArray<string> = [],
): (moduleId: string, context: ModuleGraphContext) => boolean {
  const entryId = normalizeModuleId(bootEntry);
  const rootIds = bootRoots.map(normalizeModuleId);
  const isWalkable = (id: string) =>
    !id.startsWith("\0") && !id.includes("?") && !/[\\/]node_modules[\\/]/.test(id);
  // One closure per chunking pass: rolldown reuses the module info objects
  // within a pass, so the entry's info identifies the pass.
  const closures = new WeakMap<object, ReadonlySet<string>>();
  const closureFor = (context: ModuleGraphContext): ReadonlySet<string> => {
    const entryInfo = context.getModuleInfo(entryId);
    if (!entryInfo) return new Set();
    const cached = closures.get(entryInfo);
    if (cached) return cached;
    const closure = new Set<string>();
    const visited = new Set<string>();
    const queue = [entryId, ...rootIds];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (!isWalkable(id)) continue;
      const info = context.getModuleInfo(id);
      if (!info || (id !== entryId && info.code !== null && isReexportBarrel(info.code))) continue;
      closure.add(id);
      for (const imported of info.importedIds) queue.push(normalizeModuleId(imported));
    }
    closures.set(entryInfo, closure);
    return closure;
  };
  return (moduleId, context) => {
    const id = normalizeModuleId(moduleId);
    if (id === entryId || !/\.[cm]?[jt]sx?$/.test(id)) return false;
    return closureFor(context).has(id);
  };
}

/**
 * Whether `moduleId` is an installed-package module the boot graph imports,
 * directly or through other package modules: the boot's vendor code, which
 * changes only with dependency upgrades. Package modules behind a barrel the
 * boot graph imports are included even when only a lazy chunk uses them; that
 * moves a little shared vendor code into boot (about 8 KiB compressed), but
 * nothing evaluates early that the boot did not already evaluate: packages
 * are side-effect free here and unused modules are tree-shaken.
 */
export function createBootVendorMatcher(
  bootEntry: string,
  bootRoots: ReadonlyArray<string> = [],
): (moduleId: string, context: ModuleGraphContext) => boolean {
  const isBootGraphModule = createBootGraphMatcher(bootEntry, bootRoots);
  const entryId = normalizeModuleId(bootEntry);
  const rootIds = new Set(bootRoots.map(normalizeModuleId));
  const isPackageModule = (id: string) =>
    !id.startsWith("\0") && !id.includes("?") && /[\\/]node_modules[\\/]/.test(id);
  const closures = new WeakMap<object, ReadonlySet<string>>();
  const closureFor = (context: ModuleGraphContext): ReadonlySet<string> => {
    const entryInfo = context.getModuleInfo(entryId);
    if (!entryInfo) return new Set();
    const cached = closures.get(entryInfo);
    if (cached) return cached;
    // The package modules the boot group's own modules import…
    const packageQueue: string[] = [];
    const appQueue = [entryId, ...rootIds];
    const visitedApp = new Set<string>();
    while (appQueue.length > 0) {
      const id = appQueue.pop()!;
      if (visitedApp.has(id)) continue;
      visitedApp.add(id);
      if (id !== entryId && !rootIds.has(id) && !isBootGraphModule(id, context)) continue;
      for (const imported of context.getModuleInfo(id)?.importedIds ?? []) {
        const next = normalizeModuleId(imported);
        (isPackageModule(next) ? packageQueue : appQueue).push(next);
      }
    }
    // …and every package module those import.
    const closure = new Set<string>();
    while (packageQueue.length > 0) {
      const id = packageQueue.pop()!;
      if (closure.has(id)) continue;
      closure.add(id);
      for (const imported of context.getModuleInfo(id)?.importedIds ?? []) {
        const next = normalizeModuleId(imported);
        if (isPackageModule(next)) packageQueue.push(next);
      }
    }
    closures.set(entryInfo, closure);
    return closure;
  };
  return (moduleId, context) => {
    const id = normalizeModuleId(moduleId);
    if (!/\.[cm]?[jt]sx?$/.test(id) || isMergeableIconModule(id)) return false;
    return closureFor(context).has(id);
  };
}

/** Group name prefixes; `chunkFileNames` maps their entry-set names to short files. */
export const MERGED_CHUNK_GROUP_NAMES = [
  "boot-vendor",
  "boot",
  "icons",
  "vendor",
  "lexical",
  "markdown-stack",
  "shiki-engine",
] as const;

/**
 * Route bodies every app document loads before its first commit: the router
 * awaits the `/_chat` layout (and, on `/`, the index) before it commits, even
 * while the signed-out hosted root renders only the sign-in surface. They are
 * split from the route files so their modules evaluate on first use rather than
 * at boot, and grouped back into the boot chunk so the import costs no request.
 * As separate chunks they cost a request round after boot: +0.35 s to the
 * hosted sign-in at 150 ms / 1.6 Mbps, and about 30 ms (10%) to the standard
 * shell paint on loopback.
 */
export const BOOT_ROOT_MODULES = [
  "src/components/routeViews/ChatLayoutRouteView.tsx",
  "src/components/routeViews/ChatIndexRouteView.tsx",
] as const;

export function createWebCodeSplittingOptions(input: {
  readonly bootEntry: string;
  /** Lazily imported modules that join the boot chunk (absolute paths). */
  readonly bootRoots?: ReadonlyArray<string>;
}) {
  const isBootGraphModule = createBootGraphMatcher(input.bootEntry, input.bootRoots);
  const isBootVendorModule = createBootVendorMatcher(input.bootEntry, input.bootRoots);
  const shared = {
    minShareCount: 2,
    entriesAware: true,
    entriesAwareMergeThreshold: CODE_SPLITTING_MERGE_THRESHOLD_BYTES,
  } as const;
  return {
    groups: [
      {
        name: (moduleId: string, context: ModuleGraphContext) =>
          isBootGraphModule(moduleId, context) ? "boot" : null,
        // One chunk, deliberately: splitting the group by size cut the effect
        // runtime across chunks that import each other, and a chunk could then
        // run before a binding it reads from the other one was initialised.
        // Inside one chunk the bundler keeps module execution order.
        priority: 10,
      },
      {
        // Ahead of `boot`, which would otherwise take these along as its
        // dependencies. The chunk imports nothing from `boot`, so it runs to
        // completion first and the ordering hazard above does not apply.
        name: (moduleId: string, context: ModuleGraphContext) =>
          isBootVendorModule(moduleId, context) ? "boot-vendor" : null,
        priority: 11,
      },
      { name: "icons", test: isMergeableIconModule, priority: 5, ...shared },
      { name: "vendor", test: isMergeableVendorModule, priority: 4, ...shared },
      { name: "lexical", test: isLexicalModule, priority: 3, ...shared },
      { name: "markdown-stack", test: isMarkdownModule, priority: 2, ...shared },
      { name: "shiki-engine", test: isShikiModule, priority: 1, ...shared },
    ],
  };
}

/**
 * `entriesAware` names each subgroup `<group>~<entry>~<entry>…`, which made
 * 112-character file names that every importer repeats in its preload map.
 * Merged groups get `assets/<group>-[hash].js`; every other chunk keeps Vite's
 * default `assets/[name]-[hash].js`.
 */
export function webChunkFileName(chunk: { readonly name: string }): string {
  for (const group of MERGED_CHUNK_GROUP_NAMES) {
    if (chunk.name === group || chunk.name.startsWith(`${group}~`)) {
      return `assets/${group}-[hash].js`;
    }
  }
  return "assets/[name]-[hash].js";
}
