import { useRef, useLayoutEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { WS_METHODS } from "@ryco/contracts";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useSettingsTarget, useSettingsEditingScope } from "../../settingsTarget";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { readEnvironmentConnection } from "../../environments/runtime";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { SettingsSection } from "./settingsLayout";
import { SessionImportPanel } from "./SessionImportPanel";
export function SessionImportSettings() {
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const tier = usePresentationTier();
  const capability = useHostedRpcCapability(WS_METHODS.sessionImportRun);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const current = useRef({ allowed: false, environmentId: target?.environmentId });
  const allowed =
    !!target?.connected &&
    target.canManage === true &&
    target.canMutate !== false &&
    capability.allowed;
  const environmentId = target?.environmentId;
  useLayoutEffect(() => {
    current.current = { allowed, environmentId };
  }, [allowed, environmentId]);
  if (tier === "phone" || scope === "client" || !target) return null;
  return (
    <SettingsSection title="Import local conversations" owner="node">
      <SessionImportPanel
        key={target.environmentId}
        nodeLabel={target.nodeLabel}
        allowed={allowed}
        projects={projects.filter((project) => project.environmentId === target.environmentId)}
        providerOptions={target.serverConfig?.providers ?? []}
        client={() => {
          const connection = readEnvironmentConnection(target.environmentId);
          if (
            !connection ||
            !current.current.allowed ||
            current.current.environmentId !== target.environmentId
          )
            throw new Error("Reconnect with owner access before importing.");
          return connection.client.sessionImport;
        }}
      />
    </SettingsSection>
  );
}
