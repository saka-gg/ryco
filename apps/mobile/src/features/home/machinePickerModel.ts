import type { EnvironmentId } from "@ryco/contracts";

import type { InboxEnvironment } from "../inbox/inboxModel";

// The machine picker at the top left of a tab: which machine the list is
// narrowed to, with a dot for how it is connected, and a way to manage them.

export type MachinePickerDot = "connected" | "partial" | "offline";

export interface MachinePickerModel {
  readonly label: string;
  readonly dot: MachinePickerDot;
  readonly accessibilityLabel: string;
  readonly actions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly subtitle?: string;
    readonly state?: "on" | "off";
  }>;
}

export const MACHINE_PICKER_ALL = "all";
export const MACHINE_PICKER_MANAGE = "manage";
const MACHINE_PREFIX = "machine:";

function dotOf(environments: ReadonlyArray<Pick<InboxEnvironment, "connectionState" | "stale">>) {
  const connected = environments.filter(
    (environment) => environment.connectionState === "connected" && environment.stale !== true,
  ).length;
  if (connected === 0) return "offline";
  return connected === environments.length ? "connected" : "partial";
}

function stateWord(environment: Pick<InboxEnvironment, "connectionState" | "stale">): string {
  if (environment.stale === true) return "Offline";
  switch (environment.connectionState) {
    case "connected":
      return "Connected";
    case "read-only":
      return "Read only";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
  }
}

export function buildMachinePickerModel(input: {
  readonly environments: ReadonlyArray<
    Pick<InboxEnvironment, "environmentId" | "label" | "connectionState" | "stale">
  >;
  readonly selected: EnvironmentId | null;
}): MachinePickerModel {
  const selected = input.environments.find(
    (environment) => environment.environmentId === input.selected,
  );
  const label = selected?.label ?? "All machines";
  const dot = dotOf(selected ? [selected] : input.environments);
  return {
    label,
    dot,
    accessibilityLabel: `Machine: ${label}. Choose a machine`,
    actions: [
      {
        id: MACHINE_PICKER_ALL,
        title: "All machines",
        state: selected === undefined ? "on" : "off",
      },
      ...input.environments.map((environment) => ({
        id: `${MACHINE_PREFIX}${environment.environmentId}`,
        title: environment.label,
        subtitle: stateWord(environment),
        state: environment.environmentId === input.selected ? ("on" as const) : ("off" as const),
      })),
      { id: MACHINE_PICKER_MANAGE, title: "Manage machines…" },
    ],
  };
}

/** The machine a picker action names, or null for All; undefined for Manage. */
export function machinePickerSelection(actionId: string): EnvironmentId | null | undefined {
  if (actionId === MACHINE_PICKER_ALL) return null;
  if (actionId.startsWith(MACHINE_PREFIX)) {
    return actionId.slice(MACHINE_PREFIX.length) as EnvironmentId;
  }
  return undefined;
}
