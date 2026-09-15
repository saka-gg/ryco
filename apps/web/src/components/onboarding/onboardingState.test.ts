import { EnvironmentId, ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@ryco/contracts";
import { Schema } from "effect";
import { splitUnifiedSettingsPatch } from "@ryco/shared/settingsOwnership";
import { describe, expect, it } from "vite-plus/test";
import {
  addCompletedEnvironment,
  resolveOnboardingGate,
  useOnboardingReplayStore,
} from "./onboardingState";

const fresh = { eligible: true, ready: true, completed: false, projectCount: 0 };
const localA = EnvironmentId.make("local-a");
const localB = EnvironmentId.make("local-b");

describe("local onboarding lifecycle", () => {
  it("waits for authoritative initialization and excludes ineligible surfaces", () => {
    expect(resolveOnboardingGate({ ...fresh, ready: false })).toBe("pending");
    expect(resolveOnboardingGate({ ...fresh, ready: false, projectCount: 4 })).toBe("pending");
    expect(resolveOnboardingGate({ ...fresh, eligible: false })).toBe("hidden");
    expect(resolveOnboardingGate({ ...fresh, completed: true })).toBe("hidden");
    expect(resolveOnboardingGate({ ...fresh, projectCount: 1 })).toBe("existing");
    expect(resolveOnboardingGate(fresh)).toBe("show");
  });

  it("persists lifecycle metadata through the shared client schema without writing server settings", () => {
    const completed = addCompletedEnvironment(undefined, localA);
    const { clientPatch, serverPatch } = splitUnifiedSettingsPatch({
      localOnboardingCompletedEnvironmentIds: completed,
    });
    expect(serverPatch).toEqual({});
    const saved = JSON.stringify({ ...DEFAULT_CLIENT_SETTINGS, ...clientPatch });
    const reloaded = Schema.decodeUnknownSync(ClientSettingsSchema)(JSON.parse(saved));
    expect(reloaded.localOnboardingCompletedEnvironmentIds).toEqual([localA]);
    expect(reloaded.localOnboardingCompletedEnvironmentIds?.includes(localB)).toBe(false);
    // Default preferences intentionally omit lifecycle metadata, preserving it on restore.
    const reset = { ...reloaded, ...DEFAULT_CLIENT_SETTINGS };
    expect(reset.localOnboardingCompletedEnvironmentIds).toEqual([localA]);
    expect(addCompletedEnvironment(completed, localA)).toBe(completed);
    expect(addCompletedEnvironment(completed, localB)).toEqual([localA, localB]);
  });

  it("consumes a targeted replay once so a remount cannot replay a finished tour", () => {
    useOnboardingReplayStore.getState().replay(localA);
    expect(useOnboardingReplayStore.getState().requestedFor).toBe(localA);
    useOnboardingReplayStore.getState().consume();
    expect(useOnboardingReplayStore.getState().requestedFor).toBeNull();
  });
});
