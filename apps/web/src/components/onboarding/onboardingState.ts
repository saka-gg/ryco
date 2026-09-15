import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

export type OnboardingStep = "providers" | "project" | "tour";
export const ONBOARDING_STEPS: readonly OnboardingStep[] = ["providers", "project", "tour"];
export type OnboardingOutcome = "completed" | "skipped" | "existing";

export function resolveOnboardingGate(input: {
  eligible: boolean;
  ready: boolean;
  completed: boolean;
  projectCount: number;
}): "hidden" | "pending" | "existing" | "show" {
  if (!input.eligible || input.completed) return "hidden";
  if (!input.ready) return "pending";
  return input.projectCount > 0 ? "existing" : "show";
}

/** Preserve other installations and avoid duplicate lifecycle writes. */
export function addCompletedEnvironment(
  completed: readonly EnvironmentId[] | undefined,
  environmentId: EnvironmentId,
): readonly EnvironmentId[] {
  return completed?.includes(environmentId) ? completed : [...(completed ?? []), environmentId];
}

export const useOnboardingReplayStore = create<{
  requestedFor: EnvironmentId | null;
  replay: (environmentId: EnvironmentId) => void;
  consume: () => void;
}>((set) => ({
  requestedFor: null,
  replay: (requestedFor) => set({ requestedFor }),
  consume: () => set({ requestedFor: null }),
}));
