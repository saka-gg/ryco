import type { ProviderDriverKind } from "@ryco/contracts";
import {
  PROVIDER_DRIVER_DEFINITIONS,
  type ProviderDriverDefinition,
} from "@ryco/client-runtime/state/settings/providerDrivers";
import {
  ACPRegistryIcon,
  ClaudeAI,
  CursorIcon,
  GithubCopilotIcon,
  GrokIcon,
  type Icon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";

/**
 * A provider driver as the web presents it: the shared definition (label, settings schema with
 * field annotations, early-access marker) from `@ryco/client-runtime`, plus its icon.
 */
export interface ProviderClientDefinition extends ProviderDriverDefinition {
  readonly icon: Icon;
}

const ICON_BY_DRIVER: Readonly<Record<string, Icon>> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  copilot: GithubCopilotIcon,
  cursor: CursorIcon,
  grok: GrokIcon,
  opencode: OpenCodeIcon,
  acpRegistry: ACPRegistryIcon,
};

export const PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] =
  PROVIDER_DRIVER_DEFINITIONS.map((definition) =>
    Object.assign({}, definition, { icon: ICON_BY_DRIVER[definition.value]! }),
  );

export const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<
  Record<ProviderDriverKind, ProviderClientDefinition>
> = Object.fromEntries(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
);

export const DRIVER_OPTIONS = PROVIDER_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = PROVIDER_CLIENT_DEFINITION_BY_VALUE;
export type DriverOption = ProviderClientDefinition;

/**
 * Look up the driver metadata for an instance's `driver` field. Returns `undefined` for fork /
 * unknown drivers so callers can decide how to render them — typically by falling back to a
 * generic card.
 */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}
