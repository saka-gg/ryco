import {
  AGENT_CONTROL_WS_METHODS,
  AgentControlRequestId,
  ProjectId,
  AgentControlAutomationRunId,
  type AutomationCentreSnapshot,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";
import { resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
import { makeAutomationCentreHandlers } from "./automationCentreRpc.ts";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { relayRpcPrincipal } from "./RpcPrincipal.ts";
import type { WsRpcContext } from "./context.ts";

const empty: AutomationCentreSnapshot = {
  automations: [],
  runs: [],
  proposals: [],
  unavailableRecords: 0,
  historyLimit: 50,
};
const input = {
  kind: "read" as const,
  projectId: ProjectId.make("p"),
  requestId: AgentControlRequestId.make("r"),
  runId: AgentControlAutomationRunId.make("run"),
  expectedUpdatedAt: "2026-09-15T00:00:00.000Z",
  unread: false,
};

it.effect("automation reads and mutations are owner-only before service evaluation", () =>
  Effect.gen(function* () {
    for (const role of ["viewer", "operator", "owner"] as const) {
      const principal = relayRpcPrincipal(role, "channel");
      let calls = 0;
      const invoke = () =>
        Effect.sync(() => {
          calls++;
          return empty;
        });
      const ctx = {
        automationCentre: Option.some({ snapshot: invoke, command: invoke }),
        ownerEffect: <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
          authorizeRpcPrincipal(principal, "owner", method).pipe(Effect.flatMap(() => effect)),
      } as unknown as WsRpcContext;
      const handlers = makeAutomationCentreHandlers(ctx);
      for (const method of [
        AGENT_CONTROL_WS_METHODS.automationCentre,
        AGENT_CONTROL_WS_METHODS.automationCommand,
      ]) {
        const handler = handlers[method] as (
          request: typeof input,
        ) => Effect.Effect<
          AutomationCentreSnapshot,
          import("@ryco/contracts").AgentControlRpcError | import("@ryco/contracts").AuthRpcError
        >;
        const result = yield* Effect.exit(handler(input));
        assert.strictEqual(result._tag, role === "owner" ? "Success" : "Failure");
        assert.strictEqual(hostedRoleAllows(role, method), role === "owner");
      }
      assert.strictEqual(calls, role === "owner" ? 2 : 0);
    }
  }),
);

it("automation mutations require a current hosted session, browser, role and transport", () => {
  const base = {
    hosted: true,
    role: "owner" as const,
    fresh: true,
    browserCurrent: true,
    sessionReady: true,
    method: AGENT_CONTROL_WS_METHODS.automationCommand,
  };
  assert.isTrue(resolveHostedRpcCapability(base).allowed);
  for (const key of ["fresh", "browserCurrent", "sessionReady"] as const) {
    assert.isFalse(resolveHostedRpcCapability({ ...base, [key]: false }).allowed);
  }
});
