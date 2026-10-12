// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseSync } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

/**
 * Boundaries of the launch module graph, asserted over the source.
 *
 * Metro evaluates every statically imported module before the first frame (no
 * tree shaking for CommonJS, no inline requires), so one root-barrel import or
 * one eagerly registered screen silently puts thousands of modules or megabytes
 * of grammar JSON back on the launch path. Measured with the static graph in
 * the perf research: 8,557 → ~2,000 launch modules.
 */

const SRC = join(import.meta.dirname, "..");

function sourceFiles(directory: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/u.test(entry.name)) out.push(path);
  }
  return out;
}

function read(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), "utf8");
}

/** Static, value-importing specifiers (type-only imports and `import()` excluded). */
function staticValueImports(source: string): readonly string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*(import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gmu;
  for (const match of source.matchAll(pattern)) specifiers.push(match[2]!);
  for (const match of source.matchAll(/^\s*import\s+"([^"]+)";/gmu)) specifiers.push(match[1]!);
  return specifiers;
}

// --- Whole launch graph, resolved like Metro's iOS production bundle --------

const MOBILE_ROOT = join(SRC, "..");
const REPO_ROOT = join(MOBILE_ROOT, "../..");

const workspacePackages = new Map<string, { dir: string; exports: Record<string, unknown> }>();
for (const entry of readdirSync(join(REPO_ROOT, "packages"))) {
  const manifestPath = join(REPO_ROOT, "packages", entry, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name: string;
    exports?: Record<string, unknown>;
  };
  workspacePackages.set(manifest.name, {
    dir: dirname(manifestPath),
    exports: manifest.exports ?? {},
  });
}

/** Metro's iOS platform order, then the plain source extensions. */
const SOURCE_SUFFIXES = [".ios", ".native", ""].flatMap((platform) =>
  [".ts", ".tsx", ".js"].map((extension) => `${platform}${extension}`),
);

function resolveSourceFile(base: string): string | null {
  // Workspace sources import siblings as `./x.ts` or (NodeNext) `./x.js`.
  const stem = base.replace(/\.(?:[cm]?js|tsx?)$/u, "");
  for (const candidate of [
    ...SOURCE_SUFFIXES.map((suffix) => `${stem}${suffix}`),
    ...SOURCE_SUFFIXES.map((suffix) => join(stem, `index${suffix}`)),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const conditions = value as Record<string, unknown>;
    return exportTarget(conditions.import ?? conditions.default ?? conditions.require);
  }
  return null;
}

/** A repository source file, or `pkg:<name>` for an installed package (a leaf). */
function resolveSpecifier(specifier: string, importer: string): string | null {
  if (specifier.startsWith(".")) return resolveSourceFile(resolve(dirname(importer), specifier));
  const workspace = /^(@ryco\/[^/]+)(\/.*)?$/u.exec(specifier);
  const manifest = workspace ? workspacePackages.get(workspace[1]!) : undefined;
  if (workspace && manifest) {
    const target = exportTarget(manifest.exports[`.${workspace[2] ?? ""}`]);
    if (!target) throw new Error(`${importer} imports unexported ${specifier}`);
    return resolveSourceFile(join(manifest.dir, target));
  }
  const parts = specifier.split("/");
  return `pkg:${specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]}`;
}

/**
 * Specifiers Metro evaluates when the module runs: value imports and
 * re-exports, plus column-0 `require()` calls. `import()` and function-scoped
 * `require()` are the deferral mechanism and stay out.
 */
function launchSpecifiers(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  const { module, errors } = parseSync(file, source);
  if (errors.length > 0) throw new Error(`Failed to parse ${file}`);
  const specifiers = new Set<string>();
  for (const declaration of module.staticImports) {
    const typeOnly =
      declaration.entries.length > 0 && declaration.entries.every((entry) => entry.isType);
    if (!typeOnly) specifiers.add(declaration.moduleRequest.value);
  }
  for (const declaration of module.staticExports) {
    for (const entry of declaration.entries) {
      if (entry.moduleRequest && !entry.isType) specifiers.add(entry.moduleRequest.value);
    }
  }
  for (const match of source.matchAll(
    /^(?:export\s+)?(?:(?:const|let|var)\s+[^=\n]+=\s*)?require\("([^"]+)"\)/gmu,
  )) {
    specifiers.add(match[1]!);
  }
  return [...specifiers];
}

const graphs = new Map<string, ReadonlyMap<string, string | null>>();

/** Breadth-first static graph from an entry, keeping each module's first importer. */
function staticGraph(entryRelative: string): ReadonlyMap<string, string | null> {
  const cached = graphs.get(entryRelative);
  if (cached) return cached;
  const entry = join(MOBILE_ROOT, entryRelative);
  const parents = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (file.startsWith("pkg:")) continue;
    for (const specifier of launchSpecifiers(file)) {
      const dependency = resolveSpecifier(specifier, file);
      if (dependency === null || parents.has(dependency)) continue;
      parents.set(dependency, file);
      queue.push(dependency);
    }
  }
  graphs.set(entryRelative, parents);
  return parents;
}

const display = (file: string) => (file.startsWith("pkg:") ? file : relative(REPO_ROOT, file));

/** Import chains from `entry` to every statically reachable module matching `forbidden`. */
function chainsTo(entry: string, forbidden: readonly RegExp[]): readonly string[] {
  const parents = staticGraph(entry);
  const chains: string[] = [];
  for (const file of parents.keys()) {
    const shown = display(file);
    if (!forbidden.some((pattern) => pattern.test(shown))) continue;
    const chain: string[] = [];
    for (let current: string | null = file; current; current = parents.get(current) ?? null) {
      chain.unshift(display(current));
    }
    chains.push(chain.join(" -> "));
  }
  return chains;
}

const LAUNCH_ENTRY = "index.ts";

/**
 * The relay E2EE primitives: curves, hashes and ciphers, the CBOR codec, and
 * the modules built on them. The ids and constants modules are plain data the
 * Hub API reads, and stay allowed.
 */
const RELAY_E2EE_CRYPTO: readonly RegExp[] = [
  /^pkg:@noble\//u,
  /^pkg:cborg$/u,
  /^packages\/shared\/src\/relay(?:E2ee(?!Ids\.ts$|Constants\.ts$)|Codec)/u,
  /^packages\/client-runtime\/src\/relay\/relayE2ee/u,
  /^packages\/client-runtime\/src\/authorization\/native(?:E2ee|TrustOnboarding)/u,
];

describe("mobile launch graph boundaries", () => {
  it("never imports the Tabler package root, which evaluates every icon", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !/\.test\.tsx?$/u.test(path))
      .filter((path) =>
        staticValueImports(readFileSync(path, "utf8")).includes("@tabler/icons-react-native"),
      )
      .map((path) => path.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it("keeps the Android icon fallbacks out of the iOS symbol component", () => {
    const ios = read("components/AppSymbol.ios.tsx");
    expect(staticValueImports(ios).some((specifier) => specifier.includes("tabler"))).toBe(false);
    expect(staticValueImports(ios).some((specifier) => specifier.includes("icons"))).toBe(false);
  });

  it("registers only Home eagerly in the workspace stack", () => {
    const featureImports = staticValueImports(read("Stack.tsx")).filter((specifier) =>
      specifier.startsWith("./features/"),
    );
    expect(featureImports.toSorted()).toEqual([
      "./features/files/FileWorkspaceLayout",
      "./features/home/HomeRouteScreen",
      "./features/keyboard/HardwareKeyboardCommandProvider",
    ]);
  });

  it("keeps the locked stack's identity (WebView) and pairing (camera) screens lazy", () => {
    const gateImports = staticValueImports(read("features/access/AppAccessGate.tsx"));
    expect(gateImports.filter((specifier) => /identity|connection\//u.test(specifier))).toEqual([]);
  });

  it("loads every lazy route screen through a function-scoped require", () => {
    const lazyScreens = read("navigation/lazyRouteScreens.ts");
    expect(
      staticValueImports(lazyScreens).filter((specifier) => specifier.includes("features/")),
    ).toEqual([]);
    expect(lazyScreens).toContain('require("../features/threads/ThreadRouteScreen")');
  });

  it("parses no shiki grammar or theme until a highlighter is needed", () => {
    const highlighter = read("features/review/shikiReviewHighlighter.ts");
    expect(
      staticValueImports(highlighter).filter((specifier) => specifier.startsWith("@shikijs/")),
    ).toEqual([]);
    const markdown = read("native/SelectableMarkdownText.ios.tsx");
    expect(staticValueImports(markdown).filter((specifier) => specifier.includes("shiki"))).toEqual(
      [],
    );
  });

  it("walks the launch graph the way Metro resolves an iOS bundle", () => {
    const reachable = [...staticGraph(LAUNCH_ENTRY).keys()].map(display);
    expect(reachable).toContain("apps/mobile/src/App.tsx");
    expect(reachable).toContain("apps/mobile/src/features/home/HomeRouteScreen.tsx");
    expect(reachable).toContain("apps/mobile/src/components/AppSymbol.ios.tsx");
    expect(reachable).toContain("packages/client-runtime/src/authorization/state.ts");
    expect(reachable).not.toContain("apps/mobile/src/components/AppSymbol.tsx");
    expect(reachable).not.toContain("apps/mobile/src/features/threads/ThreadRouteScreen.tsx");
    // Without this, a walker that silently stopped following imports would
    // pass every boundary below.
    expect(chainsTo("src/hostedHub/runtime.ts", RELAY_E2EE_CRYPTO)).not.toEqual([]);
  });

  it("loads the hosted relay connection and E2EE session only with the hosted runtime", () => {
    expect(
      chainsTo(LAUNCH_ENTRY, [
        /^apps\/mobile\/src\/hostedHub\/(?:runtime|primaryConnection|relaySocket|accountE2eeAttempt|e2eeAttempt|e2eeSession)\.ts$/u,
        /^apps\/mobile\/src\/platform\/(?:e2eeTrustStore|e2eeRelayProvider|e2eeAgreementKey|e2eeClientPrekey|e2eeSecureStore|nativeE2ee)\.ts$/u,
        // The barrel re-exports the relay engine and its CBOR codec; launch
        // modules import the light subpaths instead.
        /^packages\/client-runtime\/src\/relay\/index\.ts$/u,
      ]),
    ).toEqual([]);
  });

  it("keeps relay E2EE crypto (noble curves/hashes, CBOR) out of the pre-first-frame graph", () => {
    // Measured on the static graph: 75 modules, about 1.5 MiB of source, that a
    // direct-only launch never runs; only the lazily imported hosted runtime
    // may load them. This also needs the root `@ryco/client-runtime/authorization`
    // barrel to leave the native E2EE modules to its `authorization/e2ee` subpath.
    expect(chainsTo(LAUNCH_ENTRY, RELAY_E2EE_CRYPTO)).toEqual([]);
  });
});
