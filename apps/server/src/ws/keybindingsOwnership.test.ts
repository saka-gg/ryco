import { WS_METHODS } from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeProviderHandlers } from "./providerRpc.ts";
import type { WsRpcContext } from "./context.ts";

describe("legacy keybinding mutation authority", () => {
  it("rejects both remote writes without touching node persistence, even for owners", async () => {
    const upsert = vi.fn();
    const replace = vi.fn();
    const handlers = makeProviderHandlers({
      config: { stateDir: "/tmp/ryco-keybinding-ownership" },
      keybindings: { upsertKeybindingRule: upsert, replaceCustomKeybindings: replace },
      ownerEffect: (_method: string, effect: Effect.Effect<unknown>) => effect,
    } as unknown as WsRpcContext);
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.serverUpsertKeybinding]({ key: "mod+x", command: "chat.new" }),
      ),
    ).rejects.toThrow("app-owned");
    await expect(
      Effect.runPromise(handlers[WS_METHODS.keybindingsReplaceCustom]({ rules: [] })),
    ).rejects.toThrow("app-owned");
    expect(upsert).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
