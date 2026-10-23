import { describe, expect, it } from "vite-plus/test";

import { classifyTaskAgentKind, endsTaskLiveness } from "./taskClassification.ts";

describe("endsTaskLiveness", () => {
  it("ends liveness on idle and every terminal status only", () => {
    for (const status of ["idle", "completed", "failed", "stopped", "cancelled", "interrupted"]) {
      expect(endsTaskLiveness(status)).toBe(true);
    }
    for (const status of [undefined, "pending", "starting", "running", "waiting"]) {
      expect(endsTaskLiveness(status)).toBe(false);
    }
  });
});

describe("classifyTaskAgentKind", () => {
  it("classifies agent-flavored, watch-loop, and inert types", () => {
    expect(classifyTaskAgentKind({ taskType: "local_agent" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_workflow" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: undefined })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "brand_new_agent_type" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_bash" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "monitor" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "plan" })).toBe("background");
  });

  it("agent-owned tasks are background unless themselves agent-flavored", () => {
    expect(classifyTaskAgentKind({ taskType: "local_bash", agentId: "owner" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: undefined, agentId: "owner" })).toBe("background");
    // Nested agent: outlives its parent, stays in the roster.
    expect(classifyTaskAgentKind({ taskType: "local_agent", agentId: "owner" })).toBe("agent");
  });

  it("treats blank and whitespace-only agentId as absent", () => {
    expect(classifyTaskAgentKind({ taskType: "local_bash", agentId: "" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: undefined, agentId: "  " })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_agent", agentId: "" })).toBe("agent");
  });
});
