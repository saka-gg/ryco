import type { EnvironmentId } from "@ryco/contracts";

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

export function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function isGenericLocalEnvironmentLabel(value: string | null | undefined): boolean {
  const label = normalizeDisplayLabel(value);
  return label !== null && GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
}

/**
 * A node's name in pickers and labels. The primary node shows its machine name, never a generic
 * "Local" ("Device connecting…" until it knows one); other nodes their runtime name, else their
 * saved name, else their id.
 */
export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !isGenericLocalEnvironmentLabel(label);
    });
    return preferredLocalLabel ?? "Device connecting…";
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

export function resolveProjectEnvironmentLabel(input: {
  environmentId: EnvironmentId;
  label: string | null | undefined;
}): string | null {
  const label = normalizeDisplayLabel(input.label);
  if (!label) {
    return null;
  }

  if (isGenericLocalEnvironmentLabel(label)) {
    return null;
  }

  return label;
}
