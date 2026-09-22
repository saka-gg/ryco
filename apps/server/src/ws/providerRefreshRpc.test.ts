import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  WS_METHODS,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { WsRpcContext } from "./context.ts";
import { makeProviderHandlers } from "./providerRpc.ts";

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexInstanceId = ProviderInstanceId.make("codex");
const providers = [
  { instanceId: claudeInstanceId, driver: ProviderDriverKind.make("claudeAgent") },
  { instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex") },
] as unknown as ReadonlyArray<ServerProvider>;

function makeHandlers(events: string[]) {
  return makeProviderHandlers({
    config: { stateDir: "/tmp/ryco-provider-refresh" },
    ownerEffect: (_method: string, effect: Effect.Effect<unknown>) => effect,
    modelManifest: Option.some({
      refresh: Effect.sync(() => {
        events.push("manifest");
        return {};
      }),
    }),
    providerRegistry: {
      getProviders: Effect.succeed(providers),
      refresh: () =>
        Effect.sync(() => {
          events.push("providers");
          return providers;
        }),
      refreshInstance: () =>
        Effect.sync(() => {
          events.push("instance");
          return providers;
        }),
    },
  } as unknown as WsRpcContext);
}

describe("provider refresh RPC", () => {
  it("fetches the Claude model manifest before publishing an all-provider refresh", async () => {
    const events: string[] = [];
    const handlers = makeHandlers(events);

    await Effect.runPromise(handlers[WS_METHODS.serverRefreshProviders]({}));

    expect(events).toEqual(["manifest", "providers"]);
  });

  it("fetches the manifest only when the selected instance is Claude", async () => {
    const events: string[] = [];
    const handlers = makeHandlers(events);

    await Effect.runPromise(
      handlers[WS_METHODS.serverRefreshProviders]({ instanceId: codexInstanceId }),
    );
    expect(events).toEqual(["instance"]);

    events.length = 0;
    await Effect.runPromise(
      handlers[WS_METHODS.serverRefreshProviders]({ instanceId: claudeInstanceId }),
    );
    expect(events).toEqual(["manifest", "instance"]);
  });
});
