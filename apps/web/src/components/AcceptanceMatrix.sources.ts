/**
 * Raw source of every browser suite plus the supporting node/pwa suites the
 * acceptance matrix maps, loaded once at build time with `?raw` (the files are
 * read as text, never executed).
 *
 * This lives in its own module on purpose. `import.meta.glob` excludes the
 * module that calls it, so a glob written inside `AcceptanceMatrix.browser.tsx`
 * would omit the matrix suite's own source — and the matrix's `AM` cells, which
 * point at tests in that very file, could then never be verified. Calling the
 * glob from here keeps `AcceptanceMatrix.browser.tsx` in the result set.
 *
 * Keys are paths relative to this file (same directory as the matrix suite):
 * `./ChatView.PhoneComposer.browser.tsx`, `./mobile/MobileSheet.browser.tsx`,
 * `../hostedHub/state.test.ts`, `../pwa/lifecycle.test.ts`, and so on.
 */
export const SUITE_SOURCES = import.meta.glob(
  ["./**/*.browser.tsx", "../hostedHub/**/*.test.ts", "../pwa/**/*.test.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
