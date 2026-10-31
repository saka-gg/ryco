/**
 * Which `@pierre/diffs` highlighter a thread tokenizes with. Kept free of
 * `@pierre/diffs` imports, so the chat route and the diff worker pool owner
 * can decide without loading the highlighter stack.
 */

export type SyntaxHighlighterType = "highlights" | "shiki-js";

/**
 * A module whose one function returns a SIMD vector (`i8x16.splat`,
 * `i8x16.popcnt`): the probe of `@pierre/diffs`' `canUseWASM`. Highlights'
 * lexers use SIMD, which engines before Safari 16.4 lack.
 */
const SIMD_PROBE_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
]);

/**
 * Whether this context may compile and instantiate WebAssembly with SIMD. The
 * global existing is not enough: a Content-Security-Policy without
 * `'wasm-unsafe-eval'` (the hosted Hub sends one) keeps the API and makes every
 * compile throw. Compiling the probe is synchronous and cheap, and a dedicated
 * worker gets the same policy from its script response, so the page's answer
 * holds for the workers.
 */
export function canCompileWebAssembly(
  webAssembly:
    | Pick<typeof WebAssembly, "Module" | "Instance">
    | null
    | undefined = globalThis.WebAssembly,
): boolean {
  if (typeof webAssembly?.Module !== "function" || typeof webAssembly.Instance !== "function") {
    return false;
  }
  try {
    const module = new webAssembly.Module(SIMD_PROBE_MODULE);
    return new webAssembly.Instance(module) instanceof webAssembly.Instance;
  } catch {
    return false;
  }
}

/**
 * Highlights' hand-written WASM lexers tokenize many times faster than Shiki
 * and never backtrack like Shiki's JS regex engine. Against Shiki's Oniguruma
 * engine, which the diff workers used before: a 470 KiB file 1,182 -> 80 ms,
 * 156 real diffs 1,236 -> 143 ms, peak RSS 425 -> 214 MiB (medians,
 * `scripts/perf/micro/syntax-highlight.ts`). Contexts that cannot compile
 * WebAssembly (Lockdown Mode, a CSP without `'wasm-unsafe-eval'`), or where a
 * WASM highlighter already failed to start, keep Shiki's JS engine: a WASM
 * pool there fails to initialize, and highlighting would fall back to the main
 * thread.
 */
export function resolveSyntaxHighlighter(input: {
  readonly canCompileWebAssembly: boolean;
  readonly wasmFailed: boolean;
}): SyntaxHighlighterType {
  return input.canCompileWebAssembly && !input.wasmFailed ? "highlights" : "shiki-js";
}

let pageCompilesWebAssembly: boolean | null = null;

/** {@link canCompileWebAssembly} for this page, probed once. */
export function pageCanCompileWebAssembly(): boolean {
  pageCompilesWebAssembly ??= canCompileWebAssembly();
  return pageCompilesWebAssembly;
}

/**
 * The page's main-thread highlighter (chat code blocks, the diff views'
 * plain-text placeholders). `@pierre/diffs` holds one highlighter type per
 * thread, fixed by its first caller, so every main-thread caller passes this.
 */
export function getMainThreadSyntaxHighlighter(): SyntaxHighlighterType {
  return resolveSyntaxHighlighter({
    canCompileWebAssembly: pageCanCompileWebAssembly(),
    wasmFailed: false,
  });
}
