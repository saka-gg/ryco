import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import type { EnvironmentId } from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { newCommandId, newProjectId } from "../../lib/ids";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useStore } from "../../state/threadsRuntime";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import {
  buildProjectCreateCommand,
  dispatchWorkspaceCommand,
  inferNodeProjectTitle,
  validateNodeWorkspacePath,
  workspaceActionErrorMessage,
  type WorkspaceMutationReadiness,
} from "./projectActions";

function readinessFor(
  connectionState: "connected" | "reconnecting" | "offline" | "read-only",
): WorkspaceMutationReadiness {
  if (connectionState === "connected") return "ready";
  return connectionState;
}

function statusLabel(state: "connected" | "reconnecting" | "offline" | "read-only"): string {
  if (state === "connected") return "Ready";
  if (state === "read-only") return "Read-only";
  if (state === "reconnecting") return "Reconnecting";
  return "Offline";
}

function statusTone(state: "connected" | "reconnecting" | "offline" | "read-only"): StatusTone {
  const label = statusLabel(state);
  if (state === "connected") {
    return {
      label,
      pillClassName: "bg-success-bg border border-success-border",
      textClassName: "text-success",
    };
  }
  if (state === "read-only") {
    return {
      label,
      pillClassName: "bg-plan-bg border border-plan-border",
      textClassName: "text-plan-foreground",
    };
  }
  return {
    label,
    pillClassName: "bg-subtle",
    textClassName: "text-foreground-muted",
  };
}

export function AddProjectRouteScreen() {
  const navigation = useNavigation();
  const environments = useHomeEnvironments();
  const { projects } = useHomeWorkspaceData();
  const firstReady = environments.find(
    (environment) => environment.connectionState === "connected",
  );
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    firstReady?.environmentId ?? environments[0]?.environmentId ?? null,
  );
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");

  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const readiness = environment ? readinessFor(environment.connectionState) : "offline";

  useEffect(() => {
    if (environment) return;
    const next =
      environments.find((candidate) => candidate.connectionState === "connected") ??
      environments[0];
    setEnvironmentId(next?.environmentId ?? null);
  }, [environment, environments]);

  const inferredTitle = useMemo(() => {
    try {
      return inferNodeProjectTitle(validateNodeWorkspacePath(workspaceRoot));
    } catch {
      return "Project title";
    }
  }, [workspaceRoot]);

  const addProject = async () => {
    setError(null);
    if (!environment) {
      setError("Choose a connected node.");
      return;
    }
    setSubmitting(true);
    try {
      const normalizedPath = validateNodeWorkspacePath(workspaceRoot);
      const existing = projects.find(
        (project) =>
          project.environmentId === environment.environmentId && project.cwd === normalizedPath,
      );
      if (existing && isChatProject(existing)) {
        // A chat's folder becomes a project only by promotion, which also moves it.
        setError(
          "This folder belongs to a chat without a project. Turn that chat into a project in Ryco's desktop or web app.",
        );
        return;
      }
      if (existing) {
        useStore.getState().setActiveEnvironmentId(existing.environmentId);
        navigation.dispatch(
          StackActions.replace("Project", {
            environmentId: existing.environmentId,
            projectId: existing.id,
          }),
        );
        return;
      }

      const projectId = newProjectId();
      const command = buildProjectCreateCommand({
        commandId: newCommandId(),
        projectId,
        workspaceRoot: normalizedPath,
        title: title.trim() || undefined,
        createdAt: new Date().toISOString(),
      });
      await dispatchWorkspaceCommand({
        readiness,
        command,
        dispatch: (nextCommand) =>
          ensureEnvironmentApi(environment.environmentId).orchestration.dispatchCommand(
            nextCommand,
          ),
      });
      useStore.getState().setActiveEnvironmentId(environment.environmentId);
      navigation.dispatch(
        StackActions.replace("Project", {
          environmentId: environment.environmentId,
          projectId,
        }),
      );
    } catch (addError) {
      setError(workspaceActionErrorMessage("add-project", addError));
    } finally {
      setSubmitting(false);
    }
  };

  if (environments.length === 0) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 48 }}
      >
        <EmptyState
          variant="plain"
          title="Add a machine first"
          detail="Projects live on one of your machines. Use your Hub or pair a machine directly."
          actionLabel="Add a machine"
          onAction={() => {
            navigation.goBack();
            navigation.navigate("Connections");
          }}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 44 }}
    >
      <View className="gap-2">
        <Text className="text-xl font-ryco-bold text-foreground">Choose the node</Text>
        <Text className="font-sans text-base leading-normal text-foreground-muted">
          The path belongs to this node. Ryco Mobile never treats it as a path on your phone.
        </Text>
      </View>

      <View className="gap-2">
        {environments.map((candidate) => {
          const selected = candidate.environmentId === environmentId;
          return (
            <Pressable
              key={candidate.environmentId}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => setEnvironmentId(candidate.environmentId)}
              className={`min-h-14 flex-row items-center gap-3 rounded-2xl border px-4 py-3 active:bg-subtle ${
                selected ? "border-foreground bg-card-alt" : "border-border bg-card"
              }`}
            >
              <View className="min-w-0 flex-1">
                <Text className="text-base font-ryco-bold text-foreground" numberOfLines={1}>
                  {candidate.label}
                </Text>
                <Text className="text-xs font-ryco-medium text-foreground-muted">
                  {candidate.connectionState === "connected"
                    ? "Can create projects"
                    : "Unavailable for changes"}
                </Text>
              </View>
              <StatusPill {...statusTone(candidate.connectionState)} />
            </Pressable>
          );
        })}
      </View>

      {error ? <ErrorBanner message={error} /> : null}

      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">
          Workspace path on {environment?.label ?? "node"}
        </Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          value={workspaceRoot}
          onChangeText={setWorkspaceRoot}
          placeholder="/srv/code/project"
          placeholderTextColor={placeholderColor as string}
          className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-base"
          style={{ color: textColor as string }}
        />
      </View>

      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">Project title</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={inferredTitle}
          placeholderTextColor={placeholderColor as string}
          className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
          style={{ color: textColor as string }}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={submitting || readiness !== "ready" || !workspaceRoot.trim()}
        onPress={() => void addProject()}
        className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
      >
        <Text className="text-base font-ryco-bold text-primary-foreground">
          {submitting ? "Adding…" : "Add project"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
