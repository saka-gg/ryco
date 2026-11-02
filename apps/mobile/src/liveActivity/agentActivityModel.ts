import {
  deriveThreadActivityStatus,
  isArchivedThreadStub,
  isDelegatedThreadLineage,
  type AgentActivitySummary,
  type AgentActivityThread,
  type SidebarThreadOrStub,
  type SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";

import type { InboxEnvironment, InboxSection } from "../features/inbox/inboxModel";

/**
 * The phone's Live Activity for running agents, phase 1: local only. The app starts, updates and
 * ends one card from its own live Inbox state while it runs; nothing is sent anywhere. Once Ryco
 * is suspended the card stops changing and reads "Out of date" at its stale date.
 */

/** Every update moves the card's stale date this far ahead (T3's ten minutes). */
export const AGENT_ACTIVITY_STALE_AFTER_MS = 10 * 60_000;
/** A card that is current within this of its stale date is updated anyway while Ryco runs. */
export const AGENT_ACTIVITY_REFRESH_BEFORE_STALE_MS = 2 * 60_000;
/** A settled card stays on the Lock Screen this long with its results (T3's Done window). */
export const AGENT_ACTIVITY_DISMISS_AFTER_MS = 15 * 60_000;
/** Changes closer together than this become one update. */
export const AGENT_ACTIVITY_COALESCE_MS = 1_000;
/** ActivityKit refuses a content state over 4 KB. */
export const AGENT_ACTIVITY_MAX_STATE_BYTES = 4096;
/**
 * What the app sends at most: 512 bytes under ActivityKit's limit, because Swift's encoding is
 * larger than this JSON (`JSONEncoder` escapes every slash, and every link has several). The
 * native module checks its own encoding again (`AgentActivityContentState.fitted`).
 */
export const AGENT_ACTIVITY_STATE_BUDGET_BYTES = 3584;

/** `modules/ryco-widgets/ios/AgentActivityAttributes.swift` `ContentState`. */
export interface AgentActivityContentState {
  readonly v: 1;
  readonly origin: "local";
  readonly counts: AgentActivitySummary["counts"];
  readonly rows: ReadonlyArray<{
    readonly title: string;
    readonly project: string | null;
    readonly phase: string;
    readonly url: string;
  }>;
  /** What the card opens: the Inbox. */
  readonly url: string;
  readonly updatedAt: number;
}

/** Where the card's links go. */
export interface AgentActivityLinks {
  readonly inbox: string;
  readonly thread: (environmentId: string, threadId: string) => string;
}

/** A card iOS still shows, as `listAgentActivities` reports it or as this app started it. */
export interface AgentActivityCard {
  readonly id: string;
  readonly updatedAt: number;
  readonly staleAt: number | null;
  /** What it shows ({@link agentActivityShownKey}); null for a card an earlier launch left. */
  readonly shownKey: string | null;
}

export interface AgentActivityContext {
  /** Ryco is in the foreground: the only time a card may start. */
  readonly foreground: boolean;
  /** The app's switch is on and iOS allows Live Activities for Ryco. */
  readonly enabled: boolean;
  readonly signedIn: boolean;
  /** Some machine is live, so the summary says what runs; until then nothing is decided. */
  readonly known: boolean;
  /**
   * Since when no machine has been live while Ryco runs, or null while one is. Coming to the
   * foreground starts it again: a resumed app gets its machines' time to reconnect.
   */
  readonly unknownSinceMs: number | null;
  readonly nowMs: number;
}

export type AgentActivityDecision =
  | { readonly kind: "noop" }
  | {
      readonly kind: "start";
      readonly state: AgentActivityContentState;
      readonly staleAtMs: number;
    }
  | {
      readonly kind: "update";
      readonly id: string;
      readonly state: AgentActivityContentState;
      readonly staleAtMs: number;
    }
  | {
      readonly kind: "end";
      readonly id: string;
      /** The final state to show, or null to leave the last one. */
      readonly state: AgentActivityContentState | null;
      /** When iOS removes it; null removes it at once. */
      readonly dismissAtMs: number | null;
    }
  | { readonly kind: "endExtras"; readonly ids: readonly string[] };

/** What a card shows, without the time it was built: an update is due only when this changes. */
export function agentActivityShownKey(state: AgentActivityContentState): string {
  return JSON.stringify({ counts: state.counts, rows: state.rows });
}

export function agentActivityContentState(
  summary: AgentActivitySummary,
  links: AgentActivityLinks,
  nowMs: number,
): AgentActivityContentState {
  return {
    v: 1,
    origin: "local",
    counts: summary.counts,
    rows: summary.rows.map((row) => ({
      title: row.title,
      project: row.projectName,
      phase: row.phase,
      url: links.thread(row.environmentId, row.threadId),
    })),
    url: links.inbox,
    updatedAt: nowMs,
  };
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * The state as the native module takes it, within {@link AGENT_ACTIVITY_STATE_BUDGET_BYTES}: rows
 * go from the end, the counts stay. Five rows of the longest titles fit; this guards the rest.
 */
export function encodeAgentActivityState(state: AgentActivityContentState): string {
  let rows = state.rows;
  let json = JSON.stringify(state);
  while (utf8Bytes(json) > AGENT_ACTIVITY_STATE_BUDGET_BYTES && rows.length > 0) {
    rows = rows.slice(0, -1);
    json = JSON.stringify({ ...state, rows });
  }
  return json;
}

/**
 * What to do with the card now. One card at most: extras end first. It starts only in the
 * foreground with work running or waiting, never in the background; it updates when what it
 * shows changes (and before it goes stale while Ryco runs); and it ends once nothing runs or
 * waits, staying with its results for 15 minutes. Turning the switch off or signing out ends it
 * at once, and so does no machine being live for the stale window while Ryco runs.
 */
export function decideAgentActivity(
  cards: readonly AgentActivityCard[],
  summary: AgentActivitySummary,
  context: AgentActivityContext,
  links: AgentActivityLinks,
): AgentActivityDecision {
  if (cards.length > 1) {
    const newest = cards.reduce((best, card) => (card.updatedAt > best.updatedAt ? card : best));
    return {
      kind: "endExtras",
      ids: cards.filter((card) => card !== newest).map((card) => card.id),
    };
  }
  const card = cards[0];
  if (!context.enabled || !context.signedIn) {
    return card ? { kind: "end", id: card.id, state: null, dismissAtMs: null } : { kind: "noop" };
  }
  const { nowMs } = context;
  if (!context.known) {
    // Nothing can say what still runs: past the stale window the card goes instead of sitting.
    const unknownTooLong =
      context.unknownSinceMs !== null &&
      nowMs - context.unknownSinceMs >= AGENT_ACTIVITY_STALE_AFTER_MS;
    return card !== undefined && unknownTooLong
      ? { kind: "end", id: card.id, state: null, dismissAtMs: null }
      : { kind: "noop" };
  }
  const state = agentActivityContentState(summary, links, nowMs);
  const staleAtMs = nowMs + AGENT_ACTIVITY_STALE_AFTER_MS;
  if (card === undefined) {
    return context.foreground && !summary.settled
      ? { kind: "start", state, staleAtMs }
      : { kind: "noop" };
  }
  if (summary.settled) {
    // A card an earlier launch left that went stale says nothing current: it goes at once.
    const leftOver = card.shownKey === null && card.staleAt !== null && card.staleAt <= nowMs;
    return leftOver
      ? { kind: "end", id: card.id, state: null, dismissAtMs: null }
      : { kind: "end", id: card.id, state, dismissAtMs: nowMs + AGENT_ACTIVITY_DISMISS_AFTER_MS };
  }
  const changed = agentActivityShownKey(state) !== card.shownKey;
  const nearlyStale =
    context.foreground &&
    (card.staleAt === null || card.staleAt - nowMs <= AGENT_ACTIVITY_REFRESH_BEFORE_STALE_MS);
  return changed || nearlyStale
    ? { kind: "update", id: card.id, state, staleAtMs }
    : { kind: "noop" };
}

function attentionOf(thread: Parameters<typeof deriveThreadActivityStatus>[0]) {
  const status = deriveThreadActivityStatus(thread);
  return status === "approval"
    ? "approval"
    : status === "input"
      ? "input"
      : status === "plan-ready"
        ? "plan"
        : null;
}

function finishedAtMs(completedAt: string | null | undefined): number | null {
  const ms = completedAt ? Date.parse(completedAt) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The Inbox's rows as `summarizeAgentActivity` takes them: the same row state and resting rule
 * the Inbox shows, and live only on a machine that is connected with a current shell. The phone
 * keeps no record of which results were seen, so a result counts until its 15 minutes pass.
 */
export function agentActivityThreads(input: {
  readonly sections: ReadonlyArray<InboxSection>;
  readonly threads: ReadonlyArray<SidebarThreadOrStub>;
  readonly environments: ReadonlyArray<InboxEnvironment>;
}): AgentActivityThread[] {
  const threadsByKey = new Map<string, SidebarThreadSummary>(
    input.threads.flatMap((thread) =>
      isArchivedThreadStub(thread)
        ? []
        : [[`${thread.environmentId}:${thread.id}`, thread] as const],
    ),
  );
  const environments = new Map(
    input.environments.map((environment) => [environment.environmentId, environment]),
  );
  return input.sections.flatMap((section) =>
    section.rows.flatMap((row): AgentActivityThread[] => {
      const thread = threadsByKey.get(row.key);
      if (thread === undefined) return [];
      const environment = environments.get(row.environmentId);
      const live =
        environment !== undefined &&
        environment.stale !== true &&
        environment.shellCurrent === true &&
        (environment.connectionState === "connected" ||
          environment.connectionState === "read-only");
      const updatedAtMs = Date.parse(row.updatedAt);
      return [
        {
          key: row.key,
          environmentId: row.environmentId,
          threadId: row.threadId,
          title: row.title,
          projectName: row.isChat ? null : row.projectLabel,
          live,
          state: row.state,
          attention: attentionOf(thread),
          resting: row.attentionState !== "active",
          unseen: true,
          delegated: isDelegatedThreadLineage(thread.lineage),
          finishedAtMs:
            thread.latestTurn?.state === "running"
              ? null
              : finishedAtMs(thread.latestTurn?.completedAt),
          updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
        },
      ];
    }),
  );
}
