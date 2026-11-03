import {
  AGENT_CONTROL_CAPABILITIES,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { withLazyAgentControlTools } from "./lazyTools.ts";
import type { AgentControlMcpToolDescriptor, AgentControlMcpTools } from "./tools.ts";

const session = (capabilities: AgentControlSessionRecord["grantedCapabilities"]) =>
  ({
    sessionId: "session-a",
    threadId: ThreadId.make("thread-a"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeSessionId: RuntimeSessionId.make("runtime-a"),
    grantedCapabilities: capabilities,
    issuedAt: "2026-08-18T00:00:00.000Z",
    injectionMode: "codex-http",
  }) satisfies AgentControlSessionRecord;

const driver = session([AGENT_CONTROL_CAPABILITIES.controlDevices]);
const reader = session([AGENT_CONTROL_CAPABILITIES.read]);

const descriptor = (name: string): AgentControlMcpToolDescriptor => ({
  name,
  description: name,
  inputSchema: { type: "object" },
});

const base: AgentControlMcpTools = {
  descriptors: [descriptor("ryco_base")],
  descriptorsFor: () => Effect.succeed([descriptor("ryco_base")]),
  hasTool: (name) => name === "ryco_base",
  isWriteTool: () => false,
  callTool: (_session, name) =>
    Effect.succeed({ content: [{ type: "text", text: `base ${name}` }], isError: true }),
};

const loadedTools = (inner: AgentControlMcpTools): AgentControlMcpTools => ({
  ...inner,
  descriptorsFor: (caller) =>
    Effect.map(inner.descriptorsFor(caller), (tools) => [...tools, descriptor("ryco_lazy")]),
  hasTool: (name) => name === "ryco_lazy" || inner.hasTool(name),
  callTool: (caller, name, args) =>
    name === "ryco_lazy"
      ? Effect.succeed({ content: [{ type: "text", text: "lazy" }] })
      : inner.callTool(caller, name, args),
});

function harness(load?: () => Promise<AgentControlMcpTools>) {
  let loads = 0;
  const tools = withLazyAgentControlTools(base, {
    names: ["ryco_lazy"],
    writeNames: ["ryco_lazy"],
    mayUse: (caller) =>
      caller.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.controlDevices),
    load: () => {
      loads += 1;
      return load?.() ?? Promise.resolve(loadedTools(base));
    },
  });
  const names = async (caller: AgentControlSessionRecord) =>
    (await Effect.runPromise(tools.descriptorsFor(caller))).map((entry) => entry.name);
  return { tools, names, loads: () => loads };
}

describe("withLazyAgentControlTools", () => {
  it("loads nothing until a session that may use the tools lists them", async () => {
    const h = harness();
    expect(h.loads()).toBe(0);
    // Known and bound to the turn before anything loads.
    expect(h.tools.hasTool("ryco_lazy")).toBe(true);
    expect(h.tools.isWriteTool("ryco_lazy")).toBe(true);
    expect(h.tools.isWriteTool("ryco_base")).toBe(false);
    expect(await h.names(reader)).toEqual(["ryco_base"]);
    expect(h.loads()).toBe(0);

    expect(await h.names(driver)).toEqual(["ryco_base", "ryco_lazy"]);
    expect(await h.names(driver)).toEqual(["ryco_base", "ryco_lazy"]);
    expect(h.loads()).toBe(1);
  });

  it("loads once for concurrent first calls, and leaves other tools to the base", async () => {
    const h = harness();
    const call = (name: string) =>
      Effect.runPromise(h.tools.callTool(driver, name, {})).then(
        (result) => (result.content[0] as { text: string }).text,
      );
    expect(await Promise.all([call("ryco_lazy"), call("ryco_lazy")])).toEqual(["lazy", "lazy"]);
    expect(h.loads()).toBe(1);
    expect(await call("ryco_base")).toBe("base ryco_base");
  });

  it("keeps the base catalogue when the module fails to load", async () => {
    const h = harness(() => Promise.reject(new Error("chunk missing")));
    expect(await h.names(driver)).toEqual(["ryco_base"]);
    const result = await Effect.runPromise(h.tools.callTool(driver, "ryco_lazy", {}));
    expect(result).toEqual({ content: [{ type: "text", text: "base ryco_lazy" }], isError: true });
    expect(h.loads()).toBe(1);
  });
});
