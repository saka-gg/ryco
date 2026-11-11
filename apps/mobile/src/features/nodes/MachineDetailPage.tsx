import type { EnvironmentId } from "@ryco/contracts";
import type { ReactNode } from "react";
import { Pressable, Switch, View } from "react-native";
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { machineSettingsSummary } from "../settings/machine/machineSettingsModel";
import { useMachineSettings } from "../settings/machine/useMachineSettings";
import { deviceIconChoiceLabel, useDeviceIconEditable } from "./DeviceIconPicker";
import { DeviceAvatar } from "../../components/DeviceIcon";
import {
  MACHINE_ACTION_OFF_OPACITY,
  MACHINE_DIMMED_OPACITY,
  MACHINE_PAGE_NAV_HEIGHT,
  MACHINE_PAGE_TITLE_AFTER,
  type MachinesLook,
  useMachinesLook,
} from "./machinesSheetLook";
import { MACHINE_PAGE_TITLE_FADE } from "./machinePageMotion";
import {
  FORGET_FOOTER,
  machineDetail,
  machineSettingsFooter,
  type MachineAction,
  type MachineActionId,
  type MachineFacts,
  type MachineInfoRow,
} from "./machinesSheetModel";

/**
 * The fading title's inset from both edges: the mockup's 90 pt let a long name run under
 * "‹ Machines", so it clears the back link instead.
 */
const TITLE_INSET = 112;

/** A machine's own settings pages, each pushed above the sheet. */
export type MachineSettingsPage =
  | "SettingsMachineProviders"
  | "SettingsMachineAgents"
  | "SettingsMachineWork"
  | "SettingsMachineSystem"
  | "SettingsMachineImport";

export interface MachineDetailPageProps {
  readonly environmentId: EnvironmentId;
  readonly platformOs?: string | undefined;
  readonly facts: MachineFacts;
  /** A connected owner: may change the icon when the machine supports it. */
  readonly canEditIcon: boolean;
  /** A connection action is running: every action waits for it. */
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onAction: (id: MachineActionId) => void;
  readonly onRename: () => void;
  readonly onIcon: () => void;
  readonly onForget: () => void;
  readonly onSecurity: () => void;
  readonly onSettings: (page: MachineSettingsPage) => void;
}

/**
 * One machine's page inside the Machines sheet (mockup `.detail`): its avatar, name and status,
 * the 4 buttons the owner chose under them, then Connection, Settings, Access, Appearance and,
 * for a machine paired directly, the danger zone. The title fades into the bar on scroll.
 */
export function MachineDetailPage(props: MachineDetailPageProps) {
  const look = useMachinesLook();
  const reduceMotion = useReducedMotion();
  const { facts } = props;
  const icon = useDeviceIconEditable(props.environmentId, props.canEditIcon);
  const detail = machineDetail(facts, { iconEditable: icon.editable });
  const settings = useMachineSettings(props.environmentId);
  const summary = machineSettingsSummary(settings.config);
  const settingsFooter = machineSettingsFooter(facts, settings.readOnlyReason);

  const titleShown = useSharedValue(0);
  const titleOpacity = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    const shown = event.contentOffset.y > MACHINE_PAGE_TITLE_AFTER ? 1 : 0;
    if (shown === titleShown.get()) return;
    titleShown.set(shown);
    titleOpacity.set(reduceMotion ? shown : withTiming(shown, MACHINE_PAGE_TITLE_FADE));
  });
  const titleStyle = useAnimatedStyle(() => ({ opacity: titleOpacity.get() }));

  const run = (id: MachineActionId) => {
    if (props.busy) return;
    if (id === "rename") props.onRename();
    else props.onAction(id);
  };

  return (
    <View style={{ flex: 1, backgroundColor: look.sheet }} accessibilityViewIsModal>
      <View
        style={{
          height: MACHINE_PAGE_NAV_HEIGHT,
          paddingTop: 14,
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: look.sheet,
          zIndex: 2,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to Machines"
          onPress={props.onBack}
          hitSlop={6}
          style={({ pressed }) => ({
            height: 44,
            flexDirection: "row",
            alignItems: "center",
            gap: 2,
            paddingLeft: 8,
            paddingRight: 12,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <SymbolView
            name="chevron.left"
            size={20}
            weight="semibold"
            tintColor={look.link}
            type="monochrome"
          />
          <Text style={{ fontSize: 16, color: look.link }}>Machines</Text>
        </Pressable>
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: TITLE_INSET,
              right: TITLE_INSET,
              top: 14,
              bottom: 0,
              justifyContent: "center",
            },
            titleStyle,
          ]}
        >
          <Text
            numberOfLines={1}
            accessibilityElementsHidden
            importantForAccessibility="no"
            className="font-ryco-bold"
            style={{ fontSize: 16, textAlign: "center", color: look.foreground }}
          >
            {facts.label}
          </Text>
        </Animated.View>
      </View>

      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 60 }}
      >
        <View style={{ alignItems: "center", paddingTop: 6, paddingHorizontal: 24 }}>
          <View style={{ opacity: detail.dimmed ? MACHINE_DIMMED_OPACITY : 1 }}>
            <DeviceAvatar
              environmentId={props.environmentId}
              label={facts.label}
              platformOs={props.platformOs}
              tone={detail.tone}
              size={64}
              cutout={look.sheet}
            />
          </View>
          <Text
            accessibilityRole="header"
            className="font-ryco-bold"
            style={{ fontSize: 22, marginTop: 14, textAlign: "center", color: look.foreground }}
          >
            {facts.label}
          </Text>
          <Text style={{ fontSize: 13, marginTop: 4, textAlign: "center", color: look.muted }}>
            {detail.statusLine}
          </Text>
          {detail.hint ? (
            <Text style={{ fontSize: 13, marginTop: 4, textAlign: "center", color: look.muted }}>
              {detail.hint}
            </Text>
          ) : null}
          {detail.notices.map((notice) => (
            <Text
              key={notice}
              style={{ fontSize: 13, marginTop: 4, textAlign: "center", color: look.amber }}
            >
              {notice}
            </Text>
          ))}
        </View>

        <ActionBar actions={detail.actions} busy={props.busy} look={look} onPress={run} />

        <GroupLabel look={look}>Connection</GroupLabel>
        <Group look={look}>
          {detail.connection.map((row, index) => (
            <InfoRow
              key={row.label}
              row={row}
              first={index === 0}
              busy={props.busy}
              look={look}
              onAction={run}
            />
          ))}
        </Group>
        {detail.connectionFooter ? <Footer look={look}>{detail.connectionFooter}</Footer> : null}

        <GroupLabel look={look}>Settings</GroupLabel>
        <Group look={look}>
          <PageRow
            first
            look={look}
            label="Providers"
            value={summary.providers}
            onPress={() => props.onSettings("SettingsMachineProviders")}
          />
          <PageRow
            look={look}
            label="Agents"
            value={summary.agents}
            onPress={() => props.onSettings("SettingsMachineAgents")}
          />
          <PageRow
            look={look}
            label="Work"
            onPress={() => props.onSettings("SettingsMachineWork")}
          />
          <PageRow
            look={look}
            label="System"
            onPress={() => props.onSettings("SettingsMachineSystem")}
          />
          <PageRow
            look={look}
            label="Import conversations"
            onPress={() => props.onSettings("SettingsMachineImport")}
          />
        </Group>
        {settingsFooter ? <Footer look={look}>{settingsFooter}</Footer> : null}

        <GroupLabel look={look}>Access</GroupLabel>
        <Group look={look}>
          <PageRow
            first
            look={look}
            label="Pairing links & clients"
            onPress={() => run("access")}
          />
          {detail.security ? (
            <PageRow look={look} label="Node security" onPress={props.onSecurity} />
          ) : null}
        </Group>
        <Footer look={look}>{detail.accessFooter}</Footer>

        <GroupLabel look={look}>Appearance</GroupLabel>
        <Group look={look}>
          <PageRow
            first
            look={look}
            label="Name"
            value={facts.label}
            off={!detail.renameEnabled || props.busy}
            onPress={() => run("rename")}
          />
          <PageRow
            look={look}
            label="Device icon"
            value={deviceIconChoiceLabel(icon.choice)}
            off={!icon.editable}
            onPress={props.onIcon}
          />
        </Group>
        {detail.iconFooter ? <Footer look={look}>{detail.iconFooter}</Footer> : null}

        {detail.forget ? (
          <>
            <GroupLabel look={look}>Danger zone</GroupLabel>
            <Group look={look}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Forget ${facts.label}`}
                accessibilityState={{ disabled: props.busy }}
                disabled={props.busy}
                onPress={props.onForget}
                style={({ pressed }) => ({
                  minHeight: 48,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? look.pressed : undefined,
                  opacity: props.busy ? MACHINE_ACTION_OFF_OPACITY : 1,
                })}
              >
                <Text style={{ fontSize: 15.5, color: look.red }}>Forget machine</Text>
              </Pressable>
            </Group>
            <Footer look={look}>{FORGET_FOOTER}</Footer>
          </>
        ) : null}
      </Animated.ScrollView>
    </View>
  );
}

/** The 4 buttons under the header (the mockup's `.bar`): icon over label, hairlines between. */
function ActionBar(props: {
  readonly actions: ReadonlyArray<MachineAction>;
  readonly busy: boolean;
  readonly look: MachinesLook;
  readonly onPress: (id: MachineActionId) => void;
}) {
  const { look } = props;
  return (
    <View
      style={{
        marginTop: 18,
        marginHorizontal: 16,
        flexDirection: "row",
        borderRadius: 16,
        overflow: "hidden",
        backgroundColor: look.card,
      }}
    >
      {props.actions.map((action, index) => {
        const enabled = action.enabled && !props.busy;
        return (
          <Pressable
            key={action.id}
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel}
            accessibilityState={{ disabled: !enabled }}
            disabled={!enabled}
            onPress={() => props.onPress(action.id)}
            style={({ pressed }) => ({
              flex: 1,
              height: 58,
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              backgroundColor: pressed ? look.barPressed : undefined,
            })}
          >
            {index > 0 ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 14,
                  bottom: 14,
                  width: 1,
                  backgroundColor: look.line,
                }}
              />
            ) : null}
            <View
              style={{
                alignItems: "center",
                gap: 4,
                opacity: action.enabled ? 1 : MACHINE_ACTION_OFF_OPACITY,
              }}
            >
              <SymbolView
                name={action.symbol}
                size={20}
                tintColor={look.foreground}
                type="monochrome"
              />
              <Text
                numberOfLines={1}
                className="font-ryco-bold"
                style={{ fontSize: 11.5, color: look.foreground }}
              >
                {action.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function GroupLabel(props: { readonly look: MachinesLook; readonly children: ReactNode }) {
  return (
    <Text
      accessibilityRole="header"
      className="font-ryco-medium"
      style={{
        fontSize: 13,
        color: props.look.muted,
        paddingTop: 22,
        paddingHorizontal: 20,
        paddingBottom: 7,
      }}
    >
      {props.children}
    </Text>
  );
}

function Group(props: { readonly look: MachinesLook; readonly children: ReactNode }) {
  return (
    <View
      style={{
        marginHorizontal: 16,
        borderRadius: 16,
        overflow: "hidden",
        backgroundColor: props.look.card,
      }}
    >
      {props.children}
    </View>
  );
}

function Footer(props: { readonly look: MachinesLook; readonly children: ReactNode }) {
  return (
    <Text
      style={{
        fontSize: 12.5,
        lineHeight: 17.5,
        color: props.look.muted,
        paddingTop: 8,
        paddingHorizontal: 20,
      }}
    >
      {props.children}
    </Text>
  );
}

function RowDivider(props: { readonly look: MachinesLook }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: 16,
        right: 0,
        height: 1,
        backgroundColor: props.look.line,
      }}
    />
  );
}

const ROW_STYLE = {
  minHeight: 48,
  flexDirection: "row",
  alignItems: "center",
  gap: 12,
  paddingLeft: 16,
  paddingRight: 14,
} as const;

/** `.li.tap`: a row that opens something, its value on the right and a chevron. */
function PageRow(props: {
  readonly look: MachinesLook;
  readonly label: string;
  readonly value?: string;
  readonly first?: boolean;
  readonly off?: boolean;
  readonly onPress: () => void;
}) {
  const { look } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.value ? `${props.label}, ${props.value}` : props.label}
      accessibilityState={{ disabled: props.off === true }}
      disabled={props.off === true}
      onPress={props.onPress}
      style={({ pressed }) => ({
        ...ROW_STYLE,
        backgroundColor: pressed ? look.pressed : undefined,
        opacity: props.off ? MACHINE_ACTION_OFF_OPACITY : 1,
      })}
    >
      {props.first ? null : <RowDivider look={look} />}
      <Text style={{ flex: 1, fontSize: 15.5, color: look.foreground }}>{props.label}</Text>
      {props.value ? (
        <Text numberOfLines={1} style={{ maxWidth: 190, fontSize: 15.5, color: look.muted }}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={13}
        weight="semibold"
        tintColor={look.faint}
        type="monochrome"
      />
    </Pressable>
  );
}

/** A Connection row: a value, a switch, or a plain action (`.li`). */
function InfoRow(props: {
  readonly row: MachineInfoRow;
  readonly first: boolean;
  readonly busy: boolean;
  readonly look: MachinesLook;
  readonly onAction: (id: MachineActionId) => void;
}) {
  const { row, look } = props;
  if (row.kind === "action") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: props.busy }}
        disabled={props.busy}
        onPress={() => props.onAction(row.action)}
        style={({ pressed }) => ({
          ...ROW_STYLE,
          backgroundColor: pressed ? look.pressed : undefined,
        })}
      >
        {props.first ? null : <RowDivider look={look} />}
        <Text style={{ flex: 1, fontSize: 15.5, color: look.foreground }}>{row.label}</Text>
      </Pressable>
    );
  }
  return (
    <View style={ROW_STYLE}>
      {props.first ? null : <RowDivider look={look} />}
      <Text style={{ flex: 1, fontSize: 15.5, color: look.foreground }}>{row.label}</Text>
      {row.kind === "value" ? (
        <Text
          numberOfLines={1}
          selectable
          style={{ maxWidth: 190, textAlign: "right", fontSize: 15.5, color: look.muted }}
        >
          {row.value}
        </Text>
      ) : (
        <Switch
          accessibilityLabel={row.label}
          value={row.value}
          disabled={!row.enabled || props.busy}
          onValueChange={() => props.onAction(row.action)}
          style={{ opacity: row.enabled ? 1 : MACHINE_ACTION_OFF_OPACITY }}
        />
      )}
    </View>
  );
}
