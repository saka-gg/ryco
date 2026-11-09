/**
 * `POST /api/automation-hooks/<hookId>`: a webhook request sent straight to this node
 * (`docs/automation-webhooks.md`, "The direct path"). Outside session authentication: the
 * signature (or the bearer secret) is the authentication. Boot holds only the route; its handler
 * and the pipeline load with the first request.
 *
 * @module automationHooks/automationHookHttp
 */
import { Effect } from "effect";
import { HttpRouter } from "effect/http";

/** `AUTOMATION_HOOK_NODE_PATH_PREFIX` (`@ryco/contracts/automation-hooks`), kept off boot. */
export const AUTOMATION_HOOK_ROUTE_PREFIX = "/api/automation-hooks/";

export const automationHookRouteLayer = HttpRouter.add(
  "POST",
  `${AUTOMATION_HOOK_ROUTE_PREFIX}*`,
  Effect.promise(() => import("./automationHookDirect.ts")).pipe(
    Effect.flatMap((direct) => direct.handleAutomationHookRequest),
  ),
);
