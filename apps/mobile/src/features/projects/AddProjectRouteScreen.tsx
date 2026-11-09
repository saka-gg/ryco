import { StackActions, useNavigation } from "@react-navigation/native";
import {
  buildCloneImportInput,
  buildLinkImportInput,
  cloneFolderName,
} from "@ryco/client-runtime/projectCopy/addProject";
import type { Project } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";
import { ProjectImportId, type ProjectImportStartInput } from "@ryco/contracts/project-copy";
import { isChatProject } from "@ryco/shared/projectKind";
import { formatProjectPath, inferHomeDirectory } from "@ryco/shared/projectPaths";
import { useLayoutEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView, type SFSymbol } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { OptionRow } from "../../components/OptionRow";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { newCommandId, newProjectId } from "../../lib/ids";
import { uuidv4 } from "../../lib/uuid";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useStore } from "../../state/threadsRuntime";
import { trackProjectImport } from "../projectCopy/mobileCopyManager";
import { useMobileNodeCatalog } from "../projectCopy/mobileNodeCatalog";
import { useNodePathHints } from "../projectCopy/useCopyPlanning";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  addProjectActionLabel,
  addProjectMachines,
  cloneDestinationPath,
  initialAddProjectMachine,
  otherMachineProjects,
  type AddProjectSource,
  type OtherMachineProject,
} from "./addProjectModel";
import { FolderBrowser } from "./FolderBrowser";
import {
  buildProjectCreateCommand,
  dispatchWorkspaceCommand,
  validateNodeWorkspacePath,
  workspaceActionErrorMessage,
} from "./projectActions";

type Stage =
  | { readonly kind: "start" }
  | { readonly kind: "folder" }
  | { readonly kind: "clone"; readonly browsingParent: boolean }
  | { readonly kind: "pick"; readonly purpose: "copy" | "link" }
  | { readonly kind: "link"; readonly source: OtherMachineProject };

const SOURCES: ReadonlyArray<{
  readonly source: AddProjectSource;
  readonly symbol: SFSymbol;
  readonly label: (machine: string) => string;
  readonly detail: string;
}> = [
  {
    source: "folder",
    symbol: "folder",
    label: (machine) => `A folder on ${machine}`,
    detail: "Browse the machine's folders and pick one.",
  },
  {
    source: "clone",
    symbol: "arrow.down.circle",
    label: () => "Clone a repository",
    detail: "From a Git URL, into the machine's code folder.",
  },
  {
    source: "copy",
    symbol: "square.on.square",
    label: () => "Copy from another machine",
    detail: "Bring a project you have elsewhere, with its local work.",
  },
  {
    source: "link",
    symbol: "link",
    label: (machine) => `A checkout already on ${machine}`,
    detail: "Link a folder that already holds one of your projects.",
  },
];

/**
 * Add a project on one of your machines: a folder browsed there, a clone, a
 * copy of a project from another machine, or a checkout of one that is
 * already there (the desktop's add-project dialog, as one sheet). A clone and
 * a link run as imports on the machine; their progress opens in the copy
 * sheet and goes on behind a notice when it closes.
 */
export function AddProjectRouteScreen() {
  const navigation = useNavigation();
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const iconColor = useThemeColor("--color-icon");
  const { projects } = useHomeWorkspaceData();
  const catalog = useMobileNodeCatalog();
  const machines = useMemo(() => addProjectMachines(catalog.nodes), [catalog.nodes]);
  const [pickedMachine, setPickedMachine] = useState<EnvironmentId | null>(null);
  const machineId =
    machines.find((node) => node.environmentId === pickedMachine)?.environmentId ??
    initialAddProjectMachine(machines, null);
  const machine = machines.find((node) => node.environmentId === machineId) ?? null;
  const machineLabel = machine?.label ?? "the machine";
  const [stage, setStage] = useState<Stage>({ kind: "start" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [cloneParent, setCloneParent] = useState<string | null>(null);

  const hints = useNodePathHints(machineId, machine?.projectCopySupport === "yes").data;
  const knownHome =
    hints?.homeDirectory ??
    projects
      .filter((project) => project.environmentId === machineId)
      .map((project) => inferHomeDirectory(project.cwd))
      .find((home) => home !== null) ??
    null;
  const startPath = hints?.defaultProjectDirectory ?? knownHome ?? "/";
  const parent = cloneParent ?? startPath;
  const folderName = remoteUrl.trim().length > 0 ? cloneFolderName(remoteUrl, remoteUrl) : null;
  const importSupported = machine?.projectCopySupport === "yes";
  const otherProjects = useMemo(
    () =>
      machineId === null
        ? []
        : otherMachineProjects({
            projects,
            target: machineId,
            labelOf: (environmentId) =>
              catalog.nodes.find((node) => node.environmentId === environmentId)?.label ?? null,
          }),
    [catalog.nodes, machineId, projects],
  );

  useLayoutEffect(() => {
    const titles: Record<Stage["kind"], string> = {
      start: "Add Project",
      folder: "Pick a folder",
      clone: "Clone a repository",
      pick:
        stage.kind === "pick" && stage.purpose === "link" ? "Link a checkout" : "Copy a project",
      link: "Find the checkout",
    };
    navigation.setOptions({ title: titles[stage.kind] });
  }, [navigation, stage]);

  const openProject = (environmentId: EnvironmentId, projectId: Project["id"]) => {
    useStore.getState().setActiveEnvironmentId(environmentId);
    navigation.dispatch(StackActions.replace("Project", { environmentId, projectId }));
  };

  const addFolder = async (path: string) => {
    if (machine === null) return;
    setError(null);
    setBusy(true);
    try {
      const normalizedPath = validateNodeWorkspacePath(path);
      const existing = projects.find(
        (project) =>
          project.environmentId === machine.environmentId && project.cwd === normalizedPath,
      );
      if (existing && isChatProject(existing)) {
        // A chat's folder becomes a project only by promotion, which also moves it.
        setError(
          "This folder belongs to a chat without a project. Turn that chat into a project in Ryco's desktop or web app.",
        );
        return;
      }
      if (existing) {
        openProject(existing.environmentId, existing.id);
        return;
      }
      const projectId = newProjectId();
      await dispatchWorkspaceCommand({
        readiness: machine.presence === "online" ? "ready" : "offline",
        command: buildProjectCreateCommand({
          commandId: newCommandId(),
          projectId,
          workspaceRoot: normalizedPath,
          createdAt: new Date().toISOString(),
        }),
        dispatch: (command) => {
          const api = readEnvironmentApi(machine.environmentId);
          if (!api) throw new Error(`${machine.label} is not connected.`);
          return api.orchestration.dispatchCommand(command);
        },
      });
      openProject(machine.environmentId, projectId);
    } catch (addError) {
      setError(workspaceActionErrorMessage("add-project", addError));
    } finally {
      setBusy(false);
    }
  };

  /** Starts an import on the machine and opens its progress in the copy sheet. */
  const runImport = async (
    input: ProjectImportStartInput,
    action: "clone" | "link",
    sourceRef: { readonly environmentId: EnvironmentId; readonly projectId: Project["id"] } | null,
  ) => {
    if (machine === null) return;
    const start = readEnvironmentApi(machine.environmentId)?.projects.importStart;
    if (!start) {
      setError(`${machine.label} is not connected.`);
      return;
    }
    setError(null);
    setBusy(true);
    await start(input)
      .then(() =>
        trackProjectImport({
          environmentId: machine.environmentId,
          importId: input.importId,
          projectId: input.projectId,
          title: input.title,
          action,
          sourceRef,
        }),
      )
      .then(
        (copy) =>
          navigation.dispatch(
            StackActions.replace("CopyProject", {
              environmentId: machine.environmentId,
              projectId: input.projectId,
              copyId: copy.copyId,
            }),
          ),
        (cause: unknown) => {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : "The machine did not start it.");
        },
      );
  };

  const clone = () => {
    if (machine === null || folderName === null) return;
    const input = buildCloneImportInput({
      importId: ProjectImportId.make(uuidv4()),
      projectId: newProjectId(),
      destinationPath: cloneDestinationPath(parent, folderName),
      remoteUrl,
    });
    if (input === null) {
      setError("The machine can't clone that. Check the URL (https or ssh, no password in it).");
      return;
    }
    void runImport(input, "clone", null);
  };

  const link = (path: string, source: OtherMachineProject) => {
    if (machine === null) return;
    const input = buildLinkImportInput({
      importId: ProjectImportId.make(uuidv4()),
      projectId: newProjectId(),
      destinationPath: path,
      source: source.project,
    });
    if (input === null) {
      setError("The machine can't take this folder as a project.");
      return;
    }
    void runImport(input, "link", {
      environmentId: source.project.environmentId,
      projectId: source.project.id,
    });
  };

  if (machines.length === 0) {
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

  const back =
    stage.kind === "start" ? null : (
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setError(null);
          setStage(
            stage.kind === "link"
              ? { kind: "pick", purpose: "link" }
              : stage.kind === "clone" && stage.browsingParent
                ? { kind: "clone", browsingParent: false }
                : { kind: "start" },
          );
        }}
        className="flex-row items-center gap-1 self-start py-1 active:opacity-70"
      >
        <SymbolView name="chevron.left" size={13} tintColor={iconColor as string} />
        <Text className="text-sm font-ryco-medium text-foreground-muted">
          {stage.kind === "link" ? "Other project" : "Add from"}
        </Text>
      </Pressable>
    );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingBottom: 44 }}
    >
      {error ? (
        <View className="mx-5 mt-4">
          <ErrorBanner message={error} />
        </View>
      ) : null}

      {stage.kind === "start" ? (
        <>
          <View className="mt-4 gap-2 px-5">
            <Text className="pb-0.5 text-sm font-ryco-medium text-foreground-muted">Machine</Text>
            {machines.map((node) => (
              <OptionRow
                key={node.environmentId}
                label={node.label}
                detail={node.presence === "online" ? "Online" : "Connecting…"}
                selected={node.environmentId === machineId}
                onPress={() => {
                  setPickedMachine(node.environmentId);
                  setCloneParent(null);
                }}
              />
            ))}
          </View>
          <SettingsSection title="Add from">
            {SOURCES.map((entry, index) => {
              const unavailable =
                (entry.source === "clone" || entry.source === "link") && !importSupported
                  ? `Update Ryco on ${machineLabel} to do this from the phone.`
                  : (entry.source === "copy" || entry.source === "link") &&
                      otherProjects.length === 0
                    ? "No project on another machine to bring here."
                    : null;
              return (
                <Pressable
                  key={entry.source}
                  accessibilityRole="button"
                  disabled={unavailable !== null || machine === null}
                  onPress={() => {
                    setError(null);
                    if (entry.source === "folder") setStage({ kind: "folder" });
                    else if (entry.source === "clone") {
                      setStage({ kind: "clone", browsingParent: false });
                    } else setStage({ kind: "pick", purpose: entry.source });
                  }}
                  className={`flex-row items-center gap-3 px-5 py-3.5 active:bg-subtle ${
                    index === 0 ? "" : "border-t border-border-subtle"
                  } ${unavailable ? "opacity-40" : ""}`}
                >
                  <SymbolView name={entry.symbol} size={19} tintColor={iconColor as string} />
                  <View className="min-w-0 flex-1">
                    <Text className="font-sans text-[17px] text-foreground">
                      {entry.label(machineLabel)}
                    </Text>
                    <Text className="mt-0.5 font-sans text-xs leading-4 text-foreground-muted">
                      {unavailable ?? entry.detail}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </SettingsSection>
        </>
      ) : null}

      {stage.kind === "folder" && machine ? (
        <View className="mt-4 gap-3 px-5">
          {back}
          <FolderBrowser
            environmentId={machine.environmentId}
            machineLabel={machine.label}
            initialPath={startPath}
            homeDirectory={knownHome}
            actionLabel={addProjectActionLabel("folder", machine.label)}
            busy={busy}
            onPick={(path) => void addFolder(path)}
          />
        </View>
      ) : null}

      {stage.kind === "clone" && machine && !stage.browsingParent ? (
        <View className="mt-4 gap-4 px-5">
          {back}
          <View className="gap-2">
            <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">Repository</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={remoteUrl}
              onChangeText={setRemoteUrl}
              placeholder="https://github.com/owner/repo.git"
              placeholderTextColor={placeholderColor as string}
              className="min-h-12 rounded-2xl border border-border bg-card px-4 font-mono text-sm"
              style={{ color: textColor as string }}
            />
          </View>
          <View className="gap-2">
            <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">
              Folder on {machine.label}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setStage({ kind: "clone", browsingParent: true })}
              className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 active:bg-subtle"
            >
              <Text className="min-w-0 flex-1 font-mono text-sm text-foreground" numberOfLines={2}>
                {formatProjectPath(
                  folderName ? cloneDestinationPath(parent, folderName) : parent,
                  knownHome,
                )}
              </Text>
              <Text className="text-sm font-ryco-medium text-primary">Change</Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={busy || folderName === null}
            onPress={clone}
            className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
          >
            <Text className="text-base font-ryco-bold text-primary-foreground">
              {busy ? "Starting…" : addProjectActionLabel("clone", machine.label)}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {stage.kind === "clone" && machine && stage.browsingParent ? (
        <View className="mt-4 gap-3 px-5">
          {back}
          <FolderBrowser
            environmentId={machine.environmentId}
            machineLabel={machine.label}
            initialPath={parent}
            homeDirectory={knownHome}
            actionLabel="Clone into this folder"
            onPick={(path) => {
              setCloneParent(path);
              setStage({ kind: "clone", browsingParent: false });
            }}
          />
        </View>
      ) : null}

      {stage.kind === "pick" && machine ? (
        <View className="mt-4 gap-2 px-5">
          {back}
          <Text className="pb-1 font-sans text-sm leading-5 text-foreground-muted">
            {stage.purpose === "copy"
              ? `Pick the project to copy to ${machine.label}.`
              : `Pick the project whose checkout is already on ${machine.label}.`}
          </Text>
          {otherProjects.map((entry) => (
            <OptionRow
              key={`${entry.project.environmentId}:${entry.project.id}`}
              label={entry.project.name}
              detail={`On ${entry.machineLabel} · ${formatProjectPath(
                entry.project.cwd,
                inferHomeDirectory(entry.project.cwd),
              )}`}
              selected={false}
              onPress={() => {
                if (stage.purpose === "link") {
                  setStage({ kind: "link", source: entry });
                  return;
                }
                navigation.dispatch(
                  StackActions.replace("CopyProject", {
                    environmentId: entry.project.environmentId,
                    projectId: entry.project.id,
                    targetEnvironmentId: machine.environmentId,
                  }),
                );
              }}
            />
          ))}
        </View>
      ) : null}

      {stage.kind === "link" && machine ? (
        <View className="mt-4 gap-3 px-5">
          {back}
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            Open the folder on {machine.label} that holds {stage.source.project.name}. Linking adds
            it as a project without changing anything in it.
          </Text>
          <FolderBrowser
            environmentId={machine.environmentId}
            machineLabel={machine.label}
            initialPath={startPath}
            homeDirectory={knownHome}
            actionLabel={addProjectActionLabel("link", machine.label)}
            busy={busy}
            onPick={(path) => link(path, stage.source)}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}
