// FILE: AddProjectDialog.tsx
// Purpose: "Add project": the node first, then the source (open a folder, clone a repository,
//          copy from another node, link a checkout), then the folder; a clone or link follows
//          the node's import inline, and the done step shows every node the project is on.
//          It keeps what the command palette's add-project views did: Windows path checks, an
//          existing project opens its latest thread, a missing folder is created, a new thread
//          starts after adding, and the local Desktop node offers the native folder picker.
// Layer: Web UI. Mounted once by `ProjectNodesDialogs` (lazy); opened through
//        `projectNodesDialogStore.openAddProject`. Nodes that implement project copy clone and
//        link through `projects.importStart`; older ones clone with
//        `sourceControl.cloneRepository` and add with `project.create`. An import
//        still running when the dialog closes goes on in the copy runtime
//        (`trackProjectImport`: its toasts, the Copies block, a reload). An
//        import the user leaves before the node answered `importStart` (Cancel,
//        Back) is cancelled by its id, since the node may have started it.

import { isProjectCopyRpcError, joinNodePath } from "@ryco/client-runtime/projectCopy";
import type { AcquiredNode, NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@ryco/contracts";
import {
  PROJECT_IMPORT_TERMINAL_STATUSES,
  ProjectImportId,
  type ProjectImportSnapshot,
  type ProjectImportStartInput,
} from "@ryco/contracts/project-copy";
import { normalizeGitRemoteUrl } from "@ryco/shared/git";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../../environmentApi";
import { acquireNode } from "../../environments/acquireNode";
import { useNodeCatalog } from "../../environments/nodeCatalog";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { hostedCapabilityCopy } from "../../hostedHub/switchTarget";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useLogicalProjectSnapshots } from "../../hooks/useLogicalProjectSnapshots";
import { useSettings } from "../../hooks/useSettings";
import { inferProjectTitleFromPath } from "../../lib/projectPaths";
import { cn, newProjectId, randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useServerConfig } from "../../rpc/serverState";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  addedProjectLead,
  addProjectPrimaryLabel,
  addProjectStepForKind,
  addProjectStepLabels,
  buildAddedProjectNodeRows,
  buildCloneImportInput,
  buildCopySources,
  buildLinkImportInput,
  cloneFolderName,
  describeCloneDestination,
  describeFolderJoin,
  findRepositoryJoin,
  importOverallPercent,
  resolveAddProjectStart,
  type AddedProject,
  type AddProjectSourceKind,
  type AddProjectStep,
  type AddProjectCopySource,
} from "./addProjectDialog.logic";
import { AddedProjectSummary, ImportProgressSteps } from "./AddProjectOutcome";
import { CopyBar } from "./copyProjectDialogParts";
import { AddProjectSourceStep, type AddProjectCloneChoice } from "./AddProjectSourceStep";
import {
  buildCloneRepositoryInput,
  canPickProjectFolderNatively,
  getEnvironmentBrowsePlatform,
  getLocalFileManagerName,
  openOrCreateProjectAtPath,
  resolveAddProjectInitialPath,
  validateAddProjectPath,
} from "./addProjectSources";
import { FolderPicker } from "./FolderPicker";
import { nodePathLeaf, type FolderSelectionStatus } from "./folderPicker.logic";
import { useNodeEnvironmentApi, useNodePathHints } from "./nodePathQueries";
import { NodePicker } from "./NodePicker";
import type { NodePickerExtrasMap } from "./nodePicker.logic";
import { trackProjectImport } from "./copyRuntime/copyManager";
import {
  closeAddProject,
  openCopyProject,
  requestProjectSelectorOpen,
  useProjectNodesDialogStore,
  type AddProjectDialogRequest,
} from "./projectNodesDialogStore";

/** The app's one add-project dialog. */
export function AddProjectDialog() {
  const slot = useProjectNodesDialogStore((state) => state.addProject);
  return (
    <Dialog
      open={slot.open}
      onOpenChange={(next) => {
        if (!next) closeAddProject();
      }}
    >
      <DialogPopup
        className="max-w-[560px] overflow-hidden"
        showCloseButton={false}
        data-testid="add-project-dialog"
      >
        {/* Every open starts from a fresh form; the last one stays while the dialog folds. */}
        <AddProjectFlow key={slot.token} request={slot.request} open={slot.open} />
      </DialogPopup>
    </Dialog>
  );
}

/* ───────── Flow state ───────── */

type AddProjectPhase =
  | { readonly kind: "form" }
  /** A folder is added, or an older node clones; nothing to follow. */
  | { readonly kind: "busy" }
  /** The node clones or links through an import the dialog follows. */
  | {
      readonly kind: "import";
      readonly input: ProjectImportStartInput;
      readonly added: AddedProject;
      /** The node answered `importStart`; the dialog follows the job from here. */
      readonly accepted: boolean;
      readonly snapshot: ProjectImportSnapshot | null;
      readonly error: string | null;
      readonly cancelling: boolean;
    }
  | {
      readonly kind: "done";
      readonly added: AddedProject;
      /** Start a thread in it: an import finished (a folder or legacy clone already did). */
      readonly openThread: boolean;
    };

type ImportPhase = Extract<AddProjectPhase, { kind: "import" }>;

const isTerminalImport = (snapshot: ProjectImportSnapshot | null): boolean =>
  snapshot !== null && PROJECT_IMPORT_TERMINAL_STATUSES.includes(snapshot.status);

/** Applies an import's snapshot: done once it completed, its error once it ended otherwise. */
function reduceImportSnapshot(
  phase: AddProjectPhase,
  snapshot: ProjectImportSnapshot,
): AddProjectPhase {
  if (phase.kind !== "import" || snapshot.importId !== phase.input.importId) return phase;
  if (snapshot.status === "completed") {
    return { kind: "done", added: phase.added, openThread: true };
  }
  const ended = isTerminalImport(snapshot);
  return {
    ...phase,
    accepted: true,
    snapshot,
    cancelling: phase.cancelling && !ended,
    error: ended
      ? (snapshot.error?.message ??
        (snapshot.status === "cancelled" ? "The import was cancelled." : "The import stopped."))
      : null,
  };
}

/** The keys a radio group moves its selection with. */
const ROVING_KEYS: ReadonlySet<string> = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

function toastError(title: string, description: string): void {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

/**
 * Asks the node to cancel an import by its id. One the node never started
 * (`not-found`) has nothing left to cancel, and neither has a node without the call.
 */
async function cancelImportOnNode(
  environmentId: EnvironmentId,
  importId: ProjectImportId,
): Promise<void> {
  const cancel = readEnvironmentApi(environmentId)?.projects.cancelImport;
  if (!cancel) return;
  try {
    await cancel({ importId });
  } catch (error) {
    if (isProjectCopyRpcError(error) && error.code === "not-found") return;
    throw error;
  }
}

/** `<root>/<relative>` with the root's own separator; the root itself for "". */
function projectRootIn(repositoryRoot: string, relativeRoot: string): string {
  return joinNodePath(repositoryRoot, relativeRoot.split("/").filter(Boolean));
}

/**
 * Holds the picked node's connection while the dialog works on it, as a view
 * would: a saved node without a connection is reconnected, and a Hub machine or
 * hosted node keeps a view's scope, so its folders and clone stay reachable.
 */
function useNodeConnection(environmentId: EnvironmentId | null): void {
  useEffect(() => {
    if (environmentId === null) return;
    const controller = new AbortController();
    let held: AcquiredNode | null = null;
    acquireNode(environmentId, { purpose: "follow", signal: controller.signal }).then(
      (node) => {
        if (controller.signal.aborted) node.release();
        else held = node;
      },
      // The pickers say the node is not connected; nothing else to do here.
      () => undefined,
    );
    return () => {
      controller.abort();
      held?.release();
    };
  }, [environmentId]);
}

/** Reads one node's path hints into the node step's card summaries. */
function NodePathHintsProbe(props: {
  readonly environmentId: EnvironmentId;
  readonly onHints: (
    environmentId: EnvironmentId,
    hints: NonNullable<NodePickerExtrasMap[EnvironmentId]>["pathHints"],
  ) => void;
}) {
  const hints = useNodePathHints({ environmentId: props.environmentId, supported: true });
  const data = hints.data ?? null;
  const report = useEffectEvent((value: typeof data) => props.onHints(props.environmentId, value));
  useEffect(() => {
    report(data);
  }, [data]);
  return null;
}

/* ───────── The flow ───────── */

function AddProjectFlow(props: {
  readonly request: AddProjectDialogRequest | null;
  readonly open: boolean;
}) {
  const { request, open } = props;
  const nodes = useNodeCatalog();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const settings = useSettings();
  const { snapshots } = useLogicalProjectSnapshots();
  const navigate = useNavigate();
  const { handleNewThread } = useNewThreadHandler();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryServerConfig = useServerConfig();
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const openSettings = useSettingsDialogStore((state) => state.openSettings);

  const linkSource = useMemo(() => {
    const ref = request?.projectRef ?? null;
    if (ref === null) return null;
    return (
      projects.find(
        (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
      ) ?? null
    );
  }, [projects, request?.projectRef]);

  const [start] = useState(() =>
    resolveAddProjectStart({ request, nodes, linkAvailable: linkSource !== null }),
  );
  const [nodeId, setNodeId] = useState<EnvironmentId | null>(start.nodeId);
  const [step, setStep] = useState<AddProjectStep>(start.step);
  const [kind, setKind] = useState<AddProjectSourceKind | null>(start.kind);
  // The source a request asked for, applied once its node is picked.
  const [requestedKind, setRequestedKind] = useState<AddProjectSourceKind | null>(
    start.nodeId === null ? start.kind : null,
  );
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [clone, setClone] = useState<AddProjectCloneChoice | null>(null);
  const [folderValue, setFolderValue] = useState<string | null>(null);
  const [childNameOverride, setChildNameOverride] = useState<string | null>(null);
  const [status, setStatus] = useState<FolderSelectionStatus | null>(null);
  const [phase, setPhase] = useState<AddProjectPhase>({ kind: "form" });
  const [pickingNatively, setPickingNatively] = useState(false);
  const [hintsByNode, setHintsByNode] = useState<NodePickerExtrasMap>({});
  // The dialog closed (or this open was replaced): a running import is the copy runtime's now.
  const [handedOver, setHandedOver] = useState(false);
  const closedRef = useRef(false);
  // The import whose Cancel came before the node answered `importStart`: the answer cancels it.
  const cancelOnAnswerRef = useRef<ProjectImportId | null>(null);

  const node = nodes.find((entry) => entry.environmentId === nodeId) ?? null;
  // A node that left the catalog sends the flow back to the node step.
  const activeStep: AddProjectStep = node === null ? 0 : step;
  const api = useNodeEnvironmentApi(nodeId);
  useNodeConnection(nodeId);
  const supportsProjectCopy = node?.projectCopySupport === "yes";
  const hints = useNodePathHints({ environmentId: nodeId, supported: supportsProjectCopy });
  const homeDirectory = supportsProjectCopy ? (hints.data?.homeDirectory ?? null) : null;
  const platform = getEnvironmentBrowsePlatform(node?.platformOs);
  const legacyStart = resolveAddProjectInitialPath({
    environmentId: nodeId,
    primaryEnvironmentId,
    primaryServerConfig,
    primarySettings: settings,
    savedEnvironmentRuntimeById,
  });
  const importSupported =
    supportsProjectCopy &&
    api?.projects.importStart !== undefined &&
    api.projects.subscribeImport !== undefined;

  const nodeProjects = useMemo(
    () =>
      excludeChatProjects(projects)
        .filter((project) => project.environmentId === nodeId)
        .map((project) => ({ id: project.id, name: project.name, cwd: project.cwd })),
    [nodeId, projects],
  );
  const projectCountByNode = useMemo(() => {
    const counts = new Map<EnvironmentId, number>();
    for (const project of excludeChatProjects(projects)) {
      counts.set(project.environmentId, (counts.get(project.environmentId) ?? 0) + 1);
    }
    return counts;
  }, [projects]);
  const nodeExtras = useMemo<NodePickerExtrasMap>(() => {
    const extras: Partial<Record<EnvironmentId, NonNullable<NodePickerExtrasMap[EnvironmentId]>>> =
      {};
    for (const entry of nodes) {
      extras[entry.environmentId] = {
        projectCount: projectCountByNode.get(entry.environmentId) ?? 0,
        pathHints: hintsByNode[entry.environmentId]?.pathHints ?? null,
      };
    }
    return extras;
  }, [hintsByNode, nodes, projectCountByNode]);
  const rememberHints = useCallback(
    (
      environmentId: EnvironmentId,
      pathHints: NonNullable<NodePickerExtrasMap[EnvironmentId]>["pathHints"],
    ) => {
      setHintsByNode((current) =>
        current[environmentId]?.pathHints === pathHints
          ? current
          : { ...current, [environmentId]: { pathHints } },
      );
    },
    [],
  );

  const isOnline = useCallback(
    (environmentId: EnvironmentId) =>
      nodes.some((entry) => entry.environmentId === environmentId && entry.presence === "online"),
    [nodes],
  );
  const copySources = useMemo(
    () =>
      nodeId === null
        ? []
        : buildCopySources({
            groups: snapshots.map((snapshot) => ({
              key: snapshot.projectKey,
              name: snapshot.displayName,
              members: snapshot.memberProjects,
            })),
            nodeId,
            isOnline,
          }),
    [isOnline, nodeId, snapshots],
  );

  /* ── Navigation ── */

  const resetFolder = () => {
    setFolderValue(null);
    setChildNameOverride(null);
    setStatus(null);
  };
  // Arrow keys move the node step's selection; a click (or Enter, Space) goes on with it.
  const movedByArrowKeyRef = useRef(false);
  const pickNode = (environmentId: EnvironmentId) => {
    const advance = !movedByArrowKeyRef.current;
    movedByArrowKeyRef.current = false;
    if (environmentId !== nodeId) {
      setNodeId(environmentId);
      setClone(null);
      setRepositoryQuery("");
      resetFolder();
    }
    if (!advance) return;
    const nextKind = requestedKind;
    setRequestedKind(null);
    setKind(nextKind);
    setStep(addProjectStepForKind(nextKind));
  };
  const chooseKind = (next: AddProjectSourceKind | null) => {
    setKind(next);
    if (next === "folder" || next === "link") {
      resetFolder();
      setStep(2);
    }
  };
  const chooseClone = (choice: AddProjectCloneChoice) => {
    setClone(choice);
    resetFolder();
    setStep(2);
  };
  const copyFrom = (entry: AddProjectCopySource) => {
    if (nodeId === null) return;
    closeAddProject();
    openCopyProject({
      source: scopeProjectRef(entry.source.environmentId, entry.source.id),
      targetEnvironmentId: nodeId,
      origin: "add-project",
    });
  };
  const setUpProvider = () => {
    closeAddProject();
    openSettings("source-control", nodeId);
  };

  /* ── Adding ── */

  const openThread = useCallback(
    async (threadRef: Parameters<typeof buildThreadRouteParams>[0]) => {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate],
  );
  const startThreadIn = useCallback(
    (projectRef: ScopedProjectRef) =>
      handleNewThread(projectRef, { envMode: settings.defaultThreadEnvMode }).catch(
        () => undefined,
      ),
    [handleNewThread, settings.defaultThreadEnvMode],
  );

  /**
   * Adds the folder at `path` (creating it when missing). A folder that already is a
   * project opens its latest thread and closes the dialog, as the palette did.
   */
  const addFolder = async (path: string, canonicalKey: string | null) => {
    if (node === null) return;
    const nodeApi = readEnvironmentApi(node.environmentId);
    if (!nodeApi) {
      toastError("Failed to add project", `${node.label} is still connecting. Try again shortly.`);
      return;
    }
    const validation = validateAddProjectPath(path, { platform, currentProjectCwd: null });
    if (!validation.ok) {
      if (validation.reason) toastError("Failed to add project", validation.reason);
      return;
    }
    setPhase({ kind: "busy" });
    const outcome = await openOrCreateProjectAtPath({
      api: nodeApi,
      environmentId: node.environmentId,
      cwd: validation.path,
      projects,
      threads,
      settings,
      openThread,
      handleNewThread,
    });
    switch (outcome.kind) {
      case "create-failed":
        setPhase({ kind: "form" });
        toastError("Failed to add project", errorMessage(outcome.error));
        return;
      case "opened-existing":
        closeAddProject();
        return;
      case "created":
        setPhase({
          kind: "done",
          added: {
            ref: scopeProjectRef(node.environmentId, outcome.projectId),
            name: inferProjectTitleFromPath(validation.path),
            cwd: validation.path,
            canonicalKey,
          },
          openThread: false,
        });
    }
  };

  /** The node's answer for the import it runs: progress, the end, or a failure to show. */
  const applyImportSnapshot = useCallback((snapshot: ProjectImportSnapshot) => {
    setPhase((current) => reduceImportSnapshot(current, snapshot));
  }, []);
  const sendImport = async (input: ProjectImportStartInput) => {
    const environmentId = node?.environmentId ?? null;
    const start =
      environmentId === null ? undefined : readEnvironmentApi(environmentId)?.projects.importStart;
    const update = (patch: Partial<ImportPhase>) =>
      setPhase((current) =>
        current.kind === "import" && current.input === input ? { ...current, ...patch } : current,
      );
    if (!start || environmentId === null) {
      update({ error: `${node?.label ?? "The node"} is not connected.` });
      return;
    }
    let snapshot: ProjectImportSnapshot | null = null;
    let failure: unknown = null;
    try {
      // Idempotent by id: resending after a dropped answer returns the node's job.
      snapshot = await start(input);
    } catch (error) {
      failure = error;
    }
    if (cancelOnAnswerRef.current === input.importId) {
      cancelOnAnswerRef.current = null;
      await cancelAnsweredImport(input, environmentId, snapshot, update);
      return;
    }
    if (snapshot === null) {
      if (closedRef.current) {
        toastError("Couldn't start on the node", errorMessage(failure));
        return;
      }
      update({ error: errorMessage(failure) });
      return;
    }
    if (closedRef.current) {
      // Closed while the node answered: the copy runtime follows it from here.
      if (!isTerminalImport(snapshot)) handOverImport(input, environmentId, snapshot.title);
      return;
    }
    update({ accepted: true, error: null });
    applyImportSnapshot(snapshot);
  };
  /**
   * Cancel came while the node was still answering `importStart`: the job it
   * started (or may have started, when the answer failed) is cancelled now, and
   * the form comes back once the node confirmed. If it can't be cancelled, it
   * stays followed (here, or by the copy runtime once the dialog closed).
   */
  const cancelAnsweredImport = async (
    input: ProjectImportStartInput,
    environmentId: EnvironmentId,
    snapshot: ProjectImportSnapshot | null,
    update: (patch: Partial<ImportPhase>) => void,
  ) => {
    if (snapshot === null || !isTerminalImport(snapshot)) {
      try {
        await cancelImportOnNode(environmentId, input.importId);
      } catch (error) {
        toastError("Couldn't cancel", errorMessage(error));
        if (snapshot !== null && closedRef.current) {
          handOverImport(input, environmentId, snapshot.title);
        } else if (snapshot !== null) {
          update({ accepted: true, cancelling: false, error: null });
          applyImportSnapshot(snapshot);
        } else {
          update({ cancelling: false, error: errorMessage(error) });
        }
        return;
      }
    }
    if (closedRef.current) return;
    setPhase((current) =>
      current.kind === "import" && current.input === input ? { kind: "form" } : current,
    );
  };
  const startImport = (input: ProjectImportStartInput, added: AddedProject) => {
    setPhase({
      kind: "import",
      input,
      added,
      accepted: false,
      snapshot: null,
      error: null,
      cancelling: false,
    });
    void sendImport(input);
  };

  const cloneTo = async (destination: string, choice: AddProjectCloneChoice) => {
    if (node === null) return;
    const validation = validateAddProjectPath(destination, { platform, currentProjectCwd: null });
    if (!validation.ok) {
      if (validation.reason) toastError("Clone failed", validation.reason);
      return;
    }
    const canonicalKey = normalizeGitRemoteUrl(choice.remoteUrl) || null;
    const importInput = importSupported
      ? buildCloneImportInput({
          importId: ProjectImportId.make(randomUUID()),
          projectId: newProjectId(),
          destinationPath: status?.preview?.resolvedPath ?? validation.path,
          remoteUrl: choice.remoteUrl,
        })
      : null;
    if (importInput) {
      startImport(importInput, {
        ref: scopeProjectRef(node.environmentId, importInput.projectId),
        name: importInput.title,
        cwd: importInput.destinationPath,
        canonicalKey,
      });
      return;
    }
    const nodeApi = readEnvironmentApi(node.environmentId);
    if (!nodeApi) {
      toastError("Unable to clone project", `${node.label} is still connecting.`);
      return;
    }
    setPhase({ kind: "busy" });
    try {
      const result = await nodeApi.sourceControl.cloneRepository(
        buildCloneRepositoryInput({
          source: choice.source,
          repository: choice.repository,
          remoteUrl: choice.remoteUrl,
          destinationPath: validation.path,
        }),
      );
      const outcome = await openOrCreateProjectAtPath({
        api: nodeApi,
        environmentId: node.environmentId,
        cwd: result.cwd,
        projects,
        threads,
        settings,
        openThread,
        handleNewThread,
      });
      if (outcome.kind === "create-failed") {
        setPhase({ kind: "form" });
        toastError("Failed to add project", errorMessage(outcome.error));
        return;
      }
      setPhase({
        kind: "done",
        added: {
          ref: scopeProjectRef(node.environmentId, outcome.projectId),
          name: inferProjectTitleFromPath(result.cwd),
          cwd: result.cwd,
          canonicalKey,
        },
        openThread: false,
      });
    } catch (error) {
      setPhase({ kind: "form" });
      toastError("Clone failed", errorMessage(error));
    }
  };

  const linkAt = (destination: string, source: Project) => {
    if (node === null) return;
    const repositoryRoot = status?.preview?.resolvedPath ?? destination;
    const input = buildLinkImportInput({
      importId: ProjectImportId.make(randomUUID()),
      projectId: newProjectId(),
      destinationPath: repositoryRoot,
      source,
    });
    if (input === null) {
      toastError("Unable to link this checkout", "The node can't take this folder as a project.");
      return;
    }
    startImport(input, {
      ref: scopeProjectRef(node.environmentId, input.projectId),
      name: input.title,
      cwd: projectRootIn(repositoryRoot, input.relativeRootInRepository),
      canonicalKey: source.repositoryIdentity?.canonicalKey ?? null,
    });
  };

  const confirm = () => {
    if (phase.kind !== "form" || status === null || !status.usable) return;
    const destination = status.destinationPath;
    if (destination === null) return;
    if (kind === "folder") {
      void addFolder(destination, status.preview?.existingRepositoryCanonicalKey ?? null);
    } else if (kind === "clone" && clone) {
      void cloneTo(destination, clone);
    } else if (kind === "link" && linkSource) {
      linkAt(destination, linkSource);
    }
  };

  /* ── Following an import ── */

  const followedImportId =
    !handedOver && phase.kind === "import" && phase.accepted && !isTerminalImport(phase.snapshot)
      ? phase.input.importId
      : null;
  useEffect(() => {
    if (followedImportId === null || nodeId === null) return;
    // Through the node's current connection: a replaced one ends this stream without an error,
    // so the new one subscribes again, and its first snapshot is the current one.
    const projectsApi = api?.projects;
    const subscribe = projectsApi?.subscribeImport;
    if (!subscribe) return;
    let stopped = false;
    // The stream ended before the job did: ask the node where it stands.
    const recover = async () => {
      const found = await projectsApi.listImports?.({}).then(
        (result) => result.imports.find((entry) => entry.importId === followedImportId) ?? null,
        () => null,
      );
      if (stopped) return;
      if (found) {
        applyImportSnapshot(found);
        return;
      }
      setPhase((current) =>
        current.kind === "import" && current.input.importId === followedImportId
          ? { ...current, error: "Lost track of the import on the node." }
          : current,
      );
    };
    const unsubscribe = subscribe(
      { importId: followedImportId },
      (snapshot) => {
        if (!stopped) applyImportSnapshot(snapshot);
      },
      {
        onError: () => {
          if (!stopped) void recover();
        },
      },
    );
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [api, applyImportSnapshot, followedImportId, nodeId]);
  // A clone or link that finished starts a thread in the new project, as adding a folder does.
  const threadToOpen =
    !handedOver && phase.kind === "done" && phase.openThread ? phase.added.ref : null;
  const openAddedThread = useEffectEvent((projectRef: ScopedProjectRef) => {
    void startThreadIn(projectRef);
  });
  useEffect(() => {
    if (threadToOpen) openAddedThread(threadToOpen);
  }, [threadToOpen]);

  const retryImport = () => {
    if (phase.kind !== "import") return;
    if (!phase.accepted) {
      // The node may never have heard of it: the same request again is safe.
      setPhase({ ...phase, error: null });
      void sendImport(phase.input);
      return;
    }
    // The job ended; a new one gets new ids.
    const input: ProjectImportStartInput = {
      ...phase.input,
      importId: ProjectImportId.make(randomUUID()),
      projectId: newProjectId(),
    };
    startImport(input, {
      ...phase.added,
      ref: scopeProjectRef(phase.added.ref.environmentId, input.projectId),
    });
  };
  const cancelImport = async () => {
    if (phase.kind !== "import" || phase.cancelling) return;
    if (isTerminalImport(phase.snapshot)) {
      setPhase({ kind: "form" });
      return;
    }
    if (!phase.accepted && phase.error === null) {
      // `importStart` is still out: the node may start the job yet, so its answer cancels it.
      cancelOnAnswerRef.current = phase.input.importId;
      setPhase({ ...phase, cancelling: true });
      return;
    }
    setPhase({ ...phase, cancelling: true });
    try {
      await cancelImportOnNode(phase.added.ref.environmentId, phase.input.importId);
      setPhase({ kind: "form" });
    } catch (error) {
      setPhase((current) =>
        current.kind === "import" ? { ...current, cancelling: false } : current,
      );
      toastError("Couldn't cancel", errorMessage(error));
    }
  };
  /** Back from an import that failed; one whose start had no answer may still run, so it is cancelled. */
  const leaveFailedImport = () => {
    if (phase.kind === "import" && !phase.accepted) {
      void cancelImportOnNode(phase.added.ref.environmentId, phase.input.importId).catch(
        (error: unknown) =>
          console.warn("Cancelling an import the node did not confirm failed.", error),
      );
    }
    setPhase({ kind: "form" });
  };
  /** The copy runtime follows the import from here: its progress toast, the result, a reload. */
  const handOverImport = (
    input: ProjectImportStartInput,
    environmentId: EnvironmentId,
    title: string,
  ) => {
    const linking = input.source.kind === "existing-checkout";
    void trackProjectImport({
      environmentId,
      importId: input.importId,
      projectId: input.projectId,
      title,
      action: linking ? "link" : "clone",
      sourceRef:
        linking && linkSource ? scopeProjectRef(linkSource.environmentId, linkSource.id) : null,
    }).catch((error: unknown) => {
      toastError("Lost track of the import", errorMessage(error));
    });
  };
  // Closing the dialog (Run in background, Esc, another open) never stops the import.
  const leave = useEffectEvent(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    setHandedOver(true);
    if (phase.kind === "import" && phase.accepted && !isTerminalImport(phase.snapshot)) {
      handOverImport(phase.input, phase.added.ref.environmentId, phase.added.name);
    }
  });
  // Another open replacing this one unmounts it without closing first.
  const leaveIfImporting = useEffectEvent(() => {
    if (phase.kind === "import") leave();
  });
  useEffect(() => {
    if (!open) leave();
  }, [open]);
  useEffect(() => () => leaveIfImporting(), []);
  const runInBackground = () => closeAddProject();

  /* ── Native folder picker (the Desktop app's own node) ── */

  const nativePickerAvailable =
    activeStep === 2 &&
    canPickProjectFolderNatively({ environmentId: nodeId, primaryEnvironmentId });
  const pickNatively = async () => {
    const localApi = readLocalApi();
    if (!localApi || pickingNatively) return;
    // Opens where the selection is, else where the node's folders start.
    const initialPath =
      (folderValue ?? (supportsProjectCopy ? hints.data?.defaultProjectDirectory : legacyStart))
        ?.trim()
        .replace(/[\\/]+$/u, "") ?? "";
    setPickingNatively(true);
    const picked = await localApi.dialogs
      .pickFolder(initialPath.length > 0 ? { initialPath } : undefined)
      // A failed picker leaves the dialog as it was.
      .catch(() => null);
    setPickingNatively(false);
    if (!picked) return;
    if (kind === "folder") void addFolder(picked, null);
    else setFolderValue(picked);
  };

  /* ── What the folder step says ── */

  const describeStatus = useCallback(
    (base: FolderSelectionStatus): FolderSelectionStatus => {
      if (kind === "clone" && clone) {
        return describeCloneDestination(base, { remoteUrl: clone.remoteUrl, homeDirectory });
      }
      if (kind === "folder" && nodeId !== null) {
        return describeFolderJoin(
          base,
          findRepositoryJoin({
            canonicalKey: base.preview?.existingRepositoryCanonicalKey ?? null,
            nodeId,
            projects,
            nodes,
          }),
        );
      }
      return base;
    },
    [clone, homeDirectory, kind, nodeId, nodes, projects],
  );

  const writeMethod =
    kind === "folder"
      ? ORCHESTRATION_WS_METHODS.dispatchCommand
      : kind === "link" || importSupported
        ? WS_METHODS.projectsImportStart
        : WS_METHODS.sourceControlCloneRepository;
  const writeCapability = useHostedRpcCapability(writeMethod, nodeId);

  /* ── Rendering ── */

  if (phase.kind === "done" && node) {
    return (
      <AddProjectDone
        added={phase.added}
        node={node}
        nodes={nodes}
        projects={projects}
        onShowInSelector={() => {
          closeAddProject();
          // The new draft's hero opens its project selector once it shows the project.
          requestProjectSelectorOpen(phase.added.ref);
          void startThreadIn(phase.added.ref);
        }}
      />
    );
  }
  if (phase.kind === "import" && node) {
    return (
      <AddProjectImportProgress
        phase={phase}
        node={node}
        verb={phase.input.source.kind === "existing-checkout" ? "Linking" : "Cloning"}
        onCancel={() => void cancelImport()}
        onBackground={runInBackground}
        onRetry={retryImport}
        onBack={leaveFailedImport}
      />
    );
  }

  const busy = phase.kind === "busy";
  const labels = addProjectStepLabels({ nodeLabel: node?.label ?? null, kind, step: activeStep });
  let body: ReactNode;
  let footer: ReactNode;
  if (activeStep === 0 || node === null) {
    body = (
      <>
        <p className="m-0 text-muted-foreground">Which node should the project live on?</p>
        <div
          onKeyDownCapture={(event) => {
            movedByArrowKeyRef.current = ROVING_KEYS.has(event.key);
          }}
          onClickCapture={() => {
            movedByArrowKeyRef.current = false;
          }}
        >
          <NodePicker
            nodes={nodes}
            extras={nodeExtras}
            value={nodeId}
            onValueChange={pickNode}
            aria-label="Node"
          />
        </div>
        {nodes
          .filter((entry) => entry.projectCopySupport === "yes" && entry.presence !== "offline")
          .map((entry) => (
            <NodePathHintsProbe
              key={entry.environmentId}
              environmentId={entry.environmentId}
              onHints={rememberHints}
            />
          ))}
      </>
    );
    footer = (
      <>
        <FooterSummary>
          Pair more devices in{" "}
          <button
            type="button"
            className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              closeAddProject();
              openSettings("connections");
            }}
          >
            Settings → Connections
          </button>
          .
        </FooterSummary>
        <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
      </>
    );
  } else if (activeStep === 1) {
    body = (
      <AddProjectSourceStep
        node={node}
        nodes={nodes}
        kind={kind}
        onKindChange={chooseKind}
        projects={projects}
        copySources={copySources}
        linkSource={linkSource}
        repositoryQuery={repositoryQuery}
        onRepositoryQueryChange={setRepositoryQuery}
        onClone={chooseClone}
        onCopy={copyFrom}
        onSetUpProvider={setUpProvider}
      />
    );
    footer = (
      <>
        <Button size="sm" variant="outline" onClick={() => setStep(0)}>
          Back
        </Button>
        <FooterSummary />
        <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
      </>
    );
  } else {
    const folderKind: AddProjectSourceKind = kind ?? "folder";
    const cloneStart = supportsProjectCopy
      ? (hints.data?.defaultProjectDirectory ?? null)
      : legacyStart;
    const childName =
      folderKind === "clone" && clone
        ? (childNameOverride ?? cloneFolderName(clone.remoteUrl, clone.repositoryInput))
        : null;
    const lead =
      folderKind === "clone" && clone ? (
        <>
          Where should{" "}
          <b className="font-medium text-foreground">{childName ?? clone.repositoryInput}</b> go on{" "}
          <b className="font-medium text-foreground">{node.label}</b>? Pick the parent folder.
        </>
      ) : folderKind === "link" && linkSource ? (
        <>
          Which checkout of <b className="font-medium text-foreground">{linkSource.name}</b> on{" "}
          <b className="font-medium text-foreground">{node.label}</b>?
        </>
      ) : (
        <>
          Which folder on <b className="font-medium text-foreground">{node.label}</b>?
        </>
      );
    const primaryLabel = addProjectPrimaryLabel({
      kind: folderKind,
      nodeLabel: node.label,
      status,
    });
    const capabilityReason = writeCapability.allowed
      ? null
      : hostedCapabilityCopy(writeCapability, node.label);
    body = (
      <>
        <p className="m-0 text-muted-foreground">{lead}</p>
        <FolderPicker
          key={`${node.environmentId}\u0000${folderKind}`}
          environmentId={node.environmentId}
          nodeLabel={node.label}
          platformOs={node.platformOs}
          supportsProjectCopy={supportsProjectCopy}
          mode={folderKind === "clone" ? "parent" : folderKind === "link" ? "link" : "folder"}
          value={folderValue ?? (folderKind === "clone" ? cloneStart : null)}
          onValueChange={setFolderValue}
          initialDirectory={supportsProjectCopy ? undefined : legacyStart}
          initialQuery={
            folderKind === "link" && linkSource
              ? (linkSource.repositoryIdentity?.name ?? linkSource.name)
              : undefined
          }
          childName={childName}
          expectedRepositoryCanonicalKey={
            folderKind === "link"
              ? (linkSource?.repositoryIdentity?.canonicalKey ?? null)
              : undefined
          }
          projects={nodeProjects}
          allowNewFolder={folderKind === "folder"}
          describeStatus={describeStatus}
          statusAction={
            folderKind === "folder" &&
            status?.kind === "existing-project" &&
            status.destinationPath !== null ? (
              <Button
                size="xs"
                variant="outline"
                className="shrink-0"
                disabled={busy}
                onClick={() => {
                  if (status.destinationPath) void addFolder(status.destinationPath, null);
                }}
              >
                Open
              </Button>
            ) : null
          }
          onStatusChange={setStatus}
          onUseSuggestedPath={(path) => {
            if (folderKind === "clone") setChildNameOverride(nodePathLeaf(path));
            else setFolderValue(path);
          }}
          onSubmit={confirm}
          autoFocus
        />
      </>
    );
    footer = (
      <>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setStep(1)}>
          Back
        </Button>
        <FooterSummary>
          {capabilityReason ? (
            capabilityReason
          ) : nativePickerAvailable ? (
            <Button
              size="xs"
              variant="ghost"
              className="-ms-2 text-muted-foreground"
              disabled={pickingNatively || busy}
              onClick={() => void pickNatively()}
            >
              Open in {getLocalFileManagerName(navigator.platform)}
            </Button>
          ) : null}
        </FooterSummary>
        <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
        <Button
          size="sm"
          disabled={busy || !writeCapability.allowed || status === null || !status.usable}
          onClick={confirm}
          data-testid="add-project-primary"
        >
          {busy ? <Spinner className="size-3.5" /> : null}
          {primaryLabel}
        </Button>
      </>
    );
  }

  return (
    <>
      <AddProjectHeader title={ADD_PROJECT_TITLE} />
      <AddProjectStepper
        labels={labels}
        step={activeStep}
        onStep={(index) => {
          if (!busy) setStep(index);
        }}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3.5 text-[13px]">
        {body}
      </div>
      <AddProjectFooter>{footer}</AddProjectFooter>
    </>
  );
}

/* ───────── Pieces ───────── */

const ADD_PROJECT_TITLE = (
  <>
    <PlusIcon aria-hidden className="size-[15px]" />
    Add project
  </>
);

function AddProjectHeader(props: { readonly title: ReactNode; readonly trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3">
      <DialogTitle className="flex min-w-0 flex-1 items-center gap-2 font-sans font-semibold text-[15px] leading-normal">
        {props.title}
      </DialogTitle>
      {props.trailing ?? (
        <DialogClose
          aria-label="Close"
          render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground" />}
        >
          <XIcon />
        </DialogClose>
      )}
    </div>
  );
}

function AddProjectFooter(props: { readonly children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-border border-t px-4 py-[11px]">
      {props.children}
    </div>
  );
}

function FooterSummary(props: { readonly children?: ReactNode }) {
  return (
    <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
      {props.children}
    </span>
  );
}

/** Node › Source › Folder; finished steps can be clicked to go back. */
function AddProjectStepper(props: {
  readonly labels: readonly [string, string, string];
  readonly step: AddProjectStep;
  readonly onStep: (step: AddProjectStep) => void;
}) {
  return (
    <ol
      aria-label="Steps"
      className="m-0 flex list-none flex-wrap gap-1 border-border border-b px-4 pb-3 text-[12px]"
    >
      {props.labels.map((label, index) => {
        const position = index as AddProjectStep;
        const done = position < props.step;
        const current = position === props.step;
        return (
          <Fragment key={position}>
            {index > 0 ? (
              <li aria-hidden className="self-center text-muted-foreground opacity-50">
                ›
              </li>
            ) : null}
            <li>
              <button
                type="button"
                disabled={!done}
                aria-current={current ? "step" : undefined}
                onClick={() => props.onStep(position)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full py-[3px] ps-1 pe-2.5 text-muted-foreground outline-none",
                  "transition-colors duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
                  "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                  current && "bg-foreground/11 text-foreground",
                  done && "cursor-pointer text-foreground hover:bg-accent/60",
                )}
              >
                <span
                  className={cn(
                    "grid size-4 place-items-center rounded-full bg-muted text-[10px]",
                    current && "bg-primary text-primary-foreground",
                    done && "bg-success text-white",
                  )}
                >
                  {done ? (
                    <CheckIcon aria-hidden className="size-2.5" strokeWidth={3} />
                  ) : (
                    index + 1
                  )}
                </span>
                {label}
              </button>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

function AddProjectImportProgress(props: {
  readonly phase: ImportPhase;
  readonly node: NodeCatalogEntry;
  readonly verb: "Cloning" | "Linking";
  readonly onCancel: () => void;
  readonly onBackground: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}) {
  const { phase, node } = props;
  const percent = phase.snapshot ? importOverallPercent(phase.snapshot) : 0;
  const failed = phase.error !== null;
  return (
    <>
      <AddProjectHeader
        title={`${props.verb} ${phase.added.name} ${props.verb === "Cloning" ? "to" : "on"} ${node.label}`}
        trailing={
          failed ? undefined : (
            <span className="text-[11.5px] text-muted-foreground">{percent}%</span>
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3.5 text-[13px]">
        <CopyBar percent={percent} />
        <ImportProgressSteps
          snapshot={phase.snapshot}
          startingLabel={`Asking ${node.label} to start…`}
        />
        {phase.error ? (
          <p
            role="alert"
            className="m-0 rounded-lg bg-destructive/8 px-2.5 py-2 text-[12px] text-destructive-foreground"
          >
            {phase.error}
          </p>
        ) : null}
        {phase.snapshot && phase.snapshot.warnings.length > 0 ? (
          <ul className="m-0 list-none p-0 text-[11.5px] text-warning-foreground">
            {phase.snapshot.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <AddProjectFooter>
        {failed ? (
          <>
            <Button size="sm" variant="outline" onClick={props.onBack}>
              Back
            </Button>
            <FooterSummary />
            <Button size="sm" onClick={props.onRetry}>
              Try again
            </Button>
          </>
        ) : (
          <>
            <FooterSummary>This keeps running on {node.label} if you close it.</FooterSummary>
            <Button
              size="sm"
              variant="outline"
              disabled={phase.cancelling}
              onClick={props.onCancel}
            >
              {phase.cancelling ? <Spinner className="size-3.5" /> : null}
              Cancel
            </Button>
            <Button size="sm" variant="outline" onClick={props.onBackground}>
              Run in background
            </Button>
          </>
        )}
      </AddProjectFooter>
    </>
  );
}

function AddProjectDone(props: {
  readonly added: AddedProject;
  readonly node: NodeCatalogEntry;
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  readonly projects: ReadonlyArray<Project>;
  readonly onShowInSelector: () => void;
}) {
  const { added, nodes, projects } = props;
  const rows = useMemo(
    () => buildAddedProjectNodeRows({ added, projects, nodes }),
    [added, nodes, projects],
  );
  const otherNodeLabels = useMemo(() => {
    const labels: string[] = [];
    for (const row of rows) {
      if (row.environmentId === added.ref.environmentId) continue;
      const label = nodes.find((entry) => entry.environmentId === row.environmentId)?.label;
      if (label && !labels.includes(label)) labels.push(label);
    }
    return labels;
  }, [added.ref.environmentId, nodes, rows]);
  return (
    <>
      <AddProjectHeader title={ADD_PROJECT_TITLE} />
      <div
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3.5 text-[13px]"
        data-testid="add-project-done"
      >
        <AddedProjectSummary
          name={added.name}
          node={props.node}
          lead={addedProjectLead(otherNodeLabels)}
          rows={rows}
          nodes={nodes}
        />
      </div>
      <AddProjectFooter>
        <FooterSummary />
        <DialogClose render={<Button size="sm" variant="outline" />}>Done</DialogClose>
        <Button size="sm" onClick={props.onShowInSelector}>
          Show in project selector
        </Button>
      </AddProjectFooter>
    </>
  );
}
