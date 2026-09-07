import { expect, it, vi } from "vitest";
import { Effect, Option } from "effect";
import {
  AGENT_CONTROL_CAPABILITIES,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { withComputerUseTools } from "./computerTools.ts";
import type { AgentControlMcpTools } from "./tools.ts";
import type {
  AgentControlSessionRecord,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";

const session: AgentControlSessionRecord = {
  sessionId: "session",
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime"),
  grantedCapabilities: [
    AGENT_CONTROL_CAPABILITIES.controlComputer,
    AGENT_CONTROL_CAPABILITIES.controlBrowser,
  ],
  issuedAt: "2026-09-07T00:00:00Z",
  injectionMode: "codex-http",
};
const authority: AgentControlTurnAuthority = {
  sessionId: session.sessionId,
  threadId: session.threadId,
  turnId: TurnId.make("turn"),
  boundAt: session.issuedAt,
};
const base: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.succeed({ content: [] }),
};
function fixture(current = Option.some(authority)) {
  const fetcher = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }),
  );
  const authorize = vi.fn(() => Effect.void);
  const tools = withComputerUseTools(base, {
    config: { url: "http://127.0.0.1:12345/control", token: "a".repeat(43) },
    policy: {
      isEnabled: Effect.succeed(true),
      requireEnabled: () => Effect.void,
      requiredCapabilityForAction: () => AGENT_CONTROL_CAPABILITIES.read,
      authorize,
    },
    registry: { getTurnAuthority: () => Effect.succeed(current) },
    fetch: fetcher as unknown as typeof fetch,
  });
  return { tools, fetcher, authorize };
}
it("does not expose computer tools on a server without a desktop bridge", () => {
  const tools = withComputerUseTools(base, { policy: {} as never, registry: {} as never });
  expect(tools).toBe(base);
});
it("refuses non-loopback bridge configuration", () => {
  expect(
    withComputerUseTools(base, {
      config: { url: "https://remote.example/control", token: "a".repeat(43) },
      policy: {} as never,
      registry: {} as never,
    }),
  ).toBe(base);
});
it("exposes tools only to sessions carrying the explicit computer capability", async () => {
  const { tools } = fixture();
  expect(
    await Effect.runPromise(tools.descriptorsFor({ ...session, grantedCapabilities: [] })),
  ).toEqual([]);
  expect(await Effect.runPromise(tools.descriptorsFor(session))).toHaveLength(2);
  expect(tools.isWriteTool("ryco_computer")).toBe(true);
});
it("refuses inspection and input outside an active turn", async () => {
  const { tools, fetcher } = fixture(Option.none());
  const result = await Effect.runPromise(
    tools.callTool(session, "ryco_computer", { action: "apps" }),
  );
  expect(result.isError).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it("uses the authoritative session and turn, never agent-supplied identity", async () => {
  const { tools, fetcher, authorize } = fixture();
  await Effect.runPromise(
    tools.callTool(session, "ryco_browser", {
      action: "tabs",
      browser: "ryco",
      sessionId: "attacker",
    }),
  );
  const init = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(JSON.parse(String(init?.body))).toMatchObject({
    sessionId: "session",
    threadId: "thread",
    turnId: "turn",
    tool: "browser",
  });
  expect(authorize).toHaveBeenCalledWith(
    expect.objectContaining({ requiredCapability: AGENT_CONTROL_CAPABILITIES.controlBrowser }),
  );
  expect(init?.redirect).toBe("error");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});
