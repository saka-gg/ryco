import type { StaticScreenProps } from "@react-navigation/native";
import {
  buildConversationImportView,
  createConversationImportController,
  SESSION_IMPORT_SOURCES,
  sessionImportConversationCount,
} from "@ryco/client-runtime/state/sessionImport";
import type { ServerProvider } from "@ryco/contracts";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import * as Haptics from "expo-haptics";
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShallow } from "zustand/react/shallow";

import { AppText as Text } from "../../../components/AppText";
import { readRpcClient } from "../../../connection/environmentApi";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";
import { selectProjectsAcrossEnvironments, useStore } from "../../../state/threadsRuntime";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import { ImportConversationRow } from "./import/ImportConversationRow";
import { ImportPickerRow } from "./import/ImportPickerRow";
import {
  createMachineImportClient,
  machineImportButtonLabel,
  machineImportCanRun,
  machineImportProjects,
} from "./import/machineImportModel";
import { useMachineSettings } from "./useMachineSettings";

type Props = StaticScreenProps<{ readonly environmentId: string }>;

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/**
 * Import conversations from one machine: bring its Codex or Claude Code history into Ryco.
 * The same flow and rules as the web's Settings → Import conversations, through the one shared
 * controller: choose the source and store, search, select, choose the project and who
 * continues, then import one conversation at a time. Owner only, while connected.
 */
export function SettingsMachineImportRouteScreen(props: Props) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const machine = useMachineSettings(environmentId);
  const insets = useSafeAreaInsets();
  const placeholder = useThemeColor("--color-placeholder") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const allowed = machine.editable;
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const projects = useMemo(
    () => machineImportProjects(allProjects, environmentId),
    [allProjects, environmentId],
  );
  const providerOptions = machine.config ? machine.config.providers : NO_PROVIDERS;
  const [controller] = useState(createConversationImportController);
  const client = useMemo(
    () => createMachineImportClient(() => readRpcClient(environmentId)),
    [environmentId],
  );
  useLayoutEffect(() => {
    controller.setInput({ allowed, projects, providerOptions, client });
  }, [controller, allowed, projects, providerOptions, client]);
  useEffect(() => () => controller.dispose(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const view = buildConversationImportView(state, { allowed, projects, providerOptions });
  const locked = view.busy || !allowed;
  const canRun = machineImportCanRun(view);
  const provider = view.provider;
  const models = provider ? provider.models : [];
  return (
    <View className="flex-1 bg-screen">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 96 }}
      >
        <Text className="px-6 pt-3 text-xs leading-4 text-foreground-muted">
          {`Bring Codex or Claude Code history from ${machine.label} into Ryco. New turns continue in separate native session copies.`}
        </Text>
        {machine.readOnlyReason ? (
          <Text className="px-6 pt-2 text-xs text-foreground-muted">{machine.readOnlyReason}</Text>
        ) : null}
        <SettingsSection footer="Which agent's history to read. Originals stay unchanged.">
          <ImportPickerRow
            first
            label="Source"
            value={state.source}
            placeholder="Choose a source"
            disabled={view.busy}
            options={SESSION_IMPORT_SOURCES}
            onPick={(value) =>
              controller.setSource(value === "claudeAgent" ? "claudeAgent" : "codex")
            }
          />
          <ImportPickerRow
            label="Store"
            value={view.activeStore ? view.activeStore.key : ""}
            placeholder="Choose a store"
            disabled={locked}
            options={state.stores.map((store) => ({
              value: store.key,
              label: store.label,
              ...(store.instanceIds.length ? {} : { subtitle: "No enabled continuation instance" }),
            }))}
            onPick={controller.setStore}
          />
        </SettingsSection>
        <SettingsSection
          title="Search"
          footer={state.notices.length > 0 ? state.notices.join("\n") : undefined}
        >
          <View className="px-4 py-2.5">
            <TextInput
              accessibilityLabel="Search local conversations"
              value={state.search}
              onChangeText={controller.setSearch}
              placeholder="Title or project folder"
              placeholderTextColor={placeholder}
              maxLength={200}
              editable={!view.busy}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => void controller.find()}
              className="h-10 rounded-xl bg-subtle px-3 font-sans text-[15px]"
              style={{ color: foreground }}
            />
          </View>
          <SettingsSwitchRow
            label="Include archived"
            value={state.includeArchived}
            disabled={view.busy}
            onValueChange={controller.setIncludeArchived}
          />
          <SettingsRow
            icon="magnifyingglass"
            label="Find conversations"
            disabled={!view.canFind}
            onPress={() => void controller.find()}
          />
        </SettingsSection>
        {view.items.length > 0 ? (
          <SettingsSection
            title={
              view.selectedCount > 0
                ? `${sessionImportConversationCount(view.importableCount)} selected`
                : "Conversations"
            }
          >
            {view.items.map((row, index) => (
              <ImportConversationRow
                key={row.item.key}
                row={row}
                first={index === 0}
                locked={locked}
                onToggle={() => {
                  void Haptics.selectionAsync();
                  controller.setSelected(row.item.key, !row.selected);
                }}
                onInspect={() => void controller.inspect(row.item.key)}
                onInspectNextPage={() => void controller.inspectNextPage(row.item.key)}
                onAdopt={() => void controller.adopt(row.item.key)}
              />
            ))}
            {view.hasNextPage ? (
              <SettingsRow
                icon="arrow.down.circle"
                label="Search next page"
                disabled={locked}
                onPress={() => void controller.nextPage()}
              />
            ) : null}
          </SettingsSection>
        ) : null}
        <SettingsSection
          title="Add to project"
          footer={
            projects.length
              ? "Imported threads join this project, including ones whose original folder moved."
              : "Add a project on this machine, then return here to import."
          }
        >
          <ImportPickerRow
            first
            label="Project"
            value={view.projectId}
            placeholder="Choose a project"
            disabled={view.busy}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            onPick={controller.setProject}
          />
        </SettingsSection>
        <SettingsSection
          title="Continue with"
          footer={
            view.continuationStatus ??
            "The agent and model that take over new turns in imported threads."
          }
        >
          <ImportPickerRow
            first
            label="Agent"
            value={provider ? provider.instanceId : ""}
            placeholder="No provider"
            disabled={view.busy}
            options={view.providers.map((entry) => ({
              value: entry.instanceId,
              label: entry.displayName || entry.driver,
            }))}
            onPick={controller.setInstance}
          />
          <ImportPickerRow
            label="Model"
            value={view.model ? view.model.slug : ""}
            placeholder="No model"
            disabled={view.busy}
            options={models.map((choice) => ({ value: choice.slug, label: choice.name }))}
            onPick={controller.setModel}
          />
        </SettingsSection>
      </ScrollView>
      <View
        className="absolute inset-x-0 bottom-0 bg-screen px-4 pt-3"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canRun, busy: view.busy }}
          disabled={!canRun}
          onPress={() => void controller.run()}
          className={cn(
            "h-12 items-center justify-center rounded-full bg-primary active:opacity-80",
            !canRun && "opacity-40",
          )}
        >
          <Text className="text-[16px] font-ryco-bold text-primary-foreground">
            {machineImportButtonLabel(view)}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
