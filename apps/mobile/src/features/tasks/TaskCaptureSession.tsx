import type { EnvironmentId, LocalTaskLink, ProjectId } from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { useEffect, useState } from "react";
import { Alert, LayoutAnimation } from "react-native";
import { useShallow } from "zustand/react/shallow";

import { selectProjectsAcrossEnvironments, useStore } from "../../state/threadsRuntime";
import { addTasks } from "./taskActions";
import { TaskCaptureSheet, type TaskCaptureInput } from "./TaskCaptureSheet";
import { closeTaskCapture, type TaskCaptureRequest } from "./taskCaptureStore";
import {
  rememberCapture,
  resolveCaptureMachine,
  resolveCaptureProject,
} from "./tasksMachinesModel";
import { useRetainLocalTasks, useTaskMachines } from "./useMachineTasks";
import { updateTasksTabState, useTasksTabState } from "./useTasksTabState";

/** The sheet's own dismissal finishes before the task's sheet is pushed. */
const OPEN_DETAILS_DELAY_MS = 350;

function projectsOf(
  projects: ReturnType<typeof selectProjectsAcrossEnvironments>,
  environmentId: EnvironmentId | null,
) {
  return excludeChatProjects(projects.filter((project) => project.environmentId === environmentId));
}

export function CaptureSession(props: { readonly request: TaskCaptureRequest }) {
  const { request } = props;
  const machines = useTaskMachines();
  const tabState = useTasksTabState();
  // A task made from a chat or pull request goes to that machine or nowhere: its link points there.
  const required = request.link ? (request.environmentId ?? null) : null;
  const [initial] = useState(() =>
    resolveCaptureMachine(
      machines,
      [request.environmentId, tabState.environmentId, tabState.captureEnvironmentId],
      required,
    ),
  );
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(() =>
    initial === null || initial === "unavailable" ? null : initial.environmentId,
  );
  // Hub machines connect while the sheet is open, the chosen one first, so they can take the task.
  useRetainLocalTasks(
    machines.map((machine) => machine.environmentId),
    { demand: true, priority: environmentId === null ? [] : [environmentId] },
  );
  const reachable = machines.filter((machine) => machine.reachable);
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const projects = projectsOf(allProjects, environmentId);
  const [projectId, setProjectId] = useState<ProjectId | null>(() =>
    environmentId === null
      ? null
      : resolveCaptureProject(
          tabState,
          environmentId,
          projects,
          request.environmentId === environmentId ? request.projectId : undefined,
        ),
  );
  const [link, setLink] = useState<{ link: LocalTaskLink; label: string } | null>(
    request.link ? { link: request.link, label: request.linkLabel ?? "Linked" } : null,
  );

  const noMachine = environmentId === null;
  const requiredLabel =
    machines.find((machine) => machine.environmentId === required)?.label ?? "Its machine";
  useEffect(() => {
    if (!noMachine) return;
    closeTaskCapture();
    if (initial === "unavailable") {
      Alert.alert(
        `${requiredLabel} can't take tasks right now`,
        "A task made here belongs on the chat's machine, which is offline or isn't yours. Try again once it's connected.",
      );
      return;
    }
    Alert.alert(
      "No machine to add it to",
      "Tasks live on your machines. Connect one you own to add a task.",
    );
  }, [initial, noMachine, requiredLabel]);
  if (environmentId === null) return null;

  const changeMachine = (next: EnvironmentId) => {
    if (next === environmentId) return;
    setEnvironmentId(next);
    setProjectId(resolveCaptureProject(tabState, next, projectsOf(allProjects, next)));
    // The link points at the old machine's chat or checkout: it stays with that machine.
    if (request.environmentId && request.environmentId !== next) setLink(null);
  };
  const add = (
    inputs: ReadonlyArray<TaskCaptureInput>,
    options: { readonly openDetails: boolean },
  ) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const ids = addTasks(environmentId, inputs);
    updateTasksTabState((state) =>
      rememberCapture(state, environmentId, inputs.at(-1)?.projectId ?? projectId),
    );
    const first = ids[0];
    if (!options.openDetails || first === undefined) return;
    closeTaskCapture();
    setTimeout(() => request.openDetails(environmentId, first), OPEN_DETAILS_DELAY_MS);
  };
  return (
    <TaskCaptureSheet
      machines={reachable}
      environmentId={environmentId}
      onMachineChange={changeMachine}
      projects={projects.map((project) => ({ projectId: project.id, name: project.name }))}
      projectId={projectId}
      onProjectChange={setProjectId}
      link={link}
      onRemoveLink={() => setLink(null)}
      onAdd={add}
      onClose={closeTaskCapture}
    />
  );
}
