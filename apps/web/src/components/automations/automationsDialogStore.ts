import { EnvironmentId, ProjectId, type AgentControlAutomationId } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  rememberedAutomationsProject,
  type AutomationsDialogMode,
  type AutomationsDialogProjectMemory,
  type AutomationsDialogProjectTarget,
  type AutomationsDialogRequest,
} from "./data/automationsDialogProject.logic";

export type {
  AutomationsDialogMode,
  AutomationsDialogProjectMemory,
  AutomationsDialogProjectTarget,
  AutomationsDialogRequest,
};

const AUTOMATIONS_DIALOG_STORAGE_KEY = "ryco:automations-dialog:v1";

const PersistedDialog = Schema.Struct({
  lastProject: Schema.NullOr(
    Schema.Struct({
      projectKey: Schema.String,
      environmentId: EnvironmentId,
      projectId: ProjectId,
    }),
  ),
});
type PersistedDialog = typeof PersistedDialog.Type;

function restoreDialog(): PersistedDialog {
  const fallback: PersistedDialog = { lastProject: null };
  try {
    return getLocalStorageItem(AUTOMATIONS_DIALOG_STORAGE_KEY, PersistedDialog) ?? fallback;
  } catch {
    return fallback;
  }
}

export interface AutomationsDialogState {
  readonly open: boolean;
  /** Bumps on every open, so the host re-applies a request equal to the last one. */
  readonly token: number;
  /** The latest request; kept after closing so the dialog's content stays while it folds. */
  readonly request: AutomationsDialogRequest | null;
  /**
   * The control the dialog grows out of; null fades it in. Held only while
   * open: the popup reads it once when it mounts and keeps it for the fold
   * back, so a closed dialog never pins a control that has since unmounted.
   */
  readonly origin: HTMLElement | null;
  /** The project the dialog showed last (persisted). */
  readonly lastProject: AutomationsDialogProjectMemory | null;
}

/** App-wide state of the one Automations dialog; `AutomationsDialog` is its only host. */
export const useAutomationsDialogStore = create<AutomationsDialogState>()(() => ({
  open: false,
  token: 0,
  request: null,
  origin: null,
  ...restoreDialog(),
}));

interface OpenOptions {
  /** Select this schedule; with `mode: "edit"`, open its editor. */
  readonly automationId?: AgentControlAutomationId | null;
  readonly mode?: AutomationsDialogMode;
  /** The control the dialog grows out of. Pass one for programmatic opens. */
  readonly origin?: HTMLElement | null;
}

/** Name the project by its logical key; `environmentId` is the device for a new schedule. */
interface OpenByProjectKey extends OpenOptions {
  readonly projectKey: string;
  readonly projectId?: never;
  readonly environmentId?: EnvironmentId | null;
}

/** Name the project by one of its checkouts, which is also the device for a new schedule. */
interface OpenByCheckout extends OpenOptions {
  readonly projectKey?: never;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** The project the dialog showed last (or the first one). */
interface OpenLastProject extends OpenOptions {
  readonly projectKey?: never;
  readonly projectId?: never;
  readonly environmentId?: EnvironmentId | null;
}

export type OpenAutomationsDialogInput = OpenByProjectKey | OpenByCheckout | OpenLastProject;

function targetOf(input: OpenAutomationsDialogInput): AutomationsDialogProjectTarget {
  if (input.projectKey !== undefined) return { kind: "key", projectKey: input.projectKey };
  if (input.projectId !== undefined)
    return { kind: "checkout", environmentId: input.environmentId, projectId: input.projectId };
  return { kind: "last" };
}

/**
 * Opens the Automations dialog. Opening it while it is open re-targets it
 * (the host decides whether a draft blocks that) and keeps the control it
 * grew out of.
 */
export function openAutomationsDialog(input: OpenAutomationsDialogInput = {}): void {
  const request: AutomationsDialogRequest = {
    project: targetOf(input),
    automationId: input.automationId ?? null,
    mode: input.mode ?? "view",
    environmentId: input.environmentId ?? null,
  };
  useAutomationsDialogStore.setState((state) => ({
    open: true,
    token: state.token + 1,
    request,
    origin: state.open ? state.origin : (input.origin ?? null),
  }));
}

/**
 * Closes the dialog and lets go of the control it grew out of (the popup
 * already captured it for the fold), so a control torn down by the open —
 * a settings dialog that closes itself — is not kept alive app-wide.
 */
export function closeAutomationsDialog(): void {
  if (!useAutomationsDialogStore.getState().open) return;
  useAutomationsDialogStore.setState({ open: false, origin: null });
}

/** The host calls this with the project it shows, so the next open returns to it. */
export function rememberAutomationsDialogProject(snapshot: SidebarProjectSnapshot): void {
  const lastProject = rememberedAutomationsProject(snapshot);
  const current = useAutomationsDialogStore.getState().lastProject;
  if (
    current?.projectKey === lastProject.projectKey &&
    current.environmentId === lastProject.environmentId &&
    current.projectId === lastProject.projectId
  )
    return;
  useAutomationsDialogStore.setState({ lastProject });
  try {
    setLocalStorageItem(AUTOMATIONS_DIALOG_STORAGE_KEY, { lastProject }, PersistedDialog);
  } catch {
    // Best-effort: a full or unavailable storage keeps it in memory.
  }
}

/** Test-only: a closed dialog with no memory. */
export function resetAutomationsDialogStoreForTests(): void {
  useAutomationsDialogStore.setState({
    open: false,
    token: 0,
    request: null,
    origin: null,
    lastProject: null,
  });
}
