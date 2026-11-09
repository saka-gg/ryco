import { AcpRegistrySettings } from "@ryco/contracts/acp-registry";
import { ProviderDriverKind } from "@ryco/contracts/provider-instance";
import {
  ClaudeSettings,
  CodexSettings,
  CopilotSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
} from "@ryco/contracts/settings";
import type * as Schema from "effect/Schema";

export type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * A provider driver as every client presents it: its label, its settings schema (whose field
 * annotations the settings forms render generically) and an optional early-access marker. Each
 * client adds its own icon.
 */
export interface ProviderDriverDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly settingsSchema: ProviderSettingsSchema;
  /**
   * A short marker shown next to every instance of the driver, for drivers that still ship
   * behind an early-access or preview gate.
   */
  readonly badgeLabel?: string;
}

/** The drivers a client can add instances of, in the order settings lists them. */
export const PROVIDER_DRIVER_DEFINITIONS: readonly ProviderDriverDefinition[] = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", settingsSchema: CodexSettings },
  {
    value: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  {
    value: ProviderDriverKind.make("copilot"),
    label: "GitHub Copilot",
    settingsSchema: CopilotSettings,
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    badgeLabel: "Early Access",
    settingsSchema: CursorSettings,
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    badgeLabel: "Early Access",
    settingsSchema: GrokSettings,
  },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    settingsSchema: OpenCodeSettings,
  },
  {
    value: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    settingsSchema: AcpRegistrySettings,
  },
];

const DEFINITION_BY_VALUE: ReadonlyMap<string, ProviderDriverDefinition> = new Map(
  PROVIDER_DRIVER_DEFINITIONS.map((definition) => [definition.value, definition]),
);

/**
 * The definition of an instance's driver, or `undefined` for a driver this build does not ship
 * (a fork's, or a newer node's), which clients show read-only so its config round-trips intact.
 */
export function getProviderDriverDefinition(
  driver: string | undefined,
): ProviderDriverDefinition | undefined {
  return driver === undefined ? undefined : DEFINITION_BY_VALUE.get(driver);
}
