import type { AcpRegistryAgent, EnvironmentId } from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { useEnvironmentApi } from "../../../connection/useEnvironmentApi";

export interface AcpAgentInstallation {
  readonly agentId: string;
  readonly version: string;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

type ServerApi = NonNullable<NonNullable<ReturnType<typeof useEnvironmentApi>>["server"]>;

/** The registry methods of the machine's connection; `null` without one or on an older node. */
function registryApi(api: ReturnType<typeof useEnvironmentApi>): {
  readonly search: NonNullable<ServerApi["searchAcpRegistry"]>;
  readonly install: NonNullable<ServerApi["installAcpRegistry"]>;
} | null {
  if (api === undefined || api.server === undefined) return null;
  const { searchAcpRegistry, installAcpRegistry } = api.server;
  if (searchAcpRegistry === undefined || installAcpRegistry === undefined) return null;
  return { search: searchAcpRegistry, install: installAcpRegistry };
}

function agentAction(agent: AcpRegistryAgent, selected: boolean, installing: boolean): string {
  if (installing) return "Installing…";
  if (selected) return "Selected";
  return agent.installed ? "Use installed version" : `Install ${agent.version}`;
}

/**
 * The ACP registry of one machine, after the web's agent picker: search, then install an agent at
 * the shown version (the node verifies its checksum) or use one already installed. Picking one
 * hands its pinned install back; the caller saves it into the instance.
 */
export function AcpRegistryPickerSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly nodeLabel: string;
  readonly selected: AcpAgentInstallation | null;
  /** This device may install on the machine now (its owner, connected). */
  readonly canInstall: boolean;
  readonly readOnlyReason: string | null;
  readonly onSelect: (installation: AcpAgentInstallation) => void;
  readonly onClose: () => void;
}) {
  const api = useEnvironmentApi(props.environmentId);
  const [query, setQuery] = useState({ text: "" });
  const [agents, setAgents] = useState<ReadonlyArray<AcpRegistryAgent>>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const timer = setTimeout(() => {
      const registry = registryApi(api);
      setAgents([]);
      setError(null);
      setInstalling(null);
      if (registry === null) {
        setLoading(false);
        setError(`Connect to ${props.nodeLabel} to browse the ACP registry.`);
        return;
      }
      setLoading(true);
      void registry
        .search({ query: query.text })
        .then((result) => {
          if (generation.current === current) setAgents(result.agents);
        })
        .catch((cause: unknown) => {
          if (generation.current === current) {
            setError(errorMessage(cause, "Could not load the registry."));
          }
        })
        .finally(() => {
          if (generation.current === current) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      generation.current = current + 1;
    };
  }, [api, query, props.nodeLabel]);

  const install = (agent: AcpRegistryAgent) => {
    const registry = registryApi(api);
    if (registry === null || !props.canInstall || installing !== null) return;
    const current = generation.current;
    setInstalling(agent.id);
    setError(null);
    void registry
      .install({ agentId: agent.id, version: agent.version })
      .then((installation) => {
        if (generation.current !== current) return;
        props.onSelect({ agentId: installation.agentId, version: installation.version });
      })
      .catch((cause: unknown) => {
        if (generation.current === current) setError(errorMessage(cause, "Installation failed."));
      })
      .finally(() => {
        if (generation.current === current) setInstalling(null);
      });
  };

  const selected = props.selected;
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View className="flex-1 bg-screen">
          <View className="flex-row items-center gap-3 px-5 pt-5 pb-2">
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-ryco-bold text-foreground">ACP Registry</Text>
              <Text className="font-sans text-sm text-foreground-muted">On {props.nodeLabel}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close the registry"
              onPress={props.onClose}
              className="h-11 min-w-16 items-center justify-center rounded-full active:bg-subtle"
            >
              <Text className="text-base font-ryco-medium text-foreground">Done</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingTop: 8,
              paddingBottom: 32,
              gap: 12,
            }}
          >
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              Installs an agent on this machine at the version shown. Ryco verifies its checksum
              first. Agents run with the machine’s permissions.
            </Text>
            {selected !== null ? (
              <Text className="font-sans text-sm text-foreground">
                {`Selected: ${selected.agentId}@${selected.version}`}
              </Text>
            ) : null}
            <AppTextInput
              accessibilityLabel="Search the ACP registry"
              placeholder="Search agents"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={200}
              editable={installing === null}
              value={query.text}
              onChangeText={(text) => setQuery({ text })}
              className="h-11 rounded-xl bg-card px-4 font-sans text-base text-foreground"
            />
            {error !== null ? <ErrorBanner message={error} /> : null}
            {loading ? (
              <View className="flex-row items-center gap-2">
                <ActivityIndicator size="small" />
                <Text className="font-sans text-sm text-foreground-muted">Loading registry…</Text>
              </View>
            ) : agents.length === 0 && error === null ? (
              <Text className="font-sans text-sm text-foreground-muted">No matching agents.</Text>
            ) : null}
            {agents.map((agent) => {
              const isSelected =
                selected !== null &&
                selected.agentId === agent.id &&
                selected.version === agent.version;
              const disabled =
                !props.canInstall || !agent.installable || installing !== null || isSelected;
              return (
                <View
                  key={`${agent.id}@${agent.version}`}
                  className="gap-2 rounded-[22px] bg-card p-4"
                >
                  <View className="flex-row items-center gap-2">
                    <Text
                      className="min-w-0 flex-1 font-ryco-medium text-[17px] text-foreground"
                      numberOfLines={1}
                    >
                      {agent.name}
                    </Text>
                    <Text className="font-sans text-xs text-foreground-muted">{agent.version}</Text>
                  </View>
                  <Text className="font-sans text-sm leading-5 text-foreground-muted">
                    {agent.description}
                  </Text>
                  <Text className="font-sans text-xs text-foreground-muted">
                    {agent.license ? `${agent.id} · ${agent.license}` : agent.id}
                  </Text>
                  {agent.unavailableReason ? (
                    <Text className="font-sans text-xs text-foreground-muted">
                      {agent.unavailableReason}
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled, busy: installing === agent.id }}
                    disabled={disabled}
                    onPress={() => install(agent)}
                    className="h-10 items-center justify-center rounded-full border border-border active:opacity-80 disabled:opacity-40"
                  >
                    <Text className="text-sm font-ryco-medium text-foreground">
                      {agentAction(agent, isSelected, installing === agent.id)}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
            {!props.canInstall ? (
              <Text className="font-sans text-xs leading-4 text-foreground-muted">
                {props.readOnlyReason ?? "The machine's owner, connected, can install agents."}
              </Text>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
