import type { EnvironmentId } from "@ryco/contracts";
import { useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { useEnvironmentSettingsTarget } from "../../../hooks/useEnvironmentSettingsTarget";
import { SettingsTargetProvider } from "../../../settingsTarget";
import { selectProjectsForEnvironment, useStore } from "../../../store";

/**
 * Node-owned settings (worktree root, submodules, new-thread defaults) live
 * in each device's server settings, keyed by project id. Editors below this
 * read and write the checkout's own device, with the same authorization the
 * settings page uses.
 */
export function ProjectNodeSettingsScope(props: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const { target } = useEnvironmentSettingsTarget(props.environmentId);
  return <SettingsTargetProvider value={target}>{props.children}</SettingsTargetProvider>;
}

/**
 * The device's projects as the node-settings editors list them. They use it
 * to refuse editing a project that has been removed, rather than silently
 * writing the device default.
 */
export function useEnvironmentProjectChoices(
  environmentId: EnvironmentId,
): ReadonlyArray<{ readonly id: string; readonly title: string }> {
  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, environmentId)),
  );
  return useMemo(
    () => projects.map((project) => ({ id: project.id, title: project.name })),
    [projects],
  );
}
