/**
 * The CSS Custom Highlight API: named highlights painted over DOM ranges
 * without touching the DOM, so React keeps owning the text it rendered.
 * Each highlight is styled by a `::highlight(<name>)` rule.
 */

export function isCssHighlightSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof (CSS as unknown as { highlights?: unknown }).highlights !== "undefined" &&
    typeof globalThis.Highlight !== "undefined"
  );
}

/** The document's highlight registry, or null where the API is missing. */
export function cssHighlightRegistry(): Map<string, Highlight> | null {
  return isCssHighlightSupported()
    ? (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
    : null;
}
