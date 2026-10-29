/**
 * Semantic assertions on what a replayed scenario projected. Ids and timestamps are generated at
 * run time (random uuids, the live clock), so replay suites assert meaning, never snapshots.
 */
import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThread,
  ThreadId,
} from "@ryco/contracts";
import { assert } from "@effect/vitest";
import { Effect, Option } from "effect";

import type { OrchestrationIntegrationHarness } from "../OrchestrationEngineHarness.integration.ts";

/** The message roles in order, e.g. `["user", "assistant"]`. */
export function assertMessageRoles(
  thread: OrchestrationThread,
  roles: ReadonlyArray<OrchestrationThread["messages"][number]["role"]>,
): void {
  assert.deepEqual(
    thread.messages.map((message) => message.role),
    [...roles],
  );
}

/** Some assistant message contains `text`. */
export function assertAssistantTextIncludes(thread: OrchestrationThread, text: string): void {
  const assistantTexts = thread.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text);
  assert.isTrue(
    assistantTexts.some((assistantText) => assistantText.includes(text)),
    `no assistant message includes ${JSON.stringify(text)}: ${JSON.stringify(assistantTexts)}`,
  );
}

/** Once a turn settled, no message may still be streaming. */
export function assertNoStreamingMessages(thread: OrchestrationThread): void {
  assert.deepEqual(
    thread.messages.filter((message) => message.streaming).map((message) => message.id),
    [],
  );
}

export function assertLatestTurn(
  thread: OrchestrationThread,
  state: OrchestrationLatestTurn["state"],
): void {
  assert.equal(thread.latestTurn?.state, state);
}

export function assertSessionStatus(
  thread: OrchestrationThread,
  status: OrchestrationSession["status"],
): void {
  assert.equal(thread.session?.status, status);
}

/** Every approval the thread was asked for has been answered. */
export const assertNoPendingApprovals = (
  harness: OrchestrationIntegrationHarness,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const rows = yield* harness.pendingApprovalRepository
      .listByThreadId({ threadId })
      .pipe(Effect.orDie);
    assert.deepEqual(
      rows.filter((row) => row.status === "pending").map((row) => row.requestId),
      [],
    );
  });

/**
 * The live provider session still continues `providerThreadId`. The projection does not carry the
 * provider's thread id; the session's resume cursor does.
 */
export const assertProviderThreadStable = (
  harness: OrchestrationIntegrationHarness,
  threadId: ThreadId,
  providerThreadId: string,
) =>
  Effect.gen(function* () {
    const session = yield* harness.providerService.getSession(threadId).pipe(Effect.orDie);
    assert.isTrue(Option.isSome(session), `no live provider session for '${threadId}'`);
    assert.deepEqual(Option.getOrUndefined(session)?.resumeCursor, { threadId: providerThreadId });
  });

/**
 * `kinds` appear among the thread's activities in this order, other activity kinds in between
 * (token usage, session state) aside.
 */
export function assertActivityKinds(
  thread: OrchestrationThread,
  kinds: ReadonlyArray<string>,
): void {
  const actual = thread.activities.map((activity) => activity.kind);
  let position = 0;
  for (const kind of kinds) {
    const found = actual.indexOf(kind, position);
    assert.isAtLeast(
      found,
      0,
      `activity '${kind}' missing after position ${position}: ${JSON.stringify(actual)}`,
    );
    position = found + 1;
  }
}
