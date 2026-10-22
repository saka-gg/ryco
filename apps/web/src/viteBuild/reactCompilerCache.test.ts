import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createReactCompilerOptions, REACT_COMPILER_INCLUDE } from "../../vite.config";
import {
  createReactCompilerCache,
  REACT_COMPILER_CACHE_VERSION,
  reactCompilerCacheBase,
  readReactCompilerCacheKeyInputs,
  resolveReactCompilerCacheDir,
  serializeReactCompilerOptions,
  type ReactCompilerCacheKeyInputs,
} from "./reactCompilerCache";
import { createReactCompilerPoolPlugin, type ReactCompilerWorkerData } from "./reactCompilerPool";
import { createReactCompilerTransform } from "./reactCompilerTransform";

interface TransformOutput {
  readonly code?: string;
  readonly map?: unknown;
}

/** The hooks the cache tests call, the way Vite calls them. */
interface TransformPlugin {
  readonly configResolved: (config: { readonly command: "build" | "serve" }) => void;
  readonly transform: {
    readonly handler: (
      this: object,
      code: string,
      id: string,
    ) => Promise<TransformOutput | undefined>;
  };
}

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureUrl = new URL("../../test/fixtures/reactCompiler/CounterList.tsx", import.meta.url);
const fixtureId = path.join(webRoot, "src/reactCompilerFixtures/CounterList.tsx");
const warnings: string[] = [];
const transformContext = {
  environment: { name: "client", config: { consumer: "client" } },
  error(error: unknown): never {
    throw error;
  },
  warn(message: string) {
    warnings.push(message);
  },
};

const temporaryDirs: string[] = [];
function temporaryDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ryco-react-compiler-cache-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  warnings.length = 0;
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function listEntries(dir: string): Promise<string[]> {
  const files = await readdir(dir, { recursive: true }).catch(() => []);
  return files.filter((file) => file.endsWith(".json")).map((file) => path.join(dir, file));
}

function createPlugin(cacheDir: string | undefined): TransformPlugin {
  const plugin = createReactCompilerPoolPlugin(createReactCompilerOptions(), {
    cacheDir,
  }) as unknown as TransformPlugin;
  // The main thread compiles without spawning workers.
  plugin.configResolved({ command: "serve" });
  return plugin;
}

function transform(plugin: TransformPlugin, code: string, id = fixtureId) {
  return plugin.transform.handler.call(transformContext, code, id);
}

function workerData(overrides: Partial<ReactCompilerWorkerData> = {}): ReactCompilerWorkerData {
  const options = createReactCompilerOptions();
  return {
    include: options.include,
    exclude: options.exclude,
    cwd: options.cwd,
    parserOpts: options.parserOpts,
    preset: (options.presets[0].preset as () => unknown)(),
    ...overrides,
  };
}

describe("React Compiler cache key", () => {
  const inputs: ReactCompilerCacheKeyInputs = {
    version: REACT_COMPILER_CACHE_VERSION,
    packages: [
      "@babel/core@7.29.7",
      "@babel/generator@7.29.1",
      "babel-plugin-react-compiler@1.0.0",
    ],
    options: serializeReactCompilerOptions(workerData(), webRoot),
    sources: ["plugin source", "worker source"],
  };
  const base = reactCompilerCacheBase(inputs);
  const cache = createReactCompilerCache({ dir: "/unused", root: webRoot, base });
  const env = { NODE_ENV: "production" };
  const key = cache.key(fixtureId, "code", env);

  it("changes with every input outside the module", () => {
    const variants: ReactCompilerCacheKeyInputs[] = [
      { ...inputs, version: `${REACT_COMPILER_CACHE_VERSION}-next` },
      { ...inputs, packages: ["@babel/core@7.29.8", ...inputs.packages.slice(1)] },
      {
        ...inputs,
        packages: [
          ...inputs.packages.slice(0, 1),
          "@babel/generator@7.29.2",
          ...inputs.packages.slice(2),
        ],
      },
      {
        ...inputs,
        packages: [...inputs.packages.slice(0, 2), "babel-plugin-react-compiler@1.0.1"],
      },
      {
        ...inputs,
        options: serializeReactCompilerOptions(workerData({ parserOpts: {} }), webRoot),
      },
      { ...inputs, sources: ["plugin source", "worker source "] },
      { ...inputs, sources: ["plugin source", "worker source", "transform source"] },
    ];
    const keys = variants.map((variant) =>
      createReactCompilerCache({
        dir: "/unused",
        root: webRoot,
        base: reactCompilerCacheBase(variant),
      }).key(fixtureId, "code", env),
    );
    expect(new Set([key, ...keys]).size).toBe(variants.length + 1);
  });

  it("changes with the module, its path and the environment Babel reads", () => {
    const keys = [
      cache.key(fixtureId, "code ", env),
      cache.key(fixtureId.replace("CounterList", "CounterLists"), "code", env),
      cache.key(fixtureId, "code", { NODE_ENV: "development" }),
      cache.key(fixtureId, "code", { ...env, BABEL_ENV: "test" }),
    ];
    expect(new Set([key, ...keys]).size).toBe(keys.length + 1);
    expect(cache.key(fixtureId, "code", { ...env })).toBe(key);
  });

  it("serializes every Babel option", () => {
    const serialized = serializeReactCompilerOptions(workerData(), webRoot);
    const variants = [
      workerData({ include: /[\\/]apps[\\/]web[\\/]lib[\\/].*\.[jt]sx?(?:$|\?)/ }),
      workerData({ exclude: workerData().exclude.slice(1) }),
      workerData({ parserOpts: { plugins: ["typescript"] } }),
      workerData({
        preset: {
          plugins: [
            [(workerData().preset as { plugins: [[string]] }).plugins[0][0], { target: "18" }],
          ],
        },
      }),
    ].map((data) => serializeReactCompilerOptions(data, webRoot));
    expect(new Set([serialized, ...variants]).size).toBe(variants.length + 1);
  });

  it("keys checkout paths relative to the web package", () => {
    const at = (root: string) =>
      serializeReactCompilerOptions(
        workerData({
          cwd: root,
          preset: { plugins: [[path.join(root, "../../node_modules/compiler.js"), {}]] },
        }),
        root,
      );
    const serialized = at("/checkouts/a/apps/web");
    expect(at("/other/checkouts/b/apps/web")).toBe(serialized);
    expect(serialized).toContain(JSON.stringify(`regexp:${String(REACT_COMPILER_INCLUDE)}`));
    expect(serialized).toContain('"path:../../node_modules/compiler.js"');
    expect(serialized).not.toContain("/checkouts/");
    const keyAt = (root: string) =>
      createReactCompilerCache({ dir: "/unused", root, base }).key(
        path.join(root, "src/App.tsx"),
        "code",
        env,
      );
    expect(keyAt("/other/checkouts/b/apps/web")).toBe(keyAt("/checkouts/a/apps/web"));
  });

  // What makes relative keys sound: Babel's output names the module by its
  // base name only, so a module compiles the same in any checkout.
  it("compiles a module the same in any checkout", async () => {
    const code = await readFile(fixtureUrl, "utf8");
    const outputs = await Promise.all(
      ["/checkouts/a/apps/web", "/other/checkouts/b/apps/web"].map((root) =>
        createReactCompilerTransform(workerData({ cwd: root }))({
          id: path.join(root, "src/CounterList.tsx"),
          code,
        }),
      ),
    );
    expect(outputs[0]).toMatchObject({
      ok: true,
      output: { code: expect.stringContaining("react/compiler-runtime") },
    });
    expect(outputs[1]).toStrictEqual(outputs[0]);
  }, 60_000);

  // Why the key covers NODE_ENV: in development the compiler emits a source
  // hash check that resets memo caches across HMR edits.
  it("compiles differently in development", async () => {
    const code = await readFile(fixtureUrl, "utf8");
    const compileWith = async (nodeEnv: string) => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = nodeEnv;
      try {
        return await createReactCompilerTransform(workerData())({ id: fixtureId, code });
      } finally {
        process.env.NODE_ENV = previous;
      }
    };
    expect(await compileWith("development")).not.toStrictEqual(await compileWith("production"));
  }, 60_000);

  it("reads the installed Babel and compiler packages and the keyed sources", () => {
    const sourceFiles = [new URL("./reactCompilerCache.ts", import.meta.url)];
    const read = readReactCompilerCacheKeyInputs({
      data: workerData(),
      babelFrom: new URL("./reactCompilerTransform.ts", import.meta.url),
      sourceFiles,
    });
    expect(read.version).toBe(REACT_COMPILER_CACHE_VERSION);
    for (const name of [
      "@babel/core",
      "@babel/generator",
      "@babel/parser",
      "babel-plugin-react-compiler",
    ]) {
      expect(read.packages.some((entry) => entry.startsWith(`${name}@`))).toBe(true);
    }
    expect(read.packages).toStrictEqual(read.packages.toSorted());
    expect(read.sources[0]).toContain("REACT_COMPILER_CACHE_VERSION");
    expect(read.options).toBe(serializeReactCompilerOptions(workerData(), webRoot));
  });
});

describe("React Compiler cache entries", () => {
  const output = { code: "export const a = 1;", map: { version: 3, mappings: "AAAA" } as never };

  it("round-trips an entry and marks it used on a hit", async () => {
    const dir = temporaryDir();
    const cache = createReactCompilerCache({ dir, root: webRoot, base: "base" });
    const key = cache.key(fixtureId, "code");

    expect(await cache.read(key)).toBeUndefined();
    await cache.write(key, output);
    const [entry] = await listEntries(dir);
    expect(entry).toBe(path.join(dir, key.slice(0, 2), `${key}.json`));
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(entry as string, old, old);

    expect(await cache.read(key)).toStrictEqual(output);
    expect((await stat(entry as string)).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
    expect((await readdir(path.dirname(entry as string))).length).toBe(1);
  });

  it("treats an unreadable entry as a miss", async () => {
    const dir = temporaryDir();
    const cache = createReactCompilerCache({ dir, root: webRoot, base: "base" });
    const key = cache.key(fixtureId, "code");
    const entry = path.join(dir, key.slice(0, 2), `${key}.json`);
    await mkdir(path.dirname(entry), { recursive: true });

    for (const corrupt of [
      "",
      '{"code": "export',
      "null",
      '{"map": null}',
      '{"code": 1, "map": null}',
      '{"code": "x", "map": []}',
      '{"code": "x", "map": "AAAA"}',
    ]) {
      await writeFile(entry, corrupt);
      expect(await cache.read(key)).toBeUndefined();
    }
    await writeFile(entry, '{"code": "x", "map": null}');
    expect(await cache.read(key)).toStrictEqual({ code: "x", map: null });
  });

  it("prunes the least recently used entries past its bound and dead temporaries", async () => {
    const dir = temporaryDir();
    const cache = createReactCompilerCache({ dir, root: webRoot, base: "base", maxBytes: 1000 });
    const now = Date.now();
    const keys = Array.from({ length: 5 }, (_, index) => cache.key(fixtureId, `code ${index}`));
    for (const [index, key] of keys.entries()) {
      await cache.write(key, { code: "x".repeat(280), map: null });
      // keys[0] is the most recently used.
      const used = new Date(now - (index + 1) * 60_000);
      await utimes(path.join(dir, key.slice(0, 2), `${key}.json`), used, used);
    }
    const shard = path.join(dir, keys[0]!.slice(0, 2));
    const dead = path.join(shard, `${keys[0]}.json.1-dead.tmp`);
    const live = path.join(shard, `${keys[0]}.json.2-live.tmp`);
    const foreign = path.join(shard, "notes.txt");
    for (const file of [dead, live, foreign]) await writeFile(file, "x");
    const longAgo = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(dead, longAgo, longAgo);
    await utimes(foreign, longAgo, longAgo);

    await cache.prune();

    // About 300 bytes per entry: five exceed 1000, two fit under 800.
    for (const [index, key] of keys.entries()) {
      expect(await cache.read(key), `entry ${index}`).toEqual(
        index < 2 ? expect.anything() : undefined,
      );
    }
    const remaining = await readdir(shard);
    expect(remaining).not.toContain(path.basename(dead));
    expect(remaining).toContain(path.basename(live));
    expect(remaining).toContain(path.basename(foreign));
  });

  it("leaves an entry within the bound alone", async () => {
    const dir = temporaryDir();
    const cache = createReactCompilerCache({ dir, root: webRoot, base: "base" });
    const key = cache.key(fixtureId, "code");
    await cache.write(key, output);
    await cache.prune();
    expect(await cache.read(key)).toStrictEqual(output);
    await createReactCompilerCache({
      dir: path.join(dir, "missing"),
      root: webRoot,
      base: "base",
    }).prune();
  });
});

describe("React Compiler cache directory", () => {
  it("defaults to the web package's node_modules cache", () => {
    expect(resolveReactCompilerCacheDir({}, webRoot)).toBe(
      path.join(webRoot, "node_modules", ".cache", "ryco-react-compiler"),
    );
  });

  it("honors RYCO_REACT_COMPILER_CACHE_DIR", () => {
    expect(
      resolveReactCompilerCacheDir(
        { RYCO_REACT_COMPILER_CACHE_DIR: " /tmp/compiler-cache " },
        webRoot,
      ),
    ).toBe(path.resolve("/tmp/compiler-cache"));
  });

  it("is off when RYCO_REACT_COMPILER_CACHE is off", () => {
    for (const value of ["off", "OFF", " off", "0", "false"]) {
      expect(
        resolveReactCompilerCacheDir(
          {
            RYCO_REACT_COMPILER_CACHE: value,
            RYCO_REACT_COMPILER_CACHE_DIR: "/tmp/compiler-cache",
          },
          webRoot,
        ),
      ).toBeUndefined();
    }
    expect(
      resolveReactCompilerCacheDir({ RYCO_REACT_COMPILER_CACHE: "on" }, webRoot),
    ).toBeDefined();
  });
});

describe("React Compiler plugin with a cache", () => {
  it("serves an unchanged module from the cache", async () => {
    const dir = temporaryDir();
    const code = await readFile(fixtureUrl, "utf8");
    const uncached = await transform(createPlugin(undefined), code);

    const plugin = createPlugin(dir);
    expect(await transform(plugin, code)).toStrictEqual(uncached);
    const [entry] = await listEntries(dir);
    expect(JSON.parse(await readFile(entry as string, "utf8"))).toEqual(uncached);
    expect(await transform(createPlugin(dir), code)).toEqual(uncached);

    // Proves the second plugin read the entry instead of compiling.
    await writeFile(entry as string, JSON.stringify({ code: "cached", map: null }));
    expect(await transform(createPlugin(dir), code)).toStrictEqual({ code: "cached", map: null });
    // A change to the module misses.
    expect((await transform(createPlugin(dir), `${code}\n`))?.code).toContain(
      "react/compiler-runtime",
    );
    expect(warnings).toStrictEqual([]);
  }, 60_000);

  it("recompiles and replaces a corrupt entry", async () => {
    const dir = temporaryDir();
    const code = await readFile(fixtureUrl, "utf8");
    const compiled = await transform(createPlugin(dir), code);
    const [entry] = await listEntries(dir);
    await writeFile(entry as string, '{"code": "trunc');

    expect(await transform(createPlugin(dir), code)).toEqual(compiled);
    expect(JSON.parse(await readFile(entry as string, "utf8"))).toEqual(compiled);
  }, 60_000);

  it("never caches a Babel error", async () => {
    const dir = temporaryDir();
    const plugin = createPlugin(dir);
    await expect(
      transform(plugin, "export function Broken() {\n  return <div>;\n}\n"),
    ).rejects.toMatchObject({
      message: expect.stringContaining("[BabelError]"),
    });
    expect(await listEntries(dir)).toStrictEqual([]);
  }, 60_000);

  it("reads and writes nothing when turned off", async () => {
    const dir = temporaryDir();
    const code = await readFile(fixtureUrl, "utf8");
    const cacheDir = resolveReactCompilerCacheDir(
      { RYCO_REACT_COMPILER_CACHE: "off", RYCO_REACT_COMPILER_CACHE_DIR: dir },
      webRoot,
    );
    expect((await transform(createPlugin(cacheDir), code))?.code).toContain(
      "react/compiler-runtime",
    );
    expect(await readdir(dir)).toStrictEqual([]);
  }, 60_000);

  it("compiles anyway when the cache cannot be written", async () => {
    const dir = temporaryDir();
    // Files where the entries' shard directories would go.
    for (let shard = 0; shard < 256; shard++) {
      await writeFile(path.join(dir, shard.toString(16).padStart(2, "0")), "");
    }
    const code = await readFile(fixtureUrl, "utf8");

    const plugin = createPlugin(dir);
    expect((await transform(plugin, code))?.code).toContain("react/compiler-runtime");
    expect((await transform(plugin, `${code}\n`))?.code).toContain("react/compiler-runtime");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Could not write the React Compiler transform cache");
  }, 60_000);

  it("compiles anyway when the cache cannot be opened", async () => {
    const dir = temporaryDir();
    // A file where the cache directory should be.
    const blocked = path.join(dir, "blocked");
    await writeFile(blocked, "");
    const code = await readFile(fixtureUrl, "utf8");

    expect((await transform(createPlugin(blocked), code))?.code).toContain(
      "react/compiler-runtime",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("React Compiler transform cache disabled");
  }, 60_000);
});
