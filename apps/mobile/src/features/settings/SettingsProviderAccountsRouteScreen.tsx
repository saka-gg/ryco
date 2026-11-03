import { useState } from "react";
import { ScrollView } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { ProviderSignInSheet, type ProviderSignInTarget } from "./ProviderSignInSheet";
import { buildProviderAccounts } from "./providerAccountsModel";

/**
 * Every connected machine's provider instances with their accounts. An instance that needs a
 * sign-in opens a sheet that runs the provider's own login on its machine.
 */
export function SettingsProviderAccountsRouteScreen() {
  const environments = useHomeEnvironments();
  const configs = useEnvironmentServerConfigs();
  const view = buildProviderAccounts({ environments, configs });
  const [target, setTarget] = useState<ProviderSignInTarget | null>(null);
  const targetNode =
    target === null
      ? undefined
      : view.nodes.find((node) => node.environmentId === target.environmentId);
  const targetRow = targetNode?.rows?.find((row) => row.instanceId === target?.instanceId);

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
      >
        <Text className="px-5 pt-4 font-sans text-sm leading-relaxed text-foreground-muted">
          A sign-in runs on the machine the provider runs on and finishes there, even when you leave
          this screen.
        </Text>
        {view.nodes.map((node) => (
          <SettingsSection key={node.environmentId} title={node.label}>
            {node.rows === null ? (
              <SettingsRow first label="Loading providers…" />
            ) : node.rows.length === 0 ? (
              <SettingsRow first label="No providers" />
            ) : (
              node.rows.map((row, index) => (
                <SettingsRow
                  key={row.key}
                  first={index === 0}
                  label={row.displayName}
                  value={row.status}
                  detail={row.detail}
                  onPress={
                    row.canSignIn
                      ? () =>
                          setTarget({
                            environmentId: row.environmentId,
                            instanceId: row.instanceId,
                            nodeLabel: node.label,
                            displayName: row.displayName,
                          })
                      : undefined
                  }
                />
              ))
            )}
          </SettingsSection>
        ))}
        {view.nodes.length === 0 ? (
          <SettingsSection>
            <SettingsRow
              first
              label="No machine connected"
              detail="Connect a machine to see its provider accounts."
            />
          </SettingsSection>
        ) : null}
        {view.offline.length > 0 ? (
          <Text className="px-5 pt-4 font-sans text-xs leading-4 text-foreground-muted">
            {`Not connected: ${view.offline.join(", ")}.`}
          </Text>
        ) : null}
      </ScrollView>
      {target !== null ? (
        <ProviderSignInSheet
          target={target}
          provider={targetRow?.provider}
          instanceEnabled={targetRow?.instanceEnabled ?? true}
          access={
            targetNode?.access ?? {
              allowed: false,
              reason: `Available when ${target.nodeLabel} is connected`,
            }
          }
          onClose={() => setTarget(null)}
        />
      ) : null}
    </>
  );
}
