import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHostedHubStore } from "../../hostedHub/state";
import { acquireMobileHostedNode } from "../../hostedHub/acquireNode";
import { acquireBeforeNodeSecurity } from "../e2ee/acquireBeforeNodeSecurity";
import { useAuthoritativeNodeTrust } from "./useAuthoritativeNodeTrust";
import { buildNeedsVerificationRows } from "./needsVerificationModel";

export function NeedsVerificationSection() {
  const navigation = useNavigation();
  const nodes = useHostedHubStore((state) => state.nodes);
  const trust = useAuthoritativeNodeTrust(
    nodes.map((node) => ({ environmentId: node.environmentId, nodeId: node.id })),
  );
  const rows = buildNeedsVerificationRows({ nodes, trustByEnvironmentId: trust });
  const iconColor = useThemeColor("--color-icon-muted");
  if (rows.length === 0) return null;

  return (
    <View className="mx-4 mb-3 mt-3 rounded-2xl border border-warning-border bg-warning-bg">
      <Text className="px-4 pb-2 pt-3 text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
        Needs verification
      </Text>
      {rows.map((row, index) => (
        <Pressable
          key={row.environmentId}
          accessibilityRole="button"
          accessibilityLabel={`Verify ${row.label}`}
          onPress={() => {
            void acquireBeforeNodeSecurity({
              nodeId: row.nodeId,
              acquireNode: acquireMobileHostedNode,
              openSecurity: () => navigation.navigate("SettingsNodeSecurity", row.route),
            });
          }}
          className={`min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 ${index > 0 ? "border-t border-warning-border" : ""}`}
        >
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-ryco-bold text-foreground" numberOfLines={1}>
              {row.label}
            </Text>
            <Text className="mt-0.5 font-sans text-xs text-foreground-muted" numberOfLines={1}>
              {row.detail}
            </Text>
            {row.lockedHistory ? (
              <Text className="mt-1 font-sans text-xs text-warning">
                Prior workspace history is locked until this machine is verified again.
              </Text>
            ) : null}
          </View>
          <SymbolView name="chevron.right" size={14} tintColor={iconColor} type="monochrome" />
        </Pressable>
      ))}
    </View>
  );
}
