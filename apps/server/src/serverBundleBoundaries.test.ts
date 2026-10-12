/**
 * Guards the lazy-import boundaries that keep optional feature code off the
 * server's boot path. Node evaluates an ES module's whole static import graph
 * before it runs, so a single static import can pull a heavy package back into
 * every boot; the bundler keeps `import()` boundaries as separate chunks.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

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

/** The static import closure of `entry`: workspace files plus external specifiers. */
function staticGraph(entry: string) {
  const files = new Set<string>();
  const externals = new Set<string>();
  const pending = [path.resolve(serverRoot, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(?:ts|tsx|js|mjs)$/u.test(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      const clause = match[1]?.trim();
      if (clause !== undefined && /^\{\s*(?:type\s+[\w$]+\s*,?\s*)+\}$/u.test(clause)) continue;
      const specifier = (match[2] ?? match[3])!;
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

describe("server boot import boundaries", () => {
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

describe.skipIf(!hasCurrentBuild)("built server bundle", () => {
  it("keeps sharp, the @pierre/diffs root and the Codex schema out of the boot chunks", () => {
    const entryClosure = builtStaticClosure(builtEntry);
    expect(entryClosure.chunks).toEqual([builtEntry]);

    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    expect(cliChunk).toBeDefined();
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    expect(serve.externals).not.toContain("sharp");
    expect(serve.externals).not.toContain("@pierre/diffs");
    for (const chunk of serve.chunks) {
      // A type name only the generated Codex protocol schema defines.
      expect(readFileSync(chunk, "utf8")).not.toContain("V2ListMcpServerStatusResponse");
    }
  });
});
