import { EventId, ProviderDriverKind, RuntimeSubagentId, ThreadId, TurnId } from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeAcpSubagentRuntimeEvents } from "./AcpSubagentRuntimeEvents.ts";
import type { AcpSubagentSummaryState } from "./AcpRuntimeModel.ts";

describe("ACP shared subagent lifecycle", () => {
  it.each(["cursor", "grok"])(
    "settles %s completion-first streams once without reopening",
    async (provider) => {
      const emit = makeAcpSubagentRuntimeEvents();
      let sequence = 0;
      const send = (status: AcpSubagentSummaryState["status"]) =>
        Effect.runPromise(
          emit({
            provider: ProviderDriverKind.make(provider),
            threadId: ThreadId.make("parent"),
            turnId: TurnId.make("turn"),
            state: {
              subagent: {
                subagentId: RuntimeSubagentId.make("tool"),
                origin: "inferred",
                capability: "summary",
              },
              ...(status ? { status } : {}),
              summary: "Review found a bug",
            },
            rawPayload: {},
            makeStamp: () =>
              Effect.succeed({
                eventId: EventId.make(`event-${++sequence}`),
                createdAt: "2026-09-07T00:00:00.000Z",
              }),
          }),
        );
      const events = await send("completed");
      expect(events.map((event) => event.type)).toEqual(["subagent.started", "subagent.completed"]);
      expect(events[1]).toMatchObject({
        provider,
        payload: { summary: "Review found a bug", status: "completed" },
      });
      expect(await send("completed")).toEqual([]);
      expect(await send("running")).toEqual([]);
    },
  );
});
