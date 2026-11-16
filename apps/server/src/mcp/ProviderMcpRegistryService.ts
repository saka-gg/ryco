/**
 * The node's one provider MCP registry. Settings (per WebSocket connection) and the Agent Control
 * installation share it, so they also share the registry's workspace locks and list caches.
 */
import { Context, Effect, Layer } from "effect";

import { makeCodexMcpService } from "./CodexMcpService.ts";
import { makeClaudeMcpAdapter } from "./adapters/ClaudeMcpAdapter.ts";
import { makeCodexMcpAdapter } from "./adapters/CodexMcpAdapter.ts";
import { makeCopilotMcpAdapter } from "./adapters/CopilotMcpAdapter.ts";
import { makeCursorMcpAdapter } from "./adapters/CursorMcpAdapter.ts";
import { makeGrokMcpAdapter } from "./adapters/GrokMcpAdapter.ts";
import { makeOpenCodeMcpAdapter } from "./adapters/OpenCodeMcpAdapter.ts";
import { makeProviderMcpRegistry, type ProviderMcpRegistryShape } from "./ProviderMcpRegistry.ts";

export const makeDefaultProviderMcpRegistry = Effect.gen(function* () {
  const codexMcp = yield* makeCodexMcpService;
  const claudeMcp = yield* makeClaudeMcpAdapter();
  const copilotMcp = yield* makeCopilotMcpAdapter();
  const cursorMcp = yield* makeCursorMcpAdapter();
  const grokMcp = yield* makeGrokMcpAdapter();
  const openCodeMcp = yield* makeOpenCodeMcpAdapter();
  return yield* makeProviderMcpRegistry([
    makeCodexMcpAdapter(codexMcp),
    claudeMcp,
    copilotMcp,
    cursorMcp,
    grokMcp,
    openCodeMcp,
  ]);
});

export class ProviderMcpRegistryService extends Context.Service<
  ProviderMcpRegistryService,
  ProviderMcpRegistryShape
>()("ryco/mcp/ProviderMcpRegistryService") {}

export const ProviderMcpRegistryServiceLive = Layer.effect(
  ProviderMcpRegistryService,
  makeDefaultProviderMcpRegistry,
);
