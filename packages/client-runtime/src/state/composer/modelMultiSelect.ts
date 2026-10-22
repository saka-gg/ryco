import type { ModelSelection, ProviderInstanceId } from "@ryco/contracts";

// ---------------------------------------------------------------------------
// Multi-model selection ("Compare models").
//
// A new draft in a Git project may send one prompt to several models at once:
// one thread per model, each in its own worktree (see `multiModelSend.ts`).
// This is the picker's selection state for that, shared by every client. It is
// a plain value: the composer keeps one per draft and hands it to the picker,
// which returns the next value through these transitions.
// ---------------------------------------------------------------------------

/**
 * One thread per model, and the split-pane layout shows at most four threads
 * side by side (docs/thread-split-panes.md).
 */
export const MULTI_MODEL_SEND_MAX_TARGETS = 4;

export interface ModelMultiSelectState {
  /** "Compare models" is on: a send starts one thread per selection. */
  readonly enabled: boolean;
  /** Distinct by instance and model, in the order they were chosen. */
  readonly selections: ReadonlyArray<ModelSelection>;
  /**
   * The selection holds models an earlier send did not create, restored so the
   * next send retries only them (`retryModelMultiSelect`): one is then enough.
   * It stays a retry until "Compare models" is turned off.
   */
  readonly retry?: true | undefined;
}

export const MODEL_MULTI_SELECT_OFF: ModelMultiSelectState = Object.freeze({
  enabled: false,
  selections: Object.freeze([]) as ReadonlyArray<ModelSelection>,
});

/**
 * A selection's identity: its instance and model. Options (effort and the
 * like) travel with the selection but do not make a second target, so one
 * model is never started twice by the same send.
 */
export function modelMultiSelectKey(
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string {
  return JSON.stringify([selection.instanceId, selection.model]);
}

export function isModelMultiSelected(
  state: ModelMultiSelectState,
  instanceId: ProviderInstanceId,
  model: string,
): boolean {
  if (!state.enabled) return false;
  const key = modelMultiSelectKey({ instanceId, model });
  return state.selections.some((selection) => modelMultiSelectKey(selection) === key);
}

/** Turns "Compare models" on, starting from the composer's current model. */
export function enableModelMultiSelect(
  state: ModelMultiSelectState,
  active: ModelSelection,
): ModelMultiSelectState {
  if (state.enabled) return state;
  return { enabled: true, selections: [active] };
}

/** Turns "Compare models" off; the composer keeps its own (single) model. */
export function disableModelMultiSelect(): ModelMultiSelectState {
  return MODEL_MULTI_SELECT_OFF;
}

/**
 * Restores the models a send did not create (`summarizeMultiModelSend`'s
 * `notCreated`) so the next send, built from the composer as it is then,
 * retries only them. Nothing of them exists on the node, so that send is a new
 * submission with new threads. An uncertain target may have started: restore
 * it only when the user asks to send it again after checking its thread.
 */
export function retryModelMultiSelect(
  selections: ReadonlyArray<ModelSelection>,
): ModelMultiSelectState {
  const keys = new Set<string>();
  const distinct = selections.filter((selection) => {
    const key = modelMultiSelectKey(selection);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  if (distinct.length === 0) return MODEL_MULTI_SELECT_OFF;
  return { enabled: true, selections: distinct, retry: true };
}

/** `state` with other selections; a retry stays one. */
function withSelections(
  state: ModelMultiSelectState,
  selections: ReadonlyArray<ModelSelection>,
): ModelMultiSelectState {
  return state.enabled && state.retry
    ? { enabled: true, selections, retry: true }
    : { enabled: true, selections };
}

export interface ModelMultiSelectToggleResult {
  readonly state: ModelMultiSelectState;
  /** The target was not added because the selection is full. */
  readonly refused: boolean;
}

/**
 * Adds `target` to the selection, or removes it when it is already chosen.
 * Toggling while "Compare models" is off turns it on with the composer's
 * current model plus the target (Shift-click on a second model). A full
 * selection refuses another model instead of dropping an earlier one.
 */
export function toggleModelMultiSelect(
  state: ModelMultiSelectState,
  input: {
    readonly active: ModelSelection;
    readonly target: ModelSelection;
    readonly max?: number;
  },
): ModelMultiSelectToggleResult {
  const max = input.max ?? MULTI_MODEL_SEND_MAX_TARGETS;
  const current = state.enabled ? state.selections : [input.active];
  const key = modelMultiSelectKey(input.target);
  if (current.some((selection) => modelMultiSelectKey(selection) === key)) {
    // Shift-clicking the current model only turns the mode on.
    if (!state.enabled) return { state: { enabled: true, selections: current }, refused: false };
    return {
      state: withSelections(
        state,
        current.filter((selection) => modelMultiSelectKey(selection) !== key),
      ),
      refused: false,
    };
  }
  if (current.length >= max) {
    return { state: state.enabled ? state : { enabled: true, selections: current }, refused: true };
  }
  return { state: withSelections(state, [...current, input.target]), refused: false };
}

/**
 * Drops selections the composer can no longer send to (an instance or model
 * that left the catalog). Returns `state` itself when nothing changed.
 */
export function pruneModelMultiSelect(
  state: ModelMultiSelectState,
  isSelectable: (selection: ModelSelection) => boolean,
): ModelMultiSelectState {
  if (!state.enabled) return state;
  const selections = state.selections.filter(isSelectable);
  return selections.length === state.selections.length ? state : withSelections(state, selections);
}

/**
 * The models a send starts, or null for an ordinary single-model send. The
 * composer's own model keeps its live options (the effort dial tunes it), so
 * its selection is replaced by `active` when it is one of them.
 */
export function resolveModelMultiSelectTargets(
  state: ModelMultiSelectState,
  active: ModelSelection,
): ReadonlyArray<ModelSelection> | null {
  if (!state.enabled) return null;
  const activeKey = modelMultiSelectKey(active);
  return state.selections.map((selection) =>
    modelMultiSelectKey(selection) === activeKey ? active : selection,
  );
}

/** How many models a send needs: two to compare, one to retry what a send did not create. */
export function modelMultiSelectMinimum(state: ModelMultiSelectState): number {
  return state.retry ? 1 : 2;
}

/** Why a "Compare models" send cannot go out yet; null when it can. */
export function modelMultiSelectSendBlockReason(
  state: ModelMultiSelectState,
  max = MULTI_MODEL_SEND_MAX_TARGETS,
): string | null {
  if (!state.enabled) return null;
  if (state.selections.length < modelMultiSelectMinimum(state)) {
    return state.retry ? "Choose a model to send to." : "Choose at least two models to compare.";
  }
  if (state.selections.length > max) return `Choose at most ${max} models to compare.`;
  return null;
}
