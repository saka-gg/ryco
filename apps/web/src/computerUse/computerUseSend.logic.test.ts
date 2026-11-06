import { describe, expect, it } from "vite-plus/test";

import { computerUseSendBlocker, isExternalOpenCodeInstance } from "./computerUseSend.logic";

describe("computerUseSendBlocker", () => {
  const ready = { provider: "codex", agentControlEnabled: true, externalOpenCode: false };
  it("allows a supported provider with Agent Control on", () => {
    expect(computerUseSendBlocker(ready)).toBeNull();
  });
  it("names what blocks Computer Use", () => {
    expect(computerUseSendBlocker({ ...ready, provider: "grok" })).toContain("does not support");
    expect(computerUseSendBlocker({ ...ready, agentControlEnabled: false })).toContain(
      "Turn on Computer Use",
    );
    expect(
      computerUseSendBlocker({ ...ready, provider: "opencode", externalOpenCode: true }),
    ).toContain("managed OpenCode");
  });
  it("detects an external OpenCode server", () => {
    expect(isExternalOpenCodeInstance("opencode", { serverUrl: "http://x" })).toBe(true);
    expect(isExternalOpenCodeInstance("opencode", { serverUrl: "" })).toBe(false);
    expect(isExternalOpenCodeInstance("codex", { serverUrl: "http://x" })).toBe(false);
    expect(isExternalOpenCodeInstance("opencode", null)).toBe(false);
  });
});
