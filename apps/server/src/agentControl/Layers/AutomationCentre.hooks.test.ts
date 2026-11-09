import {
  AgentControlAutomationId,
  ProjectId,
  ProviderInstanceId,
  type AgentControlAutomation,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { AutomationHookStoreLive } from "../../automationHooks/Layers/AutomationHookStore.ts";
import { AutomationHookStore } from "../../automationHooks/Services/AutomationHookStore.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentControlAuditRepositoryLive } from "../../persistence/Layers/AgentControlAudit.ts";
import { AgentControlAutomationRepositoryLive } from "../../persistence/Layers/AgentControlAutomations.ts";
import { AgentControlOperationRepositoryLive } from "../../persistence/Layers/AgentControlOperations.ts";
import { AgentControlProposalRepositoryLive } from "../../persistence/Layers/AgentControlProposals.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AgentControlAutomationRepository } from "../../persistence/Services/AgentControlAutomations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import { AutomationCentre } from "../Services/AutomationCentre.ts";
import { makeAgentControlAutomationLive } from "./AgentControlAutomation.ts";
import { AgentControlPolicyLive } from "./AgentControlPolicy.ts";
import { AgentControlProposalEventsLive } from "./AgentControlProposalEvents.ts";
import { AgentControlProposalServiceLive } from "./AgentControlProposalService.ts";
import { AgentControlProposalStoreLive } from "./AgentControlProposalStore.ts";
import { AutomationCentreLive } from "./AutomationCentre.ts";

const projectId = ProjectId.make("centre-hooks");
const now = new Date().toISOString();
const automation = (
  id: string,
  schedule: AgentControlAutomation["definition"]["schedule"],
  enabled = true,
): AgentControlAutomation => ({
  automationId: AgentControlAutomationId.make(id),
  projectId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  principal: {
    kind: "automation-owner",
    projectId,
    runtimeMode: "approval-required",
    envMode: "worktree",
  },
  definition: {
    enabled,
    schedule,
    execution: {
      projectId,
      title: "Release notes",
      prompt: "Write them",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "approval-required",
      envMode: "worktree",
    },
  },
  revision: 1,
  enabled,
  cancelled: false,
  cancelledAt: null,
  nextRunAt: null,
  createdAt: now,
  updatedAt: now,
});

const secrets = new Map<string, Uint8Array>();
const layer = it.layer(
  AutomationCentreLive.pipe(
    Layer.provideMerge(makeAgentControlAutomationLive({ disableBackground: true })),
    Layer.provideMerge(AutomationHookStoreLive),
    Layer.provideMerge(
      Layer.succeed(ServerSecretStore, {
        get: (name) => Effect.succeed(secrets.get(name) ?? null),
        set: (name, value) => Effect.sync(() => void secrets.set(name, Uint8Array.from(value))),
        getOrCreateRandom: (name, bytes) =>
          Effect.sync(() => {
            if (!secrets.has(name))
              secrets.set(name, crypto.getRandomValues(new Uint8Array(bytes)));
            return secrets.get(name)!;
          }),
        remove: (name) => Effect.sync(() => void secrets.delete(name)),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ServerConfig, {
        hubConnector: { enabled: true, origin: "https://hub.example/" },
      } as never),
    ),
    Layer.provideMerge(AgentControlProposalServiceLive),
    Layer.provideMerge(AgentControlProposalStoreLive),
    Layer.provideMerge(AgentControlProposalEventsLive),
    Layer.provideMerge(AgentControlPolicyLive),
    Layer.provideMerge(AgentControlAutomationRepositoryLive),
    Layer.provideMerge(AgentControlProposalRepositoryLive),
    Layer.provideMerge(AgentControlOperationRepositoryLive),
    Layer.provideMerge(AgentControlAuditRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest({ agentControl: { enabled: true } })),
    Layer.provideMerge(
      Layer.succeed(AgentControlActionValidator, {
        validateOwnerAutomation: () => Effect.void,
        validateSubmission: () => Effect.die("unused"),
        validateExternalSubmission: () => Effect.die("unused"),
        revalidateExecution: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.some({ id: projectId })),
      } as unknown as ProjectionSnapshotQueryShape),
    ),
  ),
);

layer("Automation centre webhook hooks", (it) => {
  it.effect("shows the owner the hook's URLs, secret and Cloud state, and regenerates it", () =>
    Effect.gen(function* () {
      const centre = yield* AutomationCentre;
      const repo = yield* AgentControlAutomationRepository;
      const store = yield* AutomationHookStore;
      const item = automation("centre-webhook", { kind: "webhook" });
      assert.isTrue(yield* repo.insertAutomation(item));
      assert.strictEqual((yield* centre.snapshot({ projectId })).webhooks, true);

      const input = { projectId, automationId: item.automationId, action: "read" as const };
      // A hook the lifecycle never made is made on the owner's first read.
      const first = yield* centre.hook(input);
      assert.match(first.hookId, /^[A-Za-z0-9_-]{22}$/u);
      assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/u);
      assert.strictEqual(first.directPath, `/api/automation-hooks/${first.hookId}`);
      assert.strictEqual(first.cloudUrl, `https://hub.example/hooks/${first.hookId}`);
      assert.strictEqual(first.cloudState, "pending");
      assert.isNull(first.lastRequest);
      assert.deepStrictEqual(yield* centre.hook(input), first);

      yield* store.setHubRegistered([first.hookId]);
      assert.strictEqual((yield* centre.hook(input)).cloudState, "registered");
      store.setHubSyncState("unsupported");
      const unsupported = yield* centre.hook(input);
      assert.strictEqual(unsupported.cloudState, "unsupported");
      assert.isNull(unsupported.cloudUrl);
      store.setHubSyncState("synced");

      const regenerated = yield* centre.hook({ ...input, action: "regenerate" });
      assert.strictEqual(regenerated.hookId, first.hookId);
      assert.notStrictEqual(regenerated.secret, first.secret);
      assert.strictEqual((yield* centre.hook(input)).secret, regenerated.secret);
    }),
  );

  it.effect("has no hook for a timed schedule, and says a paused one is off the Hub", () =>
    Effect.gen(function* () {
      const centre = yield* AutomationCentre;
      const repo = yield* AgentControlAutomationRepository;
      const timed = automation("centre-timed", {
        kind: "once",
        runAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      assert.isTrue(yield* repo.insertAutomation(timed));
      const refused = yield* Effect.flip(
        centre.hook({ projectId, automationId: timed.automationId, action: "read" }),
      );
      assert.strictEqual(refused.code, "conflict");

      const paused = automation("centre-paused", { kind: "webhook" }, false);
      assert.isTrue(yield* repo.insertAutomation(paused));
      const view = yield* centre.hook({
        projectId,
        automationId: paused.automationId,
        action: "read",
      });
      assert.strictEqual(view.cloudState, "paused");
    }),
  );
});
