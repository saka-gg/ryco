/**
 * An error's own words for the person using the app, or `fallback` when it
 * has none. Tagged RPC errors carry their message on a plain object too.
 */
export function errorMessageOr(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) return fallback;
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message : fallback;
}
