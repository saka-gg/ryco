import { MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import {
  createEmptyMcpServerForm,
  formFromMcpServer,
  setMcpFormSecretValue,
  validateMcpServerForm,
  type McpSecretKind,
  type McpServerFormState,
} from "@ryco/client-runtime/state/settings/mcpServers";
import type { McpServer } from "@ryco/contracts";
import { useState, type ReactNode } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../../components/AppText";
import { ErrorBanner } from "../../../../components/ErrorBanner";
import { SettingsRow } from "../../components/SettingsRow";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import type { AgentsActionResult } from "./machineAgentsController";
import {
  applyMcpSecretAction,
  mcpSecretEntryProblem,
  mcpSecretRows,
  readLoginPassword,
  SECRET_ACTION,
  SECRET_KIND_LABEL,
  type McpSecretRowView,
} from "./mcpServerEditorModel";

const TRANSPORT_LABEL = { stdio: "Stdio", http: "HTTP" } as const;

/**
 * Adds or edits one MCP server in the selected agent's own configuration. Secrets are
 * write-only: stored values are never loaded, only whether a key holds one.
 */
export function McpServerEditorSheet(props: {
  readonly visible: boolean;
  /** Changes on every opening, so each one starts from the server as the node has it. */
  readonly session: number;
  /** The server to edit, or null to add one. */
  readonly server: McpServer | null;
  readonly providerName: string;
  readonly onClose: () => void;
  readonly onSave: (form: McpServerFormState) => Promise<AgentsActionResult>;
}) {
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <McpServerEditor
        key={props.session}
        server={props.server}
        providerName={props.providerName}
        onClose={props.onClose}
        onSave={props.onSave}
      />
    </Modal>
  );
}

function McpServerEditor(props: {
  readonly server: McpServer | null;
  readonly providerName: string;
  readonly onClose: () => void;
  readonly onSave: (form: McpServerFormState) => Promise<AgentsActionResult>;
}) {
  const [form, setForm] = useState<McpServerFormState>(() =>
    props.server ? formFromMcpServer(props.server) : createEmptyMcpServerForm(),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = props.server !== null;

  const setField = <K extends keyof McpServerFormState>(key: K, value: McpServerFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = () => {
    const invalid = validateMcpServerForm(form);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    setSaving(true);
    setProblem(null);
    void props.onSave(form).then((result) => {
      setSaving(false);
      if (result.ok) props.onClose();
      else setProblem(result.error);
    });
  };

  const enterSecret = (kind: McpSecretKind, key: string, value: string) => {
    const entryProblem = mcpSecretEntryProblem(key, value);
    if (entryProblem) {
      Alert.alert("Not added", entryProblem);
      return;
    }
    setForm((current) => setMcpFormSecretValue(current, kind, key, value));
  };

  const addSecret = (kind: McpSecretKind) => {
    Alert.prompt(
      kind === "env" ? "Add environment value" : "Add HTTP header",
      kind === "env"
        ? "The name, then its value. The value is sent to the machine and never shown again."
        : "The header name, then its value. The value is sent to the machine and never shown again.",
      // A login-password prompt answers `{ login, password }`; React Native types it as a string.
      ((entry: unknown) => {
        const typed = readLoginPassword(entry);
        if (typed) enterSecret(kind, typed.login, typed.password);
      }) as (text: string) => void,
      "login-password",
    );
  };

  const replaceSecret = (row: McpSecretRowView) => {
    Alert.prompt(
      `Replace ${row.key}`,
      "The new value is sent to the machine and never shown again.",
      (value: string) => enterSecret(row.kind, row.key, value),
      "secure-text",
    );
  };

  const onSecretAction = (row: McpSecretRowView, actionId: string) => {
    if (actionId === SECRET_ACTION.replace) replaceSecret(row);
    else setForm((current) => applyMcpSecretAction(current, row, actionId));
  };

  const secrets = mcpSecretRows(form);
  const http = form.transport === "http";

  return (
    <View className="flex-1 bg-screen">
      <View className="flex-row items-center gap-3 px-3 pt-3">
        <HeaderButton label="Cancel" onPress={props.onClose} />
        <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
          {editing ? "Edit server" : "Add server"}
        </Text>
        <HeaderButton label={saving ? "Saving…" : "Save"} bold disabled={saving} onPress={save} />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ paddingBottom: 48 }}
      >
        <Text className="px-5 pt-4 font-sans text-sm leading-relaxed text-foreground-muted">
          {`Written to ${props.providerName}'s own MCP configuration on this machine.`}
        </Text>
        {problem ? (
          <View className="px-4 pt-4">
            <ErrorBanner message={problem} />
          </View>
        ) : null}

        <SettingsSection title="Server">
          <Field label="Name" first>
            <AppTextInput
              value={form.name}
              editable={!editing}
              onChangeText={(value) => setField("name", value)}
              placeholder="github"
              autoCapitalize="none"
              autoCorrect={false}
              className={editing ? "opacity-60" : undefined}
            />
          </Field>
          <MenuView
            title="Transport"
            actions={(["stdio", "http"] as const).map((transport) => ({
              id: transport,
              title: TRANSPORT_LABEL[transport],
              state: form.transport === transport ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={(event: NativeActionEvent) =>
              setField("transport", event.nativeEvent.event === "http" ? "http" : "stdio")
            }
          >
            <SettingsRow label="Transport" value={TRANSPORT_LABEL[form.transport]} />
          </MenuView>
        </SettingsSection>

        {http ? (
          <SettingsSection title="HTTP">
            <Field label="URL" first>
              <TextField
                value={form.url}
                onChange={(value) => setField("url", value)}
                placeholder="https://mcp.example.com/mcp"
                keyboardType="url"
              />
            </Field>
            <Field label="Bearer token env var">
              <TextField
                value={form.bearerTokenEnvVar}
                onChange={(value) => setField("bearerTokenEnvVar", value)}
                placeholder="MCP_TOKEN"
              />
            </Field>
            <Field label="Env-backed headers" hint="Header=ENV_VAR_NAME, one per line.">
              <TextField
                multiline
                value={form.envHttpHeadersText}
                onChange={(value) => setField("envHttpHeadersText", value)}
                placeholder="Authorization=GITHUB_TOKEN"
              />
            </Field>
          </SettingsSection>
        ) : (
          <SettingsSection title="Command">
            <Field label="Command" first>
              <TextField
                value={form.command}
                onChange={(value) => setField("command", value)}
                placeholder="npx"
              />
            </Field>
            <Field label="Arguments" hint="One per line.">
              <TextField
                multiline
                value={form.argsText}
                onChange={(value) => setField("argsText", value)}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
              />
            </Field>
            <Field label="Working directory">
              <TextField
                value={form.cwd}
                onChange={(value) => setField("cwd", value)}
                placeholder="/path/to/project"
              />
            </Field>
          </SettingsSection>
        )}

        <SettingsSection
          title="Secrets"
          footer="Values are never shown. A stored value stays unless you replace or clear it."
        >
          {secrets.map((row, index) => (
            <MenuView
              key={row.id}
              title={row.key}
              actions={row.actions.map((action) => ({
                id: action.id,
                title: action.title,
                ...(action.destructive ? { attributes: { destructive: true } } : {}),
              }))}
              onPressAction={(event: NativeActionEvent) =>
                onSecretAction(row, event.nativeEvent.event)
              }
            >
              <SettingsRow
                first={index === 0}
                label={row.key}
                detail={row.kindLabel}
                value={row.value}
              />
            </MenuView>
          ))}
          <SettingsRow
            first={secrets.length === 0}
            icon="plus"
            label={`Add ${SECRET_KIND_LABEL.env.toLowerCase()}`}
            onPress={() => addSecret("env")}
          />
          {http ? (
            <SettingsRow
              icon="plus"
              label={`Add ${SECRET_KIND_LABEL.header.toLowerCase()}`}
              onPress={() => addSecret("header")}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title="Environment allow-list">
          <Field label="Variables passed through" hint="One name per line." first>
            <TextField
              multiline
              value={form.envVarsText}
              onChange={(value) => setField("envVarsText", value)}
              placeholder={"GITHUB_TOKEN\nSENTRY_AUTH_TOKEN"}
            />
          </Field>
        </SettingsSection>

        <SettingsSection>
          <SettingsSwitchRow
            first
            label="Enabled"
            value={form.enabled}
            onValueChange={(value) => setField("enabled", value)}
          />
          <SettingsSwitchRow
            label="Required"
            detail="The agent fails to start when this server does."
            value={form.required}
            onValueChange={(value) => setField("required", value)}
          />
        </SettingsSection>

        <SettingsSection title="Advanced">
          <Field label="Startup timeout (seconds)" first>
            <TextField
              value={form.startupTimeoutSec}
              onChange={(value) => setField("startupTimeoutSec", value)}
              placeholder="10"
              keyboardType="decimal-pad"
            />
          </Field>
          <Field label="Tool timeout (seconds)">
            <TextField
              value={form.toolTimeoutSec}
              onChange={(value) => setField("toolTimeoutSec", value)}
              placeholder="60"
              keyboardType="decimal-pad"
            />
          </Field>
          <Field label="Enabled tools" hint="One per line. Empty allows every tool.">
            <TextField
              multiline
              value={form.enabledToolsText}
              onChange={(value) => setField("enabledToolsText", value)}
            />
          </Field>
          <Field label="Disabled tools" hint="One per line.">
            <TextField
              multiline
              value={form.disabledToolsText}
              onChange={(value) => setField("disabledToolsText", value)}
            />
          </Field>
          <Field label="OAuth scopes" hint="One per line.">
            <TextField
              multiline
              value={form.oauthScopesText}
              onChange={(value) => setField("oauthScopesText", value)}
            />
          </Field>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function HeaderButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly bold?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-11 min-w-16 items-center justify-center rounded-full px-2 active:bg-subtle disabled:opacity-40"
    >
      <Text
        className={`text-base text-foreground ${props.bold ? "font-ryco-bold" : "font-ryco-medium"}`}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly first?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <View className={`gap-2 px-4 py-3 ${props.first ? "" : "border-t border-border-subtle"}`}>
      <Text className="px-1 text-[13px] font-ryco-medium text-foreground-muted">{props.label}</Text>
      {props.children}
      {props.hint ? (
        <Text className="px-1 text-xs leading-4 text-foreground-muted">{props.hint}</Text>
      ) : null}
    </View>
  );
}

function TextField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly keyboardType?: "default" | "url" | "decimal-pad";
}) {
  return (
    <AppTextInput
      value={props.value}
      onChangeText={props.onChange}
      placeholder={props.placeholder}
      multiline={props.multiline}
      keyboardType={props.keyboardType}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      className={`font-mono text-[15px] ${props.multiline ? "min-h-24" : ""}`}
      textAlignVertical={props.multiline ? "top" : "center"}
    />
  );
}
