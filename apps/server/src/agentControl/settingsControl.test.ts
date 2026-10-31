import {
  AgentControlMcpSettingsChangeRequest,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { isRoutineAgentControlAction } from "./routineActions.ts";
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

  it("reads the legacy token switch from the response streaming mode", () => {
    for (const [responseStreamingMode, value] of [
      ["turn", false],
      ["paragraph", false],
      ["token", true],
    ] as const) {
      const settings = { ...DEFAULT_SERVER_SETTINGS, responseStreamingMode };
      expect(agentControlSettingsSummary(settings).settings[0]).toMatchObject({
        kind: "legacyTokenStreaming",
        value,
      });
      expect(
        agentControlSettingsPlan(settings, { kind: "legacyTokenStreaming", value: !value }),
      ).toEqual({
        kind: "changeSettings",
        change: { kind: "legacyTokenStreaming", before: value, after: !value },
      });
    }
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

  // An agent must never let its own CLI be replaced unattended. Asserted by behaviour, like the
  // setting above, so exposing it under another alias kind still fails.
  it("neither reads nor changes automatic updates", () => {
    const enabled = { ...DEFAULT_SERVER_SETTINGS, automaticUpdates: true };
    const disabled = { ...DEFAULT_SERVER_SETTINGS, automaticUpdates: false };
    expect(agentControlSettingsSummary(enabled)).toEqual(agentControlSettingsSummary(disabled));
    // With provider update checks on, no change the agent can ask for depends on it.
    for (const kind of CHANGE_KINDS) {
      for (const value of [true, false]) {
        const change = decodeChange({ kind, value });
        expect(agentControlSettingsPlan(enabled, change)).toEqual(
          agentControlSettingsPlan(disabled, change),
        );
      }
    }
    expect(() => decodeChange({ kind: "automaticUpdates", value: true })).toThrow();
  });

  // Checks on while the owner's automatic updates are on means Ryco installs CLIs on its own.
  it("asks the owner before turning on provider update checks that would start automatic updates", () => {
    const principal = {
      kind: "provider-session",
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    } as const;
    const routine = (settings: typeof DEFAULT_SERVER_SETTINGS, value: boolean) =>
      isRoutineAgentControlAction(
        principal,
        agentControlSettingsPlan(settings, { kind: "providerUpdateChecks", value }),
      );
    const checksOff = { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false };
    expect(
      agentControlSettingsPlan(
        { ...checksOff, automaticUpdates: true },
        { kind: "providerUpdateChecks", value: true },
      ),
    ).toEqual({
      kind: "changeSettings",
      change: {
        kind: "providerUpdateChecks",
        before: false,
        after: true,
        startsAutomaticUpdates: true,
      },
    });
    expect(routine({ ...checksOff, automaticUpdates: true }, true)).toBe(false);
    // Anything that starts no unattended install stays routine.
    expect(routine({ ...checksOff, automaticUpdates: false }, true)).toBe(true);
    expect(routine({ ...checksOff, automaticUpdates: true }, false)).toBe(true);
    expect(routine({ ...DEFAULT_SERVER_SETTINGS, automaticUpdates: true }, false)).toBe(true);
    expect(
      isRoutineAgentControlAction(
        principal,
        agentControlSettingsPlan(DEFAULT_SERVER_SETTINGS, {
          kind: "legacyTokenStreaming",
          value: true,
        }),
      ),
    ).toBe(true);
  });
});
