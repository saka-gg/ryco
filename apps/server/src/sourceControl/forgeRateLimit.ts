/**
 * One shared pause per forge host and account after a rate limit.
 *
 * When a forge says "rate limited", every background read for that host waits
 * until the time the forge named (`Retry-After` or a spent quota's reset), or a
 * guessed pause: 30 s, doubling per consecutive episode up to 15 min. A refused
 * read fails at once with a typed `SourceControlProviderError` (reason
 * "rate-limited", `retryAt`) and starts no CLI child and no HTTP request. The
 * interactive lane (what a user asked for) always passes; a rate limit it hits
 * still pauses background reads.
 *
 * There are two checks, as in Synara's read gate: the provider-level guard
 * before the call (`guardForgeCall`, wrapped around every loaded provider by
 * the registry), and the admission after the forge CLI permit
 * (`forgeChildAdmission`, VcsProcess's `admit`), so a read that queued in the
 * background forge pool before the limit hit does not fire.
 *
 * Generation leases keep the pause honest: a failure of a request sent before
 * the current pause began, or sent during it, never escalates it. Refused
 * requests are never recorded.
 *
 * A rate-limited error from a guarded call usually carries `retryAt`. It can
 * be missing (a call with neither a repository context nor a host, a late
 * answer to a request sent before a pause that already ended), so a consumer
 * scheduling its next read falls back to its own delay.
 *
 * Loaded with the forge providers (an `import()` in the registry and static
 * imports from the lazily loaded CLI clients); never on the boot path.
 */
import { Clock, Context, Effect, Metric, Schema } from "effect";
import { SourceControlProviderError, SourceControlProviderKind } from "@ryco/contracts";
import { resolveChangeRequestPresentationForKind } from "@ryco/shared/sourceControl";

import { ProcessLaneRef, type ProcessLane } from "../processGovernor.ts";
import { FORGE_MAX_EXPLICIT_PAUSE_MS } from "./forgeHttpRateLimit.ts";
import {
  FORGE_REQUEST_PAUSED_TAG,
  findForgeRequestRefusal,
  isForgeRequestRefusedWhilePaused,
} from "./forgeRequestPaused.ts";
import type {
  SourceControlProviderContext,
  SourceControlProviderShape,
} from "./SourceControlProvider.ts";

/** The first guessed pause (T3 `SourceControlRateLimit` FALLBACK_COOLDOWN). */
export const FORGE_RATE_LIMIT_FALLBACK_MS = 30_000;
/** Guessed pauses double per consecutive episode up to this. */
export const FORGE_RATE_LIMIT_MAX_FALLBACK_MS = 15 * 60_000;
/** Keys remembered; the oldest ones without a running pause go first. */
export const FORGE_RATE_LIMIT_CAPACITY = 256;

/**
 * Who a pause applies to. The port is not part of it: an SSH and an HTTPS
 * remote of one host share its limits. Every Azure DevOps organisation on
 * `dev.azure.com` shares one pause.
 */
export interface ForgeRateLimitKey {
  readonly provider: SourceControlProviderKind;
  /** Lower-cased hostname, e.g. "github.com", "ghe.corp.example". */
  readonly host: string;
  /** "" = the identity the host's CLI or token uses now; otherwise a credential fingerprint. */
  readonly account: string;
}

/**
 * What a forge call goes to: a detected repository context, or, for calls
 * without one (an account-wide search), the provider and host explicitly.
 */
export type ForgeRateLimitTarget =
  | SourceControlProviderContext
  | { readonly provider: SourceControlProviderKind; readonly host: string };

/** Taken right before a request is sent; says which pause the request knew of. */
export interface ForgeRateLimitLease {
  readonly key: ForgeRateLimitKey;
  readonly id: string;
  readonly generation: number;
}

export interface ForgeRateLimitPause {
  readonly key: ForgeRateLimitKey;
  /** Epoch ms when background reads may go again. */
  readonly retryAt: number;
  /** The forge named the time (headers); false for the guessed pause. */
  readonly explicit: boolean;
  /** Consecutive episodes without a success in between, this one included. */
  readonly attempt: number;
}

interface Entry {
  readonly key: ForgeRateLimitKey;
  attempt: number;
  generation: number;
  retryAt: number;
  explicit: boolean;
}

function keyId(key: ForgeRateLimitKey): string {
  return `${key.provider}\u0000${key.host}\u0000${key.account}`;
}

function guessedPauseMs(attempt: number): number {
  return Math.min(
    FORGE_RATE_LIMIT_FALLBACK_MS * 2 ** Math.max(0, attempt - 1),
    FORGE_RATE_LIMIT_MAX_FALLBACK_MS,
  );
}

/**
 * The pause state. Synchronous and single-threaded (the JS event loop), so a
 * check and a lease taken without yielding in between see one state. Every
 * method takes the time, so Effect's clock (and TestClock) drives it.
 */
export class ForgeRateLimitStore {
  private readonly entries = new Map<string, Entry>();
  private readonly capacity: number;
  /** Process-wide, so a generation is never reused after an entry was evicted. */
  private lastGeneration = 0;

  constructor(options?: { readonly capacity?: number }) {
    this.capacity = options?.capacity ?? FORGE_RATE_LIMIT_CAPACITY;
  }

  /** The running pause for `key`, whatever the lane; null when there is none. */
  pause(key: ForgeRateLimitKey, nowMs: number): ForgeRateLimitPause | null {
    const entry = this.entries.get(keyId(key));
    return entry !== undefined && entry.retryAt > nowMs ? pauseOf(entry) : null;
  }

  /**
   * Until when a call in `lane` must wait (epoch ms), or null when it may go.
   * Background: the running pause's end. Interactive: always null, also when
   * a quota is spent; the forge answers it, and that answer extends the pause
   * for background reads.
   */
  pausedUntil(key: ForgeRateLimitKey, nowMs: number, lane: ProcessLane): number | null {
    if (lane === "interactive") return null;
    return this.pause(key, nowMs)?.retryAt ?? null;
  }

  lease(key: ForgeRateLimitKey): ForgeRateLimitLease {
    const id = keyId(key);
    return { key, id, generation: this.entries.get(id)?.generation ?? 0 };
  }

  /**
   * A forge answered "rate limited" to the leased request. `retryAt` is the
   * time the forge named, if any. Returns the pause when this call started or
   * extended one.
   */
  recordRateLimit(
    lease: ForgeRateLimitLease,
    nowMs: number,
    retryAt?: number,
  ): { readonly started: boolean; readonly pause: ForgeRateLimitPause | null } {
    const named =
      retryAt !== undefined && Number.isFinite(retryAt) && retryAt > nowMs
        ? Math.ceil(Math.min(retryAt, nowMs + FORGE_MAX_EXPLICIT_PAUSE_MS))
        : undefined;
    const entry = this.entries.get(lease.id);
    const sentBeforeThisPause = entry !== undefined && entry.generation > lease.generation;
    const pauseRunning = entry !== undefined && entry.retryAt > nowMs;
    if (entry !== undefined && (sentBeforeThisPause || pauseRunning)) {
      // Never escalate; adopt a later time the forge named.
      if (named === undefined || named <= entry.retryAt) return { started: false, pause: null };
      entry.retryAt = named;
      entry.explicit = true;
      this.touch(lease.id, entry);
      return { started: false, pause: pauseOf(entry) };
    }
    const attempt = (entry?.attempt ?? 0) + 1;
    const next: Entry = {
      key: lease.key,
      attempt,
      generation: ++this.lastGeneration,
      retryAt: named ?? nowMs + guessedPauseMs(attempt),
      explicit: named !== undefined,
    };
    this.touch(lease.id, next);
    this.evictIdle(nowMs);
    return { started: true, pause: pauseOf(next) };
  }

  /**
   * The leased request went through. A success with a stale lease is ignored.
   * A guessed pause ends early (the forge accepted a request); one the forge
   * timed runs to its end.
   */
  recordSuccess(lease: ForgeRateLimitLease, nowMs: number): void {
    const entry = this.entries.get(lease.id);
    if (entry === undefined || entry.generation !== lease.generation) return;
    if (entry.explicit && entry.retryAt > nowMs) return;
    entry.attempt = 0;
    entry.retryAt = 0;
    entry.explicit = false;
  }

  activePauses(nowMs: number): ReadonlyArray<ForgeRateLimitPause> {
    return [...this.entries.values()].filter((entry) => entry.retryAt > nowMs).map(pauseOf);
  }

  private touch(id: string, entry: Entry): void {
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  private evictIdle(nowMs: number): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.capacity) return;
      if (entry.retryAt <= nowMs) this.entries.delete(id);
    }
  }
}

function pauseOf(entry: Entry): ForgeRateLimitPause {
  return {
    key: entry.key,
    retryAt: entry.retryAt,
    explicit: entry.explicit,
    attempt: entry.attempt,
  };
}

/** The process-wide store (a Reference's default is made once). Tests provide their own. */
export const ForgeRateLimits = Context.Reference<ForgeRateLimitStore>(
  "ryco/sourceControl/ForgeRateLimits",
  { defaultValue: () => new ForgeRateLimitStore() },
);

/** The key of the forge call the current fiber makes; set by the guard, read by admission. */
export const ForgeRateLimitScope = Context.Reference<ForgeRateLimitKey | null>(
  "ryco/sourceControl/ForgeRateLimitScope",
  { defaultValue: () => null },
);

/**
 * A forge child refused after taking its permit, because its host was paused
 * meanwhile. Internal, never on the wire: the CLI normalizers turn it into
 * their client error.
 */
export class ForgeRequestPausedError extends Schema.TaggedError<ForgeRequestPausedError>()(
  FORGE_REQUEST_PAUSED_TAG,
  {
    provider: SourceControlProviderKind,
    host: Schema.String,
    retryAt: Schema.Number,
  },
) {
  override get message(): string {
    return `${forgeRequestsPausedDetail(this.provider)} Requests to ${this.host} resume at ${new Date(this.retryAt).toISOString()}.`;
  }
}

const isForgeRequestPausedError = Schema.is(ForgeRequestPausedError);

/**
 * The refusal behind a failed forge child, or null. VcsProcess reports a
 * failed `admit` as a `VcsProcessSpawnError` whose `cause` is the refusal.
 */
export function forgeRequestPausedRefusal(error: unknown): ForgeRequestPausedError | null {
  const refusal = findForgeRequestRefusal(error);
  return isForgeRequestPausedError(refusal) ? refusal : null;
}

/**
 * The detail of a refused call. It keeps the words "rate limit", so web builds
 * from before typed reasons still show their rate-limit copy.
 */
export function forgeRequestsPausedDetail(provider: SourceControlProviderKind): string {
  return `${resolveChangeRequestPresentationForKind(provider).providerName} requests are paused after a rate limit.`;
}

/** The typed part of a forge client error for a child refused by admission. */
export function forgeRequestPausedFailure(error: ForgeRequestPausedError): {
  readonly detail: string;
  readonly failureKind: "rate-limited";
  readonly retryAt: number;
} {
  return {
    detail: forgeRequestsPausedDetail(error.provider),
    failureKind: "rate-limited",
    retryAt: error.retryAt,
  };
}

// scp-like remotes: `[user@]host:path`.
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):/u;

/** The lower-cased hostname of a URL, a bare `host[:port]`, or an scp-like remote. */
function hostnameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!trimmed.includes("://") && !trimmed.startsWith("[")) {
    const scp = SCP_REMOTE.exec(trimmed);
    if (scp !== null && !/^\d+$/u.test(trimmed.slice(scp[0].length).split("/")[0] ?? "")) {
      return scp[1]!.toLowerCase();
    }
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname === "" ? null : url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isContextTarget(target: ForgeRateLimitTarget): target is SourceControlProviderContext {
  return "remoteUrl" in target;
}

/** A detected repository's forge host: its provider's base URL, else its remote URL. */
function contextHost(context: SourceControlProviderContext): string | null {
  return hostnameOf(context.provider?.baseUrl) ?? hostnameOf(context.remoteUrl);
}

/**
 * The pause key for a forge call; null for a target with no recognised forge
 * or host (such calls are never paused).
 */
export function forgeRateLimitKeyFor(
  target: ForgeRateLimitTarget,
  account = "",
): ForgeRateLimitKey | null {
  const provider = isContextTarget(target) ? target.provider.kind : target.provider;
  if (provider === "unknown") return null;
  const host = isContextTarget(target) ? contextHost(target) : hostnameOf(target.host);
  return host === null ? null : { provider, host, account };
}

const refusedTotal = Metric.counter("ryco_forge_rate_limit_refused_total", {
  description:
    "Background forge calls refused without contacting the forge while its host was paused after a rate limit.",
});

const pausesTotal = Metric.counter("ryco_forge_rate_limit_pauses_total", {
  description: "Rate-limit pauses started, by provider and by who set the end (forge or fallback).",
});

const countRefused = (key: ForgeRateLimitKey) =>
  Metric.update(Metric.withAttributes(refusedTotal, { provider: key.provider }), 1);

function pausedError(
  key: ForgeRateLimitKey,
  operation: string,
  retryAt: number,
): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: key.provider,
    operation,
    detail: forgeRequestsPausedDetail(key.provider),
    reason: "rate-limited",
    retryAt: Math.ceil(retryAt),
    cause: new ForgeRequestPausedError({ provider: key.provider, host: key.host, retryAt }),
  });
}

const isSourceControlProviderError = Schema.is(SourceControlProviderError);

function withRetryAt(error: SourceControlProviderError, retryAt: number) {
  return new SourceControlProviderError({
    provider: error.provider,
    operation: error.operation,
    detail: error.detail,
    ...(error.reason !== undefined ? { reason: error.reason } : {}),
    retryAt: Math.ceil(retryAt),
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  });
}

/**
 * Learns from a failed forge call. A rate limit the forge reported starts or
 * extends the pause; the error goes back with the pause's end when the forge
 * named none (or a past one), so a rate-limited error the caller sees has a
 * time whenever a pause is running. Refusals and other failures record nothing.
 */
const learnFromFailure = (
  store: ForgeRateLimitStore,
  key: ForgeRateLimitKey,
  lease: ForgeRateLimitLease,
  error: SourceControlProviderError,
) =>
  Effect.gen(function* () {
    if (error.reason !== "rate-limited" || isForgeRequestRefusedWhilePaused(error)) {
      return yield* Effect.fail(error);
    }
    // The call may have taken a while (gh's 30 s timeout, paginated reads): time it now.
    const nowMs = yield* Clock.currentTimeMillis;
    const { started, pause } = store.recordRateLimit(lease, nowMs, error.retryAt);
    if (started && pause !== null) {
      const source = pause.explicit ? "forge" : "fallback";
      yield* Metric.update(
        Metric.withAttributes(pausesTotal, { provider: key.provider, source }),
        1,
      );
      yield* Effect.logWarning("Pausing background forge reads after a rate limit", {
        provider: key.provider,
        host: key.host,
        retryAt: new Date(pause.retryAt).toISOString(),
        attempt: pause.attempt,
        source,
      });
    }
    const running = store.pause(key, nowMs);
    const namedFuture = error.retryAt !== undefined && error.retryAt > nowMs;
    if (!namedFuture && running !== null && isSourceControlProviderError(error)) {
      return yield* Effect.fail(withRetryAt(error, running.retryAt));
    }
    return yield* Effect.fail(error);
  });

/**
 * The provider-level gate around one forge call to `key`: refuses a
 * background call while the host is paused (before any provider code runs),
 * lets the call's forge children find `key` (`ForgeRateLimitScope`), and
 * learns from the outcome.
 */
export const guardForgeCall = <A, R>(
  key: ForgeRateLimitKey,
  operation: string,
  call: () => Effect.Effect<A, SourceControlProviderError, R>,
): Effect.Effect<A, SourceControlProviderError, R> =>
  Effect.gen(function* () {
    const store = yield* ForgeRateLimits;
    const lane = yield* ProcessLaneRef;
    const pausedUntil = store.pausedUntil(key, yield* Clock.currentTimeMillis, lane);
    if (pausedUntil !== null) {
      yield* countRefused(key);
      return yield* Effect.fail(pausedError(key, operation, pausedUntil));
    }
    // No yield between the check and the lease: both see the same pause.
    const lease = store.lease(key);
    return yield* call().pipe(
      Effect.provideService(ForgeRateLimitScope, key),
      Effect.tap(() =>
        Effect.map(Clock.currentTimeMillis, (nowMs) => store.recordSuccess(lease, nowMs)),
      ),
      Effect.catch((error) => learnFromFailure(store, key, lease, error)),
    );
  });

/**
 * VcsProcess's `admit` for forge CLI children: after the forge permit, before
 * the spawn. A background child of a guarded call whose host was paused while
 * it queued fails with `ForgeRequestPausedError` instead of running.
 */
export const forgeChildAdmission: Effect.Effect<void, ForgeRequestPausedError> = Effect.gen(
  function* () {
    const key = yield* ForgeRateLimitScope;
    if (key === null) return;
    const lane = yield* ProcessLaneRef;
    const store = yield* ForgeRateLimits;
    const pausedUntil = store.pausedUntil(key, yield* Clock.currentTimeMillis, lane);
    if (pausedUntil === null) return;
    yield* countRefused(key);
    return yield* new ForgeRequestPausedError({
      provider: key.provider,
      host: key.host,
      retryAt: pausedUntil,
    });
  },
);

/**
 * Until when a forge call to `target` from the current lane must wait (epoch
 * ms), or null. For callers that want to skip a tick instead of being refused;
 * code on the boot path reaches it through the registry's `forgePausedUntil`.
 */
export const pausedUntilFor = (target: ForgeRateLimitTarget): Effect.Effect<number | null> =>
  Effect.gen(function* () {
    const key = forgeRateLimitKeyFor(target);
    if (key === null) return null;
    const store = yield* ForgeRateLimits;
    return store.pausedUntil(key, yield* Clock.currentTimeMillis, yield* ProcessLaneRef);
  });

/** Where a provider call goes: its `context`, else an explicit `host` (calls without a repository). */
function callHost(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const { context, host } = input as {
    readonly context?: SourceControlProviderContext;
    readonly host?: unknown;
  };
  if (typeof context === "object" && context !== null) return contextHost(context);
  return hostnameOf(host);
}

/**
 * Guards every method of a loaded provider. The key comes from each call's
 * `input.context` (the registry binds the detected one), or from an explicit
 * `input.host` for calls without a repository; calls with neither are not
 * guarded. Methods that take neither must take `host` to be paused.
 */
export function withForgeRateLimitGuards(
  provider: SourceControlProviderShape,
): SourceControlProviderShape {
  if (provider.kind === "unknown") return provider;
  const guarded: Record<string, unknown> = { ...provider };
  for (const [name, member] of Object.entries(provider)) {
    if (typeof member !== "function") continue;
    const method = member as (input: unknown) => Effect.Effect<unknown, SourceControlProviderError>;
    guarded[name] = (input: unknown) => {
      const host = callHost(input);
      return host === null
        ? method(input)
        : guardForgeCall({ provider: provider.kind, host, account: "" }, name, () => method(input));
    };
  }
  return guarded as unknown as SourceControlProviderShape;
}
