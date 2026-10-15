import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

import { CLIENT_MODE_SEAM_MODULES, standardSeamSibling } from "../clientModeSeams";

/**
 * Source-level guard for the standard build's static import graph.
 *
 * Walks value imports (type-only imports are erased) from an entry the way the
 * standard build resolves them — workspace package exports, `~/` paths, and
 * the client-mode seams — and fails with the import chain when a forbidden
 * module becomes statically reachable. It runs without a build;
 * `bun run perf:bundle-budget` checks the same rules on the real dist.
 */

const srcRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(srcRoot, "../../..");

const workspacePackages = new Map<string, { dir: string; exports: Record<string, unknown> }>();
for (const entry of readdirSync(path.join(repoRoot, "packages"))) {
  const manifestPath = path.join(repoRoot, "packages", entry, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name: string;
    exports?: Record<string, unknown>;
  };
  workspacePackages.set(manifest.name, {
    dir: path.dirname(manifestPath),
    exports: manifest.exports ?? {},
  });
}

const seamSiblings = new Map(
  CLIENT_MODE_SEAM_MODULES.map((modulePath) => [
    path.join(srcRoot, modulePath),
    path.join(srcRoot, standardSeamSibling(modulePath)),
  ]),
);

const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveFile(base: string): string | null {
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const conditions = value as Record<string, unknown>;
    return exportTarget(conditions.import ?? conditions.default ?? conditions.types);
  }
  return null;
}

/** A repository file, or `pkg:<name>` for an installed package (not walked). */
function resolveSpecifier(specifier: string, importer: string): string | null {
  const bare = specifier.split("?", 1)[0]!;
  let resolved: string | null;
  if (bare.startsWith(".")) {
    resolved = resolveFile(path.resolve(path.dirname(importer), bare));
  } else if (bare.startsWith("~/")) {
    resolved = resolveFile(path.join(srcRoot, bare.slice(2)));
  } else {
    const match = /^(@ryco\/[^/]+)(\/.*)?$/u.exec(bare);
    const workspace = match ? workspacePackages.get(match[1]!) : undefined;
    if (!workspace) {
      const parts = bare.split("/");
      return `pkg:${bare.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]}`;
    }
    const target = exportTarget(workspace.exports[`.${match![2] ?? ""}`]);
    if (!target) throw new Error(`${importer} imports unexported ${specifier}`);
    resolved = resolveFile(path.join(workspace.dir, target));
  }
  if (!resolved || !/\.tsx?$/u.test(resolved)) return null;
  return seamSiblings.get(resolved) ?? resolved;
}

const importCache = new Map<string, ReadonlyArray<string>>();

function staticValueImports(file: string): ReadonlyArray<string> {
  const cached = importCache.get(file);
  if (cached) return cached;
  const { module, errors } = parseSync(file, readFileSync(file, "utf8"));
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
  const imports = [...specifiers]
    .map((specifier) => resolveSpecifier(specifier, file))
    .filter((resolved): resolved is string => resolved !== null);
  importCache.set(file, imports);
  return imports;
}

function staticGraph(entry: string): ReadonlyMap<string, string | null> {
  const parents = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file.startsWith("pkg:")) continue;
    for (const dependency of staticValueImports(file)) {
      if (parents.has(dependency)) continue;
      parents.set(dependency, file);
      queue.push(dependency);
    }
  }
  return parents;
}

const display = (file: string) => (file.startsWith("pkg:") ? file : path.relative(repoRoot, file));

function forbiddenChains(entryRelative: string, forbidden: readonly RegExp[]): string[] {
  const parents = staticGraph(path.join(srcRoot, entryRelative));
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

const HOSTED_RUNTIME: readonly RegExp[] = [
  /^pkg:@noble\//u,
  /^pkg:cborg$/u,
  /^packages\/shared\/src\/relay(?:E2ee|Codec)/u,
  /^packages\/client-runtime\/src\/relay\/(?!(?:reconnectPolicy|base64url)\.ts$)/u,
  /^packages\/client-runtime\/src\/authorization\/(?!(?:nodeMutationLease|capabilities|deliveryNotice|hostedStores|types)\.ts$)/u,
  ...CLIENT_MODE_SEAM_MODULES.map(
    (modulePath) => new RegExp(`^apps/web/src/${modulePath.replace(/[.]/gu, "\\.")}$`, "u"),
  ),
];

const MARKDOWN: readonly RegExp[] = [
  /^pkg:react-markdown$/u,
  /^apps\/web\/src\/components\/projectExplorer\/MarkdownView\.tsx$/u,
];

describe("standard build static import graph", () => {
  it("keeps the hosted runtime, relay E2EE, and OTLP export out of the boot graph", () => {
    expect(
      forbiddenChains("main.tsx", [
        ...HOSTED_RUNTIME,
        ...MARKDOWN,
        /^apps\/web\/src\/observability\/clientTracingExporter\.ts$/u,
      ]),
    ).toEqual([]);
  });

  it("keeps the chat route bodies and the preview guard off the boot's static graph", () => {
    // The chat layout and index rejoin the boot chunk as lazy roots
    // (`BOOT_ROOT_MODULES`): their bytes arrive with boot, their modules
    // evaluate when the router first renders them.
    expect(
      forbiddenChains("main.tsx", [
        /^apps\/web\/src\/components\/routeViews\/Chat(?:Layout|Index)RouteView\.tsx$/u,
        /^apps\/web\/src\/components\/NoActiveThreadState\.tsx$/u,
        /^apps\/web\/src\/components\/PreviewFileNavigationGuard\.tsx$/u,
      ]),
    ).toEqual([]);
  });

  it("keeps the preview editor session out of the boot graph", () => {
    // The root navigation guard needs only the session registry.
    expect(
      forbiddenChains("main.tsx", [
        /^apps\/web\/src\/components\/(?:previewFileSessions|PreviewFileEditSession)\.ts$/u,
        /^apps\/web\/src\/rpc\/projectPreviewAtoms\.ts$/u,
      ]),
    ).toEqual([]);
  });

  it("keeps click-only dialogs, markdown, and editor icons out of the app shell", () => {
    expect(
      forbiddenChains("components/RootAppShell.tsx", [
        ...HOSTED_RUNTIME,
        ...MARKDOWN,
        /^apps\/web\/src\/components\/worktrees\/(?:LinkedWorktreeItemDialog|NewWorktreeDialog)\.tsx$/u,
        /^apps\/web\/src\/components\/JetBrainsIcons\.tsx$/u,
      ]),
    ).toEqual([]);
  });

  it("keeps the diff renderer out of the pull requests page until the Files tab", () => {
    expect(
      forbiddenChains("components/pullRequests/PullRequestsPage.tsx", [
        ...HOSTED_RUNTIME,
        /^pkg:@pierre\/diffs$/u,
        /^pkg:shiki$/u,
        /^apps\/web\/src\/components\/pullRequests\/files\/FilesTab\.tsx$/u,
      ]),
    ).toEqual([]);
  });

  it("keeps the diff worker pool and its highlighter out of the chat routes", () => {
    // Only the review, file preview and pull request surfaces highlight
    // through the pool; they lease it from inside their own lazy chunks.
    const forbidden = [
      /^apps\/web\/src\/components\/DiffWorkerPoolProvider\.tsx$/u,
      /^apps\/web\/src\/lib\/diffWorkerPool\.ts$/u,
      /^apps\/web\/src\/components\/(?:ThreadWorkspacePanel|DiffPanel|PreviewPanel)\.tsx$/u,
      /^pkg:@pierre\/diffs$/u,
    ];
    for (const route of ["ChatThreadRouteView.tsx", "DraftChatThreadRouteView.tsx"]) {
      expect(forbiddenChains(`components/routeViews/${route}`, forbidden)).toEqual([]);
    }
  });

  it("keeps the hosted runtime out of Settings", () => {
    // Hosted-only settings actions load the Hub API on demand.
    expect(forbiddenChains("components/routeViews/SettingsRouteView.tsx", HOSTED_RUNTIME)).toEqual(
      [],
    );
  });

  it("follows the seams the standard build applies", () => {
    const reachable = [...staticGraph(path.join(srcRoot, "main.tsx")).keys()].map(display);
    expect(reachable).toContain("apps/web/src/hostedHub/state.standard.ts");
    expect(reachable).not.toContain("apps/web/src/hostedHub/state.ts");
  });
});
