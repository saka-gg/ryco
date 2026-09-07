import type {
  EventId,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Effect } from "effect";
import type { AcpSubagentSummaryState } from "./AcpRuntimeModel.ts";

/** One lifecycle per ACP tool id, shared by every ACP adapter. Scoped to a session. */
export function makeAcpSubagentRuntimeEvents() {
  const started = new Set<string>();
  const completed = new Set<string>();
  return Effect.fn("makeAcpSubagentRuntimeEvents")(function* (input: {
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
    readonly turnId: TurnId | undefined;
    readonly state: AcpSubagentSummaryState | undefined;
    readonly rawPayload: unknown;
    readonly makeStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  }) {
    const state = input.state;
    if (!state) return [];
    const id = String(state.subagent.subagentId);
    // A late nonterminal patch must not resurrect an already settled child.
    if (completed.has(id)) return [];
    const base = {
      provider: input.provider,
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      raw: { source: "acp.jsonrpc" as const, method: "session/update", payload: input.rawPayload },
    };
    const events: ProviderRuntimeEvent[] = [];
    if (!started.has(id)) {
      started.add(id);
      events.push({
        ...base,
        ...(yield* input.makeStamp()),
        type: "subagent.started",
        payload: { subagent: state.subagent },
      });
    }
    if (state.status === "completed" || state.status === "failed" || state.status === "stopped") {
      completed.add(id);
      events.push({
        ...base,
        ...(yield* input.makeStamp()),
        type: "subagent.completed",
        payload: {
          subagent: state.subagent,
          status: state.status,
          ...(state.summary ? { summary: state.summary } : {}),
        },
      });
    } else {
      events.push({
        ...base,
        ...(yield* input.makeStamp()),
        type: "subagent.updated",
        payload: {
          subagent: state.subagent,
          ...(state.status ? { status: state.status } : {}),
          ...(state.summary ? { summary: state.summary } : {}),
          ...(state.detail ? { detail: state.detail } : {}),
        },
      });
    }
    return events;
  });
}
