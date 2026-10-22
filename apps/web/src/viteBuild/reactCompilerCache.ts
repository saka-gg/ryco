import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReactCompilerJobOutput, ReactCompilerWorkerData } from "./reactCompilerPool";

/**
 * A content-addressed disk cache of React Compiler output. Most modules are
 * unchanged between builds, dev server starts and browser test runs, and Babel
 * is most of their transform time. An entry is the exact `{code, map}` Babel
 * produced, keyed by everything that shapes it, so a hit is byte-identical to a
 * fresh compile. Errors are never cached.
 */

/** Bump when the entry format or what the key covers changes. */
export const REACT_COMPILER_CACHE_VERSION = "ryco-react-compiler-cache-v1";
/** "off" makes every module compile from source. Release builds set it. */
const REACT_COMPILER_CACHE_ENV = "RYCO_REACT_COMPILER_CACHE";
const REACT_COMPILER_CACHE_DIR_ENV = "RYCO_REACT_COMPILER_CACHE_DIR";

/** About six full builds' entries (one writes about 33 MB). */
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** Pruning goes this far below the bound so the next starts don't prune again. */
const PRUNE_TARGET_RATIO = 0.8;
/** A temporary file this old belongs to a writer that died before renaming it. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000;
const SHARD_NAME = /^[0-9a-f]{2}$/;
const ENTRY_NAME = /^[0-9a-f]{64}\.json$/;
const TEMPORARY_NAME = /\.tmp$/;

export function resolveReactCompilerCacheDir(
  env: NodeJS.ProcessEnv,
  webRoot: string,
): string | undefined {
  const mode = env[REACT_COMPILER_CACHE_ENV]?.trim().toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") return undefined;
  const dir = env[REACT_COMPILER_CACHE_DIR_ENV]?.trim();
  return dir ? resolve(dir) : join(webRoot, "node_modules", ".cache", "ryco-react-compiler");
}

/** Everything other than the module itself that shapes the compiler's output. */
export interface ReactCompilerCacheKeyInputs {
  readonly version: string;
  /** `name@version` of Babel, the compiler plugin and every package they load. */
  readonly packages: ReadonlyArray<string>;
  /** The full Babel option set; see `serializeReactCompilerOptions`. */
  readonly options: string;
  /** Source text of the modules that build Babel's options and call it. */
  readonly sources: ReadonlyArray<string>;
}

/** The environment Babel and the compiler read while compiling. */
export interface ReactCompilerCacheEnv {
  /** The compiler resets memo caches on HMR edits when this is "development". */
  readonly NODE_ENV?: string | undefined;
  /** Babel's `envName`. */
  readonly BABEL_ENV?: string | undefined;
}

function digest(inputs: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  for (const input of inputs) {
    hash.update(`${Buffer.byteLength(input)}\0`);
    hash.update(input);
  }
  return hash.digest("hex");
}

export function reactCompilerCacheBase(inputs: ReactCompilerCacheKeyInputs): string {
  return digest([JSON.stringify(inputs)]);
}

/** Resolves symlinks, so a checkout reached through one keys like the real path. */
function realRoot(root: string): string {
  return existsSync(root) ? realpathSync(root) : resolve(root);
}

/**
 * Serializes Babel's options with absolute paths made relative to `root`, the
 * web package. Where the checkout lives does not change Babel's output (the
 * source map names a module by its base name), so checkouts share entries.
 * Every string is tagged: JSON.stringify does not pass a replacer's string
 * result back through it, so a regex's source is never mistaken for a path.
 */
export function serializeReactCompilerOptions(data: ReactCompilerWorkerData, root: string): string {
  const base = realRoot(root);
  return JSON.stringify(data, (_key, value: unknown) => {
    if (value instanceof RegExp) return `regexp:${String(value)}`;
    if (typeof value === "string") {
      return isAbsolute(value)
        ? `path:${relative(base, existsSync(value) ? realpathSync(value) : value)}`
        : `string:${value}`;
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new Error(`React Compiler options must be plain data, found a ${typeof value}`);
    }
    return value;
  });
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** The directory Node would load `name` from when imported by `fromFile`. */
function findPackageDir(name: string, fromFile: string): string | undefined {
  return createRequire(fromFile)
    .resolve.paths(name)
    ?.map((base) => join(base, name))
    .find((candidate) => existsSync(join(candidate, "package.json")));
}

function readManifest(dir: string): PackageManifest | undefined {
  const manifestPath = join(dir, "package.json");
  return existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest)
    : undefined;
}

/** The package `file` belongs to; a nested package.json without a name (`{"type": …}`) is not one. */
function findOwningPackageDir(file: string): string {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (readManifest(dir)?.name !== undefined) return dir;
    if (dirname(dir) === dir) throw new Error(`No package owns ${file}`);
  }
}

/**
 * `name@version` of every installed package in the dependency closure of
 * `packageDirs`, sorted. Babel's parser, generator and traverse float within
 * semver ranges of @babel/core, so its own version does not pin its output.
 */
function readPackageClosure(packageDirs: ReadonlyArray<string>): string[] {
  const seen = new Map<string, string>();
  const visit = (packageDir: string) => {
    const dir = realpathSync(packageDir);
    if (seen.has(dir)) return;
    const manifest = readManifest(dir);
    if (!manifest) throw new Error(`No package.json in ${dir}`);
    seen.set(dir, `${manifest.name}@${manifest.version}`);
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      // An optional or unmet peer dependency that is not installed loads nothing.
      const found = findPackageDir(name, join(dir, "package.json"));
      if (found) visit(found);
    }
  };
  for (const packageDir of packageDirs) visit(packageDir);
  return [...new Set(seen.values())].toSorted();
}

/** The absolute plugin paths in a Babel preset's `plugins`, as `reactCompilerPreset()` gives them. */
function presetPluginFiles(preset: unknown): string[] {
  const plugins = (preset as { readonly plugins?: unknown } | null)?.plugins;
  const files = Array.isArray(plugins)
    ? plugins.map((plugin: unknown) => (Array.isArray(plugin) ? plugin[0] : plugin))
    : [];
  if (files.length === 0 || !files.every((file) => typeof file === "string" && isAbsolute(file))) {
    throw new Error("The React Compiler cache only keys presets of absolute plugin paths");
  }
  return files as string[];
}

/**
 * Reads the key inputs for `data` from disk: the installed packages Babel and
 * the preset's plugins load, and the source of `sourceFiles`. `babelFrom` is
 * the module that imports @babel/core.
 */
export function readReactCompilerCacheKeyInputs(input: {
  readonly data: ReactCompilerWorkerData;
  readonly babelFrom: URL;
  readonly sourceFiles: ReadonlyArray<URL>;
}): ReactCompilerCacheKeyInputs {
  const babelDir = findPackageDir("@babel/core", fileURLToPath(input.babelFrom));
  if (!babelDir) throw new Error("Cannot find @babel/core");
  return {
    version: REACT_COMPILER_CACHE_VERSION,
    packages: readPackageClosure([
      babelDir,
      ...presetPluginFiles(input.data.preset).map(findOwningPackageDir),
    ]),
    options: serializeReactCompilerOptions(input.data, input.data.cwd),
    sources: input.sourceFiles.map((file) => readFileSync(file, "utf8")),
  };
}

function parseEntry(text: string): ReactCompilerJobOutput | undefined {
  try {
    const entry = JSON.parse(text) as { readonly code?: unknown; readonly map?: unknown } | null;
    if (typeof entry?.code !== "string") return undefined;
    const { map } = entry;
    if (map !== null && (typeof map !== "object" || Array.isArray(map))) return undefined;
    return { code: entry.code, map: map as ReactCompilerJobOutput["map"] };
  } catch {
    return undefined;
  }
}

interface CacheFile {
  readonly path: string;
  readonly temporary: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Entries and temporaries; anything else in the directory is left alone. */
async function listCacheFiles(dir: string): Promise<CacheFile[]> {
  const shards = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const listed = await Promise.all(
    shards
      .filter((shard) => SHARD_NAME.test(shard))
      .map(async (shard) => {
        const names = await readdir(join(dir, shard)).catch(() => []);
        const files = await Promise.all(
          names.map(async (name) => {
            const temporary = TEMPORARY_NAME.test(name);
            if (!temporary && !ENTRY_NAME.test(name)) return [];
            const path = join(dir, shard, name);
            // Another process may have pruned or renamed it since readdir.
            const stats = await stat(path).catch(() => undefined);
            if (!stats?.isFile()) return [];
            return { path, temporary, size: stats.size, mtimeMs: stats.mtimeMs };
          }),
        );
        return files.flat();
      }),
  );
  return listed.flat();
}

export interface ReactCompilerCache {
  /** The entry key for a module's code under the current environment. */
  readonly key: (id: string, code: string, env?: ReactCompilerCacheEnv) => string;
  /** The entry, or `undefined` on a miss or an unreadable entry. Marks a hit as used. */
  readonly read: (key: string) => Promise<ReactCompilerJobOutput | undefined>;
  /** Publishes an entry atomically; a concurrent writer of the same key wins or loses whole. */
  readonly write: (key: string, output: ReactCompilerJobOutput) => Promise<void>;
  /** Deletes dead temporaries and, past the size bound, the least recently used entries. */
  readonly prune: () => Promise<void>;
}

export function createReactCompilerCache(options: {
  readonly dir: string;
  /** Module ids key relative to this, the web package, so checkouts share entries. */
  readonly root: string;
  /** `reactCompilerCacheBase()` of everything but the module. */
  readonly base: string;
  readonly maxBytes?: number;
}): ReactCompilerCache {
  const { dir, base } = options;
  const root = realRoot(options.root);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const entryPath = (key: string) => join(dir, key.slice(0, 2), `${key}.json`);

  return {
    key: (id, code, env = process.env) =>
      digest([
        base,
        env.NODE_ENV ?? "",
        env.BABEL_ENV ?? "",
        isAbsolute(id) ? relative(root, id) : id,
        code,
      ]),
    read: async (key) => {
      const path = entryPath(key);
      const text = await readFile(path, "utf8").catch(() => undefined);
      // A corrupt entry is a miss; the compile that follows replaces it.
      const output = text === undefined ? undefined : parseEntry(text);
      if (output) {
        // CI saves only what a job used and local pruning drops the least
        // recently used, both by mtime. Losing the mark only costs a recompile.
        const now = new Date();
        await utimes(path, now, now).catch(() => undefined);
      }
      return output;
    },
    write: async (key, output) => {
      const path = entryPath(key);
      const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, JSON.stringify({ code: output.code, map: output.map }));
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    prune: async () => {
      const staleBefore = Date.now() - STALE_TEMPORARY_MS;
      const files = await listCacheFiles(dir);
      await Promise.all(
        files
          .filter((file) => file.temporary && file.mtimeMs < staleBefore)
          .map((file) => rm(file.path, { force: true })),
      );
      const entries = files.filter((file) => !file.temporary);
      let total = entries.reduce((sum, entry) => sum + entry.size, 0);
      if (total <= maxBytes) return;
      for (const entry of entries.toSorted((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total <= maxBytes * PRUNE_TARGET_RATIO) break;
        await rm(entry.path, { force: true });
        total -= entry.size;
      }
    },
  };
}
