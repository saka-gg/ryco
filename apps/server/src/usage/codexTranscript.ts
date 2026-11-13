import { RYCO_CODEX_CLIENT_NAME } from "../provider/codexClientName.ts";
import type { UsageRecord, UsageSpeed } from "./usageRecord.ts";
import { parseTimestampMs, positiveInteger, withTokenTotal } from "./usageRecord.ts";

export interface CodexTranscriptState {
  model: string;
  speed: UsageSpeed;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
  /** The session's working directory (`session_meta`, updated by `turn_context`). */
  cwd: string;
  /** A spawned subagent thread's parent thread id; empty for a top-level session. */
  parentSessionId: string;
  /** The session's client (`originator`) is Ryco. */
  rycoClient: boolean;
}

export function initialCodexTranscriptState(): CodexTranscriptState {
  return {
    model: "",
    speed: "standard",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
    cwd: "",
    parentSessionId: "",
    rycoClient: false,
  };
}

const FORK_COPY_MAX_GAP_MS = 1_000;

/** The parent thread of a session another thread spawned (a subagent), if any. */
function spawnedParentThreadId(payload: Record<string, unknown>): string | null {
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return null;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return null;
  const threadSpawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof threadSpawn !== "object" || threadSpawn === null) return null;
  const parent = (threadSpawn as Record<string, unknown>)["parent_thread_id"];
  return typeof parent === "string" && parent.length > 0 ? parent : null;
}

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  return typeof payload["forked_from_id"] === "string" || spawnedParentThreadId(payload) !== null;
}

/** Parse one Codex rollout JSONL record while carrying its session/model state. */
export function parseCodexTranscriptLine(
  line: string,
  state: CodexTranscriptState,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;

  if (record["type"] === "session_meta") {
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const sessionId = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof sessionId === "string") state.sessionId = sessionId;
    if (typeof payloadRecord["cwd"] === "string") state.cwd = payloadRecord["cwd"];
    state.parentSessionId = spawnedParentThreadId(payloadRecord) ?? "";
    state.rycoClient = payloadRecord["originator"] === RYCO_CODEX_CLIENT_NAME;
    const timestampMs = parseTimestampMs(record["timestamp"]);
    if (timestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = timestampMs;
    }
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    if (typeof payloadRecord["cwd"] === "string" && payloadRecord["cwd"].length > 0)
      state.cwd = payloadRecord["cwd"];
    state.lastUsageSignature = null;
    return null;
  }

  if (payloadRecord["type"] === "thread_settings_applied") {
    const settings = payloadRecord["thread_settings"];
    if (typeof settings === "object" && settings !== null) {
      const tier = (settings as Record<string, unknown>)["service_tier"];
      state.speed =
        tier === "ultrafast"
          ? "ultrafast"
          : tier === "priority" || tier === "fast"
            ? "fast"
            : "standard";
    }
    return null;
  }

  if (payloadRecord["type"] !== "token_count") return null;
  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const lastUsage = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof lastUsage !== "object" || lastUsage === null) return null;
  const lastUsageRecord = lastUsage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null || state.model.length === 0) return null;

  const signature = JSON.stringify(lastUsageRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputTokens = positiveInteger(lastUsageRecord["input_tokens"]);
  const cachedInputTokens = positiveInteger(lastUsageRecord["cached_input_tokens"]);
  const cacheCreationInputTokens = positiveInteger(lastUsageRecord["cache_write_input_tokens"]);
  const outputTokens = positiveInteger(lastUsageRecord["output_tokens"]);
  const totals = withTokenTotal({
    // Codex input_tokens includes both cache-read and cache-write tokens.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationInputTokens),
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningTokens: Math.min(
      outputTokens,
      positiveInteger(lastUsageRecord["reasoning_output_tokens"]),
    ),
  });
  if (totals.totalTokens === 0) return null;

  return {
    provider: "codex",
    speed: state.speed,
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: null,
    dedupeKey: null,
    ...(state.cwd.length > 0 ? { cwd: state.cwd } : {}),
    ...(state.parentSessionId.length > 0
      ? { sidechain: true, ownerSessionId: state.parentSessionId }
      : {}),
    ...(state.rycoClient ? { rycoClient: true } : {}),
  };
}
