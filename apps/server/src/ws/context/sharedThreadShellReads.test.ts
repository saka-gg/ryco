import { ThreadId, type OrchestrationThreadShell } from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { toShellStreamEvent } from "./orchestrationStreams.ts";
import { readSharedThreadShell, SHARED_THREAD_SHELL_TTL_MS } from "./sharedThreadShellReads.ts";

const threadId = ThreadId.make("thread-shared");
const shell = { id: threadId, title: "Shared" } as unknown as OrchestrationThreadShell;

function counting(fail = 0) {
  let reads = 0;
  let failures = fail;
  return {
    reads: () => reads,
    query: {
      getThreadShellById: () =>
        Effect.suspend(() => {
          reads += 1;
          if (failures > 0) {
            failures -= 1;
            return Effect.fail(toPersistenceSqlError("test")(new Error("database is locked")));
          }
          // A yield, so concurrent subscribers overlap like real reads do.
          return Effect.as(Effect.yieldNow, Option.some(shell));
        }),
    },
  };
}

describe("shared thread shell reads", () => {
  it("serves every subscriber mapping the same event from one read", async () => {
    const { query, reads } = counting();
    const results = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 3 }, () => readSharedThreadShell(query, threadId, 7)),
        { concurrency: "unbounded" },
      ),
    );
    expect(reads()).toBe(1);
    for (const result of results) expect(Option.getOrNull(result)).toBe(shell);
    // Sequentially, too: a subscriber draining its batch a moment later.
    await Effect.runPromise(readSharedThreadShell(query, threadId, 7));
    expect(reads()).toBe(1);
    // A later event of the thread reads again.
    await Effect.runPromise(readSharedThreadShell(query, threadId, 8));
    expect(reads()).toBe(2);
  });

  it("expires entries and never shares a failure", async () => {
    let now = 0;
    const { query, reads } = counting(1);
    await expect(
      Effect.runPromise(readSharedThreadShell(query, threadId, 1, () => now)),
    ).rejects.toBeDefined();
    await Effect.runPromise(readSharedThreadShell(query, threadId, 1, () => now));
    expect(reads()).toBe(2);
    now += SHARED_THREAD_SHELL_TTL_MS;
    await Effect.runPromise(readSharedThreadShell(query, threadId, 1, () => now));
    expect(reads()).toBe(3);
  });

  it("is what the shell stream uses for thread upserts", async () => {
    const { query, reads } = counting();
    const event = {
      type: "thread.activity-appended",
      aggregateKind: "thread",
      aggregateId: threadId,
      sequence: 42,
      payload: { threadId },
    } as never;
    const fullQuery = {
      ...query,
      getProjectShellById: () => Effect.die("unused"),
    };
    const items = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 3 }, () => toShellStreamEvent(fullQuery, event)),
        { concurrency: "unbounded" },
      ),
    );
    expect(reads()).toBe(1);
    expect(items.map((item) => Option.getOrNull(item)?.kind)).toEqual([
      "thread-upserted",
      "thread-upserted",
      "thread-upserted",
    ]);
  });
});
