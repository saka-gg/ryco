// FILE: ProjectImportDialog.tsx
// Purpose: The app's one "Import from Codex or Claude Code" dialog: resolves
//          the node to import on, who may import there, its projects and
//          providers, and creates missing projects the way the project picker
//          does. The import itself is `ProjectImportPanel`.
// Layer: Web UI. Mounted lazily by `RootAppShell`, opened through
//        `projectImportDialogStore.ts`.

import { type EnvironmentId, type ProjectId, WS_METHODS } from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useEnvironmentSettingsTarget } from "../../hooks/useEnvironmentSettingsTarget";
import { useSettingsPageTarget } from "../../hooks/useSettingsPageTarget";
import { buildProjectCreateCommand } from "../../lib/projectCreateCommand";
import { newProjectId } from "../../lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { useSessionImportAccess } from "../settings/sessionImportAccess";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ProjectImportPanel } from "./ProjectImportPanel";
import { closeProjectImportDialog, useProjectImportDialogStore } from "./projectImportDialogStore";

/**
 * Creates a project in an existing folder on the node through the same
 * `project.create` command the project picker sends. The node checks the
 * folder against its workspace access policy; a folder that does not exist is
 * refused rather than created.
 */
async function createImportProject(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<ProjectId> {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("The node is reconnecting. Retry when it is back.");
  const projectId = newProjectId();
  await api.orchestration.dispatchCommand(
    buildProjectCreateCommand({ projectId, workspaceRoot, createWorkspaceRootIfMissing: false }),
  );
  return projectId;
}

/** Mount once; open with `openProjectImportDialog`. */
export function ProjectImportDialog() {
  const open = useProjectImportDialogStore((state) => state.open);
  const token = useProjectImportDialogStore((state) => state.token);
  const requestedEnvironmentId = useProjectImportDialogStore((state) => state.environmentId);
  // While an import runs the dialog stays: Stop ends it after the current conversation.
  const [running, setRunning] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) closeProjectImportDialog();
      }}
    >
      <DialogPopup
        className="max-w-2xl"
        data-testid="project-import-dialog"
        bottomStickOnMobile={false}
      >
        <ProjectImportDialogBody
          key={token}
          requestedEnvironmentId={requestedEnvironmentId}
          onRunningChange={setRunning}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ProjectImportDialogBody(props: {
  readonly requestedEnvironmentId: EnvironmentId | null;
  readonly onRunningChange: (running: boolean) => void;
}) {
  const settingsPage = useSettingsPageTarget();
  const environmentId = props.requestedEnvironmentId ?? settingsPage.environmentId;
  const { target } = useEnvironmentSettingsTarget(environmentId);
  const { allowed, client } = useSessionImportAccess(target);
  const createCapability = useHostedRpcCapability(WS_METHODS.projectsAdd, environmentId);
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  // Imports land in real projects on this node; chats are not import targets.
  const projects = useMemo(
    () =>
      excludeChatProjects(allProjects)
        .filter((project) => project.environmentId === environmentId)
        .map((project) => ({ id: project.id, name: project.name, workspaceRoot: project.cwd })),
    [allProjects, environmentId],
  );
  const nodeLabel = target?.nodeLabel ?? "this node";
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import from Codex or Claude Code</DialogTitle>
        <DialogDescription>
          Bring whole projects from {nodeLabel}. Conversations are grouped by the folder they ran
          in. Each becomes its own copy in Ryco; the originals stay unchanged.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ProjectImportPanel
          key={environmentId ?? "none"}
          nodeLabel={nodeLabel}
          allowed={allowed}
          canCreateProjects={createCapability.allowed}
          projects={projects}
          providerOptions={target?.serverConfig?.providers ?? []}
          client={client}
          createProject={(workspaceRoot) => {
            if (!environmentId) return Promise.reject(new Error("Choose a node first."));
            return createImportProject(environmentId, workspaceRoot);
          }}
          onRunningChange={props.onRunningChange}
        />
      </DialogPanel>
    </>
  );
}
