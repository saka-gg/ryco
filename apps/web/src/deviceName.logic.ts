import type { EnvironmentId } from "@ryco/contracts";

/** Names are presentation only: a rename must never change a device's identity or routing. */
export function resolveDeviceName(input: {
  readonly environmentId: EnvironmentId | null;
  readonly primaryEnvironmentId?: EnvironmentId | null;
  readonly localHubEnvironmentId?: EnvironmentId | null;
  readonly machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly fallback?: string | null;
}): string {
  const catalogId =
    input.environmentId !== null && input.environmentId === input.primaryEnvironmentId
      ? (input.localHubEnvironmentId ?? input.environmentId)
      : input.environmentId;
  const label = input.machines.find((machine) => machine.environmentId === catalogId)?.label.trim();
  return label || input.fallback?.trim() || "Device connecting…";
}
