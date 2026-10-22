import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { createReactCompilerOptions } from "../../vite.config";
import { createReactCompilerPoolPlugin } from "./reactCompilerPool";

/**
 * The plugin replaces `@rolldown/plugin-babel`, so in a build (worker pool) and
 * outside one (main thread) it must select the same modules and compile them
 * to the same code and source map.
 */

interface TransformOutput {
  readonly code?: string;
  readonly map?: unknown;
}

interface ThrownPluginError {
  readonly message: string;
  readonly loc?: { readonly line: number; readonly column: number } | undefined;
  readonly pos?: number | undefined;
  readonly pluginCode?: unknown;
}

/** The hooks both plugins implement, called the way Vite and rolldown call them. */
interface TransformPlugin {
  readonly config: () => unknown;
  readonly configResolved?: (config: { readonly command: "build" | "serve" }) => void;
  readonly applyToEnvironment: (environment: object) => boolean;
  readonly transform: {
    readonly filter: unknown;
    readonly handler: (
      this: object,
      code: string,
      id: string,
      meta: { readonly moduleType: string },
    ) => Promise<TransformOutput | undefined>;
  };
  readonly buildEnd?: () => Promise<void>;
}

const clientEnvironment = { name: "client", config: { consumer: "client" } };
const serverEnvironment = { name: "ssr", config: { consumer: "server" } };
const transformContext = {
  environment: clientEnvironment,
  error(error: ThrownPluginError): never {
    throw error;
  },
};

const srcUrl = new URL("../", import.meta.url);
const fixturesUrl = new URL("../../test/fixtures/reactCompiler/", import.meta.url);

/** Fixtures compile under an id in `src/`, where the compiler's include filter applies. */
const fixture = (name: string) => ({
  source: new URL(name, fixturesUrl),
  id: fileURLToPath(new URL(`reactCompilerFixtures/${name}`, srcUrl)),
});
const FIXTURES = ["CounterList.tsx", "useSortedEntries.ts", "LabeledInput.tsx"].map(fixture);
const APP_MODULES = ["components/Sidebar.tsx", "hooks/useSettings.ts"].map((path) => {
  const source = new URL(path, srcUrl);
  return { source, id: fileURLToPath(source) };
});

function createPlugin(command: "build" | "serve"): TransformPlugin {
  const plugin = createReactCompilerPoolPlugin(
    createReactCompilerOptions(),
  ) as unknown as TransformPlugin;
  plugin.configResolved?.({ command });
  return plugin;
}
const createPoolPlugin = () => createPlugin("build");

async function createPlugins() {
  const legacy = (await babel(createReactCompilerOptions())) as unknown as TransformPlugin;
  legacy.configResolved?.({ command: "build" });
  return { legacy, pool: createPoolPlugin(), mainThread: createPlugin("serve") };
}

function transform(plugin: TransformPlugin, code: string, id: string) {
  const moduleType = id.endsWith(".tsx") ? "tsx" : "ts";
  return plugin.transform.handler.call(transformContext, code, id, { moduleType });
}

async function rejection(promise: Promise<unknown>): Promise<ThrownPluginError> {
  try {
    await promise;
  } catch (error) {
    const { message, loc, pos, pluginCode } = error as ThrownPluginError;
    return { message, pluginCode, pos, loc: loc && { line: loc.line, column: loc.column } };
  }
  throw new Error("expected the transform to fail");
}

describe("React Compiler plugin", async () => {
  const { legacy, pool, mainThread } = await createPlugins();

  afterAll(async () => {
    await pool.buildEnd?.();
  });

  it("selects the modules and environments @rolldown/plugin-babel does", () => {
    for (const plugin of [pool, mainThread]) {
      expect(plugin.transform.filter).toEqual(legacy.transform.filter);
      expect(plugin.config()).toEqual(legacy.config());
      for (const environment of [serverEnvironment, clientEnvironment]) {
        expect(plugin.applyToEnvironment(environment)).toBe(legacy.applyToEnvironment(environment));
      }
    }
  });

  it("compiles modules to the same code and source map", async () => {
    const modules = await Promise.all(
      [...FIXTURES, ...APP_MODULES].map(async ({ source, id }) => ({
        id,
        code: await readFile(source, "utf8"),
      })),
    );
    // Concurrent, as in a build, so the jobs spread over several workers.
    const [expected, pooled, onMainThread] = await Promise.all(
      [legacy, pool, mainThread].map((plugin) =>
        Promise.all(modules.map(({ code, id }) => transform(plugin, code, id))),
      ),
    );

    expect(pooled).toStrictEqual(expected);
    expect(onMainThread).toStrictEqual(expected);
    for (const output of expected ?? []) {
      expect(output?.code).toContain("react/compiler-runtime");
    }
  }, 60_000);

  it("reports Babel errors the way @rolldown/plugin-babel does", async () => {
    const id = fileURLToPath(new URL("reactCompilerFixtures/Broken.tsx", srcUrl));
    const code = "export function Broken() {\n  return <div>;\n}\n";

    const expected = await rejection(transform(legacy, code, id));
    expect(expected.message).toContain("[BabelError]");
    expect(await rejection(transform(pool, code, id))).toEqual(expected);
    expect(await rejection(transform(mainThread, code, id))).toEqual(expected);
  }, 60_000);

  it("fails in-flight transforms on close and starts a fresh pool afterwards", async () => {
    const plugin = createPoolPlugin();
    const { source, id } = fixture("CounterList.tsx");
    const code = await readFile(source, "utf8");

    const inFlight = expect(transform(plugin, code, id)).rejects.toThrow(
      "React Compiler worker pool closed",
    );
    await plugin.buildEnd?.();
    await inFlight;
    expect((await transform(plugin, code, id))?.code).toContain("react/compiler-runtime");
    await plugin.buildEnd?.();
  }, 60_000);

  // Closing has no pool to stop outside a build, so an in-flight transform
  // still completes.
  it("compiles on the main thread outside builds", async () => {
    const plugin = createPlugin("serve");
    const { source, id } = fixture("CounterList.tsx");
    const code = await readFile(source, "utf8");

    const inFlight = transform(plugin, code, id);
    await plugin.buildEnd?.();
    expect((await inFlight)?.code).toContain("react/compiler-runtime");
  }, 60_000);
});
