import { AgentControlMcpSettingsChangeRequest, DEFAULT_SERVER_SETTINGS } from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { agentControlSettingsSummary } from "./settingsControl.ts";

const decodeChange = Schema.decodeUnknownSync(AgentControlMcpSettingsChangeRequest);

describe("Agent Control settings allowlist", () => {
  it("never exposes the usage-limit recovery settings", () => {
    const summary = agentControlSettingsSummary({
      ...DEFAULT_SERVER_SETTINGS,
      autoResumeLimitedThreads: true,
      snoozeLimitedThreads: true,
    });
    const kinds = summary.settings.map((setting) => setting.kind as string);
    expect(kinds).not.toContain("autoResumeLimitedThreads");
    expect(kinds).not.toContain("snoozeLimitedThreads");
  });

  it("cannot change the usage-limit recovery settings", () => {
    expect(() => decodeChange({ kind: "autoResumeLimitedThreads", value: true })).toThrow();
    expect(() => decodeChange({ kind: "snoozeLimitedThreads", value: true })).toThrow();
  });

  // An agent must never grant itself unattended continuation after a restart.
  it("never exposes continue-after-restart", () => {
    const summary = agentControlSettingsSummary({
      ...DEFAULT_SERVER_SETTINGS,
      continueThreadsAfterRestart: true,
    });
    expect(summary.settings.map((setting) => setting.kind as string)).not.toContain(
      "continueThreadsAfterRestart",
    );
  });

  it("cannot change continue-after-restart", () => {
    expect(() => decodeChange({ kind: "continueThreadsAfterRestart", value: true })).toThrow();
  });
});
