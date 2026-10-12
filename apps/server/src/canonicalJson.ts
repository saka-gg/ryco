/**
 * Canonical JSON for digests: object keys sorted by code unit, `undefined` entries dropped,
 * non-finite numbers written as `null`, anything else that JSON cannot represent (functions,
 * symbols, bigints) written as `null`. Equal values always produce equal bytes, whatever their
 * key order, so a sha-256 over the text identifies the value.
 *
 * Shared by Agent Control plan digests, context handoff documents and fork request digests.
 * Changing the output changes every persisted digest: keep it byte-stable.
 */
import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function canonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (value && typeof value === "object") {
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).toSorted()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        result[key] = canonicalJsonValue(entry);
      }
    }
    return result;
  }
  return null;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

/** Lowercase hex sha-256 of the UTF-8 text. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
