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
  /**
   * Starts the agent Live Activity; resolves to its id. `pushUpdates` asks for an update token
   * (`pushType: .token`), only when the Hub sends Live Activity updates; a card that cannot get
   * one starts local only.
   */
  readonly startAgentActivity: (
    stateJson: string,
    staleDateMs: number,
    pushUpdates?: boolean,
  ) => Promise<string>;
  /** The widget kinds on the Home and Lock Screens; absent from binaries older than it. */
  readonly installedWidgetKinds?: () => Promise<ReadonlyArray<string>>;
  /** Follows the update tokens of the cards still showing; absent from older binaries. */
  readonly observeAgentActivityPushTokens?: () => void;
  /**
   * Push-to-start (iOS 17.2+): reports the push-to-start token and follows new cards' update
   * tokens; answers whether this iOS can start a card by push. Absent from older binaries.
   */
  readonly observeAgentActivityPushToStart?: () => boolean;
  /**
   * `onAgentActivityPushToken`: a card's update token (hex), or "" once the card ended.
   * `onAgentActivityPushToStartToken`: the app's push-to-start token (hex).
   */
  readonly addListener?: {
    (
      event: "onAgentActivityPushToken",
      listener: (event: { readonly id: string; readonly token: string }) => void,
    ): { readonly remove: () => void };
    (
      event: "onAgentActivityPushToStartToken",
      listener: (event: { readonly token: string }) => void,
    ): { readonly remove: () => void };
  };
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
  /**
   * Ends cards at once: every one, or only those that ended and still show their results
   * (`endedOnly`).
   */
  readonly dismissAgentActivities: (endedOnly: boolean) => Promise<void>;
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
