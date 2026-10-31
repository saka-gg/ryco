/**
 * Identifies a provider instance configuration for a native fork: a fork accepted under one
 * configuration hands off instead of forking natively under another. Kept apart from
 * `nativeFork.ts`, which loads only with the first native fork, because acceptance needs it on
 * every fork.
 *
 * Pure.
 */
import type { ProviderInstanceConfig } from "@ryco/contracts";

import { canonicalJson, sha256Hex } from "../canonicalJson.ts";

/** Identifies an instance configuration; a fork accepted under another one hands off instead. */
export function nativeForkConfigFingerprint(config: ProviderInstanceConfig): string {
  return sha256Hex(canonicalJson(config));
}
