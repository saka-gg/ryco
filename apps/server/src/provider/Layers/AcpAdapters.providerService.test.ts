/**
 * ACP adapters driven through the real `ProviderService`, the way a node runs
 * them. `ProviderService` starts every session in its own detached fiber that
 * ends once the session has started; the adapter unit tests call
 * `startSession` from the long-lived test fiber instead, so they kept passing
 * while an event drain tied to that start fiber dropped every streamed
 * `session/update` (text, tool rows, plans) in the product.
 */
import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";

import {
  CursorSettings,
  defaultInstanceIdForDriver,
  GrokSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@ryco/contracts";

import { ServerConfig } from "../../config.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const CURSOR = ProviderDriverKind.make("cursor");
const GROK = ProviderDriverKind.make("grok");

async function makeMockAgentWrapper() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acp-provider-service-mock-"));
  const wrapperPath = path.join(dir, "fake-agent.sh");
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const providerServiceLayer = (wrapperPath: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cursor = yield* makeCursorAdapter(
        Schema.decodeSync(CursorSettings)({ binaryPath: wrapperPath }),
      );
      const grok = yield* makeGrokAdapter(
        Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath }),
      ).pipe(Effect.orDie);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      return makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(
            ProviderAdapterRegistry,
            makeAdapterRegistryMock({ [CURSOR]: cursor, [GROK]: grok }),
          ),
        ),
        Layer.provide(ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))),
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-acp-provider-service-" })),
    Layer.provide(NodeServices.layer),
  );

const runTurnThroughProviderService = (driver: ProviderDriverKind) =>
  Effect.gen(function* () {
    const provider = yield* ProviderService;
    const threadId = ThreadId.make(`acp-provider-service-${driver}`);
    const events: ProviderRuntimeEvent[] = [];
    const turnCompleted = yield* Deferred.make<void>();
    const collector = yield* Stream.runForEach(provider.streamEvents, (event) =>
      Effect.gen(function* () {
        if (event.threadId !== threadId) return;
        events.push(event);
        if (event.type === "turn.completed") yield* Deferred.succeed(turnCompleted, undefined);
      }),
    ).pipe(Effect.forkChild);

    yield* provider.startSession(threadId, {
      provider: driver,
      providerInstanceId: defaultInstanceIdForDriver(driver),
      threadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    yield* provider.sendTurn({ threadId, input: "hello mock", attachments: [] });
    yield* Deferred.await(turnCompleted).pipe(Effect.timeout("20 seconds"));
    yield* Fiber.interrupt(collector);
    yield* provider.stopSession({ threadId });
    return events;
  });

for (const driver of [CURSOR, GROK]) {
  it.live(
    `${driver} streams the agent's session updates after a detached start`,
    () =>
      Effect.gen(function* () {
        const wrapperPath = yield* Effect.promise(makeMockAgentWrapper);
        const events = yield* runTurnThroughProviderService(driver).pipe(
          Effect.provide(providerServiceLayer(wrapperPath)),
        );
        const types = events.map((event) => event.type);
        assert.include(types, "turn.plan.updated");
        const deltas = events.flatMap((event) =>
          event.type === "content.delta" ? [event.payload.delta] : [],
        );
        assert.deepStrictEqual(deltas, ["hello from mock"]);
      }),
    60_000,
  );
}
