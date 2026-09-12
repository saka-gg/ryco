import { describe, expect, it } from "vitest";
import type { Part } from "@opencode-ai/sdk/v2";
import { OpenCodeTaskLifecycle } from "./openCodeTaskLifecycle.ts";

function tool(
  status: "pending" | "running" | "completed" | "error",
  options: {
    call?: string;
    session?: string | null;
    background?: boolean;
    model?: boolean;
  } = {},
): Part {
  return {
    type: "tool",
    id: options.call ?? "part",
    callID: options.call ?? "call",
    sessionID: "parent",
    messageID: "message",
    tool: "task",
    state: {
      status,
      input: { description: "Inspect retry behavior", subagent_type: "explore" },
      metadata: {
        ...(options.session !== null ? { sessionId: options.session ?? "child" } : {}),
        ...(options.background ? { background: true } : {}),
        ...(options.model ? { model: { providerID: "anthropic", modelID: "sonnet" } } : {}),
      },
      title: "Inspect retries",
      time: { start: 100, end: 200 },
      output: "task_id: child\n<task_result>Done</task_result>",
      error: "Failed",
    },
  } as Part;
}
function notice(state = "completed"): Part {
  return {
    type: "text",
    id: "notice",
    sessionID: "parent",
    messageID: "notice-message",
    synthetic: true,
    text: `<task id="child" state="${state}"><task_result>Done</task_result><task_error>Failed</task_error></task>`,
  } as Part;
}

describe("OpenCodeTaskLifecycle", () => {
  it("preserves identity and metadata while suppressing duplicates and terminal regression", () => {
    const lifecycle = new OpenCodeTaskLifecycle();
    expect(lifecycle.project(tool("pending", { session: null }))).toEqual([]);
    const started = lifecycle.project(tool("running", { model: true }));
    expect(started.map((event) => event.type)).toEqual(["started", "updated"]);
    expect(started[0]?.subagent).toMatchObject({
      subagentId: "opencode:session:child",
      model: "anthropic/sonnet",
      parentProviderItemId: "call",
    });
    expect(lifecycle.project(tool("running", { model: true }))).toEqual([]);
    const completed = lifecycle.project(tool("completed"));
    expect(completed[0]).toMatchObject({ type: "completed", status: "completed", summary: "Done" });
    expect(completed[0]?.subagent.model).toBe("anthropic/sonnet");
    expect(lifecycle.project(tool("completed"))).toEqual([]);
    expect(lifecycle.project(tool("running"))).toEqual([]);
  });
  it("keeps background Tasks active until synthetic terminal and ignores ordinary text", () => {
    const lifecycle = new OpenCodeTaskLifecycle();
    expect(lifecycle.project(tool("completed", { background: true })).at(-1)?.status).toBe(
      "running",
    );
    expect(lifecycle.project({ ...notice(), synthetic: false } as Part)).toEqual([]);
    expect(lifecycle.project(notice())[0]?.status).toBe("completed");
    expect(lifecycle.project(notice())).toEqual([]);
  });
  it("enriches a terminal-before-tool without reopening it", () => {
    const lifecycle = new OpenCodeTaskLifecycle();
    expect(lifecycle.project(notice()).at(-1)?.status).toBe("completed");
    expect(lifecycle.project(tool("completed", { background: true, model: true }))).toMatchObject([
      { type: "updated", status: "completed", subagent: { model: "anthropic/sonnet" } },
    ]);
    expect(lifecycle.stop()).toEqual([]);
  });
  it("retains linkage for metadata-free errors and interrupts only active tasks", () => {
    const lifecycle = new OpenCodeTaskLifecycle();
    lifecycle.project(tool("running"));
    expect(lifecycle.project(tool("error", { session: null }))[0]).toMatchObject({
      status: "failed",
      subagent: { providerSessionId: "child" },
    });
    expect(lifecycle.stop()).toEqual([]);
    lifecycle.project(tool("running", { call: "resume" }));
    expect(lifecycle.stop()[0]?.status).toBe("stopped");
    expect(lifecycle.project(tool("running", { call: "resume" }))).toEqual([]);
  });
  it("reopens new calls but ignores old-call replays", () => {
    const lifecycle = new OpenCodeTaskLifecycle();
    lifecycle.project(tool("completed"));
    expect(lifecycle.project(tool("running", { call: "resume" }))[0]?.status).toBe("running");
    expect(lifecycle.project(tool("completed"))).toEqual([]);
    expect(lifecycle.project(tool("completed", { call: "resume" }))[0]?.status).toBe("completed");
  });
  it("reads running envelopes and interrupted native notifications", () => {
    const lifecycle = new OpenCodeTaskLifecycle();
    const part = tool("completed");
    if (part.type !== "tool" || part.state.status !== "completed") throw new Error("fixture");
    part.state.output = '<task id="child" state="running">Started</task>';
    expect(lifecycle.project(part).at(-1)?.status).toBe("running");
    expect(lifecycle.project(notice("interrupted"))[0]?.status).toBe("stopped");
  });
  it("reads jobId metadata when no session is present", () => {
    const lifecycle = new OpenCodeTaskLifecycle();
    const part = tool("running", { session: null });
    if (part.type !== "tool" || part.state.status !== "running") throw new Error("fixture");
    part.state.metadata = { jobId: "job" };
    expect(lifecycle.project(part)[0]?.subagent.providerSessionId).toBe("job");
  });
  it("keeps a metadata-free failure identity stable when linkage arrives late", () => {
    const lifecycle = new OpenCodeTaskLifecycle();
    const failed = lifecycle.project(tool("error", { session: null }));
    const id = failed[0]?.subagent.subagentId;
    expect(id).toBe("opencode:task:parent:call");
    const enriched = lifecycle.project(tool("error"));
    expect(enriched[0]).toMatchObject({
      type: "updated",
      status: "failed",
      subagent: { subagentId: id, providerSessionId: "child" },
    });
    expect([...lifecycle.values()]).toHaveLength(1);
    expect(lifecycle.hasSession("child")).toBe(true);
  });
  it("ignores an old background notification after a new call resumes the child", () => {
    const lifecycle = new OpenCodeTaskLifecycle();
    lifecycle.project(tool("completed", { background: true }));
    lifecycle.project(notice());
    lifecycle.project(tool("running", { call: "resume" }));
    expect(lifecycle.project(notice())).toEqual([]);
    expect(lifecycle.stop()[0]?.status).toBe("stopped");
  });
  it("reconstructs deterministic event keys in a fresh projector", () => {
    const parts = [tool("running"), tool("completed")];
    const project = () => {
      const lifecycle = new OpenCodeTaskLifecycle();
      return parts.flatMap((part) => lifecycle.project(part)).map((event) => event.eventKey);
    };
    expect(project()).toEqual(project());
  });
});
