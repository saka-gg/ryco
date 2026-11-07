import {
  AGENT_ACTIVITY_REFRESH_BEFORE_STALE_MS,
  AGENT_ACTIVITY_STALE_AFTER_MS,
  agentActivityShownKey,
  type AgentActivityContentState,
} from "../liveActivity/agentActivityModel";
import type { RycoWidgetsNativeModule } from "./rycoWidgetsNative";
import { AGENT_WIDGET_KIND } from "./widgetKinds";
import { encodeWidgetTimeline, type WidgetTimelineEntry } from "./widgetTimeline";

/**
 * The agent widget (Home Screen small and medium, Lock Screen rectangular and inline): the same
 * state as the Live Activity's card (`agentActivityContentState`), so the two never disagree. Each
 * write is two entries: the state now, and the same state marked out of date at the card's stale
 * date, so a widget that Ryco stopped updating says so instead of claiming work still runs.
 */
export interface AgentWidgetContent {
  readonly state: AgentActivityContentState;
  /** Past the stale date: unfinished rows read "Out of date". */
  readonly stale: boolean;
}

export function buildAgentWidgetTimeline(
  state: AgentActivityContentState,
  nowMs: number,
): ReadonlyArray<WidgetTimelineEntry<AgentWidgetContent>> {
  return [
    { at: nowMs, content: { state, stale: false } },
    { at: nowMs + AGENT_ACTIVITY_STALE_AFTER_MS, content: { state, stale: true } },
  ];
}

export interface AgentWidgetRuntimeDeps {
  readonly native: Pick<RycoWidgetsNativeModule, "writeTimeline" | "clear">;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export interface AgentWidgetRuntime {
  /**
   * The current state, or null while no machine is live: nothing is written then, and the last
   * timeline goes out of date on its own.
   */
  readonly setState: (state: AgentActivityContentState | null) => void;
  /** Stops; `clear` empties the widget, as on sign-out. */
  readonly stop: (options?: { readonly clear?: boolean }) => Promise<void>;
  readonly settled: () => Promise<void>;
}

/**
 * Writes the agent widget's timeline when what it shows changes, and again before the written one
 * goes out of date while Ryco keeps running. One write at a time; a failed one is tried again
 * with the next state.
 */
export function startAgentWidgetRuntime(deps: AgentWidgetRuntimeDeps): AgentWidgetRuntime {
  const now = deps.now ?? Date.now;
  const onError =
    deps.onError ?? ((error: unknown) => console.warn("The agent widget was not updated.", error));
  let written: { readonly key: string; readonly at: number } | null = null;
  let writes: Promise<void> = Promise.resolve();
  let stopped = false;

  const enqueue = (write: () => Promise<void>, key: string | null) => {
    writes = writes.then(write).catch((error: unknown) => {
      if (written?.key === key) written = null;
      onError(error);
    });
  };

  return {
    setState: (state) => {
      if (stopped || state === null) return;
      const nowMs = now();
      const key = agentActivityShownKey(state);
      const fresh =
        written !== null &&
        nowMs - written.at < AGENT_ACTIVITY_STALE_AFTER_MS - AGENT_ACTIVITY_REFRESH_BEFORE_STALE_MS;
      if (written?.key === key && fresh) return;
      written = { key, at: nowMs };
      const json = encodeWidgetTimeline(buildAgentWidgetTimeline(state, nowMs));
      enqueue(() => deps.native.writeTimeline(AGENT_WIDGET_KIND, json), key);
    },
    stop: async (options = {}) => {
      if (stopped) return writes;
      stopped = true;
      if (options.clear === true) enqueue(() => deps.native.clear(AGENT_WIDGET_KIND), null);
      return writes;
    },
    settled: () => writes,
  };
}
