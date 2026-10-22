import { availableParallelism } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { Worker } from "node:worker_threads";
import type { BabelFileResult, TransformOptions } from "@babel/core";
import type { reactCompilerPreset } from "@vitejs/plugin-react";
import type { Plugin } from "vite";

import {
  createReactCompilerCache,
  reactCompilerCacheBase,
  readReactCompilerCacheKeyInputs,
  type ReactCompilerCache,
} from "./reactCompilerCache";
import { createReactCompilerTransform } from "./reactCompilerTransform";

/**
 * Runs the React Compiler's Babel pass behind a content-addressed disk cache
 * (./reactCompilerCache.ts), on a pool of worker threads in builds.
 *
 * `@rolldown/plugin-babel` runs Babel on the main thread, where the compiler
 * is about 90% of the web build. This plugin takes the same options, keeps the
 * same transform filter and passes Babel the same options per module, but a
 * build's transforms run in workers; rolldown already calls transform hooks
 * concurrently. Rolldown's own `defineParallelPlugin` would do this, but
 * vite-plus-core does not map the `#parallel-plugin-worker` import it resolves.
 *
 * The dev server and Vitest compile on the main thread as that plugin did:
 * they request modules a few at a time, and every worker warms up its own
 * Babel, so a pool there roughly doubled CPU time and memory for little gain.
 */

type ReactCompilerPreset = ReturnType<typeof reactCompilerPreset>;
type BabelParserOptions = NonNullable<TransformOptions["parserOpts"]>;

/** The `@rolldown/plugin-babel` options this plugin mirrors. */
export interface ReactCompilerPoolOptions {
  readonly include: RegExp;
  readonly exclude: RegExp[];
  readonly cwd: string;
  readonly parserOpts: BabelParserOptions;
  readonly presets: [ReactCompilerPreset];
}

/** Cloned into every worker, so it holds plain data only. */
export interface ReactCompilerWorkerData {
  readonly include: RegExp;
  readonly exclude: ReadonlyArray<RegExp>;
  readonly cwd: string;
  readonly parserOpts: BabelParserOptions;
  /** What `reactCompilerPreset()`'s Babel preset returns: the compiler plugin's path and options. */
  readonly preset: unknown;
}

export interface ReactCompilerJob {
  readonly id: string;
  readonly code: string;
}

export interface ReactCompilerJobError {
  readonly message: string;
  readonly stack?: string | undefined;
  readonly code?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly loc?: { readonly line: number; readonly column: number } | undefined;
  readonly pos?: number | undefined;
}

export interface ReactCompilerJobOutput {
  readonly code: string;
  readonly map: NonNullable<BabelFileResult["map"]> | null;
}

export type ReactCompilerJobResult =
  /** `output` is `null` when Babel had nothing to run on the module. */
  | { readonly ok: true; readonly output: ReactCompilerJobOutput | null }
  | { readonly ok: false; readonly error: ReactCompilerJobError };

const WORKER_URL = new URL("./reactCompilerWorker.ts", import.meta.url);
const TRANSFORM_URL = new URL("./reactCompilerTransform.ts", import.meta.url);
/** Their source is part of the cache key: they build Babel's options and run it. */
const CACHE_KEYED_SOURCES = [
  new URL("./reactCompilerPool.ts", import.meta.url),
  WORKER_URL,
  TRANSFORM_URL,
  new URL("./reactCompilerCache.ts", import.meta.url),
];
/** Each worker holds its own Babel, compiler and heap (up to ~0.5 GB in a build). */
const MAX_WORKERS = 8;
/**
 * A watch build compiles in bursts, then a module per edit. Workers beyond the
 * first stop after this long idle instead of holding their heaps until close.
 */
const IDLE_WORKER_TIMEOUT_MS = 10_000;

interface QueuedJob extends ReactCompilerJob {
  readonly resolve: (result: ReactCompilerJobResult) => void;
  readonly reject: (error: Error) => void;
}

interface PoolWorker {
  readonly worker: Worker;
  job: QueuedJob | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

interface ReactCompilerWorkerPool {
  readonly run: (job: ReactCompilerJob) => Promise<ReactCompilerJobResult>;
  /** Terminates every worker; the next `run` starts a fresh pool. */
  readonly close: () => Promise<void>;
}

/**
 * Starts workers on demand, up to `maxWorkers`, and hands each one job at a
 * time from a shared queue so a slow module never holds others behind it.
 * Idle workers are unref'd and never keep the process alive; all but one stop
 * after `IDLE_WORKER_TIMEOUT_MS`.
 */
function createReactCompilerWorkerPool(
  workerData: ReactCompilerWorkerData,
  maxWorkers: number,
): ReactCompilerWorkerPool {
  const workers = new Set<PoolWorker>();
  const idle: PoolWorker[] = [];
  const queue: QueuedJob[] = [];

  const release = (entry: PoolWorker) => {
    entry.job = undefined;
    entry.worker.unref();
  };

  /** Takes a worker out of the pool; false if it already left. */
  const remove = (entry: PoolWorker): boolean => {
    if (!workers.delete(entry)) return false;
    clearTimeout(entry.idleTimer);
    const idleIndex = idle.indexOf(entry);
    if (idleIndex !== -1) idle.splice(idleIndex, 1);
    return true;
  };

  const dispatch = () => {
    while (queue.length > 0) {
      const entry = idle.pop() ?? (workers.size < maxWorkers ? spawn() : undefined);
      if (!entry) return;
      clearTimeout(entry.idleTimer);
      const job = queue.shift() as QueuedJob;
      entry.job = job;
      entry.worker.ref();
      // A worker_threads port, not a window: there is no target origin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      entry.worker.postMessage({ id: job.id, code: job.code } satisfies ReactCompilerJob);
    }
  };

  const spawn = (): PoolWorker => {
    const entry: PoolWorker = {
      worker: new Worker(WORKER_URL, { workerData }),
      job: undefined,
      idleTimer: undefined,
    };
    entry.worker.unref();
    entry.worker.on("message", (result: ReactCompilerJobResult) => {
      if (!workers.has(entry)) return;
      const { job } = entry;
      release(entry);
      idle.push(entry);
      job?.resolve(result);
      dispatch();
      if (entry.job || workers.size === 1) return;
      entry.idleTimer = setTimeout(() => {
        if (workers.size > 1 && remove(entry)) void entry.worker.terminate();
      }, IDLE_WORKER_TIMEOUT_MS).unref();
    });
    // A crashed worker fails the build, so fail the queued jobs with it rather
    // than respawning a worker per queued module.
    const fail = (error: Error) => {
      if (!remove(entry)) return;
      const failed = [...(entry.job ? [entry.job] : []), ...queue.splice(0)];
      release(entry);
      for (const job of failed) job.reject(error);
    };
    entry.worker.on("error", fail);
    entry.worker.on("exit", (exitCode) => {
      fail(new Error(`React Compiler worker exited with code ${exitCode}`));
    });
    workers.add(entry);
    return entry;
  };

  return {
    run: (job) =>
      new Promise((resolve, reject) => {
        queue.push({ ...job, resolve, reject });
        dispatch();
      }),
    close: async () => {
      const closing = [...workers];
      for (const entry of closing) remove(entry);
      const error = new Error("React Compiler worker pool closed");
      for (const job of [...closing.flatMap((entry) => entry.job ?? []), ...queue.splice(0)]) {
        job.reject(error);
      }
      await Promise.all(closing.map((entry) => entry.worker.terminate()));
    },
  };
}

export interface ReactCompilerPluginSettings {
  /** Where compiled modules are cached (`resolveReactCompilerCacheDir()`); unset compiles every module. */
  readonly cacheDir?: string | undefined;
}

/** Drop-in replacement for `@rolldown/plugin-babel` with a single `reactCompilerPreset()`. */
export function createReactCompilerPoolPlugin(
  options: ReactCompilerPoolOptions,
  settings: ReactCompilerPluginSettings = {},
): Plugin {
  const [preset] = options.presets;
  const codeFilter = preset.rolldown.filter?.code;
  // @rolldown/plugin-babel derives its transform filter from the preset's; this
  // mirrors only the shape reactCompilerPreset() has, so fail on anything else.
  if (!(codeFilter instanceof RegExp) || typeof preset.preset !== "function") {
    throw new Error("createReactCompilerPoolPlugin supports reactCompilerPreset() only");
  }
  const optimizeDepsInclude = preset.rolldown.optimizeDeps?.include ?? [];
  // Functions can't be cloned into a worker. reactCompilerPreset()'s preset
  // ignores its arguments and returns data, so each worker gets that data.
  const presetFactory = preset.preset as () => unknown;
  let data: ReactCompilerWorkerData | undefined;
  const workerData = () =>
    (data ??= {
      include: options.include,
      exclude: options.exclude,
      cwd: options.cwd,
      parserOpts: options.parserOpts,
      preset: presetFactory(),
    });

  let usePool = false;
  let pool: ReactCompilerWorkerPool | undefined;
  let transformOnMainThread: ReturnType<typeof createReactCompilerTransform> | undefined;
  const compile = (job: ReactCompilerJob) => {
    if (!usePool) {
      transformOnMainThread ??= createReactCompilerTransform(workerData());
      return transformOnMainThread(job);
    }
    pool ??= createReactCompilerWorkerPool(
      workerData(),
      Math.min(availableParallelism(), MAX_WORKERS),
    );
    return pool.run(job);
  };
  const closePool = async () => {
    const closing = pool;
    pool = undefined;
    await closing?.close();
  };

  // A cache that cannot open or write only costs speed, never the build.
  let opening: Promise<ReactCompilerCache | undefined> | undefined;
  let warnedWrite = false;
  const openCache = (dir: string, warn: (message: string) => void) =>
    (opening ??= (async () => {
      try {
        const cache = createReactCompilerCache({
          dir,
          root: options.cwd,
          base: reactCompilerCacheBase(
            readReactCompilerCacheKeyInputs({
              data: workerData(),
              babelFrom: TRANSFORM_URL,
              sourceFiles: CACHE_KEYED_SOURCES,
            }),
          ),
        });
        await cache.prune();
        return cache;
      } catch (error) {
        warn(`React Compiler transform cache disabled: ${String(error)}`);
        return undefined;
      }
    })());

  return {
    name: "ryco:react-compiler",
    enforce: "pre",
    config: () =>
      optimizeDepsInclude.length > 0
        ? { optimizeDeps: { include: optimizeDepsInclude } }
        : undefined,
    configResolved: (config) => {
      usePool = config.command === "build";
    },
    applyToEnvironment: (environment) =>
      preset.rolldown.applyToEnvironmentHook?.(environment) ?? true,
    transform: {
      filter: {
        id: { include: [options.include], exclude: [...options.exclude] },
        code: [codeFilter],
      },
      async handler(code, id) {
        const { cacheDir } = settings;
        const cache =
          cacheDir === undefined
            ? undefined
            : await openCache(cacheDir, (message) => this.warn(message));
        const key = cache?.key(id, code);
        if (cache && key !== undefined) {
          const cached = await cache.read(key);
          if (cached) return cached;
        }
        const result = await compile({ id, code });
        if (result.ok) {
          if (cache && key !== undefined && result.output) {
            await cache.write(key, result.output).catch((error: unknown) => {
              if (warnedWrite) return;
              warnedWrite = true;
              this.warn(`Could not write the React Compiler transform cache: ${String(error)}`);
            });
          }
          return result.output ?? undefined;
        }
        const { message, stack, code: errorCode, reasonCode, loc, pos } = result.error;
        return this.error({
          message: `[BabelError] ${message}`,
          ...(loc ? { loc } : {}),
          ...(pos === undefined ? {} : { pos }),
          cause: Object.assign(new Error(message), { stack }),
          pluginCode: `${errorCode}:${reasonCode}`,
        });
      },
    },
    // Vite also runs both when a dev server closes.
    buildEnd: closePool,
    closeBundle: closePool,
  };
}
