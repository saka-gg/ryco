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
  // Hub machines connect while the sheet is open, so they can take the task.
  useRetainLocalTasks(
    machines.map((machine) => machine.environmentId),
    { demand: true },
  );
  const connected = machines.filter((machine) => machine.connected);
  const tabState = useTasksTabState();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    () =>
      resolveCaptureMachine(machines, [
        request.environmentId,
        tabState.environmentId,
        tabState.captureEnvironmentId,
      ])?.environmentId ?? null,
  );
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
  useEffect(() => {
    if (!noMachine) return;
    closeTaskCapture();
    Alert.alert(
      "No machine to add it to",
      "Tasks live on your machines. Connect one you own to add a task.",
    );
  }, [noMachine]);
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
      machines={connected}
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
