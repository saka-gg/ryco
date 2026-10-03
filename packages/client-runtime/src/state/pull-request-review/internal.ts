import { DateTime, Option } from "effect";

/**
 * Epoch milliseconds for the timestamp shapes the source-control contracts use
 * (`DateTimeUtc`, `Option<DateTimeUtc>`), or null when absent.
 */
export function epochMillis(
  value: DateTime.DateTime | Option.Option<DateTime.DateTime> | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (Option.isOption(value)) {
    return Option.isSome(value) ? DateTime.toEpochMillis(value.value) : null;
  }
  return DateTime.toEpochMillis(value);
}

/** The value of an optional contract field that may be an `Option`, a bare value, or absent. */
export function optionalValue<T>(value: Option.Option<T> | T | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  if (Option.isOption(value)) return Option.getOrNull(value as Option.Option<T>);
  return value as T;
}

export function sameLogin(left: string | null | undefined, right: string | null | undefined) {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.toLowerCase() === right.toLowerCase()
  );
}
