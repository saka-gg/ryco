/**
 * startupFailure - Tells deterministic startup failures from transient ones.
 *
 * A supervisor (the desktop shell, a service manager) restarts a backend that
 * exits. For failures that will repeat on every attempt - a database written by
 * a newer binary, invalid configuration - the backend exits with
 * `EX_CONFIG` (78) and reports a structured `fatal` frame instead, so the
 * supervisor can stop and show the reason. Everything else keeps exit code 1.
 *
 * @module startupFailure
 */
import { DESKTOP_BACKEND_FATAL_EXIT_CODE } from "@ryco/shared/desktopResourceTelemetry";

import { writeDesktopLifecycleFrame } from "./desktopLifecycle.ts";

export const FATAL_STARTUP_EXIT_CODE = DESKTOP_BACKEND_FATAL_EXIT_CODE;
export const DEFAULT_FAILURE_EXIT_CODE = 1;

export type FatalStartupErrorCode =
  | "database-schema-newer"
  | "invalid-config"
  | "bootstrap-envelope-missing";

const tagOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { readonly _tag?: unknown })._tag : null;

/** The fatal code for a deterministic startup failure, or null when a retry may help. */
export function classifyFatalStartupError(error: unknown): FatalStartupErrorCode | null {
  const tag = tagOf(error);
  // `Migrations.ts` fails closed with `BadState` only when the database holds
  // migrations newer than this binary knows: a downgrade, which never heals.
  if (tag === "MigrationError" && (error as { readonly kind?: unknown }).kind === "BadState") {
    return "database-schema-newer";
  }
  if (tag === "ConfigError") return "invalid-config";
  // An explicit bootstrap fd without an envelope: the launcher is gone or
  // stalled, and a restart by that same launcher would wait the same way.
  if (tag === "BootstrapEnvelopeUnavailableError") return "bootstrap-envelope-missing";
  return null;
}

/** Message of an error-like value, for a one-line report. */
export function failureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}

/**
 * Reports a deterministic startup failure on the desktop lifecycle channel
 * (a no-op outside desktop mode) and returns the exit code to use.
 */
export function reportFatalStartupFailure(code: FatalStartupErrorCode, error: unknown): number {
  writeDesktopLifecycleFrame({ type: "fatal", code, message: failureMessage(error) });
  return FATAL_STARTUP_EXIT_CODE;
}
