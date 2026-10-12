import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@ryco/contracts";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: mocks.query,
}));

import { probeClaudeCapabilities } from "./ClaudeProvider.ts";

describe("probeClaudeCapabilities", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("never starts the user's MCP servers while reading account metadata", async () => {
    mocks.query.mockReturnValue({
      initializationResult: async () => ({
        account: { email: "user@example.com", subscriptionType: "max" },
        commands: [{ name: "review", description: "Review code", argumentHint: "" }],
      }),
    });

    const result = await Effect.runPromise(
      probeClaudeCapabilities(Schema.decodeSync(ClaudeSettings)({}), {}).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );

    expect(result?.email).toBe("user@example.com");
    const options = mocks.query.mock.calls[0]?.[0]?.options;
    expect(options?.mcpServers).toEqual({});
    expect(options?.strictMcpConfig).toBe(true);
  });
});
