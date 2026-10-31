import { requireOptionalNativeModule } from "expo";

/** `modules/ryco-widgets/ios/RycoWidgetsModule.swift`. */
export interface RycoWidgetsNativeModule {
  /** The build embeds the widget extension and its App Group resolves. */
  readonly isAvailable: () => boolean;
  /** Replaces `kind`'s timeline (`encodeWidgetTimeline`) and asks WidgetKit to reload it. */
  readonly writeTimeline: (kind: string, json: string) => Promise<void>;
  /** Removes `kind`'s timeline, so its widget shows its empty state. */
  readonly clear: (kind: string) => Promise<void>;
  /** The build has the extension and iOS allows Live Activities for Ryco. */
  readonly activitiesEnabled: () => boolean;
  /** Starts the agent Live Activity (local, no push token); resolves to its id. */
  readonly startAgentActivity: (stateJson: string, staleDateMs: number) => Promise<string>;
  readonly updateAgentActivity: (
    id: string,
    stateJson: string,
    staleDateMs: number,
    timestampMs: number,
  ) => Promise<void>;
  /** Ends it, showing `stateJson` until `dismissAtMs`; null removes it at once. */
  readonly endAgentActivity: (
    id: string,
    stateJson: string | null,
    dismissAtMs: number | null,
  ) => Promise<void>;
  /** The cards still showing work, with their last update and stale date (epoch ms). */
  readonly listAgentActivities: () => Promise<
    ReadonlyArray<{ readonly id: string; readonly updatedAt: number; readonly staleAt?: number }>
  >;
}

let mobileModule: RycoWidgetsNativeModule | null | undefined;

/**
 * This build's widgets module, or null where there are no widgets: on
 * Android, in Personal Team builds (no extension, no App Group), and in
 * binaries older than the module.
 */
export function rycoWidgetsNative(): RycoWidgetsNativeModule | null {
  if (mobileModule === undefined) {
    const native = requireOptionalNativeModule<RycoWidgetsNativeModule>("RycoWidgets");
    mobileModule = native !== null && native.isAvailable() ? native : null;
  }
  return mobileModule;
}
