import { AgentControlMcpSettingsChangeRequest, DEFAULT_SERVER_SETTINGS } from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { agentControlSettingsPlan, agentControlSettingsSummary } from "./settingsControl.ts";

const decodeChange = Schema.decodeUnknownSync(AgentControlMcpSettingsChangeRequest);

/** Every change kind the request schema accepts. Kinds are aliases, not ServerSettings keys. */
const CHANGE_KINDS = AgentControlMcpSettingsChangeRequest.members.map(
  (member) => member.fields.kind.literal,
);

describe("Agent Control settings allowlist", () => {
  // Pinned, so any new entry (under any alias) is a deliberate, reviewed test change.
  it("allows exactly the reviewed settings", () => {
    expect(
      agentControlSettingsSummary(DEFAULT_SERVER_SETTINGS).settings.map((setting) => setting.kind),
    ).toEqual(["legacyTokenStreaming", "providerUpdateChecks"]);
    expect(CHANGE_KINDS).toEqual(["legacyTokenStreaming", "providerUpdateChecks"]);
  });

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

  // An agent must never grant itself unattended continuation after a restart. Asserted by
  // behaviour, so exposing the setting under another alias kind still fails.
  it("neither reads nor changes continue-after-restart", () => {
    const enabled = { ...DEFAULT_SERVER_SETTINGS, continueThreadsAfterRestart: true };
    const disabled = { ...DEFAULT_SERVER_SETTINGS, continueThreadsAfterRestart: false };
    expect(agentControlSettingsSummary(enabled)).toEqual(agentControlSettingsSummary(disabled));
    for (const kind of CHANGE_KINDS) {
      for (const value of [true, false]) {
        const change = decodeChange({ kind, value });
        expect(agentControlSettingsPlan(enabled, change)).toEqual(
          agentControlSettingsPlan(disabled, change),
        );
      }
    }
    expect(() => decodeChange({ kind: "continueThreadsAfterRestart", value: true })).toThrow();
  });
});
