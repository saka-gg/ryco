import {
  AGENT_CONTROL_EXTERNAL_ACTIVE_TASK_LIMIT_MAX,
  AGENT_CONTROL_EXTERNAL_RATE_LIMIT_MAX,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createAgentControlIntegrationForm,
  parseAgentControlIntegrationForm,
} from "./IntegrationsSettings";

const base = { ...createAgentControlIntegrationForm(), displayName: "CI" };

describe("parseAgentControlIntegrationForm limits", () => {
  it("accepts the largest active-task limit the contract allows", () => {
    const parsed = parseAgentControlIntegrationForm({
      ...base,
      activeTaskLimit: String(AGENT_CONTROL_EXTERNAL_ACTIVE_TASK_LIMIT_MAX),
    });
    expect(parsed.activeTaskLimit).toBe(AGENT_CONTROL_EXTERNAL_ACTIVE_TASK_LIMIT_MAX);
  });

  it("rejects an active-task limit above the contract cap", () => {
    expect(() =>
      parseAgentControlIntegrationForm({
        ...base,
        activeTaskLimit: String(AGENT_CONTROL_EXTERNAL_ACTIVE_TASK_LIMIT_MAX + 1),
      }),
    ).toThrow(/at most 10/);
  });

  it("accepts the largest rate limit the contract allows", () => {
    const parsed = parseAgentControlIntegrationForm({
      ...base,
      rateLimitPerMinute: String(AGENT_CONTROL_EXTERNAL_RATE_LIMIT_MAX),
    });
    expect(parsed.rateLimitPerMinute).toBe(AGENT_CONTROL_EXTERNAL_RATE_LIMIT_MAX);
  });

  it("rejects a rate limit above the contract cap", () => {
    expect(() =>
      parseAgentControlIntegrationForm({
        ...base,
        rateLimitPerMinute: String(AGENT_CONTROL_EXTERNAL_RATE_LIMIT_MAX + 1),
      }),
    ).toThrow(/at most 600/);
  });

  it("still rejects zero", () => {
    expect(() => parseAgentControlIntegrationForm({ ...base, activeTaskLimit: "0" })).toThrow(
      /positive whole number/,
    );
  });
});
