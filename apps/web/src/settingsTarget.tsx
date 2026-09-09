import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { createContext, useContext, type ReactNode } from "react";

/**
 * The exact node whose settings are displayed by the open settings surface.
 *
 * Most of the application intentionally reads the primary server snapshot. A
 * settings dialog is different: Desktop can open a remote Hub node without
 * replacing its colocated primary backend, so node-owned reads and writes must
 * carry the selected environment explicitly instead of falling back to that
 * primary connection.
 */
export interface SettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly nodeLabel: string;
  readonly serverConfig: ServerConfig | null;
  readonly primary: boolean;
  readonly connected: boolean;
  readonly canManage?: boolean;
  readonly canMutate?: boolean;
}

export type SettingsEditingScope = "client" | "node" | "all";
const SettingsEditingScopeContext = createContext<SettingsEditingScope>("all");
export const SettingsEditingScopeProvider = SettingsEditingScopeContext.Provider;
export function useSettingsEditingScope(): SettingsEditingScope {
  return useContext(SettingsEditingScopeContext);
}

export function resolveSettingsTargetEnvironmentId(input: {
  readonly requestedEnvironmentId: EnvironmentId | null;
  readonly routedEnvironmentId: EnvironmentId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly desktopLocalEnvironmentId?: EnvironmentId | null;
}): EnvironmentId | null {
  const selected =
    input.requestedEnvironmentId ??
    input.routedEnvironmentId ??
    input.activeEnvironmentId ??
    input.primaryEnvironmentId ??
    null;
  // The colocated node has a Hub alias, but Desktop already owns a direct
  // primary connection to it. Its native relay intentionally is never opened.
  return selected && selected === input.desktopLocalEnvironmentId && input.primaryEnvironmentId
    ? input.primaryEnvironmentId
    : selected;
}

const SettingsTargetContext = createContext<SettingsTarget | null>(null);

export function SettingsTargetProvider(props: {
  readonly value: SettingsTarget | null;
  readonly children: ReactNode;
}) {
  return (
    <SettingsTargetContext.Provider value={props.value}>
      {props.children}
    </SettingsTargetContext.Provider>
  );
}

export function useSettingsTarget(): SettingsTarget | null {
  return useContext(SettingsTargetContext);
}
