/**
 * Webhook schedules end to end on one node: the automation lifecycle keeps the hook, the direct
 * endpoint (served over HTTP) takes signed requests through the real pipeline, and each accepted
 * request becomes a run exactly like a due timed one.
 */
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AGENT_CONTROL_RISK_TAGS,
  AgentControlAutomationId,
  AgentControlProposalId,
  AgentControlRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlAutomation,
  type AgentControlAutomationDefinition,
  type AgentControlProposal,
} from "@ryco/contracts";
import { AUTOMATION_HOOK_MAX_BODY_BYTES } from "@ryco/contracts/automation-hooks";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

import { makeAgentControlAutomationLive } from "../agentControl/Layers/AgentControlAutomation.ts";
import { AgentControlPolicyLive } from "../agentControl/Layers/AgentControlPolicy.ts";
import { AgentControlProposalEventsLive } from "../agentControl/Layers/AgentControlProposalEvents.ts";
import { AgentControlProposalStoreLive } from "../agentControl/Layers/AgentControlProposalStore.ts";
import { AgentControlAutomationService } from "../agentControl/Services/AgentControlAutomation.ts";
import { AgentControlProposalStore } from "../agentControl/Services/AgentControlProposalStore.ts";
import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../auth/Services/ServerSecretStore.ts";
import { AgentControlAuditRepositoryLive } from "../persistence/Layers/AgentControlAudit.ts";
import { AgentControlAutomationRepositoryLive } from "../persistence/Layers/AgentControlAutomations.ts";
import { AgentControlOperationRepositoryLive } from "../persistence/Layers/AgentControlOperations.ts";
import { AgentControlProposalRepositoryLive } from "../persistence/Layers/AgentControlProposals.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AgentControlAutomationRepository } from "../persistence/Services/AgentControlAutomations.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { automationHookRouteLayer } from "./automationHookHttp.ts";
import { automationHookRequestDeps, takeAutomationHookRequest } from "./automationHookRequest.ts";
import { signAutomationHookBody } from "./automationHookSignature.ts";
import { AutomationHookStoreLive } from "./Layers/AutomationHookStore.ts";
import { AutomationHookStore } from "./Services/AutomationHookStore.ts";

const projectId = ProjectId.make("project-hooks");
const providerInstanceId = ProviderInstanceId.make("provider-hooks");
const ownerPrincipal = {
  kind: "automation-owner" as const,
  projectId,
  runtimeMode: "approval-required" as const,
  envMode: "worktree" as const,
};
const agentPrincipal = {
  kind: "provider-session" as const,
  threadId: ThreadId.make("thread-hooks"),
  providerInstanceId,
  originProjectId: projectId,
  originRuntimeMode: "approval-required" as const,
  originEnvMode: "worktree" as const,
};

const definition = (
  patch: Partial<AgentControlAutomationDefinition> = {},
): AgentControlAutomationDefinition => ({
  execution: {
    projectId,
    title: "Release notes",
    prompt: "Write the release notes entry.",
    modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    runtimeMode: "approval-required",
    envMode: "worktree",
  },
  schedule: { kind: "webhook" },
  enabled: true,
  ...patch,
});

let proposalCount = 0;
const lifecycle = (
  principal: AgentControlProposal["principal"],
  plan: AgentControlProposal["plan"],
): AgentControlProposal => {
  proposalCount += 1;
  return {
    proposalId: AgentControlProposalId.make(`proposal-hooks-${proposalCount}`),
    requestId: AgentControlRequestId.make(`request-hooks-${proposalCount}`),
    principal,
    planVersion: 1,
    plan,
    planDigest: "f".repeat(64),
    riskTags: [AGENT_CONTROL_RISK_TAGS.createsAutomation],
    promptSummary: "Schedule",
    status: "executing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: "2099-01-01T00:00:00.000Z",
    decidedAt: new Date().toISOString(),
    result: null,
  };
};

const memorySecretStore = Layer.sync(ServerSecretStore, () => {
  const secrets = new Map<string, Uint8Array>();
  return {
    get: (name) => Effect.succeed(secrets.get(name) ?? null),
    set: (name, value) => Effect.sync(() => void secrets.set(name, Uint8Array.from(value))),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const known = secrets.get(name);
        if (known) return known;
        const fresh = crypto.getRandomValues(new Uint8Array(bytes));
        secrets.set(name, fresh);
        return fresh;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  } satisfies ServerSecretStoreShape;
});

const services = makeAgentControlAutomationLive({ disableBackground: true }).pipe(
  Layer.provideMerge(AutomationHookStoreLive.pipe(Layer.provide(memorySecretStore))),
  Layer.provideMerge(AgentControlAutomationRepositoryLive),
  Layer.provideMerge(AgentControlProposalStoreLive),
  Layer.provideMerge(AgentControlProposalEventsLive),
  Layer.provideMerge(AgentControlPolicyLive),
  Layer.provideMerge(AgentControlProposalRepositoryLive),
  Layer.provideMerge(AgentControlOperationRepositoryLive),
  Layer.provideMerge(AgentControlAuditRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
);

const served = HttpRouter.serve(automationHookRouteLayer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(services),
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
  Layer.provideMerge(NodeServices.layer),
);

const origin = Effect.gen(function* () {
  const address = (yield* HttpServer.HttpServer).address;
  if (typeof address === "string" || !("port" in address)) return assert.fail("no listener");
  return `http://127.0.0.1:${address.port}`;
});

const create = (id: string, patch: Partial<AgentControlAutomationDefinition> = {}) =>
  Effect.gen(function* () {
    const automations = yield* AgentControlAutomationService;
    const store = yield* AutomationHookStore;
    const automation = yield* automations.applyLifecycle(
      lifecycle(ownerPrincipal, {
        kind: "createAutomation",
        automationId: AgentControlAutomationId.make(id),
        definition: definition(patch),
      }),
    );
    const hook = Option.getOrThrow(yield* store.get(automation.automationId));
    const secret = Option.getOrThrow(yield* store.secret(hook));
    return { automation, hook, secret };
  });

const post = (url: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : Buffer.from(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
    };
  });

const signed = (secret: string, body: string, extra: Record<string, string> = {}) => ({
  "x-hub-signature-256": signAutomationHookBody(secret, new TextEncoder().encode(body)),
  ...extra,
});

const runsOf = (automation: AgentControlAutomation) =>
  Effect.flatMap(AgentControlAutomationRepository, (repository) =>
    repository.listRuns({ automationId: automation.automationId, limit: 50 }),
  );

/** Rejects the schedule's waiting runs, so its next request may start one. */
const settle = (automation: AgentControlAutomation) =>
  Effect.gen(function* () {
    const proposals = yield* AgentControlProposalStore;
    const automations = yield* AgentControlAutomationService;
    for (const run of yield* runsOf(automation)) {
      if (run.proposalId === null || !["pending-approval", "approved"].includes(run.status))
        continue;
      const decided = yield* proposals.decide({
        proposalId: run.proposalId,
        decision: "rejected",
        actor: "user",
        decidedAt: new Date().toISOString(),
      });
      yield* automations.reconcileProposal(decided);
    }
  });

it.layer(served)("webhook schedules", (it) => {
  it.effect("a signed request to the direct endpoint becomes a run waiting for approval", () =>
    Effect.gen(function* () {
      const { automation, hook, secret } = yield* create("hook-approve");
      const url = `${yield* origin}/api/automation-hooks/${hook.hookId}`;
      const body = '{"version":"0.1.45"}';
      const answer = yield* post(url, body, signed(secret, body, { "x-github-event": "push" }));
      assert.strictEqual(answer.status, 202);
      assert.strictEqual(answer.body.queued, false);
      assert.isString(answer.body.deliveryId);

      const runs = yield* runsOf(automation);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]!.status, "pending-approval");
      assert.strictEqual(runs[0]!.coalescedOccurrences, 0);
      const proposal = Option.getOrThrow(
        yield* (yield* AgentControlProposalStore).getById(runs[0]!.proposalId!),
      );
      assert.strictEqual(proposal.status, "pending-user-approval");
      assert.strictEqual(proposal.plan.kind, "automationRun");
      if (proposal.plan.kind !== "automationRun") return;
      const prompt = proposal.plan.execution.prompt;
      assert.isTrue(prompt.startsWith("Write the release notes entry.\n\n---\nWebhook request"));
      assert.include(prompt, "(event: push, delivery:");
      assert.include(prompt, '```json\n{\n  "version": "0.1.45"\n}\n```');
      assert.strictEqual(proposal.promptSummary, "Webhook run for Release notes");

      const store = yield* AutomationHookStore;
      const recorded = Option.getOrThrow(yield* store.get(automation.automationId));
      assert.deepInclude(recorded.lastRequest, { via: "direct", outcome: "awaiting-approval" });
    }),
  );

  it.effect("a schedule that runs without asking starts at once; a bearer works directly", () =>
    Effect.gen(function* () {
      const { automation, hook, secret } = yield* create("hook-unattended", {
        runPolicy: "run-without-asking",
      });
      const url = `${yield* origin}/api/automation-hooks/${hook.hookId}`;
      const answer = yield* post(url, "plain text", { authorization: `Bearer ${secret}` });
      assert.strictEqual(answer.status, 202);
      const runs = yield* runsOf(automation);
      assert.strictEqual(runs[0]!.status, "approved");
    }),
  );

  it.effect("refuses unknown hooks, bad signatures and bodies over the limit", () =>
    Effect.gen(function* () {
      const { automation, hook, secret } = yield* create("hook-refusals");
      const base = yield* origin;
      const url = `${base}/api/automation-hooks/${hook.hookId}`;
      const unknown = yield* post(
        `${base}/api/automation-hooks/${"Z".repeat(22)}`,
        "{}",
        signed(secret, "{}"),
      );
      assert.deepStrictEqual([unknown.status, unknown.body], [404, { error: "unknown_hook" }]);
      const malformed = yield* post(`${base}/api/automation-hooks/short`, "{}");
      assert.strictEqual(malformed.status, 404);

      const unsigned = yield* post(url, "{}");
      assert.deepStrictEqual([unsigned.status, unsigned.body], [401, { error: "unauthorized" }]);
      const wrong = yield* post(url, "{}", signed("w".repeat(43), "{}"));
      assert.strictEqual(wrong.status, 401);
      const otherBody = yield* post(url, '{"a":1}', signed(secret, "{}"));
      assert.strictEqual(otherBody.status, 401);

      const big = new Uint8Array(AUTOMATION_HOOK_MAX_BODY_BYTES + 1).fill(32);
      const tooLarge = yield* post(url, big, signed(secret, "{}"));
      assert.deepStrictEqual([tooLarge.status, tooLarge.body], [413, { error: "too_large" }]);

      assert.strictEqual((yield* runsOf(automation)).length, 0);
      const store = yield* AutomationHookStore;
      assert.deepInclude(Option.getOrThrow(yield* store.get(automation.automationId)).lastRequest, {
        outcome: "too-large",
      });
    }),
  );

  it.effect("answers a delivery again without a new run, and GitHub's ping without any", () =>
    Effect.gen(function* () {
      const { automation, hook, secret } = yield* create("hook-dedupe");
      const url = `${yield* origin}/api/automation-hooks/${hook.hookId}`;
      const headers = signed(secret, "{}", { "x-github-delivery": "gh-1" });
      assert.strictEqual((yield* post(url, "{}", headers)).status, 202);
      assert.strictEqual((yield* post(url, "{}", headers)).status, 202);
      assert.strictEqual((yield* runsOf(automation)).length, 1);

      const ping = yield* post(url, "{}", signed(secret, "{}", { "x-github-event": "ping" }));
      assert.strictEqual(ping.status, 202);
      assert.strictEqual((yield* runsOf(automation)).length, 1);
      yield* settle(automation);

      // Through the Hub the delivery id is the Hub's: handed out twice, it runs once.
      const deps = automationHookRequestDeps({
        store: yield* AutomationHookStore,
        automations: yield* AgentControlAutomationService,
        repository: yield* AgentControlAutomationRepository,
      });
      const fromHub = {
        hookId: hook.hookId,
        body: new TextEncoder().encode("{}"),
        headers: signed(secret, "{}"),
        deliveryId: "hkd_AAAAAAAAAAAAAAAAAAAAAA",
        receivedAt: new Date(),
        via: "cloud" as const,
      };
      const first = yield* takeAutomationHookRequest(deps, fromHub);
      const second = yield* takeAutomationHookRequest(deps, fromHub);
      assert.deepStrictEqual(first, { kind: "accepted", outcome: "awaiting-approval" });
      assert.deepStrictEqual(second, { kind: "accepted", outcome: "duplicate" });
      // The Hub path takes signatures only.
      const bearer = yield* takeAutomationHookRequest(deps, {
        ...fromHub,
        deliveryId: "hkd_BBBBBBBBBBBBBBBBBBBBBB",
        headers: { authorization: `Bearer ${secret}` },
      });
      assert.deepStrictEqual(bearer, { kind: "refused", error: "unauthorized" });
      assert.strictEqual((yield* runsOf(automation)).length, 2);
    }),
  );

  it.effect("refuses a paused schedule's requests, and rate-limits a busy hook", () =>
    Effect.gen(function* () {
      const automations = yield* AgentControlAutomationService;
      const { automation, hook, secret } = yield* create("hook-limits");
      const url = `${yield* origin}/api/automation-hooks/${hook.hookId}`;
      for (let index = 0; index < 6; index += 1) {
        const body = `{"n":${index}}`;
        assert.strictEqual((yield* post(url, body, signed(secret, body))).status, 202);
        yield* settle(automation);
      }
      const limited = yield* post(url, '{"n":6}', signed(secret, '{"n":6}'));
      assert.deepStrictEqual([limited.status, limited.body], [429, { error: "rate_limited" }]);
      assert.isTrue(Number(limited.retryAfter) > 0 && Number(limited.retryAfter) <= 600);
      assert.strictEqual((yield* runsOf(automation)).length, 6);

      const paused = yield* automations.applyLifecycle(
        lifecycle(ownerPrincipal, {
          kind: "updateAutomation",
          automationId: automation.automationId,
          before: {
            revision: automation.revision,
            definition: automation.definition,
            cancelled: false,
            updatedAt: automation.updatedAt,
          },
          after: { ...automation.definition, enabled: false },
        }),
      );
      const refused = yield* post(url, "{}", signed(secret, "{}"));
      assert.deepStrictEqual([refused.status, refused.body], [409, { error: "not_accepting" }]);
      // Paused, the hook stays (and leaves the Hub's list).
      const store = yield* AutomationHookStore;
      assert.isTrue(Option.isSome(yield* store.get(paused.automationId)));
      assert.notInclude(yield* store.enabledHookIds, hook.hookId);
    }),
  );

  it.effect(
    "a request while a run still waits is refused for now, and runs once it is settled",
    () =>
      Effect.gen(function* () {
        const { automation, hook, secret } = yield* create("hook-busy");
        const url = `${yield* origin}/api/automation-hooks/${hook.hookId}`;
        assert.strictEqual((yield* post(url, '{"n":1}', signed(secret, '{"n":1}'))).status, 202);
        const busy = yield* post(url, '{"n":2}', signed(secret, '{"n":2}'));
        assert.deepStrictEqual([busy.status, busy.body], [429, { error: "rate_limited" }]);
        assert.strictEqual(busy.retryAfter, "60");
        assert.strictEqual((yield* runsOf(automation)).length, 1);
        const store = yield* AutomationHookStore;
        assert.deepInclude(
          Option.getOrThrow(yield* store.get(automation.automationId)).lastRequest,
          {
            outcome: "busy",
          },
        );
        // The same request again, once the first run is settled: not a duplicate.
        yield* settle(automation);
        assert.strictEqual((yield* post(url, '{"n":2}', signed(secret, '{"n":2}'))).status, 202);
        assert.strictEqual((yield* runsOf(automation)).length, 2);
      }),
  );

  it.effect("cancelling deletes the hook; regenerating replaces only the secret", () =>
    Effect.gen(function* () {
      const automations = yield* AgentControlAutomationService;
      const store = yield* AutomationHookStore;
      const { automation, hook, secret } = yield* create("hook-lifecycle");
      assert.include(yield* store.enabledHookIds, hook.hookId);
      const url = `${yield* origin}/api/automation-hooks/${hook.hookId}`;

      const regenerated = Option.getOrThrow(yield* store.regenerate(automation.automationId));
      assert.strictEqual(regenerated.hookId, hook.hookId);
      const fresh = Option.getOrThrow(yield* store.secret(regenerated));
      assert.notStrictEqual(fresh, secret);
      assert.strictEqual((yield* post(url, "{}", signed(secret, "{}"))).status, 401);
      assert.strictEqual((yield* post(url, "{}", signed(fresh, "{}"))).status, 202);

      yield* automations.applyLifecycle(
        lifecycle(ownerPrincipal, {
          kind: "cancelAutomation",
          automationId: automation.automationId,
          expected: {
            revision: automation.revision,
            definition: automation.definition,
            cancelled: false,
            updatedAt: automation.updatedAt,
          },
        }),
      );
      assert.isTrue(Option.isNone(yield* store.get(automation.automationId)));
      assert.notInclude(yield* store.enabledHookIds, hook.hookId);
      assert.strictEqual((yield* post(url, "{}", signed(fresh, "{}"))).status, 404);
    }),
  );

  it.effect("switching a schedule to times deletes its hook", () =>
    Effect.gen(function* () {
      const automations = yield* AgentControlAutomationService;
      const store = yield* AutomationHookStore;
      const { automation } = yield* create("hook-switch");
      const runAt = new Date(Date.now() + 60 * 60_000).toISOString();
      yield* automations.applyLifecycle(
        lifecycle(ownerPrincipal, {
          kind: "updateAutomation",
          automationId: automation.automationId,
          before: {
            revision: automation.revision,
            definition: automation.definition,
            cancelled: false,
            updatedAt: automation.updatedAt,
          },
          after: { ...automation.definition, schedule: { kind: "once", runAt } },
        }),
      );
      assert.isTrue(Option.isNone(yield* store.get(automation.automationId)));
    }),
  );

  it.effect("an agent cannot create a webhook trigger or switch one to it", () =>
    Effect.gen(function* () {
      const automations = yield* AgentControlAutomationService;
      const refused = yield* Effect.flip(
        automations.applyLifecycle(
          lifecycle(agentPrincipal, {
            kind: "createAutomation",
            automationId: AgentControlAutomationId.make("hook-agent"),
            definition: definition(),
          }),
        ),
      );
      assert.strictEqual(refused._tag, "AgentControlPlanValidationError");

      const runAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const timed = yield* automations.applyLifecycle(
        lifecycle(agentPrincipal, {
          kind: "createAutomation",
          automationId: AgentControlAutomationId.make("hook-agent-timed"),
          definition: definition({ schedule: { kind: "once", runAt } }),
        }),
      );
      const switched = yield* Effect.flip(
        automations.applyLifecycle(
          lifecycle(agentPrincipal, {
            kind: "updateAutomation",
            automationId: timed.automationId,
            before: {
              revision: timed.revision,
              definition: timed.definition,
              cancelled: false,
              updatedAt: timed.updatedAt,
            },
            after: { ...timed.definition, schedule: { kind: "webhook" } },
          }),
        ),
      );
      assert.strictEqual(switched._tag, "AgentControlPlanValidationError");
    }),
  );
});
