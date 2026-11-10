/**
 * automationHookRequest - Takes one webhook request (`docs/automation-webhooks.md`, "Taking a
 * request"). Both paths end here: the direct endpoint with a new delivery id, the Hub sync with
 * the Hub's.
 *
 * 1. Find the hook; none → `unknown_hook`.
 * 2. Check the signature (directly, also the bearer); bad or missing → `unauthorized`.
 * 3. A delivery handled in the last 48 hours → accepted again, nothing new runs.
 * 4. GitHub's `ping` → accepted, no run.
 * 5. A paused, cancelled or ended schedule → `not_accepting`.
 * 6. More than 6 runs started in the last 10 minutes → `rate_limited`.
 * 7. A run materialized exactly like a due timed run, through the same run policy.
 *
 * Requests run one at a time per process, so a delivery handed over twice at once runs once.
 *
 * @module automationHooks/automationHookRequest
 */
import {
  AUTOMATION_HOOK_MAX_BODY_BYTES,
  type AutomationHookError,
} from "@ryco/contracts/automation-hooks";
import type { AutomationHookRequestOutcome } from "@ryco/contracts";
import { Effect, Option, Semaphore } from "effect";

import type { AgentControlAutomationRepositoryError } from "../persistence/Errors.ts";
import type { AgentControlAutomationRepositoryShape } from "../persistence/Services/AgentControlAutomations.ts";

import type { AgentControlAutomationShape } from "../agentControl/Services/AgentControlAutomation.ts";
import { buildAutomationHookPrompt } from "./automationHookPrompt.ts";
import { verifyAutomationHookRequest } from "./automationHookSignature.ts";
import type {
  AutomationHookRecord,
  AutomationHookStoreShape,
  AutomationHookVia,
} from "./Services/AutomationHookStore.ts";

export const AUTOMATION_HOOK_DEDUPE_WINDOW_MS = 48 * 60 * 60_000;
export const AUTOMATION_HOOK_RATE_WINDOW_MS = 10 * 60_000;
/** How long a sender waits while a run of the schedule is still waiting or starting. */
export const AUTOMATION_HOOK_BUSY_RETRY_SECONDS = 60;
/** Runs a hook may start in a rate window; the next request is refused. */
export const AUTOMATION_HOOK_RATE_LIMIT = 6;

export interface AutomationHookRequest {
  readonly hookId: string;
  readonly body: Uint8Array;
  /** Lowercase names. Through the Hub, only the forwarded headers. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly deliveryId: string;
  readonly receivedAt: Date;
  readonly via: AutomationHookVia;
}

export type AutomationHookAnswer =
  | {
      readonly kind: "accepted";
      readonly outcome: Extract<
        AutomationHookRequestOutcome,
        "started" | "awaiting-approval" | "duplicate" | "ping"
      >;
    }
  | {
      readonly kind: "refused";
      readonly error: AutomationHookError["error"];
      /** Seconds, for `rate_limited`. */
      readonly retryAfterSeconds?: number;
    }
  /** The node could not take it now (storage); the sender (or the Hub's lease) tries again. */
  | { readonly kind: "failed" };

export interface AutomationHookRequestDeps {
  readonly store: AutomationHookStoreShape;
  readonly automations: Pick<AgentControlAutomationShape, "triggerWebhookRun">;
  /** The automation's schedule prompt and state, for the framing and step 5. */
  readonly readAutomation: (
    automationId: AutomationHookRecord["automationId"],
  ) => Effect.Effect<
    Option.Option<{ readonly prompt: string; readonly accepting: boolean }>,
    AgentControlAutomationRepositoryError
  >;
}

const lock = Semaphore.makeUnsafe(1);

const refusedOutcome: Record<AutomationHookError["error"], AutomationHookRequestOutcome | null> = {
  unknown_hook: null,
  unauthorized: "unauthorized",
  too_large: "too-large",
  rate_limited: "rate-limited",
  not_accepting: "not-accepting",
};

/** The delivery keys a request is known by: its delivery id, and GitHub's when sent. */
export function automationHookDeliveryKeys(request: {
  readonly deliveryId: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): ReadonlyArray<string> {
  const github = request.headers["x-github-delivery"]?.trim();
  return [
    `delivery:${request.deliveryId}`,
    ...(github === undefined || github === "" ? [] : [`github:${github.slice(0, 128)}`]),
  ];
}

/** A body over the limit, on a path that never read it: recorded when the hook exists. */
export const refuseTooLargeAutomationHookRequest = (
  deps: Pick<AutomationHookRequestDeps, "store">,
  input: { readonly hookId: string; readonly receivedAt: Date; readonly via: AutomationHookVia },
): Effect.Effect<AutomationHookAnswer> =>
  Effect.gen(function* () {
    const hook = yield* deps.store.findByHookId(input.hookId);
    if (Option.isNone(hook)) return { kind: "refused", error: "unknown_hook" } as const;
    yield* deps.store.recordRequest({
      automationId: hook.value.automationId,
      at: input.receivedAt.toISOString(),
      via: input.via,
      outcome: "too-large",
    });
    return { kind: "refused", error: "too_large" } as const;
  }).pipe(Effect.catch(() => Effect.succeed({ kind: "failed" } as const)));

export const takeAutomationHookRequest = (
  deps: AutomationHookRequestDeps,
  request: AutomationHookRequest,
): Effect.Effect<AutomationHookAnswer> =>
  Effect.gen(function* () {
    const at = request.receivedAt.toISOString();
    // 1. The hook.
    const found = yield* deps.store.findByHookId(request.hookId);
    if (Option.isNone(found)) return { kind: "refused", error: "unknown_hook" } as const;
    const hook = found.value;
    const automation = yield* deps.readAutomation(hook.automationId);
    if (Option.isNone(automation)) return { kind: "refused", error: "unknown_hook" } as const;
    const record = (outcome: AutomationHookRequestOutcome) =>
      deps.store.recordRequest({ automationId: hook.automationId, at, via: request.via, outcome });
    const refuse = (error: AutomationHookError["error"], retryAfterSeconds?: number) =>
      Effect.gen(function* () {
        const outcome = refusedOutcome[error];
        if (outcome !== null) yield* record(outcome);
        return {
          kind: "refused",
          error,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        } as const;
      });
    if (request.body.byteLength > AUTOMATION_HOOK_MAX_BODY_BYTES) return yield* refuse("too_large");

    // 2. The signature, or directly the bearer.
    const secret = yield* deps.store.secret(hook);
    if (
      Option.isNone(secret) ||
      !verifyAutomationHookRequest({
        secret: secret.value,
        body: request.body,
        headers: request.headers,
        allowBearer: request.via === "direct",
      })
    ) {
      return yield* refuse("unauthorized");
    }

    // 3. A delivery handled before.
    const keys = automationHookDeliveryKeys(request);
    const nowMs = Date.now();
    if (
      yield* deps.store.seenDelivery({
        hookId: hook.hookId,
        keys,
        since: new Date(nowMs - AUTOMATION_HOOK_DEDUPE_WINDOW_MS).toISOString(),
      })
    ) {
      yield* record("duplicate");
      return { kind: "accepted", outcome: "duplicate" } as const;
    }
    const remember = (started: boolean) =>
      deps.store.rememberDelivery({
        hookId: hook.hookId,
        keys,
        at,
        started,
        pruneBefore: new Date(nowMs - AUTOMATION_HOOK_DEDUPE_WINDOW_MS).toISOString(),
      });

    // 4. GitHub's test when a webhook is added.
    if (request.headers["x-github-event"]?.trim().toLowerCase() === "ping") {
      yield* remember(false);
      yield* record("ping");
      return { kind: "accepted", outcome: "ping" } as const;
    }

    // 5. Paused, cancelled or ended.
    if (!automation.value.accepting) return yield* refuse("not_accepting");

    // 6. The rate limit counts the runs requests started.
    const recent = yield* deps.store.startedSince({
      hookId: hook.hookId,
      since: new Date(nowMs - AUTOMATION_HOOK_RATE_WINDOW_MS).toISOString(),
    });
    if (recent.count >= AUTOMATION_HOOK_RATE_LIMIT) {
      const oldestMs = recent.oldest === null ? nowMs : Date.parse(recent.oldest);
      const retryAfter = Math.max(
        1,
        Math.ceil((oldestMs + AUTOMATION_HOOK_RATE_WINDOW_MS - nowMs) / 1000),
      );
      return yield* refuse("rate_limited", retryAfter);
    }

    // 7. A run, like a due timed one. The delivery is remembered first, so a second hand-over
    // while the run is created runs nothing; it is forgotten again when nothing ran.
    yield* remember(true);
    const triggered = yield* deps.automations
      .triggerWebhookRun({
        automationId: hook.automationId,
        receivedAt: at,
        prompt: buildAutomationHookPrompt({
          prompt: automation.value.prompt,
          receivedAt: at,
          event: request.headers["x-github-event"],
          deliveryId: request.deliveryId,
          body: request.body,
        }),
      })
      .pipe(
        Effect.tapError(() =>
          deps.store.forgetDelivery({ hookId: hook.hookId, keys }).pipe(Effect.ignore),
        ),
      );
    if (triggered === "not-accepting") {
      yield* deps.store.forgetDelivery({ hookId: hook.hookId, keys });
      return yield* refuse("not_accepting");
    }
    if (triggered === "busy") {
      // A run of the schedule is still waiting for approval or starting: like a due timed run,
      // this one waits. Through the Hub it stays queued (no outcome is sent).
      yield* deps.store.forgetDelivery({ hookId: hook.hookId, keys });
      yield* record("busy");
      return {
        kind: "refused",
        error: "rate_limited",
        retryAfterSeconds: AUTOMATION_HOOK_BUSY_RETRY_SECONDS,
      } as const;
    }
    yield* record(triggered);
    return { kind: "accepted", outcome: triggered } as const;
  }).pipe(
    lock.withPermits(1),
    Effect.catch((error: unknown) =>
      Effect.logWarning("automation-hook.request-failed", {
        via: request.via,
        error: error instanceof Error ? error.message : String(error),
      }).pipe(Effect.as({ kind: "failed" } as const)),
    ),
  );

/** The pipeline's dependencies from the server's services. */
export const automationHookRequestDeps = (services: {
  readonly store: AutomationHookStoreShape;
  readonly automations: Pick<AgentControlAutomationShape, "triggerWebhookRun">;
  readonly repository: Pick<AgentControlAutomationRepositoryShape, "getAutomation">;
}): AutomationHookRequestDeps => ({
  store: services.store,
  automations: services.automations,
  readAutomation: (automationId) =>
    services.repository.getAutomation(automationId).pipe(
      Effect.map(
        Option.map((automation) => ({
          prompt: automation.definition.execution.prompt,
          accepting:
            automation.enabled &&
            !automation.cancelled &&
            automation.definition.schedule.kind === "webhook",
        })),
      ),
    ),
});
