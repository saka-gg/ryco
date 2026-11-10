/**
 * The direct endpoint's handler (`automationHookHttp.ts` registers the route and loads this with
 * the first request): reads the bounded raw body, runs the pipeline and answers per
 * `docs/automation-webhooks.md`.
 *
 * @module automationHooks/automationHookDirect
 */
import { randomUUID } from "node:crypto";

import {
  AUTOMATION_HOOK_MAX_BODY_BYTES,
  AUTOMATION_HOOK_NODE_PATH_PREFIX,
  type AutomationHookAccepted,
  type AutomationHookError,
} from "@ryco/contracts/automation-hooks";
import { Data, Effect, Option, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { AgentControlAutomationService } from "../agentControl/Services/AgentControlAutomation.ts";
import { AgentControlAutomationRepository } from "../persistence/Services/AgentControlAutomations.ts";
import { AutomationHookStore } from "./Services/AutomationHookStore.ts";

const HOOK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const NO_STORE = { "Cache-Control": "no-store" } as const;

const STATUS: Record<AutomationHookError["error"], number> = {
  unknown_hook: 404,
  unauthorized: 401,
  too_large: 413,
  rate_limited: 429,
  not_accepting: 409,
};

class BodyTooLarge extends Data.TaggedError("BodyTooLarge")<{}> {}

const refusal = (error: AutomationHookError["error"], retryAfterSeconds?: number) =>
  HttpServerResponse.jsonUnsafe({ error } satisfies AutomationHookError, {
    status: STATUS[error],
    headers:
      retryAfterSeconds === undefined
        ? NO_STORE
        : { ...NO_STORE, "Retry-After": String(retryAfterSeconds) },
  });

/** The raw body, refused past the limit whether or not a length was declared. */
const readBoundedBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* request.stream.pipe(
      Stream.runForEach((chunk) => {
        size += chunk.byteLength;
        if (size > AUTOMATION_HOOK_MAX_BODY_BYTES) return Effect.fail(new BodyTooLarge());
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    return Buffer.concat(chunks, size);
  });

const lowercaseHeaders = (headers: Readonly<Record<string, string | undefined>>) => {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
};

export const handleAutomationHookRequest = Effect.gen(function* () {
  const receivedAt = new Date();
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  const hookId = Option.isSome(url)
    ? url.value.pathname.slice(AUTOMATION_HOOK_NODE_PATH_PREFIX.length)
    : "";
  if (!HOOK_ID_PATTERN.test(hookId)) return refusal("unknown_hook");
  // Optional so a server built without automations answers like an unknown hook.
  const store = yield* Effect.serviceOption(AutomationHookStore);
  const automations = yield* Effect.serviceOption(AgentControlAutomationService);
  const repository = yield* Effect.serviceOption(AgentControlAutomationRepository);
  if (Option.isNone(store) || Option.isNone(automations) || Option.isNone(repository)) {
    return refusal("unknown_hook");
  }
  const pipeline = yield* Effect.promise(() => import("./automationHookRequest.ts"));
  const deps = pipeline.automationHookRequestDeps({
    store: store.value,
    automations: automations.value,
    repository: repository.value,
  });
  const declared = Number(request.headers["content-length"]);
  const body =
    Number.isFinite(declared) && declared > AUTOMATION_HOOK_MAX_BODY_BYTES
      ? null
      : yield* readBoundedBody(request).pipe(
          Effect.catchTag("BodyTooLarge", () => Effect.succeed(null)),
        );
  const deliveryId = randomUUID();
  const answer =
    body === null
      ? yield* pipeline.refuseTooLargeAutomationHookRequest(deps, {
          hookId,
          receivedAt,
          via: "direct",
        })
      : yield* pipeline.takeAutomationHookRequest(deps, {
          hookId,
          body,
          headers: lowercaseHeaders(request.headers),
          deliveryId,
          receivedAt,
          via: "direct",
        });
  if (answer.kind === "refused") return refusal(answer.error, answer.retryAfterSeconds);
  if (answer.kind === "failed") {
    return HttpServerResponse.jsonUnsafe(
      {},
      { status: 503, headers: { ...NO_STORE, "Retry-After": "30" } },
    );
  }
  return HttpServerResponse.jsonUnsafe(
    { deliveryId, queued: false } satisfies AutomationHookAccepted,
    { status: 202, headers: NO_STORE },
  );
}).pipe(
  Effect.catch(() =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        {},
        { status: 503, headers: { ...NO_STORE, "Retry-After": "30" } },
      ),
    ),
  ),
);
