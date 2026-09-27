import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { ProviderInstanceId, WS_METHODS } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WsRpcContext } from "./context.ts";
const calls = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock("../provider/Layers/CodexResetCredits.ts", () => ({
  readResetAccount: () => Effect.succeed({}),
  consumeResetCredit: (...args: unknown[]) => {
    calls.consume(...args);
    return Effect.succeed({ outcome: "reset" });
  },
  runtimeBinding: () => "fixture-runtime",
}));
import { makeProviderHandlers } from "./providerRpc.ts";

describe("reset RPC confirmed results", () => {
  it("preserves confirmed redemption if refreshing providers fails", async () => {
    const instanceId = ProviderInstanceId.make("fixture-codex");
    const owner = vi.fn((_method: string, effect: Effect.Effect<unknown>) => effect);
    const handlers = makeProviderHandlers({
      config: { stateDir: "/tmp/fixture-reset-rpc" },
      ownerEffect: owner,
      serverSettings: {
        getSettings: Effect.succeed({
          providerInstances: {
            [instanceId]: {
              driver: "codex",
              enabled: true,
              config: { homePath: "/tmp/fixture-codex-home" },
              environment: [],
            },
          },
        }),
      },
      providerRegistry: { refreshInstance: () => Effect.die(new Error("fixture refresh failure")) },
    } as unknown as WsRpcContext);
    const result = await Effect.runPromise(
      handlers[WS_METHODS.serverConsumeCodexResetCredit]({
        instanceId,
        accountBinding: "fixture-binding",
        idempotencyKey: "fixture-key",
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(result).toEqual({ outcome: "reset" });
    expect(owner).toHaveBeenCalled();
    expect(calls.consume).toHaveBeenCalledOnce();
  });
});
