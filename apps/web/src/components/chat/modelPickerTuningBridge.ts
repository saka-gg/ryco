import { createContext, useContext } from "react";

/**
 * How a model was picked. `keepOpen` marks a pointer pick while a tuning
 * footer is docked: the picker stays open, so callers must not move focus
 * (e.g. back to the composer), which would dismiss it.
 */
export interface ModelPickMeta {
  readonly keepOpen: boolean;
}

/** Steps the dial by `delta` stops; returns whether the key press was consumed. */
export type TuningStepper = (delta: 1 | -1) => boolean;

/**
 * What the model picker lends the tuning dial docked in its footer: the active
 * model's display name, a way to bring its row back into view, and a slot for
 * the dial's stepper so ←/→ in the picker's search field adjust effort.
 */
export interface ModelPickerTuningBridge {
  readonly activeModelLabel: string | null;
  readonly revealActiveModel: () => void;
  readonly registerStepper: (stepper: TuningStepper | null) => void;
}

export const ModelPickerTuningBridgeContext = createContext<ModelPickerTuningBridge | null>(null);

export function useModelPickerTuningBridge(): ModelPickerTuningBridge | null {
  return useContext(ModelPickerTuningBridgeContext);
}
