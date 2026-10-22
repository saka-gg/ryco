import type { ModelMultiSelectState } from "@ryco/client-runtime/state/composer";

/**
 * Lets the model picker choose several models for one send ("Compare models":
 * Shift-click, or the toggle under the list). Only passed where a send may
 * start one thread per model: a new draft in a Git project. The picker is
 * controlled: it reports the next state through the shared transitions in
 * `@ryco/client-runtime/state/composer`, and the composer keeps it per draft.
 */
export interface ModelPickerMultiSelect {
  readonly state: ModelMultiSelectState;
  readonly onChange: (next: ModelMultiSelectState) => void;
  /** Defaults to `MULTI_MODEL_SEND_MAX_TARGETS`. */
  readonly max?: number | undefined;
}
