/**
 * Guards for reading untrusted `unknown` values (parsed JSON, stored state, IPC messages) as
 * objects. Two families, which differ only in how they treat arrays:
 *
 * - `isRecord` / `asRecord`: a non-null object that is NOT an array. Use these to read a value as
 *   a keyed record; an array there is malformed input.
 * - `isObjectLike` / `asObjectLike`: any non-null object, arrays INCLUDED. These exist for readers
 *   that only need property access to be safe (`value.field` on an array is just `undefined`) and
 *   whose callers already accept arrays; switching those to `isRecord` would change which inputs
 *   they reject.
 *
 * Both families accept class instances, `Date`, `Map` and other exotic objects (no plain-object
 * prototype check), and reject functions and every primitive, `null` included.
 */

/** A non-null, non-array object. Class instances pass; functions and primitives do not. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as a record when {@link isRecord} holds, otherwise `undefined`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * A non-null object, arrays included. Prefer {@link isRecord}; this keeps the behavior of readers
 * that already let arrays through.
 */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `value` as a record when {@link isObjectLike} holds (arrays included), otherwise `undefined`. */
export function asObjectLike(value: unknown): Record<string, unknown> | undefined {
  return isObjectLike(value) ? value : undefined;
}
