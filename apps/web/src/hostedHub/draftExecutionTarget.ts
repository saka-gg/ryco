import {
  nodeMutationLeaseIsCurrent,
  type NodeMutationLease,
} from "@ryco/client-runtime/authorization";
import type { Project } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import type { DraftId } from "../composerDraftStore";

export interface HostedDraftTargetSelection {
  readonly sequence: number;
  readonly draftId: DraftId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly phase: "connecting" | "project" | "error";
  readonly error?: string;
}

export interface HostedDraftTargetPorts {
  readonly sourceIsCurrent: (request: HostedDraftTargetSelection) => boolean;
  readonly targetIsEligible: (environmentId: EnvironmentId) => boolean;
  readonly routeMatches: (request: HostedDraftTargetSelection) => boolean;
  readonly subscribeRoute: (listener: () => void) => () => void;
  readonly retain: (environmentId: EnvironmentId) => () => void;
  readonly adopt: (environmentId: EnvironmentId) => boolean;
  readonly waitForLease: (environmentId: EnvironmentId) => Promise<NodeMutationLease | null>;
  readonly readLease: (environmentId: EnvironmentId) => NodeMutationLease | null;
  readonly readProjects: (environmentId: EnvironmentId) => ReadonlyArray<Project>;
  readonly canPreviewProjects?: (environmentId: EnvironmentId) => boolean;
  readonly subscribeProjects?: (listener: () => void) => () => void;
  readonly move: (draftId: DraftId, project: Project, logicalKey: string) => void;
  /** Turns the draft into a "No project" chat on the target; absent disables that choice. */
  readonly moveToChat?: (draftId: DraftId, environmentId: EnvironmentId) => void;
  readonly retry: (environmentId: EnvironmentId) => void;
}

/** Where the moved draft lands on the target device. */
type HostedDraftTargetChoice =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "chat" };

/** UI intent survives the shell remount; the existing lifecycle still owns every connection. */
export function createHostedDraftTargetController(ports: HostedDraftTargetPorts) {
  let sequence = 0;
  let loadSequence = 0;
  let selection: HostedDraftTargetSelection | null = null;
  let operation: {
    readonly sequence: number;
    readonly logicalKey: (project: Project) => string;
    readonly sourceLogicalKey: string;
    readonly release: () => void;
    unsubscribeRoute: () => void;
    unsubscribeProjects: () => void;
    previewing: boolean;
    chosen: HostedDraftTargetChoice | null;
  } | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: HostedDraftTargetSelection | null) => {
    selection = next;
    for (const listener of Array.from(listeners)) listener();
  };
  const current = (request: HostedDraftTargetSelection) =>
    operation?.sequence === request.sequence &&
    ports.sourceIsCurrent(request) &&
    ports.routeMatches(request);
  const cancel = (restoreSource = true) => {
    const previous = selection;
    const restore = restoreSource && previous !== null && current(previous);
    operation?.unsubscribeRoute();
    operation?.unsubscribeProjects();
    operation?.release();
    operation = null;
    loadSequence += 1;
    publish(null);
    if (restore && previous) ports.adopt(previous.sourceEnvironmentId);
  };
  const fail = (request: HostedDraftTargetSelection, error: string) => {
    if (current(request)) publish({ ...request, phase: "error", error });
  };
  const chooseTarget = (request: HostedDraftTargetSelection, choice: HostedDraftTargetChoice) => {
    if (!current(request) || !operation) return;
    if (choice.kind === "chat" && !ports.moveToChat) return;
    if (operation.previewing && !ports.readLease(request.environmentId)) {
      // Choosing a cached row records local intent only. The fresh shell must
      // still confirm this project and the mutation lease before moving it.
      operation.chosen = choice;
      publish({ ...request, phase: "connecting" });
      return;
    }
    const before = ports.readLease(request.environmentId);
    const project =
      choice.kind === "project"
        ? ports
            .readProjects(request.environmentId)
            .find((candidate) => candidate.id === choice.projectId)
        : null;
    const after = ports.readLease(request.environmentId);
    if (
      (choice.kind === "project" && !project) ||
      !ports.targetIsEligible(request.environmentId) ||
      !before ||
      !after ||
      !nodeMutationLeaseIsCurrent(before, request.environmentId, after)
    ) {
      fail(request, "The device connection changed. Try again.");
      return;
    }
    if (project) ports.move(request.draftId, project, operation.logicalKey(project));
    else ports.moveToChat?.(request.draftId, request.environmentId);
    // The committed draft takes over destination demand when the shell renders.
    cancel(false);
  };
  const load = async (request: HostedDraftTargetSelection) => {
    const attempt = ++loadSequence;
    try {
      const lease = await ports.waitForLease(request.environmentId);
      if (attempt !== loadSequence || operation?.sequence !== request.sequence) return;
      if (!current(request)) {
        cancel(false);
        return;
      }
      if (!lease || !ports.targetIsEligible(request.environmentId)) {
        fail(request, "Could not connect to this device. Your draft is preserved.");
        return;
      }
      const active = operation;
      active.previewing = false;
      if (active.chosen) {
        chooseTarget(request, active.chosen);
        return;
      }
      const matches = ports
        .readProjects(request.environmentId)
        .filter((project) => active.logicalKey(project) === active.sourceLogicalKey);
      if (matches.length === 1 && matches[0])
        chooseTarget(request, { kind: "project", projectId: matches[0].id });
      else publish({ ...request, phase: "project" });
    } catch {
      if (attempt === loadSequence)
        fail(request, "Could not connect to this device. Your draft is preserved.");
    }
  };
  return {
    getSnapshot: () => selection,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(input: {
      readonly draftId: DraftId;
      readonly project: Project;
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly logicalKey: (project: Project) => string;
    }) {
      if (
        input.project.environmentId === input.environmentId ||
        !ports.targetIsEligible(input.environmentId)
      )
        return;
      const request: HostedDraftTargetSelection = {
        sequence: ++sequence,
        draftId: input.draftId,
        sourceEnvironmentId: input.project.environmentId,
        sourceProjectId: input.project.id,
        environmentId: input.environmentId,
        label: input.label,
        phase: "connecting",
      };
      if (!ports.sourceIsCurrent(request)) return;
      cancel(false);
      operation = {
        sequence: request.sequence,
        logicalKey: input.logicalKey,
        sourceLogicalKey: input.logicalKey(input.project),
        release: ports.retain(input.environmentId),
        unsubscribeRoute: () => undefined,
        unsubscribeProjects: () => undefined,
        previewing: false,
        chosen: null,
      };
      publish(request);
      if (!ports.adopt(input.environmentId)) {
        cancel(false);
        return;
      }
      operation.unsubscribeRoute = ports.subscribeRoute(() => {
        if (!current(request)) cancel(false);
      });
      const preview = () => {
        if (
          !current(request) ||
          !operation ||
          operation.chosen ||
          selection?.phase !== "connecting" ||
          !ports.canPreviewProjects?.(request.environmentId) ||
          ports.readProjects(request.environmentId).length === 0
        )
          return;
        operation.previewing = true;
        publish({ ...request, phase: "project" });
      };
      operation.unsubscribeProjects = ports.subscribeProjects?.(preview) ?? (() => undefined);
      preview();
      void load(request);
    },
    cancel,
    selectProject(projectId: ProjectId) {
      if (selection?.phase === "project") chooseTarget(selection, { kind: "project", projectId });
    },
    /** "No project": the draft becomes a chat on the target device. */
    selectNoProject() {
      if (selection?.phase === "project") chooseTarget(selection, { kind: "chat" });
    },
    retry() {
      if (!selection || !current(selection)) return;
      const request = { ...selection, phase: "connecting" as const };
      publish(request);
      ports.retry(request.environmentId);
      void load(request);
    },
  };
}
