import type { AgentActivitySummary } from "@ryco/client-runtime/state/threads";

import type { RycoWidgetsNativeModule } from "../widgets/rycoWidgetsNative";
import {
  AGENT_ACTIVITY_COALESCE_MS,
  agentActivityShownKey,
  decideAgentActivity,
  encodeAgentActivityState,
  type AgentActivityCard,
  type AgentActivityLinks,
} from "./agentActivityModel";

/** The Live Activity half of the widgets module (`RycoWidgetsModule.swift`). */
export type LiveActivityNative = Pick<
  RycoWidgetsNativeModule,
  | "activitiesEnabled"
  | "startAgentActivity"
  | "updateAgentActivity"
  | "endAgentActivity"
  | "listAgentActivities"
>;

export interface LiveActivityRuntimeDeps {
  readonly native: LiveActivityNative;
  readonly links: AgentActivityLinks;
  /** React Native's `AppState`, reduced to whether the app is in the foreground. */
  readonly appState: {
    readonly isActive: () => boolean;
    readonly subscribe: (listener: (active: boolean) => void) => () => void;
  };
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export interface LiveActivityRuntime {
  /** The app's Live Activity switch. */
  readonly setEnabled: (enabled: boolean) => void;
  /**
   * The latest summary of the Inbox. `known` is false until some machine is live; `account`
   * names the signed-in account, and a different one ends the card first.
   */
  readonly setSummary: (
    summary: AgentActivitySummary,
    known: boolean,
    account: string | null,
  ) => void;
  /** Ends every card at once (sign-out) and stops. */
  readonly stop: () => Promise<void>;
  /** Resolves once the work asked for so far is done. */
  readonly settled: () => Promise<void>;
}

const EMPTY_SUMMARY: AgentActivitySummary = {
  counts: { running: 0, needsYou: 0, failed: 0, done: 0 },
  rows: [],
  settled: true,
};

/** Bounds one round of decisions: an extra card ends, then the real one updates. */
const MAX_STEPS = 4;

/**
 * Drives the one Live Activity card from the app's own state while it runs (phase 1: local
 * only, no push token). It decides with {@link decideAgentActivity}, coalesces changes for a
 * second, runs one native call at a time, and adopts a card an earlier launch left.
 */
export function startLiveActivityRuntime(deps: LiveActivityRuntimeDeps): LiveActivityRuntime {
  const now = deps.now ?? Date.now;
  const onError =
    deps.onError ?? ((error: unknown) => console.warn("The Live Activity was not updated.", error));
  let cards: AgentActivityCard[] = [];
  let summary = EMPTY_SUMMARY;
  let known = false;
  let account: string | null = null;
  let enabled = false;
  let foreground = deps.appState.isActive();
  let stopped = false;
  // A card iOS refused, or the person swiped away, is not started again until the next foreground.
  let startBlocked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>) => {
    work = work.then(task).catch(onError);
    return work;
  };

  const endAll = async () => {
    const ending = cards;
    cards = [];
    for (const card of ending) await deps.native.endAgentActivity(card.id, null, null);
  };

  const step = async (): Promise<boolean> => {
    const decision = decideAgentActivity(
      cards,
      summary,
      {
        foreground,
        enabled: enabled && deps.native.activitiesEnabled(),
        signedIn: true,
        known,
        nowMs: now(),
      },
      deps.links,
    );
    switch (decision.kind) {
      case "noop":
        return false;
      case "endExtras":
        for (const id of decision.ids) await deps.native.endAgentActivity(id, null, null);
        cards = cards.filter((card) => !decision.ids.includes(card.id));
        return true;
      case "end":
        cards = cards.filter((card) => card.id !== decision.id);
        await deps.native.endAgentActivity(
          decision.id,
          decision.state === null ? null : encodeAgentActivityState(decision.state),
          decision.dismissAtMs,
        );
        return false;
      case "start": {
        if (startBlocked) return false;
        try {
          const id = await deps.native.startAgentActivity(
            encodeAgentActivityState(decision.state),
            decision.staleAtMs,
          );
          cards = [
            {
              id,
              updatedAt: decision.state.updatedAt,
              staleAt: decision.staleAtMs,
              shownKey: agentActivityShownKey(decision.state),
            },
          ];
        } catch (error) {
          startBlocked = true;
          throw error;
        }
        return false;
      }
      case "update": {
        try {
          await deps.native.updateAgentActivity(
            decision.id,
            encodeAgentActivityState(decision.state),
            decision.staleAtMs,
            decision.state.updatedAt,
          );
        } catch (error) {
          // Gone: the person dismissed it, or iOS ended it.
          cards = cards.filter((card) => card.id !== decision.id);
          startBlocked = true;
          throw error;
        }
        cards = cards.map((card) =>
          card.id === decision.id
            ? {
                ...card,
                updatedAt: decision.state.updatedAt,
                staleAt: decision.staleAtMs,
                shownKey: agentActivityShownKey(decision.state),
              }
            : card,
        );
        return false;
      }
    }
  };

  const run = () =>
    enqueue(async () => {
      if (stopped) return;
      for (let steps = 0; steps < MAX_STEPS && (await step()); steps += 1) {
        // Another decision follows an ended extra card.
      }
    });

  const schedule = (delayMs = AGENT_ACTIVITY_COALESCE_MS) => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
  };

  const unsubscribe = deps.appState.subscribe((active) => {
    foreground = active;
    if (active) startBlocked = false;
    schedule(0);
  });

  // A card an earlier launch left is adopted, or ended once it says nothing current.
  void enqueue(async () => {
    const left = await deps.native.listAgentActivities();
    cards = [
      ...left.map((card) => ({
        id: card.id,
        updatedAt: card.updatedAt,
        staleAt: card.staleAt ?? null,
        shownKey: null,
      })),
      ...cards,
    ];
  });
  schedule(0);

  return {
    setEnabled: (next) => {
      if (next === enabled) return;
      enabled = next;
      if (next) startBlocked = false;
      schedule(0);
    },
    setSummary: (next, nextKnown, nextAccount) => {
      const switched = account !== null && nextAccount !== account;
      account = nextAccount;
      summary = next;
      known = nextKnown;
      if (switched) void enqueue(endAll);
      schedule();
    },
    stop: async () => {
      if (stopped) return work;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      unsubscribe();
      return enqueue(endAll);
    },
    settled: () => work,
  };
}
