import type { WorkspaceMachineCatalogEntry } from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId } from "@ryco/contracts";

export interface ComposerExecutionTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly disabled?: boolean;
  readonly status?: string;
}

/** Directory eligibility is separate from having this project's shell already loaded. */
export function hostedComposerExecutionTargets(input: {
  readonly machines: ReadonlyArray<WorkspaceMachineCatalogEntry>;
  readonly ready: boolean;
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): ReadonlyArray<ComposerExecutionTarget> {
  const targets = input.machines
    .filter((machine) => !machine.removed && machine.revokedAt === null)
    .map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      disabled: !input.ready || !machine.canMutate,
      status: !input.ready
        ? "Refreshing devices…"
        : machine.canMutate
          ? "Online"
          : machine.accessReasons.includes("native-client-required")
            ? "Use the native app"
            : machine.accessReasons.includes("viewer")
              ? "Read only"
              : machine.presence.online
                ? "Unavailable"
                : "Offline",
    }));
  if (!targets.some((target) => target.environmentId === input.environmentId)) {
    targets.push({
      environmentId: input.environmentId,
      label: input.label,
      disabled: true,
      status: "Unavailable",
    });
  }
  return targets.toSorted((a, b) => {
    return (
      Number(b.environmentId === input.environmentId) -
        Number(a.environmentId === input.environmentId) ||
      Number(a.disabled) - Number(b.disabled) ||
      a.label.localeCompare(b.label)
    );
  });
}
