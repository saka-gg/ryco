import { afterEach, expect, it, vi } from "vitest";
import { Effect, Option } from "effect";
import {
  AGENT_CONTROL_CAPABILITIES,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { withComputerBetaTools } from "./computerBetaTools.ts";
import {
  stageComputerTurn,
  retireComputerTurn,
  bindComputerTurn,
} from "../../computer/computerTurnLifecycle.ts";
import { CuaComputerBackend } from "../../computer/CuaComputerBackend.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import type { AgentControlMcpTools } from "./tools.ts";
const session: AgentControlSessionRecord = {
  sessionId: "session",
  threadId: ThreadId.make("beta-tool-test"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime"),
  grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.controlComputer],
  issuedAt: "2026-09-26T00:00:00Z",
  injectionMode: "codex-http",
};
const authority = {
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
afterEach(() => {
  stageComputerTurn(session.threadId, undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  let current = Option.some(authority);
  const requests: Record<string, unknown>[] = [];
  vi.spyOn(CuaComputerBackend.prototype, "dispose").mockResolvedValue();
  vi.spyOn(CuaComputerBackend.prototype, "endTask").mockResolvedValue();
  const fetcher = vi.fn(async (_url: unknown, options: RequestInit) => {
    requests.push(JSON.parse(String(options.body)));
    return Response.json({ ready: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = withComputerBetaTools(base, {
    config: {
      url: "http://127.0.0.1:12345/control",
      token: "a".repeat(43),
      native: { endpoint: "/tmp/not-a-live-computer.sock", capability: "private" },
    },
    stateDir: "/tmp/ryco-computer-beta-test",
    policy: {
      isEnabled: Effect.succeed(true),
      requireEnabled: () => Effect.void,
      requiredCapabilityForAction: () => AGENT_CONTROL_CAPABILITIES.controlComputer,
      authorize: () => Effect.void,
    },
    registry: { getTurnAuthority: () => Effect.sync(() => current) } as never,
    projections: { getThreadCheckpointContext: () => Effect.succeed(Option.none()) } as never,
  });
  const stage = () => {
    stageComputerTurn(session.threadId, {
      text: "Inspect Calculator",
      intent: { mode: "request", generation: "epoch:0" },
      runtimeMode: "full-access",
      label: "Calculator",
    });
    bindComputerTurn(session.threadId, authority.turnId);
  };
  return {
    ...runtime,
    requests,
    fetcher,
    stage,
    retire: () => {
      current = Option.none();
      retireComputerTurn(session.threadId, authority.turnId);
    },
  };
}
it("advertises native tools only on enabled turns with a computer capability", async () => {
  const runtime = fixture();
  try {
    expect(await Effect.runPromise(runtime.tools.descriptorsFor(session))).toEqual([]);
    runtime.stage();
    expect(
      (await Effect.runPromise(runtime.tools.descriptorsFor(session))).some(
        (tool) => tool.name === "computer_help",
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        runtime.tools.descriptorsFor({ ...session, grantedCapabilities: [] }),
      ),
    ).toEqual([]);
  } finally {
    await runtime.dispose();
  }
});
it("rejects calls before native bridge access when turn authority is absent", async () => {
  const runtime = fixture();
  try {
    runtime.stage();
    runtime.retire();
    expect(
      (await Effect.runPromise(runtime.tools.callTool(session, "computer_help", {}))).isError,
    ).toBe(true);
    expect(runtime.requests).toEqual([]);
  } finally {
    await runtime.dispose();
  }
});
it("rechecks turn authority after asynchronous desktop admission", async () => {
  const runtime = fixture();
  try {
    runtime.stage();
    runtime.fetcher.mockImplementationOnce(async (_url, options) => {
      runtime.requests.push(JSON.parse(String(options.body)));
      runtime.retire();
      return Response.json({ ready: true });
    });
    expect(
      (
        await Effect.runPromise(
          runtime.tools.callTool(session, "computer_help", {
            threadId: "forged",
            turnId: "forged",
          }),
        )
      ).isError,
    ).toBe(true);
    expect(runtime.requests[0]).toMatchObject({
      operation: "begin",
      threadId: session.threadId,
      turnId: "turn",
      intent: { generation: "epoch:0" },
    });
  } finally {
    await runtime.dispose();
  }
});
