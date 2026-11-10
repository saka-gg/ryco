import type {
  EnvironmentMachineKind,
  ExecutionEnvironmentDescriptor,
  ServerConfig,
} from "@ryco/contracts";
import {
  inferEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@ryco/shared/environmentIcon";

// The one rule for which icon a machine gets on the phone: the machine
// picker, thread rows, Machines and every other place draw it from here.

/** The SF Symbol each machine kind is drawn with. */
export const MACHINE_KIND_SYMBOL = {
  laptop: "laptopcomputer",
  desktop: "desktopcomputer",
  "mini-pc": "macmini",
  workstation: "macpro.gen3",
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  windows: "pc",
} as const satisfies Record<EnvironmentMachineKind, string>;

export type MachineSymbol = (typeof MACHINE_KIND_SYMBOL)[EnvironmentMachineKind];

/** What the phone may know about a machine, from the most to the least authoritative. */
export interface MachineKindInput {
  readonly label: string;
  /** What the node last reported live: its `environmentIcon` setting and descriptor. */
  readonly config: Pick<ServerConfig, "settings" | "environment"> | null;
  /** A directly paired machine's last descriptor, kept while it is not connected. */
  readonly descriptor: Pick<ExecutionEnvironmentDescriptor, "label" | "platform"> | null;
  /** The node catalog's kind (a Hub machine's directory platform, or a guess from it). */
  readonly catalogKind: EnvironmentMachineKind | null;
  /** `platform.os` when a caller knows it and nothing above does. */
  readonly platformOs?: string | null | undefined;
}

/**
 * A machine's kind, the machine's own choice first: the desktop's icon
 * setting, then its platform hint, then a guess from its OS and name
 * (`resolveEnvironmentMachineKind`). Without anything from the machine itself,
 * the node catalog's kind, then a guess from what the caller knows.
 */
export function resolveMachineKind(input: MachineKindInput): EnvironmentMachineKind {
  const descriptor = input.config?.environment ?? input.descriptor;
  if (input.config !== null || descriptor !== null) {
    return resolveEnvironmentMachineKind(input.config, descriptor);
  }
  return (
    input.catalogKind ?? inferEnvironmentMachineKind(input.platformOs ?? undefined, input.label)
  );
}
