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

/** A device a "No project" chat draft could start on, outside the hosted Hub. */
export interface ChatExecutionCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Connected and allowed to create work. */
  readonly reachable: boolean;
  /** Whether the device's node supports chats; null while its config is unknown. */
  readonly chatsAvailable: boolean | null;
}

/**
 * Devices an unsent "No project" chat can move to. A chat needs no project on
 * the device, only a reachable node that supports chats. The current device
 * leads, then every usable device, then the unusable ones.
 */
export function chatComposerExecutionTargets(input: {
  readonly candidates: ReadonlyArray<ChatExecutionCandidate>;
  readonly environmentId: EnvironmentId;
  /** Label for the current device when no candidate describes it. */
  readonly label: string;
}): ReadonlyArray<ComposerExecutionTarget> {
  const seen = new Set<EnvironmentId>();
  const targets: ComposerExecutionTarget[] = [];
  for (const candidate of input.candidates) {
    if (seen.has(candidate.environmentId)) continue;
    seen.add(candidate.environmentId);
    const chatsUnavailable = candidate.chatsAvailable === false;
    targets.push({
      environmentId: candidate.environmentId,
      label: candidate.label,
      disabled: !candidate.reachable || chatsUnavailable,
      status: !candidate.reachable ? "Unavailable" : chatsUnavailable ? "No chats" : "Online",
    });
  }
  if (!seen.has(input.environmentId)) {
    targets.push({
      environmentId: input.environmentId,
      label: input.label,
      disabled: true,
      status: "Unavailable",
    });
  }
  return targets.toSorted(
    (a, b) =>
      Number(b.environmentId === input.environmentId) -
        Number(a.environmentId === input.environmentId) ||
      Number(a.disabled) - Number(b.disabled) ||
      a.label.localeCompare(b.label),
  );
}
