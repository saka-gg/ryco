import type { EnvironmentId } from "@ryco/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { DeviceAvatar } from "../../components/DeviceIcon";
import { MACHINE_DIMMED_OPACITY, useMachinesLook } from "./machinesSheetLook";
import { machineListRow, type MachineFacts } from "./machinesSheetModel";

/**
 * One machine in the Machines sheet (`.cr`): the picker's avatar with its ring and dot, the
 * name, one detail line led by its status, a white checkmark on the machine in use and a
 * chevron. A tap opens the machine's own page.
 */
export function MachineListRow(props: {
  readonly environmentId: EnvironmentId;
  readonly platformOs?: string | undefined;
  readonly label: string;
  readonly facts: MachineFacts;
  readonly showDivider: boolean;
  readonly onPress: () => void;
}) {
  const look = useMachinesLook();
  const row = machineListRow(props.facts);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.accessibilityLabel}
      accessibilityHint="Opens the machine's page"
      accessibilityState={{ selected: props.facts.selected }}
      onPress={props.onPress}
      style={({ pressed }) => ({
        minHeight: 62,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 10,
        paddingLeft: 14,
        paddingRight: 12,
        backgroundColor: pressed ? look.pressed : undefined,
      })}
    >
      {props.showDivider ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 58,
            right: 0,
            height: 1,
            backgroundColor: look.line,
          }}
        />
      ) : null}
      <View style={{ opacity: row.dimmed ? MACHINE_DIMMED_OPACITY : 1 }}>
        <DeviceAvatar
          environmentId={props.environmentId}
          label={props.label}
          platformOs={props.platformOs}
          tone={row.tone}
          size={34}
          cutout={look.card}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0, opacity: row.dimmed ? MACHINE_DIMMED_OPACITY : 1 }}>
        <Text
          numberOfLines={1}
          className="font-ryco-medium"
          style={{ fontSize: 16, color: look.foreground }}
        >
          {props.label}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 13, marginTop: 2, color: look.muted }}>
          <Text style={{ color: row.statusConnecting ? look.amber : look.muted }}>
            {row.status}
          </Text>
          {row.detailRest}
        </Text>
        {row.hint ? (
          <Text numberOfLines={2} style={{ fontSize: 13, marginTop: 2, color: look.muted }}>
            {row.hint}
          </Text>
        ) : null}
        {row.notice ? (
          <Text numberOfLines={2} style={{ fontSize: 13, marginTop: 2, color: look.amber }}>
            {row.notice}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {props.facts.selected ? (
          <SymbolView
            name="checkmark"
            size={17}
            weight="semibold"
            tintColor={look.check}
            type="monochrome"
          />
        ) : null}
        <SymbolView
          name="chevron.right"
          size={14}
          weight="semibold"
          tintColor={look.faint}
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}
