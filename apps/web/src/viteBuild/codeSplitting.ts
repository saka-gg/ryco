import { readFileSync } from "node:fs";
import path from "node:path";

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
 * - `route-vendor` and `route-shared` (hosted builds only, see
 *   `HOSTED_ROUTE_GROUP_MODULES`): the shared modules of `sideEffects: false`
 *   packages in the static closure of the routes a cold hosted load requests
 *   together, as one chunk of installed packages and one of workspace
 *   packages instead of a few dozen small ones. Hosted builds also keep the
 *   shared icons in one chunk.
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

function readPackageManifest(directory: string): string | null {
  try {
    return readFileSync(`${directory}/package.json`, "utf8");
  } catch {
    return null;
  }
}

/**
 * Whether the package that contains a module declares itself free of side
 * effects: its nearest `package.json` says `"sideEffects": false`. The bundler
 * already drops unused modules of such a package, so evaluating one before its
 * first importer is equally unobservable. A list of side-effectful files does
 * not count; neither does an application `package.json` without the field.
 */
export function createSideEffectFreePackageLookup(
  readManifest: (directory: string) => string | null = readPackageManifest,
): (moduleId: string) => boolean {
  const byDirectory = new Map<string, boolean>();
  const declaresNoSideEffects = (directory: string): boolean => {
    const cached = byDirectory.get(directory);
    if (cached !== undefined) return cached;
    const manifest = readManifest(directory);
    let declared = false;
    if (manifest !== null) {
      try {
        const parsed: unknown = JSON.parse(manifest);
        declared =
          typeof parsed === "object" &&
          parsed !== null &&
          "sideEffects" in parsed &&
          parsed.sideEffects === false;
      } catch {
        declared = false;
      }
    } else {
      const parent = path.posix.dirname(directory);
      declared = parent !== directory && declaresNoSideEffects(parent);
    }
    byDirectory.set(directory, declared);
    return declared;
  };
  return (moduleId) => {
    const id = normalizeModuleId(moduleId);
    if (id.startsWith("\0") || id.includes("?") || !/^(?:[A-Za-z]:)?\//.test(id)) return false;
    return declaresNoSideEffects(path.posix.dirname(id));
  };
}

/**
 * The hosted route groups' roots: the workspace shell and the thread route,
 * which a cold signed-in load requests at the same time (their closures beyond
 * boot used to arrive as ~150 files in one burst on a 6-connection HTTP/1.1
 * pool). Excluded: what every hosted visit loads, signed in or not — the hosted
 * root with its sign-in surfaces and the workspace owners the boot gate starts.
 * Their modules stay out of the route groups, so a signed-out visit never
 * downloads the routes' package code.
 */
export const HOSTED_ROUTE_GROUP_MODULES = {
  roots: ["src/components/RootAppShell.tsx", "src/components/routeViews/ChatThreadRouteView.tsx"],
  excludedRoots: [
    "src/components/hostedHub/HostedHubRoot.tsx",
    "src/components/hostedHub/hostedRootAppShell.tsx",
    "src/hostedHub/hostedWorkspaceOwners.ts",
  ],
} as const;

export type RouteGroupName = "route-vendor" | "route-shared";

/**
 * Which route group, if any, `moduleId` belongs to: a module of a
 * `sideEffects: false` package that one of `routeRoots` reaches through static
 * imports, outside the boot groups, the static closure of `excludedRoots` and
 * the stable vendor groups (lexical, the markdown stack, Shiki). Installed
 * packages go to `route-vendor`, which changes only with dependency upgrades;
 * workspace packages to `route-shared`.
 *
 * Grouping can make an entry load a module it never imports, so only modules
 * whose package declares evaluating them harmless are captured, and the group
 * is applied with `minShareCount: 2` so entry-private modules stay in their
 * entry chunk. A module is captured only when everything it imports is in boot,
 * boot vendor or its own group (a workspace module may also import
 * `route-vendor`): the route chunks then import nothing but boot and each
 * other in one direction, so no chunk cycle can run a module before a binding
 * it reads was initialised.
 */
export function createRouteGroupMatcher(input: {
  readonly bootEntry: string;
  readonly bootRoots?: ReadonlyArray<string> | undefined;
  readonly routeRoots: ReadonlyArray<string>;
  readonly excludedRoots?: ReadonlyArray<string>;
  readonly isSideEffectFreePackageModule?: (moduleId: string) => boolean;
}): (moduleId: string, context: ModuleGraphContext) => RouteGroupName | null {
  const isBootGraphModule = createBootGraphMatcher(input.bootEntry, input.bootRoots);
  const isBootVendorModule = createBootVendorMatcher(input.bootEntry, input.bootRoots);
  const isSideEffectFree =
    input.isSideEffectFreePackageModule ?? createSideEffectFreePackageLookup();
  const entryId = normalizeModuleId(input.bootEntry);
  const rootIds = input.routeRoots.map(normalizeModuleId);
  const excludedRootIds = (input.excludedRoots ?? []).map(normalizeModuleId);
  const isScript = (id: string) =>
    !id.startsWith("\0") && !id.includes("?") && /\.[cm]?[jt]sx?$/.test(id);
  const isBootModule = (id: string, context: ModuleGraphContext) =>
    id === entryId || isBootGraphModule(id, context) || isBootVendorModule(id, context);
  const groupOf = (id: string): RouteGroupName =>
    /[\\/]node_modules[\\/]/.test(id) ? "route-vendor" : "route-shared";
  /** The static closure of `roots` beyond boot, with each module's imports. */
  const closureBeyondBoot = (roots: ReadonlyArray<string>, context: ModuleGraphContext) => {
    const imports = new Map<string, ReadonlyArray<string>>();
    const queue = [...roots];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (imports.has(id) || !isScript(id) || isBootModule(id, context)) continue;
      const importedIds = (context.getModuleInfo(id)?.importedIds ?? []).map(normalizeModuleId);
      imports.set(id, importedIds);
      queue.push(...importedIds);
    }
    return imports;
  };
  const passes = new WeakMap<object, ReadonlyMap<string, RouteGroupName>>();
  const groupsFor = (context: ModuleGraphContext): ReadonlyMap<string, RouteGroupName> => {
    const entryInfo = context.getModuleInfo(entryId);
    if (!entryInfo) return new Map();
    const cached = passes.get(entryInfo);
    if (cached) return cached;
    const imports = closureBeyondBoot(rootIds, context);
    const excluded = closureBeyondBoot(excludedRootIds, context);
    const groups = new Map<string, RouteGroupName>();
    for (const id of imports.keys()) {
      if (rootIds.includes(id) || excluded.has(id) || !isSideEffectFree(id)) continue;
      if (isLexicalModule(id) || isMarkdownModule(id) || isShikiModule(id)) continue;
      if (WASM_MODULE.test(id)) continue;
      groups.set(id, groupOf(id));
    }
    // Drop every module that imports something outside boot and the groups it
    // may depend on, until none is left.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, group] of groups) {
        const closed = (imports.get(id) ?? []).every((imported) => {
          if (isBootModule(imported, context)) return true;
          const importedGroup = groups.get(imported);
          return importedGroup === group || importedGroup === "route-vendor";
        });
        if (!closed) {
          groups.delete(id);
          changed = true;
        }
      }
    }
    passes.set(entryInfo, groups);
    return groups;
  };
  return (moduleId, context) => groupsFor(context).get(normalizeModuleId(moduleId)) ?? null;
}

/** Group name prefixes; `chunkFileNames` maps their entry-set names to short files. */
export const MERGED_CHUNK_GROUP_NAMES = [
  "boot-vendor",
  "boot",
  "route-vendor",
  "route-shared",
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
  /**
   * Lazily imported routes whose side-effect-free package modules form the
   * route groups, and the modules whose closures stay out of them (absolute
   * paths; hosted builds pass `HOSTED_ROUTE_GROUP_MODULES`). Without them the
   * build keeps the layout described above.
   */
  readonly routeGroups?: {
    readonly roots: ReadonlyArray<string>;
    readonly excludedRoots: ReadonlyArray<string>;
  };
}) {
  const isBootGraphModule = createBootGraphMatcher(input.bootEntry, input.bootRoots);
  const isBootVendorModule = createBootVendorMatcher(input.bootEntry, input.bootRoots);
  const shared = {
    minShareCount: 2,
    entriesAware: true,
    entriesAwareMergeThreshold: CODE_SPLITTING_MERGE_THRESHOLD_BYTES,
  } as const;
  const routeGroupOf =
    input.routeGroups && input.routeGroups.roots.length > 0
      ? createRouteGroupMatcher({
          bootEntry: input.bootEntry,
          bootRoots: input.bootRoots,
          routeRoots: input.routeGroups.roots,
          excludedRoots: input.routeGroups.excludedRoots,
        })
      : null;
  const routeGroups = routeGroupOf
    ? [
        {
          // One chunk per group (not entries-aware): an entry that imports one
          // of these modules loads the whole group, which the modules' packages
          // declare harmless. Ahead of `icons` and `vendor`, which would
          // otherwise split the routes' modules by importing entry set.
          name: (moduleId: string, context: ModuleGraphContext) => routeGroupOf(moduleId, context),
          priority: 6,
          ...shared,
          entriesAware: false,
        },
      ]
    : [];
  // With the route groups, the shared icons are one chunk as well: the routes
  // reach every icon through the package's barrel, so the excluded closures
  // keep all of them out of `route-vendor`, and split by entry set they were
  // six files of a few KiB on the cold path. The signed-out root then loads
  // that one chunk instead of three of them.
  const icons = routeGroupOf
    ? {
        name: "icons",
        test: isMergeableIconModule,
        priority: 5,
        ...shared,
        entriesAware: false,
      }
    : { name: "icons", test: isMergeableIconModule, priority: 5, ...shared };
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
      ...routeGroups,
      icons,
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
