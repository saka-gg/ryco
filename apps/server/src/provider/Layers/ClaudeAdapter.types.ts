/**
 * Claude adapter state shapes and shared constants: session context, turn state, pending
 * requests and the live options. Closure state itself stays in `ClaudeAdapter.ts`.
 */
import type { AgentProcessPriorityShape } from "../agentProcessPriority.ts";
import {
  type ClaudeCacheObservation,
  type ModelSelection,
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeTurnStatus,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ServerProviderSlashCommand,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  type SubagentRef,
  type TaskRunHandles,
  TurnId,
  type UserInputQuestion,
} from "@ryco/contracts";
import {
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionUpdate,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Fiber, Queue, Semaphore } from "effect";
import type { ContextCompactionPolicyState } from "../contextCompactionPolicy.ts";
import type { DeviceToolBinding } from "../../providerTools/deviceToolGateway.ts";
import { ClaudePlanTaskTracker } from "../claudePlanTasks.ts";
import type { ClaudeTranscriptPresence } from "../claudeTranscriptPresence.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  type AgentControlProviderBridge,
  type AgentControlRuntimeLease,
} from "../../agentControl/ProviderInjection.ts";
import type { ClaudeWorkflowPhase } from "./ClaudeAdapter.tasks.ts";
import type { StreamedJsonScan } from "./ClaudeAdapter.tools.ts";

export const PROVIDER = ProviderDriverKind.make("claudeAgent");

export const WAKE_NO_OUTPUT_REASON = "Claude started a background turn but produced no output.";

export const PROVIDER_TURN_STOP_REASON = "Claude did not end the background turn after Stop.";

export const DISCARDED_STEER_TURN_REASON = "Claude started a turn for a message Stop cancelled.";

export const FOLDED_INTO_DISCARDED_STEER_REASON =
  "Claude Code merged this message into a cancelled steer's request, so no reply is shown. Send it again.";

export const STEER_TURN_ENDED_DETAIL =
  "The turn finished before this message could be steered. It stays queued and is sent next.";

export const STEER_TURN_COMPACTING_DETAIL =
  "Claude is compacting the conversation. The message stays queued.";

/** A compaction segment correlates by its own prompt uuid alone. */
export const NO_STEER_PROMPT_UUIDS: ReadonlySet<string> = new Set();

export type ClaudeTextStreamKind = Extract<
  RuntimeContentStreamKind,
  "assistant_text" | "reasoning_text"
>;

export type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

export type ClaudeSdkEffort = NonNullable<ClaudeQueryOptions["effort"]>;

export type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

/** Transcript chain entry, as read by `getSessionMessages`. */
export interface ClaudeTranscriptEntry {
  readonly type: string;
  readonly uuid: string;
  readonly parent_tool_use_id: string | null;
}

export const CLAUDE_TURN_HEADS_CAP = 64;

export const CLAUDE_REWIND_PROBE_TIMEOUT = "30 seconds";

export const CLAUDE_REWIND_TRANSCRIPT_TIMEOUT = "10 seconds";

/** A transcript check that takes longer (a hung network mount) reads as `unknown`. */
export const CLAUDE_TRANSCRIPT_CHECK_TIMEOUT = "2 seconds";

export const CLAUDE_REWIND_QUERY_EXIT_MS = 5_000;

/**
 * How long the CLI may take to answer its initialize control request on a runtime's first turn.
 * It loads its settings, plugins and MCP servers first; a hang there would otherwise surface only
 * through the 90 s turn-acceptance deadline, with no hint at the cause.
 */
export const CLAUDE_STARTUP_INITIALIZE_TIMEOUT_MS = 30_000;

/**
 * Who opened a turn. Anything but "prompt" is a provider turn: Claude started it without a
 * prompt (a background "wake"), so it has no prompt UUID. It still holds exact-turn Agent
 * Control authority (bound as a provider turn), so the agent can keep acting on the user's task.
 */
export type ClaudeTurnOpener = "prompt" | "wake-signal" | "assistant-output";

export interface ClaudeTurnState {
  readonly turnId: TurnId;
  /** Only user-initiated turns have a prompt UUID; provider turns preserve legacy completion. */
  readonly promptUuid?: string;
  readonly openedBy: ClaudeTurnOpener;
  readonly startedAt: string;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  nextSyntheticAssistantBlockIndex: number;
  /** Open thinking blocks by stream index; each one is a reasoning item. */
  readonly reasoningBlocks: Map<number, { readonly itemId: string }>;
  reasoningBlockCount: number;
  /** A root frame proved Claude is producing this turn (first-output watchdog liveness). */
  rootOutputObserved: boolean;
  /** Newest main-chain transcript entry of this turn (subagent sidechains excluded). */
  lastChainUuid: string | undefined;
  /**
   * A root content frame (stream event, assistant or user) was routed into this turn. Unlike
   * `rootOutputObserved`, system frames (`api_retry`, compaction) never set it: they carry no
   * echo, so a wake turn they opened can still turn out to be a discarded steer's CLI turn.
   */
  rootContentObserved: boolean;
  /**
   * Set while one fiber finishes this turn. Concurrent closes wait on it instead of emitting a
   * second lifecycle event.
   */
  completion: Deferred.Deferred<void> | undefined;
  /** Rejected rate-limit windows already warned about in this turn; created lazily. */
  announcedUsageLimitKeys?: Set<string>;
  /** Uuids of steers offered into this turn. The turn owns every CLI segment they start. */
  readonly steerPromptUuids: Set<string>;
  /**
   * Steers that need nothing more: a result consumed them, or Stop's interrupt cancelled them
   * (the CLI never runs those, so no result may discard them again).
   */
  readonly settledSteerPromptUuids: Set<string>;
  /** Steers whose CLI segment's echo was routed into this turn: they run, whatever a receipt says. */
  readonly startedSteerPromptUuids: Set<string>;
  /** Echo sets already re-interrupted after Stop (once per CLI segment). */
  readonly reinterruptedEchoKeys: Set<string>;
  /** Stop was requested for this turn; it never waits for a steer again. */
  interruptRequested: boolean;
  /** CLI segments sealed while the turn waited for a steer's segment. */
  sealedSegmentCount: number;
  /**
   * Set between a sealed segment and the next root frame: the CLI promised another result, and
   * no segment of this turn is running.
   */
  awaitingSteerContinuation:
    | { readonly since: string; readonly segmentStatus: ProviderRuntimeTurnStatus }
    | undefined;
  /**
   * The uuid of the `/compact` the compaction policy sent after this turn's own work completed.
   * The turn stays open for that last segment and closes at its result.
   */
  compactionPromptUuid: string | undefined;
}

/** The only turn-state constructor: prompt and provider turns must share one shape. */
export function makeClaudeTurnState(input: {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly openedBy: ClaudeTurnOpener;
  readonly promptUuid?: string;
}): ClaudeTurnState {
  return {
    turnId: input.turnId,
    ...(input.promptUuid !== undefined ? { promptUuid: input.promptUuid } : {}),
    openedBy: input.openedBy,
    startedAt: input.startedAt,
    assistantTextBlocks: new Map(),
    assistantTextBlockOrder: [],
    capturedProposedPlanKeys: new Set(),
    nextSyntheticAssistantBlockIndex: -1,
    reasoningBlocks: new Map(),
    reasoningBlockCount: 0,
    rootOutputObserved: input.openedBy !== "wake-signal",
    lastChainUuid: undefined,
    rootContentObserved: input.openedBy !== "wake-signal",
    completion: undefined,
    steerPromptUuids: new Set(),
    settledSteerPromptUuids: new Set(),
    startedSteerPromptUuids: new Set(),
    reinterruptedEchoKeys: new Set(),
    interruptRequested: false,
    sealedSegmentCount: 0,
    awaitingSteerContinuation: undefined,
    compactionPromptUuid: undefined,
  };
}

export interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

export interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  /** The CLI refused a session-wide grant for this request. */
  readonly acceptForSessionOffered?: false;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  /** Unparks the waiting handler as cancelled. Session teardown must run it. */
  readonly cancel: Effect.Effect<void>;
}

export interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly partialInputScan: StreamedJsonScan;
  readonly lastEmittedInputFingerprint?: string;
  /** Owning agent when this tool ran inside a subagent (see attribution note). */
  readonly agentId?: string;
  readonly parentToolUseId?: string;
}

/**
 * Agent identity captured from task_started and repeated on every subsequent
 * task.* payload, so client folds can reconstruct an agent even when its
 * start row aged out of activity retention.
 */
export interface ClaudeTaskAgentState {
  backgroundAttempt?: number | undefined;
  readonly taskId: string;
  toolUseId: string | undefined;
  description: string | undefined;
  subagentType: string | undefined;
  taskType: string | undefined;
  workflowName: string | undefined;
  skipTranscript: boolean;
  runHandles: TaskRunHandles | undefined;
  /** Set when this task was launched from inside a subagent. */
  owningAgentId: string | undefined;
  /** Seeded from the launching tool's input; refined by the subagent's own
   * assistant snapshots (authoritative API model). */
  model: string | undefined;
  effort: string | undefined;
}

export interface ClaudeSessionContext {
  readonly generation: number;
  session: ProviderSession;
  /** The start input without its cursor, so a checkpoint revert can reopen the session. */
  readonly startInput: Omit<ProviderSessionStartInput, "resumeCursor" | "resumePolicy">;
  /** Last main-chain entry of recent completed turns (in memory, FIFO-capped). */
  readonly turnHeads: Array<{ readonly turnId: TurnId; readonly head: string }>;
  /** A rewind that later resumes must keep honoring until a turn completes. */
  pendingRewind: { readonly at: string } | undefined;
  /**
   * The Claude Code stderr tail when Ryco spawned the CLI itself (agent priority); the SDK
   * appends it to its exit errors only for its own spawn.
   */
  readonly processStderrTail?: () => string;
  /** Reopen probe in progress: stream exits and error results feed `probeFailure`. */
  probing: boolean;
  probeFailure: Deferred.Deferred<string> | undefined;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  /** The configured CLI command, for startup error messages. */
  readonly cliCommand: string;
  /** The CLI answered its initialize control request; startup is no longer bounded. */
  cliInitialized: boolean;
  readonly deviceToolBinding: DeviceToolBinding | null;
  readonly agentControl?: AgentControlRuntimeLease;
  readonly agentControlHostContext: string;
  agentControlHostContextDelivered: boolean;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  /**
   * The session's own permission mode, which a "default" interaction turn restores. Cleared when
   * the CLI turns out to refuse Auto, so the turns never ask for it again.
   */
  basePermissionMode: PermissionMode | undefined;
  /** The Auto-mode refusal warning was emitted; it is shown once per session. */
  autoModeRefusedWarningEmitted: boolean;
  /**
   * The permission mode this process is known to be in: the start option, then each mode a
   * turn set. Undefined when unknown (no start option, or the CLI may have changed it), so the
   * next turn with an interaction mode sets it explicitly.
   */
  currentPermissionMode: PermissionMode | undefined;
  currentApiModelId: string | undefined;
  /** Effective effort for the session's turns; subagents without an explicit
   * effort override inherit this. */
  currentEffort: string | undefined;
  resumeSessionId: string | undefined;
  /** The session whose transcript the config root was seen to hold (the cursor's `transcriptSeen`). */
  transcriptSeenFor: string | undefined;
  /** The session a completed turn already ran the transcript check for. */
  transcriptCheckedFor: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /** Completed turn ids only (resume `turnCount`, `readThread`); never message bodies. */
  readonly completedTurnIds: Array<TurnId>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  /**
   * The session's Task tool list (TaskCreate/TaskUpdate/TaskGet/TaskList), shown as the plan and
   * carried in the resume cursor. Unlike `inFlightTools`, its pending calls outlive the turn: a
   * background subagent's result can land after the turn settled.
   */
  readonly planTasks: ClaudePlanTaskTracker;
  /**
   * Block indexes of dropped subagent narration, keyed by parent_tool_use_id.
   * Block indexes are per-message, so a suppressed block's
   * content_block_stop must be dropped too — index N could otherwise match
   * the parent's open assistant text block at N and close it mid-stream.
   */
  readonly suppressedSubagentBlocks: Map<string, Set<number>>;
  readonly taskAgents: Map<string, ClaudeTaskAgentState>;
  /** Agent-tool input retained beyond parent-turn completion for delayed task_started. */
  readonly subagentLaunchInputByToolUseId: Map<string, Record<string, unknown>>;
  /**
   * Turn that issued each Agent tool call. Background task_started often
   * arrives after that turn settled (or inside a later wake turn); stamping
   * the launching turn keeps one turn's spawns in one batch.
   */
  readonly subagentLaunchTurnByToolUseId: Map<string, TurnId>;
  /**
   * Authoritative API model observed in a subagent-owned assistant snapshot,
   * keyed by the launching tool use id. The SDK can deliver the snapshot and
   * task_started on independent paths, so retain the observation until both
   * sides of the linkage have arrived.
   */
  readonly subagentModelByToolUseId: Map<string, string>;
  /** Snapshot-only tool calls need the same parent attribution as streamed calls. */
  readonly subagentParentByToolUseId: Map<string, string>;
  /**
   * Last emitted workflow-member fingerprint per member slot. A coordinator
   * task_progress repeats the FULL member array every tick; without a
   * material-transition filter one provider tick fans out into up to 100
   * runtime events (event-log writes, queue pressure, client reducer work)
   * even when nothing changed for most members.
   */
  readonly workflowMemberFingerprints: Map<string, string>;
  /**
   * Rejected rate-limit windows by limit type (reset ISO time, or null when unknown).
   * Account-scoped, so they outlive turns: a wake turn opened after the rejection still
   * classifies its limit stop with the reset. Allowed events clear them.
   */
  readonly rejectedRateLimitWindows: Map<string, string | null>;
  /**
   * Last complete workflow phase roster per coordinator task. Claude only
   * includes workflow_progress on some task_progress heartbeats, while the
   * persisted activity is a latest-state upsert. Repeating this cached shape
   * prevents a thin heartbeat from temporarily erasing future phases in the
   * Agents workspace.
   */
  readonly workflowPhasesByTaskId: Map<string, ReadonlyArray<ClaudeWorkflowPhase>>;
  /** Task ids that have started and not yet reached a terminal state. */
  readonly liveTaskIds: Set<string>;
  /**
   * A person's messages for running subagents, by task id, oldest first. The PreToolUse hook
   * hands them to the agent at its next tool call (`claudeSubagentMessages.ts`).
   */
  readonly pendingSubagentMessages: Map<string, Array<string>>;
  /**
   * Task ids positively observed as backgrounded (membership in a
   * background_tasks_changed set, or a task_updated is_backgrounded patch).
   * Only these are ever settled by set reconciliation: the set carries
   * BACKGROUND work only, so a foreground task's absence proves nothing.
   */
  readonly backgroundedTaskIds: Set<string>;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  cacheObservation: ClaudeCacheObservation | undefined;
  /**
   * Sticky: a root assistant frame reported main-loop usage on this runtime. Legacy task
   * telemetry must never feed the gauge after that, even when a compaction boundary cleared
   * `cacheObservation`.
   */
  mainLoopUsageObserved: boolean;
  /**
   * A compaction boundary was crossed since the last result. That result's cumulative usage
   * includes the pre-compaction input, so it must not become the gauge.
   */
  cumulativeUsageSpansCompaction: boolean;
  cacheModelSelection: ModelSelection | undefined;
  compactionPolicy: ContextCompactionPolicyState;
  /** The CLI's latest init frame lists `/compact`, which the compaction policy sends. */
  supportsAutomaticCompaction: boolean;
  /** Ryco asked this runtime for Fast mode, at start or by a later turn's selection. */
  fastModeRequested: boolean;
  /** `state:reason` of the Fast mode report last seen on this runtime; undefined before one. */
  lastFastModeSignature: string | undefined;
  compactionUnavailableWarningEmitted: boolean;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  readonly subagentByTaskId: Map<string, SubagentRef>;
  readonly startedSubagentIds: Set<string>;
  readonly completedSubagentIds: Set<string>;
  stopped: boolean;
  /** A prompt turn was installed on this runtime; earlier signals are startup/resume handshakes. */
  promptSent: boolean;
  /** sendTurn calls between entry and install. A provider turn must not open under them. */
  turnInstallsInFlight: number;
  /** The CLI emitted `status: requesting`; from then on `init` alone never opens a turn. */
  requestingStatusObserved: boolean;
  /** Protocol capabilities from the latest `system/init`; undefined before the first one. */
  cliCapabilities: ReadonlySet<string> | undefined;
  /**
   * The full slash-command list the CLI last pushed (`commands_changed`), with the adapter-wide
   * order of that push; undefined before the first one.
   */
  slashCommands:
    | { readonly commands: ReadonlyArray<ServerProviderSlashCommand>; readonly order: number }
    | undefined;
  /**
   * Steer uuids that must never reply (Stop, or a failed segment) but that the CLI may still
   * run; their CLI turn is dropped. A uuid leaves the set once a CLI turn consumed it.
   */
  readonly discardedSteerPromptUuids: Set<string>;
  /** A CLI turn of discarded steers is running; its frames are dropped until its result. */
  discardingCliTurn: { readonly uuids: ReadonlySet<string> } | undefined;
  /**
   * A wake signal arrived while discarded steers were pending. The provider turn opens at the
   * next root content frame instead, whose echo was checked first. System frames carry no echo,
   * so they never open it; a result ends the signalling CLI turn and clears the deferral.
   */
  wakeSignalDeferred: boolean;
  /** Serializes SDK frame handling against Stop bookkeeping and steer registration. */
  readonly turnLock: Semaphore.Semaphore;
  /**
   * The turn this runtime finished last and how it ended. Claude sends a turn's
   * `prompt_suggestion` after its result, when the turn is already detached.
   */
  lastFinishedTurn?: { readonly turnId: TurnId; readonly status: ProviderRuntimeTurnStatus };
}

export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  /**
   * Resolves to the interrupt receipt on CLIs with `interrupt_receipt_v1`, else undefined. The
   * 0.3.263 SDK runtime forwards `cancelQueued` as `cancel_queued` even though its public `.d.ts`
   * declares no argument, so the receipt is always parsed defensively.
   */
  readonly interrupt: (options?: { readonly cancelQueued?: boolean }) => Promise<unknown>;
  /** SDK Query.stopTask — present on real queries; optional for test doubles. */
  readonly stopTask?: (taskId: string) => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  /** SDK Query.applyFlagSettings; `null` clears the key from the flag layer. */
  readonly applyFlagSettings: (settings: { readonly fastMode: true | null }) => Promise<void>;
  readonly close: () => void;
  readonly mcpServerStatus?: () => Promise<
    ReadonlyArray<{ readonly name: string; readonly status: string }>
  >;
  /** Resolves once the CLI accepted the initialize control request. */
  readonly initializationResult?: () => Promise<unknown>;
}

export interface ClaudeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly agentControl?: AgentControlProviderBridge;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Test seam: a small capacity makes runtime-event backpressure deterministic. */
  readonly runtimeEventQueueCapacity?: number;
  /** Runs each session's Claude Code through `nice`; undefined keeps the SDK's own spawn. */
  readonly processPriority?: AgentProcessPriorityShape | undefined;
  /**
   * The node's `promptSuggestions` setting, read when a session opens: Claude Code then predicts
   * the next prompt after each turn. Undefined keeps it off.
   */
  readonly promptSuggestionsEnabled?: Effect.Effect<boolean> | undefined;
  /** Reads a session's main transcript chain. Defaults to the SDK's `getSessionMessages`. */
  readonly readSessionMessages?: (
    sessionId: string,
    options: { readonly dir?: string; readonly includeSystemMessages: boolean },
  ) => Promise<ReadonlyArray<ClaudeTranscriptEntry>>;
  /**
   * Whether Claude still keeps a session's transcript, read before a resume. Defaults to
   * `readClaudeTranscriptPresence` in the instance's config root.
   */
  readonly readTranscriptPresence?: (sessionId: string) => Promise<ClaudeTranscriptPresence>;
  /**
   * Whether this instance's Claude Code says a model (slug or alias) can run Auto mode, from the
   * instance's snapshot. Undefined is unknown: the session keeps Auto.
   */
  readonly resolveAutoModeSupport?: (model: string) => Effect.Effect<boolean | undefined>;
}

/** The device tool gateway's MCP server name in Claude sessions (tools are `mcp__ryco_device__*`). */
export const CLAUDE_DEVICE_TOOL_SERVER = "ryco_device";

/** Insertion-ordered map that forgets its oldest entries past `max`. */
export function rememberBounded<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.make(value);
}

export function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

export function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.make(value);
}

export function trimmedClaudeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
