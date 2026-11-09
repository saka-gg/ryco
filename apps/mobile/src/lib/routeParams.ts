/** A route param as navigation hands it over. */
export type RouteParam = string | number | readonly string[] | undefined;

/**
 * A route param as one string. Deep links can repeat a param (the first one
 * wins) and a typed navigation may pass a number; blank is no value.
 */
export function firstRouteParam(value: RouteParam): string | null {
  const raw = typeof value === "number" ? String(value) : Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
