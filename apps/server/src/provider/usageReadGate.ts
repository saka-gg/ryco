/**
 * Usage read gate — keeps the last good usage read of one provider instance and backs off when
 * the provider throttles or fails usage reads.
 *
 * Without it, one throttled (429) read dropped the limits from the snapshot, and an adopted
 * snapshot without limits is never re-read on its own, so usage stayed hidden until the next full
 * probe. A throttled or failed read now re-serves the last good numbers, marked `stale` and still
 * dated by their own read (`observedAt`), and no request is sent until the cooldown ends.
 * Re-served numbers are bounded: windows past their reset are left out, since those numbers are
 * known to be wrong, and nothing older than `maxStaleAgeMs` is served.
 *
 * Each driver instance owns its gate, so the state is per instance and never global. Reads are
 * keyed on the account (`usageAccountKey`, a SHA-256 digest held only in memory): another account
 * starts over, so one account's numbers are never served for another, even during a cooldown.
 *
 * Imported only by driver chunks, never by the server boot path.
 *
 * @module provider/usageReadGate
 */
import { createHash } from "node:crypto";

import type { ServerProviderRateLimits } from "@ryco/contracts";
import { Clock, Effect, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";

export type UsageReadOutcome =
  /** A 2xx response with usage windows. */
  | { readonly _tag: "Read"; readonly rateLimits: ServerProviderRateLimits }
  /** A 429; `retryAfterMs` from its `Retry-After`. */
  | { readonly _tag: "Throttled"; readonly retryAfterMs: number | undefined }
  /** A timeout, network error, 408, 5xx or unparsable body: the numbers may still hold. */
  | { readonly _tag: "Failed" }
  /** A 401/403, expired token, 2xx without windows or unsupported credential: no usage. */
  | { readonly _tag: "Cleared" };

export interface UsageReadPlan {
  /** `usageAccountKey(...)` of the credential the read uses; memory only. */
  readonly accountKey: string;
  /** The only network step. */
  readonly fetch: Effect.Effect<UsageReadOutcome>;
}

export interface UsageReadGate {
  /**
   * The limits to show for one read. `plan` reads local credentials only; undefined means no
   * applicable login, which clears the state.
   */
  readonly read: (
    plan: Effect.Effect<UsageReadPlan | undefined>,
  ) => Effect.Effect<ServerProviderRateLimits | undefined>;
}

export interface UsageReadGateOptions {
  /** Cooldown after a 429 without a usable `Retry-After`. */
  readonly defaultCooldownMs?: number;
  /** Upper bound on a 429 cooldown, so a huge `Retry-After` cannot freeze usage for hours. */
  readonly maxCooldownMs?: number;
  /** Cooldown after a failed read. */
  readonly failureCooldownMs?: number;
  /** How old re-served numbers may be; older ones are not shown at all. */
  readonly maxStaleAgeMs?: number;
}

const DEFAULT_THROTTLE_COOLDOWN_MS = 5 * 60_000;
const MIN_THROTTLE_COOLDOWN_MS = 60_000;
const MAX_THROTTLE_COOLDOWN_MS = 15 * 60_000;
const FAILURE_COOLDOWN_MS = 60_000;
const MAX_STALE_AGE_MS = 60 * 60_000;
// A credential this close to its expiry counts as expired: the request would race the expiry.
const CREDENTIAL_EXPIRY_SKEW_MS = 60_000;

const FAILED: UsageReadOutcome = { _tag: "Failed" };
const CLEARED: UsageReadOutcome = { _tag: "Cleared" };

/** Free text on the wire (`ServerProviderRateLimits.staleReason`); clients word known values. */
type StaleReason = "rateLimited" | "unreachable";

interface UsageReadState {
  readonly accountKey: string;
  readonly lastGood:
    | { readonly rateLimits: ServerProviderRateLimits; readonly observedAtMs: number }
    | undefined;
  readonly cooldown: { readonly untilMs: number; readonly reason: StaleReason } | undefined;
}

/** A digest of the parts that identify an account's credential; never the credential itself. */
export function usageAccountKey(...parts: ReadonlyArray<string>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * A `Retry-After` value as a positive delay: delta seconds (`"120"`) or an HTTP date. Undefined
 * when it is absent, malformed, zero or already past, so the caller falls back to its default.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/u.test(trimmed)) {
    const delayMs = Number(trimmed) * 1000;
    return delayMs > 0 && Number.isSafeInteger(delayMs) ? delayMs : undefined;
  }
  // An HTTP date starts with a weekday name; this keeps `Date.parse` from reading other number
  // spellings (`1.5`, `+10`) as dates.
  if (/^[+\-.\d]/u.test(trimmed)) return undefined;
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) && dateMs > nowMs ? dateMs - nowMs : undefined;
}

/**
 * A credential's expiry as a provider CLI stores it (`expiresAt`, `expires_at`), in epoch ms: an
 * ISO date, or epoch seconds or milliseconds. Undefined when it is absent or unreadable.
 */
export function parseCredentialExpiresAtMs(value: unknown): number | undefined {
  const epochMs = (epoch: number) => (epoch < 1_000_000_000_000 ? epoch * 1000 : epoch);
  if (typeof value === "number") return Number.isFinite(value) ? epochMs(value) : undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return epochMs(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The usage read of a credential the provider's CLI owns and renews: `request`, unless the
 * credential has expired (`expiresAtMs`, undefined when unknown) or expires within a minute. Then
 * usage is cleared without a request; Ryco never renews the CLI's credential itself.
 */
export const credentialUsageReadPlan = (
  accountKey: string,
  expiresAtMs: number | undefined,
  request: Effect.Effect<UsageReadOutcome>,
): Effect.Effect<UsageReadPlan> =>
  Effect.map(Clock.currentTimeMillis, (nowMs) => ({
    accountKey,
    fetch:
      expiresAtMs !== undefined && nowMs > expiresAtMs - CREDENTIAL_EXPIRY_SKEW_MS
        ? Effect.succeed(CLEARED)
        : request,
  }));

/** The outcome of a non-2xx usage response. */
export function usageOutcomeForStatus(
  status: number,
  retryAfter: string | null,
  nowMs: number,
): UsageReadOutcome {
  if (status === 429) {
    return { _tag: "Throttled", retryAfterMs: parseRetryAfterMs(retryAfter, nowMs) };
  }
  // A timeout or server error may pass; any other refusal (401, 403, 404) will not.
  if (status === 408 || status >= 500 || status < 400) return FAILED;
  return CLEARED;
}

/**
 * One usage request as an outcome; never fails. `parse` turns a 2xx JSON body read at `nowMs`
 * into limits, or undefined when it reports none.
 */
export const requestUsage = (
  send: () => Promise<Response>,
  parse: (body: unknown, nowMs: number) => ServerProviderRateLimits | undefined,
): Effect.Effect<UsageReadOutcome> =>
  Effect.gen(function* () {
    const { response, body } = yield* Effect.tryPromise(async () => {
      const response = await send();
      return { response, body: response.ok ? ((await response.json()) as unknown) : undefined };
    });
    const nowMs = yield* Clock.currentTimeMillis;
    if (!response.ok) {
      return usageOutcomeForStatus(response.status, response.headers.get("retry-after"), nowMs);
    }
    const rateLimits = yield* Effect.try(() => parse(body, nowMs));
    return rateLimits ? ({ _tag: "Read", rateLimits } as const) : CLEARED;
  }).pipe(Effect.orElseSucceed(() => FAILED));

/**
 * The last good read re-served, keeping its `observedAt`, or undefined when it is too old or every
 * window has reset. A window past its reset is left out: its numbers are known to be wrong.
 */
function staleRateLimits(
  lastGood: UsageReadState["lastGood"],
  reason: StaleReason,
  nowMs: number,
  maxStaleAgeMs: number,
): ServerProviderRateLimits | undefined {
  if (!lastGood || nowMs - lastGood.observedAtMs > maxStaleAgeMs) return undefined;
  const current = (window: { readonly resetsAt?: number | undefined } | undefined) =>
    window !== undefined && (window.resetsAt === undefined || window.resetsAt * 1000 > nowMs);
  const { primary, secondary, tertiary, windows, ...rest } = lastGood.rateLimits;
  const currentWindows = windows?.filter(current) ?? [];
  if (currentWindows.length === 0 && ![primary, secondary, tertiary].some(current)) {
    return undefined;
  }
  return {
    ...rest,
    ...(current(primary) ? { primary } : {}),
    ...(current(secondary) ? { secondary } : {}),
    ...(current(tertiary) ? { tertiary } : {}),
    ...(currentWindows.length > 0 ? { windows: currentWindows } : {}),
    stale: true,
    staleReason: reason,
  };
}

export const makeUsageReadGate = Effect.fn("makeUsageReadGate")(function* (
  options: UsageReadGateOptions = {},
) {
  const defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_THROTTLE_COOLDOWN_MS;
  const maxCooldownMs = options.maxCooldownMs ?? MAX_THROTTLE_COOLDOWN_MS;
  const failureCooldownMs = options.failureCooldownMs ?? FAILURE_COOLDOWN_MS;
  const maxStaleAgeMs = options.maxStaleAgeMs ?? MAX_STALE_AGE_MS;
  const stateRef = yield* Ref.make<UsageReadState | undefined>(undefined);
  // One read at a time, so concurrent callers in a cooldown never both reach the provider.
  const semaphore = yield* Semaphore.make(1);

  // A missing or zero `Retry-After` gets the default, then the result is kept within bounds.
  const throttleCooldownMs = (retryAfterMs: number | undefined) =>
    Math.min(
      Math.max(
        retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : defaultCooldownMs,
        MIN_THROTTLE_COOLDOWN_MS,
      ),
      maxCooldownMs,
    );

  const read: UsageReadGate["read"] = (plan) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const usageRead = yield* plan;
        if (!usageRead) {
          yield* Ref.set(stateRef, undefined);
          return undefined;
        }
        // Another account starts over: no numbers or cooldown carry across accounts.
        const previous = yield* Ref.get(stateRef);
        const state: UsageReadState =
          previous?.accountKey === usageRead.accountKey
            ? previous
            : { accountKey: usageRead.accountKey, lastGood: undefined, cooldown: undefined };
        const startedAtMs = yield* Clock.currentTimeMillis;
        if (state.cooldown && startedAtMs < state.cooldown.untilMs) {
          return staleRateLimits(state.lastGood, state.cooldown.reason, startedAtMs, maxStaleAgeMs);
        }

        const outcome = yield* usageRead.fetch;
        const nowMs = yield* Clock.currentTimeMillis;
        switch (outcome._tag) {
          case "Read": {
            const { stale: _stale, staleReason: _staleReason, ...fresh } = outcome.rateLimits;
            const rateLimits = { ...fresh, observedAt: new Date(nowMs).toISOString() };
            yield* Ref.set(stateRef, {
              accountKey: state.accountKey,
              lastGood: { rateLimits, observedAtMs: nowMs },
              cooldown: undefined,
            });
            return rateLimits;
          }
          case "Throttled":
          case "Failed": {
            const cooldown =
              outcome._tag === "Throttled"
                ? {
                    untilMs: nowMs + throttleCooldownMs(outcome.retryAfterMs),
                    reason: "rateLimited" as const,
                  }
                : { untilMs: nowMs + failureCooldownMs, reason: "unreachable" as const };
            yield* Ref.set(stateRef, { ...state, cooldown });
            return staleRateLimits(state.lastGood, cooldown.reason, nowMs, maxStaleAgeMs);
          }
          case "Cleared": {
            yield* Ref.set(stateRef, {
              accountKey: state.accountKey,
              lastGood: undefined,
              cooldown: undefined,
            });
            return undefined;
          }
        }
      }),
    );

  return { read } satisfies UsageReadGate;
});
