import { type ReactNode, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import type { NodeSettingsTarget } from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import type { EnvironmentId, ProjectId, ServerConfig } from "@ryco/contracts";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { updateEnvironmentServerSettings } from "../../connection/environmentApi";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { selectProjectsForEnvironment, useStore } from "../../state/threadsRuntime";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { ModelPickerSheet } from "../threads/ModelPickerSheet";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import {
  buildNewTaskDefaultsView,
  createNewTaskDefaultsController,
  initialModelOptionPatch,
  initialModelPicker,
  initialModelPickPatch,
  newTaskDefaultsApplyChoices,
  newTaskDefaultsScopes,
  resolveNewTaskDefaultsScope,
  worktreeSubmodulesRow,
  type NewTaskDefaultRow,
  type NewTaskDefaultsController,
} from "./nodeNewTaskDefaultsModel";
import {
  canChangeNodeSettings,
  homeNodeSettingsTargets,
  nodeConnected,
  nodeSettingsReadOnlyReason,
} from "./nodeSettingsTargets";

const APPLY_DETAIL =
  "Writes one of this node's defaults to every connected node you own. Offline nodes keep their value. The model stays per node.";

/**
 * One "New tasks" panel per node: the defaults a new task on it starts with, and each project's
 * overrides. Edits go to that node only, and only from its owner.
 */
export function NodeNewTaskDefaults() {
  const nodes = useHomeEnvironments();
  const configs = useEnvironmentServerConfigs();
  // Every known node, for "Apply to all connected nodes": each writes through its own
  // connection and compares its own values.
  const targets = useMemo(
    () => homeNodeSettingsTargets({ nodes, configs, write: updateEnvironmentServerSettings }),
    [configs, nodes],
  );
  return (
    <>
      {nodes.map((node) => (
        <NodeNewTaskDefaultsPanel
          key={node.environmentId}
          environmentId={node.environmentId}
          label={node.label}
          config={configs.get(node.environmentId) ?? null}
          // A viewer reads the defaults too; only the owner changes them.
          readable={nodeConnected(node)}
          editable={canChangeNodeSettings(node)}
          readOnly={nodeSettingsReadOnlyReason(node)}
          targets={targets}
        />
      ))}
    </>
  );
}

function NodeNewTaskDefaultsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly config: ServerConfig | null;
  readonly readable: boolean;
  readonly editable: boolean;
  /** Why the rows take no edit from this device, or null when they may. */
  readonly readOnly: string | null;
  readonly targets: ReadonlyArray<NodeSettingsTarget>;
}) {
  const { environmentId, label, config, editable } = props;
  const connectedApi = useEnvironmentApi(environmentId);
  const api = props.readable ? connectedApi : undefined;
  const controller = useMemo(
    () =>
      createNewTaskDefaultsController({
        write: (patch) => updateEnvironmentServerSettings(environmentId, patch),
      }),
    [environmentId],
  );
  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, environmentId)),
  );
  const scopes = newTaskDefaultsScopes(projects);
  const [selected, setSelected] = useState<ProjectId | null>(null);
  const projectId = resolveNewTaskDefaultsScope(selected, scopes);
  useLayoutEffect(() => {
    controller.setInput({ label, config, api, editable, projectId });
  }, [api, config, controller, editable, label, projectId]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const view = buildNewTaskDefaultsView({ state, label, config, readOnly: props.readOnly });
  // The scope the sheet was opened for, which its picks are written to: a re-render after that
  // project is gone must not send them to the node's defaults.
  const [pickerScope, setPickerScope] = useState<{ readonly projectId: ProjectId | null } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [applyOpen, setApplyOpen] = useState(false);

  const showScopes =
    scopes.length > 1 && state.phase !== "offline" && state.phase !== "unsupported";
  const leading = showScopes || view.notice !== null;
  const modelRow = view.rows.find((row) => row.kind === "model");
  const picker = modelRow
    ? initialModelPicker({ config, selection: modelRow.selection, query })
    : null;
  const submodules = worktreeSubmodulesRow(config, projectId);
  const applyChoices =
    editable && state.projectId === null && props.targets.length > 1
      ? newTaskDefaultsApplyChoices(view.rows, props.targets)
      : [];
  const closePicker = () => {
    setPickerScope(null);
    setQuery("");
  };

  return (
    <SettingsSection title={`New tasks · ${label}`}>
      {showScopes ? (
        <View className="px-5 py-3">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-2">
              {scopes.map((scope) => (
                <Pressable
                  key={scope.projectId ?? "node"}
                  accessibilityRole="button"
                  accessibilityState={{ selected: scope.projectId === projectId }}
                  onPress={() => {
                    closePicker();
                    setApplyOpen(false);
                    setSelected(scope.projectId);
                  }}
                  className="rounded-full border border-border px-3 py-2"
                >
                  <Text className="text-sm text-foreground">
                    {scope.projectId === projectId ? "✓ " : ""}
                    {scope.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
      ) : null}
      {view.notice ? (
        <View className={`px-5 py-3 ${showScopes ? "border-t border-border-subtle" : ""}`}>
          <Text className="text-sm text-foreground-muted">{view.notice}</Text>
        </View>
      ) : null}
      {view.rows.map((row, index) => (
        <NewTaskDefaultRowView
          key={row.key}
          row={row}
          first={!leading && index === 0}
          projectId={state.projectId}
          editable={editable}
          canEdit={view.canEdit}
          controller={controller}
          onOpenModel={() => setPickerScope({ projectId: state.projectId })}
        />
      ))}
      <SettingsRow
        first={!leading && view.rows.length === 0}
        label="Worktree submodules"
        value={submodules.value}
        detail={submodules.detail}
      />
      {applyChoices.length > 0 || view.applyStatus !== null ? (
        <SettingsRow
          label="Apply to all connected nodes"
          value={state.applying ? "Applying…" : undefined}
          detail={view.applyStatus ?? APPLY_DETAIL}
          disabled={!view.canApply || applyChoices.length === 0}
          onPress={() => setApplyOpen((open) => !open)}
        />
      ) : null}
      {applyOpen
        ? applyChoices.map((choice) => (
            <SettingsRow
              key={`apply:${choice.key}`}
              label={`Apply ${choice.title.toLowerCase()}: ${choice.value}`}
              detail={choice.detail}
              disabled={!view.canApply}
              onPress={() => {
                setApplyOpen(false);
                void controller.applyToAllNodes(choice.key, props.targets);
              }}
            />
          ))
        : null}
      {view.error ? (
        <View className="border-t border-border-subtle px-5 py-3">
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {view.error}
          </Text>
        </View>
      ) : state.saving ? (
        <View className="border-t border-border-subtle px-5 py-3">
          <Text className="text-xs text-foreground-muted">Saving…</Text>
        </View>
      ) : null}
      {picker && modelRow ? (
        <ModelPickerSheet
          visible={pickerScope !== null}
          model={picker}
          query={query}
          onChangeQuery={setQuery}
          onClose={closePicker}
          onSelect={(key) => {
            const patch = initialModelPickPatch(picker, key);
            const target = pickerScope?.projectId ?? null;
            closePicker();
            if (patch) void controller.save(target, patch);
          }}
          onSelectOption={(optionId, value) => {
            const patch = initialModelOptionPatch(config, modelRow.selection, optionId, value);
            if (patch) void controller.save(pickerScope?.projectId ?? null, patch);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function NewTaskDefaultRowView(props: {
  readonly row: NewTaskDefaultRow;
  readonly first: boolean;
  /**
   * The scope the row was built for (null: the node's defaults). Its edits name it, so one still
   * open when that project goes is dropped; a text field shows a new scope's own value again.
   */
  readonly projectId: ProjectId | null;
  /** This device may change the node's settings at all. */
  readonly editable: boolean;
  /** It may right now: the node answered and nothing of this panel is being written. */
  readonly canEdit: boolean;
  readonly controller: NewTaskDefaultsController;
  readonly onOpenModel: () => void;
}) {
  const { row, controller, projectId } = props;
  let control: ReactNode;
  if (row.kind === "text" && props.editable) {
    control = (
      <View className={`px-5 py-3.5 ${props.first ? "" : "border-t border-border-subtle"}`}>
        <Text className="font-sans text-[17px] text-foreground">{row.title}</Text>
        <AppTextInput
          key={`${projectId ?? "node"}:${row.text}`}
          accessibilityLabel={row.accessibilityLabel}
          defaultValue={row.text}
          placeholder={row.placeholder}
          editable={props.canEdit}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onEndEditing={(event) => {
            void controller.saveText(projectId, row.key, event.nativeEvent.text);
          }}
          className="mt-2"
        />
        <Text className="mt-1 font-sans text-xs leading-4 text-foreground-muted">{row.source}</Text>
      </View>
    );
  } else {
    const onPress = !props.editable
      ? undefined
      : row.kind === "model"
        ? props.onOpenModel
        : row.kind === "select"
          ? () =>
              Alert.alert(row.title, row.description, [
                ...row.choices.map((choice) => ({
                  text: choice.selected ? `${choice.label} ✓` : choice.label,
                  onPress: () => {
                    if (!choice.selected) void controller.save(projectId, choice.patch);
                  },
                })),
                { text: "Cancel", style: "cancel" as const },
              ])
          : undefined;
    control = (
      <SettingsRow
        first={props.first}
        label={row.title}
        value={row.value}
        detail={row.source}
        disabled={props.editable && !props.canEdit}
        {...(onPress ? { onPress } : {})}
      />
    );
  }
  return (
    <>
      {control}
      {row.reset && props.editable ? (
        <SettingsRow
          label={row.reset.label}
          disabled={!props.canEdit}
          onPress={() => {
            if (row.reset) void controller.save(projectId, row.reset.patch);
          }}
        />
      ) : null}
    </>
  );
}
