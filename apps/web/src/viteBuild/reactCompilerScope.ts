/**
 * The modules the React Compiler compiles: web React source, minus generated,
 * test, worker and deliberately pure logic modules and the perf and PWA
 * helpers. Workspace packages stay uncompiled; mobile shares them.
 *
 * With `compiler` on, plugin-react also does Fast Refresh inside the compiler
 * transform only, so these filters scope Fast Refresh too.
 *
 * Kept out of `vite.config.ts` so `src/perf/reactCompilerCoverage.test.ts` can
 * select the same modules without building the whole Vite config.
 */
export const REACT_COMPILER_INCLUDE = /[\\/]apps[\\/]web[\\/]src[\\/].*\.[jt]sx?(?:$|\?)/;
export const REACT_COMPILER_EXCLUDE = [
  /[\\/]node_modules[\\/]/,
  /\0rolldown[\\/]runtime\.js/,
  /[\\/]routeTree\.gen\.ts(?:$|\?)/,
  /\.(?:test|browser)\.[jt]sx?(?:$|\?)/,
  /\.worker\.[jt]s(?:$|\?)/,
  /\.logic\.ts(?:$|\?)/,
  /[\\/]src[\\/]perf[\\/]/,
  /[\\/]src[\\/]pwa[\\/]/,
] as const;

/** Whether the React Compiler compiles the module at `path`. */
export function isReactCompilerModule(path: string): boolean {
  return (
    REACT_COMPILER_INCLUDE.test(path) &&
    !REACT_COMPILER_EXCLUDE.some((pattern) => pattern.test(path))
  );
}
