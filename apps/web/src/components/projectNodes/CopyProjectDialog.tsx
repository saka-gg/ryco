// FILE: CopyProjectDialog.tsx
// Purpose: "Copy <project> to another node": the form (From, To, How, the
//          folder, options), then the copy's progress inside the dialog, how it
//          ended, and handing a running copy over to its toast when the dialog
//          closes ("Run in background"; closing never cancels).
// Layer: Web UI. Mounted once by `ProjectNodesDialogs` (lazy); opened through
//        `projectNodesDialogStore.openCopyProject`. Copies run through
//        `copyRuntime/copyManager`.

import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { useMemo, useState } from "react";

import { useNodeCatalog } from "../../environments/nodeCatalog";
import { useLogicalProjectSnapshots } from "../../hooks/useLogicalProjectSnapshots";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import { Dialog, DialogPopup } from "../ui/dialog";
import {
  cancelProjectCopy,
  retryProjectCopy,
  showProjectCopyProgress,
  useProjectCopyEntries,
  useProjectCopyEntry,
  viewCopiedProject,
  type ProjectCopyEntry,
} from "./copyRuntime/copyManager";
import { projectCopyView } from "./copyRuntime/projectCopyProgress.logic";
import { CopyProjectForm, type StartedProjectCopy } from "./CopyProjectForm";
import { CopyProjectProgress } from "./CopyProjectProgress";
import {
  closeCopyProject,
  useProjectNodesDialogStore,
  type CopyProjectDialogRequest,
} from "./projectNodesDialogStore";
import { DEFAULT_COPY_DIALOG_SERVICES, type CopyDialogServices } from "./useCopyProjectPlanning";

const NO_PROJECTS: ReadonlyArray<Project> = [];

/** Every checkout of the logical project the request's checkout belongs to (A26 grouping). */
export function copyProjectMembers(
  request: CopyProjectDialogRequest | null,
  snapshots: ReadonlyArray<SidebarProjectSnapshot>,
  projects: ReadonlyArray<Project>,
): ReadonlyArray<Project> {
  if (request === null) return NO_PROJECTS;
  const { environmentId, projectId } = request.source;
  const snapshot = snapshots.find((candidate) =>
    candidate.memberProjectRefs.some(
      (ref) => ref.environmentId === environmentId && ref.projectId === projectId,
    ),
  );
  if (snapshot) return snapshot.memberProjects;
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  return project ? [project] : NO_PROJECTS;
}

/** The app's one copy-to-another-node dialog. */
export function CopyProjectDialog() {
  const slot = useProjectNodesDialogStore((state) => state.copyProject);
  const nodes = useNodeCatalog();
  const { orderedProjects, snapshots } = useLogicalProjectSnapshots();
  const members = useMemo(
    () => copyProjectMembers(slot.request, snapshots, orderedProjects),
    [orderedProjects, slot.request, snapshots],
  );
  const entries = useProjectCopyEntries();
  const copies = useMemo(() => Object.values(entries), [entries]);
  return (
    <CopyProjectDialogView
      open={slot.open}
      token={slot.token}
      request={slot.request}
      nodes={nodes}
      members={members}
      copies={copies}
      services={DEFAULT_COPY_DIALOG_SERVICES}
      onClose={closeCopyProject}
    />
  );
}

type Stage =
  | { readonly token: number; readonly kind: "form"; readonly notice: string | null }
  | { readonly token: number; readonly kind: "copy"; readonly copy: StartedProjectCopy };

export interface CopyProjectDialogViewProps {
  readonly open: boolean;
  /** Bumps on every open: each open starts from a fresh form. */
  readonly token: number;
  readonly request: CopyProjectDialogRequest | null;
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  readonly members: ReadonlyArray<Project>;
  readonly copies: ReadonlyArray<ProjectCopyEntry>;
  readonly services: CopyDialogServices;
  readonly onClose: () => void;
}

/** The dialog over its data, so tests can hand it nodes, checkouts and services. */
export function CopyProjectDialogView(props: CopyProjectDialogViewProps) {
  const { open, token, request, onClose } = props;
  const [stage, setStage] = useState<Stage>({ token, kind: "form", notice: null });
  if (stage.token !== token) setStage({ token, kind: "form", notice: null });
  const copyId = stage.kind === "copy" ? stage.copy.copyId : null;
  const entry = useProjectCopyEntry(copyId);
  const [retrying, setRetrying] = useState(false);

  // A stopped copy goes back to the form, as the mockup's Cancel does.
  const stopped =
    entry !== null && !entry.running && entry.progress.phase === "cancelled" ? entry : null;
  const stoppedView = stopped
    ? projectCopyView(stopped.progress, {
        title: stopped.title,
        sourceLabel: stopped.sourceLabel,
        targetLabel: stopped.targetLabel,
      })
    : null;
  const notice =
    stage.kind === "form"
      ? stage.notice
      : stoppedView
        ? `${stoppedView.title}. ${stoppedView.description}`
        : null;
  const showForm = stage.kind === "form" || stoppedView !== null;

  const close = () => {
    // A copy the dialog showed goes on in its toast; closing never cancels it.
    if (copyId !== null) showProjectCopyProgress(copyId);
    onClose();
  };
  // The progress view has no close button (the mockup's percent sits there).
  const progressShown = !showForm && entry !== null && entry.running;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup
        className="max-h-[calc(100dvh-2rem)] max-w-[744px] overflow-hidden"
        data-testid="copy-project-dialog"
        showCloseButton={!progressShown}
      >
        {request === null ? null : stage.kind === "copy" && !showForm ? (
          <CopyProjectProgress
            copy={stage.copy}
            entry={entry}
            nodes={props.nodes}
            members={props.members}
            retrying={retrying}
            onCancel={() => cancelProjectCopy(stage.copy.copyId)}
            onBackground={close}
            onRetry={() => {
              setRetrying(true);
              void retryProjectCopy(stage.copy.copyId, { toast: false })
                .catch((error: unknown) => console.warn("Retrying the copy failed.", error))
                .finally(() => setRetrying(false));
            }}
            onStartThread={() => {
              void viewCopiedProject(stage.copy.copyId);
              onClose();
            }}
            onClose={close}
          />
        ) : (
          <CopyProjectForm
            key={`${stage.token}:${copyId ?? ""}`}
            request={request}
            nodes={props.nodes}
            members={props.members}
            copies={props.copies}
            services={props.services}
            notice={notice}
            onStarted={(copy) => setStage({ token: stage.token, kind: "copy", copy })}
            onClose={close}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
