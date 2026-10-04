import { Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeAgentControlExternalListener } from "../ExternalMcp/listener.ts";
import {
  clearExternalRuntimeDescriptor,
  writeExternalRuntimeDescriptor,
} from "../ExternalMcp/runtimeFiles.ts";
import { makeExternalMcpTools } from "../ExternalMcp/tools.ts";
import { AgentControlExternalIntegrationService } from "../Services/AgentControlExternalIntegration.ts";
import { AgentControlExternalTopologyService } from "../Services/AgentControlExternalTopology.ts";
import { AgentControlExternalTaskService } from "../Services/AgentControlExternalTask.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import { AgentControlAutomationService } from "../Services/AgentControlAutomation.ts";
import { AgentControlDiagnosticsService } from "../Services/AgentControlDiagnostics.ts";
import { AgentControlProposalService } from "../Services/AgentControlProposalService.ts";

const makeAgentControlExternalMcpServer = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const integrations = yield* AgentControlExternalIntegrationService;
  const tasks = yield* AgentControlExternalTaskService;
  const projections = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry;
  const validator = yield* Effect.serviceOption(AgentControlActionValidator);
  const automations = yield* Effect.serviceOption(AgentControlAutomationService);
  const diagnostics = yield* Effect.serviceOption(AgentControlDiagnosticsService);
  const proposals = yield* Effect.serviceOption(AgentControlProposalService);
  const topology = yield* AgentControlExternalTopologyService;
  const tools = makeExternalMcpTools({
    integrations,
    tasks,
    projections,
    getProviders: providers.getProviders,
    ...(Option.isSome(validator) ? { validator: validator.value } : {}),
    ...(Option.isSome(automations) ? { automations: automations.value } : {}),
    ...(Option.isSome(diagnostics) ? { diagnostics: diagnostics.value } : {}),
    ...(Option.isSome(proposals) ? { proposals: proposals.value } : {}),
  });
  const transitions = yield* Semaphore.make(1);
  let listenerScope: Scope.Closeable | null = null;
  let shuttingDown = false;

  const start = Effect.gen(function* () {
    if (shuttingDown || listenerScope !== null || !topology.current().available) return;
    const scope = yield* Scope.make("sequential");
    const started = yield* makeAgentControlExternalListener({ integrations, tools }).pipe(
      Scope.provide(scope),
      Effect.exit,
    );
    if (Exit.isFailure(started)) {
      yield* Scope.close(scope, Exit.void);
      yield* Effect.logWarning("External Agent Control listener failed to start");
      return;
    }
    const descriptor = {
      version: 1 as const,
      pid: process.pid,
      instanceId: crypto.randomUUID(),
      mcpUrl: started.value.url,
      pairingUrl: started.value.pairingUrl,
      startedAt: new Date().toISOString(),
    };
    const written = yield* Effect.tryPromise(() =>
      writeExternalRuntimeDescriptor(config.stateDir, descriptor),
    ).pipe(Effect.orDie, Effect.exit);
    if (Exit.isFailure(written)) {
      yield* Scope.close(scope, Exit.void);
      yield* Effect.logWarning("External Agent Control descriptor failed closed");
      return;
    }
    listenerScope = scope;
    yield* Effect.logInfo("External Agent Control listener started", { port: started.value.port });
  });

  const stop = Effect.gen(function* () {
    yield* Effect.tryPromise(() => clearExternalRuntimeDescriptor(config.stateDir)).pipe(
      Effect.ignore,
    );
    if (listenerScope === null) return;
    const scope = listenerScope;
    listenerScope = null;
    yield* Scope.close(scope, Exit.void);
    yield* Effect.logInfo("External Agent Control listener stopped");
  });

  // Read per transition: the Hub connector can take this process over.
  const converge = (enabled: boolean) =>
    transitions.withPermits(1)(
      Effect.suspend(() => (enabled && topology.current().available ? start : stop)),
    );
  // A standby Hub connector closes this listener, and its accepted
  // connections, before it opens its first relay connection. The hand-off
  // runs before every connection attempt, so it touches nothing when no
  // listener is up.
  yield* topology.onYieldToHub(
    transitions.withPermits(1)(Effect.suspend(() => (listenerScope === null ? Effect.void : stop))),
  );
  const initial = yield* settings.getSettings.pipe(
    Effect.map((value) => value.agentControl.enabled),
    Effect.catch(() => Effect.succeed(false)),
  );
  yield* converge(initial);
  yield* settings.streamChanges.pipe(
    Stream.runForEach((value) => converge(value.agentControl.enabled).pipe(Effect.ignore)),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    transitions.withPermits(1)(
      Effect.gen(function* () {
        shuttingDown = true;
        yield* stop;
      }),
    ),
  );
});

export const AgentControlExternalMcpServerLive = Layer.effectDiscard(
  makeAgentControlExternalMcpServer,
);
