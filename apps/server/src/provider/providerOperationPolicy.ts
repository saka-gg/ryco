/**
 * Deadlines for provider operations, resolved once per ProviderService.
 *
 * Precedence per value: explicit overrides (tests, layer options), then the
 * operator environment, then the defaults below. Environment values must be
 * positive safe integers; anything else is ignored and reported so the caller
 * can log one warning.
 *
 * Pure module: no services, no I/O.
 *
 * @module providerOperationPolicy
 */
import type { ProviderDriverKind } from "@ryco/contracts";

export interface ProviderOperationTimeouts {
  readonly sessionStartMs: (driver: ProviderDriverKind | string) => number;
  readonly turnAcceptanceMs: number;
  /** Interrupt, stop, approval and user-input responses, goal sync. */
  readonly controlRequestMs: number;
  /** Silence on a live, running turn before a single "unresponsive" notice. */
  readonly unresponsiveAfterMs: number;
}

export const DEFAULT_SESSION_START_TIMEOUT_MS = 120_000;
/** The ACP registry driver may download its agent on first run. */
export const DEFAULT_REGISTRY_SESSION_START_TIMEOUT_MS = 300_000;
export const DEFAULT_TURN_ACCEPTANCE_TIMEOUT_MS = 90_000;
export const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_UNRESPONSIVE_AFTER_MS = 15 * 60_000;

export const PROVIDER_OPERATION_TIMEOUT_ENV = {
  sessionStartMs: "RYCO_PROVIDER_SESSION_START_TIMEOUT_MS",
  turnAcceptanceMs: "RYCO_PROVIDER_TURN_ACCEPT_TIMEOUT_MS",
  controlRequestMs: "RYCO_PROVIDER_CONTROL_TIMEOUT_MS",
  unresponsiveAfterMs: "RYCO_PROVIDER_UNRESPONSIVE_AFTER_MS",
} as const;

const REGISTRY_DRIVER = "acpRegistry";

export type ProviderOperationTimeoutOverrides = Partial<{
  readonly sessionStartMs: number;
  readonly turnAcceptanceMs: number;
  readonly controlRequestMs: number;
  readonly unresponsiveAfterMs: number;
}>;

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function resolveProviderOperationTimeouts(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly overrides?: ProviderOperationTimeoutOverrides | undefined;
}): ProviderOperationTimeouts & { readonly invalidEnv: ReadonlyArray<string> } {
  const invalidEnv: string[] = [];
  const read = (key: keyof typeof PROVIDER_OPERATION_TIMEOUT_ENV): number | undefined => {
    const override = input.overrides?.[key];
    if (override !== undefined && isPositiveSafeInteger(override)) return override;
    const name = PROVIDER_OPERATION_TIMEOUT_ENV[key];
    const raw = input.env[name]?.trim();
    if (raw === undefined || raw.length === 0) return undefined;
    const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!isPositiveSafeInteger(parsed)) {
      invalidEnv.push(name);
      return undefined;
    }
    return parsed;
  };

  const sessionStart = read("sessionStartMs");
  const turnAcceptanceMs = read("turnAcceptanceMs") ?? DEFAULT_TURN_ACCEPTANCE_TIMEOUT_MS;
  const controlRequestMs = read("controlRequestMs") ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS;
  const unresponsiveAfterMs = read("unresponsiveAfterMs") ?? DEFAULT_UNRESPONSIVE_AFTER_MS;

  return {
    // A configured start deadline applies to every driver.
    sessionStartMs: (driver) =>
      sessionStart ??
      (String(driver) === REGISTRY_DRIVER
        ? DEFAULT_REGISTRY_SESSION_START_TIMEOUT_MS
        : DEFAULT_SESSION_START_TIMEOUT_MS),
    turnAcceptanceMs,
    controlRequestMs,
    unresponsiveAfterMs,
    invalidEnv,
  };
}

export type ProviderStartPhase = "lock" | "admission" | "adapter";

export type ProviderTimedOperation =
  | "session.start"
  | "session.recover"
  | "turn.start"
  | "turn.interrupt"
  | "session.stop"
  | "request.respond"
  | "user-input.respond"
  | "goal.sync";

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

/** One user-facing sentence for a provider operation that hit its deadline. */
export function providerOperationTimeoutDetail(input: {
  readonly operation: ProviderTimedOperation;
  /** The instance display name, or its id. */
  readonly label: string;
  readonly timeoutMs: number;
  /** Where a session start was waiting when its deadline fired. */
  readonly startPhase?: ProviderStartPhase;
}): string {
  const label = `Provider '${input.label}'`;
  const s = formatSeconds(input.timeoutMs);
  switch (input.operation) {
    case "session.start":
      switch (input.startPhase) {
        case "lock":
          return `${label} could not start because a previous start for this thread is still shutting down (waited ${s}s). Try again shortly.`;
        case "admission":
          return `${label} is busy starting other sessions (waited ${s}s). Try again shortly.`;
        default:
          return `${label} did not finish starting within ${s}s. Ryco stopped waiting; send the message again to retry.`;
      }
    case "session.recover":
      return `${label} did not resume this thread within ${s}s.`;
    case "turn.start":
      return `${label} did not accept the turn within ${s}s. Ryco cancelled the request; send it again to retry.`;
    case "turn.interrupt":
      return `${label} did not respond to the interrupt within ${s}s.`;
    case "session.stop":
      return `${label} did not confirm the stop within ${s}s. Ryco will keep trying to stop it in the background.`;
    case "request.respond":
    case "user-input.respond":
      return `${label} did not acknowledge the response within ${s}s; it may or may not have been delivered.`;
    case "goal.sync":
      return `${label} did not confirm the goal change within ${s}s.`;
  }
}
