import { afterEach, expect, it, vi } from "vitest";
import { NO_DELEGATION_LIMITS } from "../../orchestration/delegationLimits.ts";
import { Effect, Option } from "effect";
import {
  AGENT_CONTROL_CAPABILITIES,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { readComputerConsentReply, withComputerBetaTools } from "./computerBetaTools.ts";
import {
  stageComputerTurn,
  retireComputerTurn,
  bindComputerTurn,
} from "../../computer/computerTurnLifecycle.ts";
import { CuaComputerBackend } from "../../computer/CuaComputerBackend.ts";
import { ComputerManager } from "../../computer/ComputerManager.ts";
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
function fixture(
  getThreadCheckpointContext: (threadId: ThreadId) => Effect.Effect<Option.Option<unknown>> = () =>
    Effect.succeed(Option.none()),
) {
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
      delegationLimits: Effect.succeed(NO_DELEGATION_LIMITS),
      requireEnabled: () => Effect.void,
      requiredCapabilityForAction: () => AGENT_CONTROL_CAPABILITIES.controlComputer,
      authorize: () => Effect.void,
    },
    registry: { getTurnAuthority: () => Effect.sync(() => current) } as never,
    projections: { getThreadCheckpointContext } as never,
  });
  const stage = (runtimeMode: "full-access" | "approval-required" = "full-access") => {
    stageComputerTurn(session.threadId, {
      text: "Inspect Calculator",
      intent: { mode: "request", generation: "epoch:0" },
      runtimeMode,
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
it("resolves the workspace through thread projections for native file paste", async () => {
  const getThreadCheckpointContext = vi.fn((_threadId: ThreadId) => Effect.succeed(Option.none()));
  const runtime = fixture(getThreadCheckpointContext);
  try {
    runtime.stage();
    const result = await Effect.runPromise(
      runtime.tools.callTool(session, "computer_paste", { image_path: "/tmp/ryco-image.png" }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "No canonical workspace is available for native file paste",
    );
    expect(getThreadCheckpointContext).toHaveBeenCalledWith(session.threadId);
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
it.each([
  ["approves only an accept", { approved: true, outcome: "accept", retryable: false }, true],
  ["refuses a decline", { approved: false, outcome: "decline", retryable: false }, false],
  ["refuses a stopped task", { approved: false, outcome: "stopped", retryable: false }, false],
] as const)("%s", (_label, reply, approved) => {
  expect(readComputerConsentReply(reply)).toBe(approved);
});
it.each([
  ["an open dialog", { approved: false, outcome: "pending", retryable: true }, "approval_pending"],
  ["an expiry", { approved: false, outcome: "expired", retryable: true }, "approval_expired"],
  [
    "a missing window",
    { approved: false, outcome: "unavailable", retryable: true },
    "approval_unavailable",
  ],
  [
    "a full prompt queue",
    { approved: false, outcome: "busy", retryable: true },
    "approval_queue_full",
  ],
] as const)("refuses this call without binding the turn for %s", (_label, reply, code) => {
  expect(() => readComputerConsentReply(reply)).toThrow(
    expect.objectContaining({ code, effect: "not-dispatched", retryable: true }),
  );
});
it.each([
  ["the turn's re-request also expired", "expired", "approval_expired"],
  ["the dialog could not be shown again", "unavailable", "approval_unavailable"],
  ["other dialogs kept it from showing again", "busy", "approval_queue_full"],
] as const)("passes on that %s", (_label, outcome, code) => {
  expect(() => readComputerConsentReply({ approved: false, outcome, retryable: false })).toThrow(
    expect.objectContaining({
      code,
      retryable: false,
      message: expect.stringContaining("Do not ask again in this turn"),
    }),
  );
});
it.each([
  ["a bare approval without an outcome", { approved: true }],
  [
    "an approval that contradicts its outcome",
    { approved: false, outcome: "accept", retryable: false },
  ],
  ["a decline that claims approval", { approved: true, outcome: "decline", retryable: false }],
  ["an unknown outcome", { approved: false, outcome: "maybe", retryable: true }],
  ["a non-object reply", "approved"],
  ["no reply", null],
] as const)("fails closed on %s", (_label, reply) => {
  expect(() => readComputerConsentReply(reply)).toThrow(
    expect.objectContaining({ code: "approval_unavailable", retryable: true }),
  );
});
it("returns an open consent dialog to the agent as approval_pending without native input", async () => {
  const runtime = fixture();
  const pressKey = vi.spyOn(CuaComputerBackend.prototype, "pressKey");
  vi.spyOn(CuaComputerBackend.prototype, "missingPermissions").mockResolvedValue([]);
  const audit = vi
    .spyOn(ComputerManager.prototype, "recordComputerAudit")
    .mockImplementation(() => undefined);
  runtime.fetcher.mockImplementation(async (_url, options) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    runtime.requests.push(body);
    return Response.json(
      body.operation === "consent"
        ? { approved: false, outcome: "pending", retryable: true }
        : { ready: true },
    );
  });
  try {
    runtime.stage("approval-required");
    const result = await Effect.runPromise(
      runtime.tools.callTool(session, "computer_press_key", {
        key: "enter",
        include_screenshot: false,
      }),
    );
    expect(result.isError).toBe(true);
    const text = result.content.find((part) => part.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      error: { code: "approval_pending", effect: "not-dispatched", retryable: true },
    });
    expect(runtime.requests).toContainEqual({
      operation: "consent",
      threadId: session.threadId,
      turnId: "turn",
      clipboard: false,
    });
    expect(pressKey).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ effect: "refused", code: "approval_pending" }),
    );
  } finally {
    await runtime.dispose();
  }
});
