import type { TransformOptions } from "@babel/core";

import type {
  ReactCompilerJob,
  ReactCompilerJobError,
  ReactCompilerJobOutput,
  ReactCompilerJobResult,
  ReactCompilerWorkerData,
} from "./reactCompilerPool";

// Runs in the pool's workers, which Node loads directly (type stripping), and
// on the main thread outside builds: keep this module to erasable syntax and
// type-only local imports.

// @types/babel__core 7.20 predates loadOptionsAsync and lacks Babel's
// `sourceMap` alias and boolean `inputSourceMap`.
type LoadOptions = Omit<TransformOptions, "inputSourceMap"> & {
  readonly sourceMap?: boolean;
  readonly inputSourceMap?: boolean;
};
type LoadedOptions = TransformOptions & { readonly plugins: ReadonlyArray<unknown> };
interface Babel {
  readonly loadOptionsAsync: (options: LoadOptions) => Promise<LoadedOptions | null>;
  readonly transformAsync: typeof import("@babel/core").transformAsync;
}

// @rolldown/plugin-babel 0.2.4 adds these after the caller's options.
const parserOverrides: TransformOptions[] = [
  { test: /\.jsx(?:$|\?)/, parserOpts: { plugins: ["jsx"] } },
  { test: /\.ts(?:$|\?)/, parserOpts: { plugins: ["typescript"] } },
  { test: /\.tsx(?:$|\?)/, parserOpts: { plugins: ["typescript", "jsx"] } },
];

function describeError(error: unknown): ReactCompilerJobError {
  if (!(error instanceof Error)) return { message: String(error) };
  // Babel's parse errors carry these.
  const { code, reasonCode, loc, pos } = error as Error & {
    readonly code?: unknown;
    readonly reasonCode?: unknown;
    readonly loc?: { readonly line: number; readonly column: number };
    readonly pos?: unknown;
  };
  return {
    message: error.message,
    stack: error.stack,
    code: code === undefined ? undefined : String(code),
    reasonCode: reasonCode === undefined ? undefined : String(reasonCode),
    loc: loc ? { line: loc.line, column: loc.column } : undefined,
    pos: typeof pos === "number" ? pos : undefined,
  };
}

/**
 * Compiles one module per call with the options @rolldown/plugin-babel 0.2.4
 * hands Babel, key for key. Babel loads on the first call, so a build's main
 * thread, which only dispatches to workers, never loads it.
 */
export function createReactCompilerTransform({
  include,
  exclude,
  cwd,
  parserOpts,
  preset,
}: ReactCompilerWorkerData): (job: ReactCompilerJob) => Promise<ReactCompilerJobResult> {
  const presets = [() => preset];
  let loading: Promise<Babel> | undefined;

  const compile = async ({
    id,
    code,
  }: ReactCompilerJob): Promise<ReactCompilerJobOutput | null> => {
    const babel = await (loading ??= import("@babel/core") as unknown as Promise<Babel>);
    const loadedOptions = await babel.loadOptionsAsync({
      include,
      exclude: [...exclude],
      cwd,
      parserOpts: { sourceType: "module", allowAwaitOutsideFunction: true, ...parserOpts },
      presets,
      overrides: parserOverrides,
      sourceMap: true,
      inputSourceMap: false,
      babelrc: false,
      configFile: false,
      filename: id,
    });
    if (!loadedOptions || loadedOptions.plugins.length === 0) return null;
    const result = await babel.transformAsync(code, loadedOptions);
    if (result?.code == null) return null;
    return { code: result.code, map: result.map ?? null };
  };

  return async (job) => {
    try {
      return { ok: true, output: await compile(job) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  };
}
