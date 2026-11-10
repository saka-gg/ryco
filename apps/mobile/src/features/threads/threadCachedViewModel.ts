import type { ThreadConnectionDegradedReason } from "../../connection/threadConnectionRetarget";

/**
 * Wave 3a: what a thread detail surface renders when its content is cache
 * provenance rather than live node state.
 *
 * Every decision the screen makes about that condition lives here, because
 * `ThreadDetailScreen.tsx` imports react-native and therefore can never be
 * tested (untranspiled Flow). The screen keeps the layout; this module keeps
 * the judgement.
 *
 * Two liveness rules this encodes, both learned the hard way:
 *
 * - Cache provenance is read from `selectEnvironmentHydratedFromCacheAt`, never
 *   from the per-environment WS ui-state. A demoted environment's socket slot is
 *   reset on dispose and then reads "connecting" forever, so keying the cached
 *   treatment on it would leave a cached thread presenting as a live one that is
 *   merely slow.
 * - A degraded retarget always produces a banner. The acceptance criterion for
 *   this wave is that an unselectable node's thread opens "read-only from cache
 *   with a stated reason, and does not hang" — a silent surface with a spinner
 *   is the exact failure the reason copy exists to prevent.
 */

export interface ThreadCachedViewInput {
  /**
   * `selectEnvironmentHydratedFromCacheAt(state, environmentId)` — non-null
   * while this environment's rows came from the snapshot cache (hydrated at
   * launch, or demoted after a disconnect) with no live snapshot applied since.
   */
  readonly hydratedFromCacheAt: number | null;
  /** The retarget engine's stated reason, or null while it is pending/idle. */
  readonly degradedReason: ThreadConnectionDegradedReason | null;
  /**
   * The environment row's wave 2 staleness phrase ("Online · cached",
   * "Offline · last seen 2h ago"). Reused verbatim: this wave introduces no
   * second staleness vocabulary.
   */
  readonly staleDetail: string | null;
  /** Whether the cached snapshot carries any timeline content at all. */
  readonly hasMessages: boolean;
}

export interface ThreadCachedViewBanner {
  readonly text: string;
  readonly tone: "info" | "warning";
}

export interface ThreadCachedView {
  /** Non-null whenever the thread is not live. Never null while degraded. */
  readonly banner: ThreadCachedViewBanner | null;
  readonly composerDisabled: boolean;
  /** Model picker, session policy sheet, rename / stop / archive. */
  readonly actionsDisabled: boolean;
  /**
   * Approval / user-input / agent-control prompt cards. Demotion preserves the
   * activities these render from, but responding goes through
   * `ensureEnvironmentApi`, which throws without a connection — and a prompt
   * answered against a cached snapshot may already be stale on the node.
   */
  readonly promptsDisabled: boolean;
  /** Replacement empty-state copy; null keeps the live "No messages yet" line. */
  readonly emptyStateDetail: string | null;
  /** Gate the header status the way the inbox gates a stale row's state. */
  readonly headerForcedOffline: boolean;
}

/** Fallback when the environment row has no wave 2 phrase to lend. */
export const THREAD_CACHED_FALLBACK_STALE_DETAIL = "Offline · cached";

/**
 * A cache-hydrated thread renders shell only — title, model, branch, no
 * messages. The live "No messages yet. Send one to get started." line is
 * actively wrong there: it claims an empty conversation when what we have is an
 * unsynced one.
 */
export const THREAD_CACHED_EMPTY_STATE_DETAIL =
  "Cached view — messages appear when this node reconnects.";

/**
 * Bounded reason copy, mirroring web's `HOSTED_NODE_ROUTE_NOTICE_COPY`
 * register: one sentence of cause, one of consequence, and never a raw node id,
 * environment id or transport error string. Anything unbounded here becomes a
 * banner that leaks internals to a user who can only act on the cause.
 */
const THREAD_CACHED_REASON_COPY: Record<ThreadConnectionDegradedReason, string> = {
  revoked: "Access to this node was revoked. Showing cached content.",
  "node-missing": "This node is no longer in your Hub directory. Showing cached content.",
  "directory-unavailable": "The Hub directory is unreachable. Showing cached content.",
  "signed-out": "Hub session ended. Sign in to reconnect. Showing cached content.",
  "hub-unreachable": "Your Hub can't be reached right now. Showing cached content.",
  "hosted-unavailable": "Hub connections are unavailable on this device. Showing cached content.",
};

const LIVE_VIEW: ThreadCachedView = {
  banner: null,
  composerDisabled: false,
  actionsDisabled: false,
  promptsDisabled: false,
  emptyStateDetail: null,
  headerForcedOffline: false,
};

export function deriveThreadCachedView(input: ThreadCachedViewInput): ThreadCachedView {
  const { hydratedFromCacheAt, degradedReason, staleDetail, hasMessages } = input;
  const cacheProvenance = hydratedFromCacheAt !== null;

  // Live: a live snapshot has landed and the retarget has nothing to report.
  if (!cacheProvenance && degradedReason === null) return LIVE_VIEW;

  // A cache-provenance thread with no timeline is a shell, not an empty
  // conversation. With messages the list speaks for itself and the banner
  // already says the content is cached.
  const emptyStateDetail = hasMessages ? null : THREAD_CACHED_EMPTY_STATE_DETAIL;

  if (degradedReason === null) {
    // Retarget pending or in flight. The thread is cached but the connection is
    // still expected, so the composer stays ENABLED: a send lands in the
    // outbox, and wave 1's per-environment drain gate keeps it from being
    // dispatched to the wrong node. Mutations that cannot be queued — model,
    // policy, rename/stop/archive — are the ones that have to wait.
    return {
      banner: {
        text: staleDetail ?? THREAD_CACHED_FALLBACK_STALE_DETAIL,
        tone: "info",
      },
      composerDisabled: false,
      actionsDisabled: true,
      promptsDisabled: true,
      emptyStateDetail,
      headerForcedOffline: true,
    };
  }

  // Degraded: the retarget decided, before dispatching anything, that this node
  // cannot become the selection. Nothing is coming, so queueing a send would be
  // a promise the app cannot keep — the composer closes too.
  const reasonCopy = THREAD_CACHED_REASON_COPY[degradedReason];
  return {
    banner: {
      text: staleDetail === null ? reasonCopy : `${reasonCopy} ${staleDetail}`,
      tone: "warning",
    },
    composerDisabled: true,
    actionsDisabled: true,
    promptsDisabled: true,
    emptyStateDetail,
    headerForcedOffline: true,
  };
}
