import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, McpServer } from "@ryco/contracts";
import { useState, type ReactNode } from "react";
import { Alert, Linking, RefreshControl, ScrollView, Switch, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useEnvironmentApi } from "../../../connection/useEnvironmentApi";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import {
  buildAgentControlSectionView,
  buildMcpSectionView,
  buildPluginsSectionView,
  PLUGIN_DOCS_ACTION,
  pluginStatusForAction,
  STATUS_TONE_CLASS,
  type AgentControlRowView,
  type AgentsMenuAction,
  type McpServerRowView,
  type PluginRowView,
} from "./agents/agentsModel";
import type { AgentsActionResult } from "./agents/machineAgentsController";
import { McpServerEditorSheet } from "./agents/McpServerEditorSheet";
import { useMachineAgents } from "./agents/useMachineAgents";
import { useMachineSettings } from "./useMachineSettings";

type Props = StaticScreenProps<{ readonly environmentId: string }>;

/**
 * One machine's agent extensions, as the web's MCP servers, Plugins and Agent Control pages
 * show them: the MCP servers in each agent's own configuration, the opinionated plugins, and
 * which agents have Ryco's Agent Control MCP server installed. Its owner changes them.
 */
export function SettingsMachineAgentsRouteScreen(props: Props) {
  const environmentId = props.route.params.environmentId as EnvironmentId;
  const machine = useMachineSettings(environmentId);
  const connectedApi = useEnvironmentApi(environmentId);
  const { state, controller } = useMachineAgents(machine.connected ? connectedApi : undefined);
  const editable = machine.editable;
  const mcp = buildMcpSectionView({ state: state.mcp, editable });
  const plugins = buildPluginsSectionView({ state: state.plugins, editable });
  const agentControl = buildAgentControlSectionView({
    state: state.agentControl,
    mcp: state.mcp,
    editable,
  });
  // Kept after closing so the sheet slides out with its content; `session` restarts its form.
  const [editor, setEditor] = useState<{
    readonly server: McpServer | null;
    readonly session: number;
    readonly open: boolean;
  }>({ server: null, session: 0, open: false });
  const openEditor = (server: McpServer | null) =>
    setEditor((current) => ({ server, session: current.session + 1, open: true }));
  const [refreshing, setRefreshing] = useState(false);

  const refresh = () => {
    setRefreshing(true);
    void controller.load().then(() => setRefreshing(false));
  };

  const onServerAction = (row: McpServerRowView, actionId: string) => {
    if (actionId === "edit") {
      openEditor(row.server);
      return;
    }
    if (actionId !== "remove") return;
    Alert.alert(
      `Remove ${row.title}?`,
      `It is removed from ${mcp.providerName}'s MCP configuration on ${machine.label}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void controller.removeServer(row.server.name).then(alertFailure("Not removed"));
          },
        },
      ],
    );
  };

  const onPluginAction = (row: PluginRowView, actionId: string) => {
    if (actionId === PLUGIN_DOCS_ACTION) {
      void Linking.openURL(row.docsUrl);
      return;
    }
    const target = pluginStatusForAction(row, actionId);
    if (!target) return;
    const action = row.actions.find((candidate) => candidate.id === actionId);
    Alert.alert(
      `${action ? action.title : "Install"}?`,
      `${row.title} may run networked installation commands on ${machine.label}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Install",
          onPress: () => {
            void controller.installPlugin(target).then(alertFailure("Not installed"));
          },
        },
      ],
    );
  };

  const onAgentControlAction = (row: AgentControlRowView, actionId: string) => {
    const installation = row.installation;
    if (actionId === "connect") {
      void controller.connectAgentControl(row.workspaceId).then(alertFailure("Not installed"));
      return;
    }
    if (!installation) return;
    if (actionId === "repair") {
      void controller
        .repairAgentControl(row.workspaceId, installation)
        .then(alertFailure("Not repaired"));
      return;
    }
    if (actionId !== "disconnect") return;
    Alert.alert(
      `Remove Agent Control from ${row.title}?`,
      "Its MCP entry and credential are removed. Ryco-started sessions are not affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void controller
              .disconnectAgentControl(row.workspaceId, installation)
              .then(alertFailure("Not removed"));
          },
        },
      ],
    );
  };

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {machine.readOnlyReason ? (
          <Text className="px-5 pt-4 font-sans text-sm leading-relaxed text-foreground-muted">
            {machine.readOnlyReason}
          </Text>
        ) : null}

        <SettingsSection title="MCP servers" footer={joinLines([mcp.footer, mcp.unmanaged])}>
          {mcp.notice !== null ? (
            <SettingsRow first label={mcp.notice} />
          ) : (
            <>
              {mcp.picker ? (
                <MenuView
                  title="Agent"
                  actions={mcp.picker.options.map((option): MenuAction => ({
                    id: option.id,
                    title: option.title,
                    state: option.selected ? "on" : "off",
                  }))}
                  onPressAction={(event: NativeActionEvent) => {
                    const workspace = state.mcp.workspaces.find(
                      (candidate) => candidate.id === event.nativeEvent.event,
                    );
                    if (workspace) void controller.selectWorkspace(workspace.id);
                  }}
                >
                  <SettingsRow first label="Agent" value={mcp.picker.value} />
                </MenuView>
              ) : null}
              {mcp.warnings.map((warning, index) => (
                <Note key={warning} first={!mcp.picker && index === 0} tone="warning">
                  {warning}
                </Note>
              ))}
              {mcp.servers.map((row, index) => (
                <McpServerRow
                  key={row.title}
                  row={row}
                  first={!mcp.picker && mcp.warnings.length === 0 && index === 0}
                  onAction={(actionId) => onServerAction(row, actionId)}
                  onToggle={(enabled) => {
                    void controller
                      .setServerEnabled(row.server.name, enabled)
                      .then(alertFailure("Not changed"));
                  }}
                />
              ))}
              {mcp.empty !== null ? (
                <SettingsRow first={!mcp.picker && mcp.warnings.length === 0} label={mcp.empty} />
              ) : null}
              {mcp.canAdd ? (
                <SettingsRow icon="plus" label="Add server" onPress={() => openEditor(null)} />
              ) : null}
              {mcp.canReload ? (
                <SettingsRow
                  icon="arrow.clockwise"
                  label={state.mcp.reloading ? "Reloading…" : "Reload servers"}
                  detail={`Restarts ${mcp.providerName}'s MCP servers.`}
                  disabled={state.mcp.reloading}
                  onPress={() => {
                    void controller.reloadServers().then(alertFailure("Not reloaded"));
                  }}
                />
              ) : null}
            </>
          )}
        </SettingsSection>

        <SettingsSection
          title="Plugins"
          footer="Opinionated helpers that trim what agents read or write. An install runs on the machine."
        >
          {plugins.notice !== null ? (
            <SettingsRow first label={plugins.notice} />
          ) : (
            plugins.rows.map((row, index) => (
              <PluginRow
                key={row.key}
                row={row}
                first={index === 0}
                onAction={(actionId) => onPluginAction(row, actionId)}
              />
            ))
          )}
        </SettingsSection>

        <SettingsSection
          title="Agent Control"
          footer={joinLines([
            agentControl.automatic,
            "Installing writes Ryco's Agent Control MCP server into the agent's own configuration, for sessions you start outside Ryco. Every task it asks for still needs your approval.",
          ])}
        >
          {agentControl.notice !== null ? (
            <Note first tone={agentControl.rows.length > 0 ? "warning" : "muted"}>
              {agentControl.notice}
            </Note>
          ) : null}
          {agentControl.rows.map((row, index) => (
            <AgentControlRow
              key={row.workspaceId}
              row={row}
              first={agentControl.notice === null && index === 0}
              onAction={(actionId) => onAgentControlAction(row, actionId)}
            />
          ))}
        </SettingsSection>
      </ScrollView>

      <McpServerEditorSheet
        visible={editor.open}
        session={editor.session}
        server={editor.server}
        providerName={mcp.providerName}
        onClose={() => setEditor((current) => ({ ...current, open: false }))}
        onSave={(form) => controller.saveServer(form)}
      />
    </>
  );
}

function alertFailure(title: string) {
  return (result: AgentsActionResult) => {
    if (!result.ok) Alert.alert(title, result.error);
  };
}

function joinLines(lines: ReadonlyArray<string | null>): string | undefined {
  const present = lines.filter((line): line is string => line !== null);
  return present.length > 0 ? present.join("\n\n") : undefined;
}

function menuActions(actions: ReadonlyArray<AgentsMenuAction>): MenuAction[] {
  return actions.map((action) => ({
    id: action.id,
    title: action.title,
    ...(action.destructive ? { attributes: { destructive: true } } : {}),
  }));
}

/** Wraps a row in its action menu (opened by a tap), or leaves it inert without actions. */
function WithMenu(props: {
  readonly title: string;
  readonly actions: ReadonlyArray<AgentsMenuAction>;
  readonly disabled?: boolean;
  readonly onAction: (actionId: string) => void;
  readonly children: ReactNode;
}) {
  if (props.actions.length === 0 || props.disabled) return <>{props.children}</>;
  return (
    <MenuView
      title={props.title}
      actions={menuActions(props.actions)}
      onPressAction={(event: NativeActionEvent) => props.onAction(event.nativeEvent.event)}
    >
      {props.children}
    </MenuView>
  );
}

function RowFrame(props: { readonly first?: boolean; readonly children: ReactNode }) {
  return (
    <View
      className={`min-h-[52px] flex-row items-center gap-3 px-4 py-3 ${
        props.first ? "" : "border-t border-border-subtle"
      }`}
    >
      {props.children}
    </View>
  );
}

function Note(props: {
  readonly first?: boolean;
  readonly tone: "warning" | "muted";
  readonly children: string;
}) {
  return (
    <RowFrame first={props.first}>
      <Text
        className={`flex-1 text-sm leading-5 ${
          props.tone === "warning" ? "text-warning" : "text-foreground-muted"
        }`}
      >
        {props.children}
      </Text>
    </RowFrame>
  );
}

function McpServerRow(props: {
  readonly row: McpServerRowView;
  readonly first: boolean;
  readonly onAction: (actionId: string) => void;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const { row } = props;
  return (
    <RowFrame first={props.first}>
      <View className="min-w-0 flex-1">
        <WithMenu
          title={row.title}
          actions={row.actions}
          disabled={row.busy}
          onAction={props.onAction}
        >
          <View accessible accessibilityLabel={`${row.title}, ${row.status.label}`}>
            <View className="flex-row items-center gap-2">
              <Text className="shrink text-[17px] text-foreground" numberOfLines={1}>
                {row.title}
              </Text>
              <Text
                className={`text-[13px] font-ryco-medium ${STATUS_TONE_CLASS[row.status.tone]}`}
              >
                {row.busy ? "Saving…" : row.status.label}
              </Text>
            </View>
            <Text
              className="mt-0.5 font-mono text-xs text-foreground-muted"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {row.connection}
            </Text>
            <Text className="mt-0.5 text-xs leading-4 text-foreground-muted">{row.meta}</Text>
            {row.error ? (
              <Text className="mt-1 text-xs leading-4 text-danger-foreground">{row.error}</Text>
            ) : null}
          </View>
        </WithMenu>
      </View>
      {row.toggle ? (
        <Switch
          accessibilityLabel={`Enable ${row.title}`}
          value={row.toggle.value}
          disabled={row.toggle.disabled}
          onValueChange={props.onToggle}
        />
      ) : null}
    </RowFrame>
  );
}

function PluginRow(props: {
  readonly row: PluginRowView;
  readonly first: boolean;
  readonly onAction: (actionId: string) => void;
}) {
  const { row } = props;
  return (
    <WithMenu
      title={row.title}
      actions={row.actions}
      disabled={row.installing}
      onAction={props.onAction}
    >
      <RowFrame first={props.first}>
        <View className="min-w-0 flex-1">
          <Text className="text-[17px] text-foreground">{row.title}</Text>
          <Text className="mt-0.5 text-xs leading-4 text-foreground-muted">{row.summary}</Text>
          {row.targets.map((target) => (
            <Text
              key={target.key}
              className={`mt-1 text-xs leading-4 ${STATUS_TONE_CLASS[target.tone]}`}
            >
              {target.text}
            </Text>
          ))}
        </View>
        <Text className={`text-[15px] ${STATUS_TONE_CLASS[row.valueTone]}`}>{row.value}</Text>
      </RowFrame>
    </WithMenu>
  );
}

function AgentControlRow(props: {
  readonly row: AgentControlRowView;
  readonly first: boolean;
  readonly onAction: (actionId: string) => void;
}) {
  const { row } = props;
  return (
    <WithMenu title={row.title} actions={row.actions} disabled={row.busy} onAction={props.onAction}>
      <RowFrame first={props.first}>
        <View className="min-w-0 flex-1">
          <Text className="text-[17px] text-foreground">{row.title}</Text>
          <Text
            className="mt-0.5 font-mono text-xs text-foreground-muted"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {row.detail}
          </Text>
          {row.notes.map((note) => (
            <Text key={note} className="mt-1 text-xs leading-4 text-warning">
              {note}
            </Text>
          ))}
        </View>
        <Text className={`text-[15px] ${STATUS_TONE_CLASS[row.status.tone]}`}>
          {row.busy ? "Working…" : row.status.label}
        </Text>
      </RowFrame>
    </WithMenu>
  );
}
