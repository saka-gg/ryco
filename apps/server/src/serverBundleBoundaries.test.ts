/**
 * Guards the lazy-import boundaries that keep optional feature code off the
 * server's boot path. Node evaluates an ES module's whole static import graph
 * before it runs, so a single static import can pull a heavy package back into
 * every boot; the bundler keeps `import()` boundaries as separate chunks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { isBundledPatchedPackageImport, patchAddedExports } from "../scripts/patchedPackages.ts";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(serverRoot, "../..");

interface WorkspacePackage {
  readonly dir: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

const workspacePackages = new Map<string, WorkspacePackage>();
for (const dir of [
  "client-runtime",
  "contracts",
  "effect-acp",
  "effect-codex-app-server",
  "shared",
  "ssh",
  "tailscale",
]) {
  const packageDir = path.join(repoRoot, "packages", dir);
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
    readonly name: string;
    readonly exports?: Record<string, unknown>;
  };
  workspacePackages.set(manifest.name, { dir: packageDir, exports: manifest.exports ?? {} });
}

// Static `import`/`export ... from` statements and side-effect imports. Type-only
// imports are erased, and `import()` expressions are lazy chunk boundaries.
const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function resolveWorkspaceExport(specifier: string): string | null {
  for (const [name, workspacePackage] of workspacePackages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
    let target = workspacePackage.exports[subpath];
    while (typeof target === "object" && target !== null) {
      const conditions = target as Record<string, unknown>;
      target = conditions.import ?? conditions.default ?? conditions.types;
    }
    return typeof target === "string" ? path.resolve(workspacePackage.dir, target) : null;
  }
  return null;
}

function resolveRelative(specifier: string, importer: string): string | null {
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/**
 * The static import closure of `entry`: workspace files plus external
 * specifiers. With `dynamic`, `import("...")` edges are followed too: everything
 * the server can load.
 */
function staticGraph(entry: string, options?: { readonly dynamic?: boolean }) {
  const files = new Set<string>();
  const externals = new Set<string>();
  const pending = [path.resolve(serverRoot, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(?:ts|tsx|js|mjs)$/u.test(file)) continue;
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(STATIC_IMPORT)].flatMap((match) => {
      const clause = match[1]?.trim();
      if (clause !== undefined && /^\{\s*(?:type\s+[\w$]+\s*,?\s*)+\}$/u.test(clause)) return [];
      return [(match[2] ?? match[3])!];
    });
    if (options?.dynamic) {
      for (const match of source.matchAll(DYNAMIC_IMPORT)) specifiers.push(match[1]!);
    }
    for (const specifier of specifiers) {
      const resolved = specifier.startsWith(".")
        ? resolveRelative(specifier, file)
        : resolveWorkspaceExport(specifier);
      if (resolved === null) {
        if (!specifier.startsWith(".")) externals.add(specifier);
        continue;
      }
      pending.push(resolved);
    }
  }
  const relativeFiles = [...files].map((file) => path.relative(repoRoot, file));
  return { files: relativeFiles, externals: [...externals] };
}

/** Provider SDK packages, each tens of megabytes of evaluated code (or a native binary). */
const PROVIDER_SDKS =
  /^(?:@anthropic-ai\/(?:claude-agent-sdk|sdk)|@github\/copilot-sdk|@opencode-ai\/sdk)(?:\/|$)/u;

describe("server boot import boundaries", () => {
  it("bundles every dependency it imports through an export only a repo patch adds", () => {
    // npm installs of the published `ryco-cli` get upstream packages: an
    // external import of a patch-added export fails at startup there.
    const patchAdded = patchAddedExports();
    expect(patchAdded.size).toBeGreaterThan(0);
    const graph = staticGraph("src/bin.ts", { dynamic: true });
    const unbundled = graph.externals.filter(
      (specifier) => patchAdded.has(specifier) && !isBundledPatchedPackageImport(specifier),
    );
    expect(unbundled).toEqual([]);
  });

  it("keeps the process entry free of the server graph", () => {
    const graph = staticGraph("src/bin.ts");
    expect(graph.files.toSorted()).toEqual([
      "apps/server/src/agentControl/stdioProxyProtocol.ts",
      "apps/server/src/bin.ts",
      "apps/server/src/compileCache.ts",
    ]);
    expect(graph.externals).toEqual(["node:module"]);
  });

  it("loads the Agent Control stdio proxy without the server graph", () => {
    const graph = staticGraph("src/agentControl/stdioProxy.ts");
    expect(graph.files.length).toBeLessThan(10);
    expect(graph.files.some((file) => file.startsWith("packages/"))).toBe(false);
  });

  it("keeps heavy optional packages off the serve path", () => {
    const graph = staticGraph("src/cliMain.ts");
    // Image processing loads on first use (`loadSharp`).
    expect(graph.externals).not.toContain("sharp");
    // Only the patch parser; the package root pulls in shiki and its grammars.
    expect(graph.externals).not.toContain("@pierre/diffs");
    // Provider SDKs load with their driver's adapter (chat forks read resume cursors from the
    // SDK-free cursor modules).
    expect(graph.externals.filter((specifier) => PROVIDER_SDKS.test(specifier))).toEqual([]);
    // Protocol schemas load with the Codex/ACP features that use them. The error classes are
    // schema-free (chat forks classify Codex request failures with them).
    expect(
      graph.files.filter((file) => file.startsWith("packages/effect-codex-app-server/")),
    ).toEqual(["packages/effect-codex-app-server/src/errors.ts"]);
    expect(graph.files.filter((file) => file.startsWith("packages/effect-acp/"))).toEqual([]);
    // `ryco remote` client stores load with that command only.
    expect(
      graph.externals.filter((specifier) => /^(?:react|zustand)(?:\/|$)/u.test(specifier)),
    ).toEqual([]);
  });

  it("keeps optional feature stacks off the serve path", () => {
    const graph = staticGraph("src/cliMain.ts");
    const reached = (pattern: RegExp) => graph.files.filter((file) => pattern.test(file));
    // Native Computer use loads only when Desktop hands over a native bridge; the turn
    // lifecycle and the tool guidance the provider reactor reads stay eager.
    expect(reached(/^apps\/server\/src\/computer\//u).toSorted()).toEqual([
      "apps/server/src/computer/computerTurnLifecycle.ts",
      "apps/server/src/computer/computerVisibleUse.ts",
      "apps/server/src/computer/tools/computerGuidance.ts",
    ]);
    // The Hub connector, key custody and relay E2EE build after the router serves.
    expect(
      reached(
        /^apps\/server\/src\/hubConnector\/(?:HubConnector|HubConnectorLive|HubIdentityRuntime|NodeE2ee\w*)\.ts$/u,
      ),
    ).toEqual([]);
    expect(reached(/^packages\/shared\/src\/relayE2ee(?!Constants)/u)).toEqual([]);
    expect(graph.externals.filter((specifier) => specifier.startsWith("@noble/"))).toEqual([]);
    // Source-control clients load with the provider that uses them (Forgejo answers
    // synchronous remote detection and stays eager).
    expect(
      reached(
        /^apps\/server\/src\/sourceControl\/(?:GitHubCli|GitLabCli|BitbucketApi|AzureDevOpsCli|gitHubPullRequests|gitLabMergeRequests|bitbucketPullRequests|azureDevOpsPullRequests)\.ts$/u,
      ),
    ).toEqual([]);
  });
});

/** Static imports of a built ES chunk (rolldown output keeps them at top level). */
const CHUNK_STATIC_IMPORT = /^(?:import|export)\s[^;]*?from\s*"([^"]+)";|^import\s*"([^"]+)";/gmu;

function builtStaticClosure(entry: string) {
  const chunks = new Set<string>();
  const externals = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const chunk = pending.pop()!;
    if (chunks.has(chunk)) continue;
    chunks.add(chunk);
    for (const match of readFileSync(chunk, "utf8").matchAll(CHUNK_STATIC_IMPORT)) {
      const specifier = (match[1] ?? match[2])!;
      if (specifier.startsWith(".")) pending.push(path.resolve(path.dirname(chunk), specifier));
      else externals.add(specifier);
    }
  }
  return { chunks: [...chunks], externals: [...externals] };
}

const builtEntry = path.join(serverRoot, "dist/bin.mjs");
// Only a bundle built from the current entry shim is meaningful here.
const hasCurrentBuild =
  existsSync(builtEntry) && readFileSync(builtEntry, "utf8").includes("enableCompileCache");
// CI's build job sets this after building the server: the built-bundle suites must run there
// instead of skipping silently.
const requireBuild = process.env.RYCO_REQUIRE_SERVER_BUILD === "1";

describe.runIf(requireBuild)("built server bundle presence", () => {
  it("finds a server bundle built from the current entry shim", () => {
    expect(hasCurrentBuild).toBe(true);
  });
});

describe.skipIf(!hasCurrentBuild)("built server bundle", () => {
  it("keeps sharp, the @pierre/diffs root, provider SDKs and the Codex schema out of the boot chunks", () => {
    const entryClosure = builtStaticClosure(builtEntry);
    expect(entryClosure.chunks).toEqual([builtEntry]);

    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    expect(cliChunk).toBeDefined();
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    expect(serve.externals).not.toContain("sharp");
    expect(serve.externals).not.toContain("@pierre/diffs");
    expect(serve.externals.filter((specifier) => PROVIDER_SDKS.test(specifier))).toEqual([]);
    // Bundled: only its patch exposes the parser (see `scripts/patchedPackages.ts`).
    expect(serve.externals.filter((specifier) => specifier.startsWith("@pierre/diffs"))).toEqual(
      [],
    );
    for (const chunk of serve.chunks) {
      // A type name only the generated Codex protocol schema defines.
      expect(readFileSync(chunk, "utf8")).not.toContain("V2ListMcpServerStatusResponse");
    }
  });

  it("bundles effect and the platform packages instead of resolving them per file", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    expect(
      serve.externals.filter((specifier) =>
        /^(?:effect|@effect\/[\w-]+|mime|ws|undici)(?:\/|$)/u.test(specifier),
      ),
    ).toEqual([]);
  });

  it("keeps the boot chunks within budget", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    const bytes = serve.chunks.reduce((total, chunk) => total + statSync(chunk).size, 0);
    // 6.6 MB with effect and the platform packages bundled in, and with Computer use,
    // the Hub connector and the source-control clients behind import(). Raise it only
    // for code that every boot needs.
    expect(bytes).toBeLessThan(7_000_000);
    for (const chunk of serve.chunks) {
      const source = readFileSync(chunk, "utf8");
      // Region markers rolldown leaves in the output name the modules each chunk holds.
      expect(source).not.toMatch(/^\/\/#region src\/computer\/CuaComputerBackend\.ts$/mu);
      expect(source).not.toMatch(/^\/\/#region src\/hubConnector\/HubIdentityRuntime\.ts$/mu);
      expect(source).not.toMatch(/^\/\/#region src\/sourceControl\/GitHubCli\.ts$/mu);
      // Loaded when the external Agent Control integration first starts.
      expect(source).not.toMatch(/^\/\/#region src\/agentControl\/ExternalMcp\/tools\.ts$/mu);
      expect(source).not.toMatch(/^\/\/#region src\/agentControl\/ExternalMcp\/listener\.ts$/mu);
    }
  });
});

describe.skipIf(!hasCurrentBuild)("built server bundle imports", () => {
  it("leaves no import of a patch-added export to the installed package", () => {
    const patchAdded = patchAddedExports();
    const distDir = path.join(serverRoot, "dist");
    const external = new Set<string>();
    for (const file of readdirSync(distDir)) {
      if (!file.endsWith(".mjs")) continue;
      const source = readFileSync(path.join(distDir, file), "utf8");
      for (const match of source.matchAll(CHUNK_STATIC_IMPORT))
        external.add((match[1] ?? match[2])!);
      for (const match of source.matchAll(DYNAMIC_IMPORT)) external.add(match[1]!);
    }
    expect([...external].filter((specifier) => patchAdded.has(specifier))).toEqual([]);
  });
});
