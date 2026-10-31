import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CARRIED_THREAD_HISTORY_MAX_BYTES,
  CARRIED_THREAD_TEXT_MAX_CHARS,
  type CarriedThreadHistory,
  THREAD_FORKED_ACTIVITY_KIND,
  type ThreadForkCarriedRequest,
  ThreadForkError,
} from "@ryco/contracts";
import { readThreadForkedActivity } from "@ryco/shared/threadFork";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { threadForkIdentity } from "./forkLedger.ts";
import { createForkHarness, type ForkHarness, historyAt } from "./threadFork.fixtures.ts";

const roots: string[] = [];
const harnesses: ForkHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A harness that offers chats and counts every write the fork service asks of its ledger. */
async function chatHarness() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-carried-fork-")));
  roots.push(root);
  const writes = { inserts: 0, transitions: 0 };
  const h = await createForkHarness({
    chatsRoot: path.join(root, "chats"),
    ledger: (base) => ({
      ...base,
      insertIfAbsent: (row) => (writes.inserts++, base.insertIfAbsent(row)),
      compareAndSetPhase: (input) => (writes.transitions++, base.compareAndSetPhase(input)),
    }),
  });
  harnesses.push(h);
  return { h, writes };
}

/** Two completed turns as another node's client would carry them. */
function history(overrides: Partial<CarriedThreadHistory> = {}): CarriedThreadHistory {
  return {
    schemaVersion: 1,
    source: {
      machineLabel: "Studio Mac",
      threadTitle: "Fix the login bug",
      threadId: "thread-on-studio" as CarriedThreadHistory["source"]["threadId"],
      environmentId: "environment-studio" as CarriedThreadHistory["source"]["environmentId"],
    },
    messages: [
      { role: "user", text: "Find the login bug", createdAt: historyAt(0), turnId: turn(1) },
      { role: "assistant", text: "It is in auth.ts", createdAt: historyAt(3), turnId: turn(1) },
      { role: "user", text: "Fix it", createdAt: historyAt(10), turnId: turn(2) },
      { role: "assistant", text: "Fixed", createdAt: historyAt(13), turnId: turn(2) },
    ],
    proposedPlans: [],
    turnOutcomes: [],
    model: {
      driver: "codex" as CarriedThreadHistory["model"]["driver"],
      model: "gpt-fixture",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...overrides,
  };
}

function turn(index: number) {
  return `turn-on-studio-${index}` as NonNullable<
    CarriedThreadHistory["messages"][number]["turnId"]
  >;
}

const request = (forkKey: string, carried: unknown): ThreadForkCarriedRequest => ({
  forkKey,
  projectId: null,
  destination: { kind: "new-chat" },
  history: carried,
});

const refusal = (h: ForkHarness, input: ThreadForkCarriedRequest) =>
  h.run(Effect.flip(h.forks.forkCarried(input))).then((error) => {
    expect(error).toBeInstanceOf(ThreadForkError);
    return error;
  });

describe("carried forks: checks before anything is written", () => {
  it("refuses an oversize payload, too many messages, a system role, a future time and an unknown source key", async () => {
    const { h, writes } = await chatHarness();
    const long = "x".repeat(CARRIED_THREAD_TEXT_MAX_CHARS - 10);
    const oversize = history({
      messages: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: long,
        createdAt: historyAt(index),
        turnId: turn(Math.floor(index / 2)),
      })),
    });
    expect(JSON.stringify(oversize).length).toBeGreaterThan(CARRIED_THREAD_HISTORY_MAX_BYTES);
    const tooMany = history({
      messages: Array.from({ length: 2001 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: "hi",
        createdAt: historyAt(index),
        turnId: turn(Math.floor(index / 2)),
      })),
    });
    const base = history();
    const systemRole = {
      ...base,
      messages: [{ ...base.messages[0], role: "system" }, ...base.messages.slice(1)],
    };
    const future = history({
      messages: [
        ...base.messages.slice(0, 3),
        {
          ...base.messages[3]!,
          createdAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    const unknownSourceKey = { ...base, source: { ...base.source, url: "https://studio.invalid" } };

    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
      ["oversize payload", oversize, "history-too-large"],
      ["2001 messages", tooMany, "history-too-large"],
      ["system role", systemRole, "history-invalid"],
      ["future timestamp", future, "history-invalid"],
      ["unknown key on source", unknownSourceKey, "history-invalid"],
    ];
    for (const [label, carried, reason] of cases) {
      const error = await refusal(
        h,
        request(`carried-refused-${label.replaceAll(" ", "-")}`, carried),
      );
      expect(error, label).toMatchObject({ reason, retryable: false, attempt: "none" });
    }
    expect(writes).toEqual({ inserts: 0, transitions: 0 });
    expect(await h.ledgerRows()).toEqual([]);
    expect(await h.threadIds()).toEqual([]);
  });

  it("refuses a conversation that does not end at a completed reply or mixes its turns", async () => {
    const { h, writes } = await chatHarness();
    const base = history();
    const cases: ReadonlyArray<readonly [string, CarriedThreadHistory]> = [
      ["ends with a prompt", history({ messages: base.messages.slice(0, 3) })],
      [
        "reply without a turn",
        history({
          messages: [...base.messages.slice(0, 3), { ...base.messages[3]!, turnId: null }],
        }),
      ],
      [
        "turn split apart",
        history({
          messages: [
            ...base.messages,
            { role: "assistant", text: "Late", createdAt: historyAt(20), turnId: turn(1) },
          ],
        }),
      ],
      [
        "out of order",
        history({
          messages: [
            base.messages[0]!,
            base.messages[1]!,
            { ...base.messages[2]!, createdAt: historyAt(1) },
            base.messages[3]!,
          ],
        }),
      ],
      [
        "interrupted boundary",
        history({ turnOutcomes: [{ turnId: turn(2), state: "interrupted" }] }),
      ],
      [
        "outcome of an unknown turn",
        history({ turnOutcomes: [{ turnId: turn(9), state: "error" }] }),
      ],
      [
        "plan of an unknown turn",
        history({
          proposedPlans: [
            { turnId: turn(9), planMarkdown: "Plan", createdAt: historyAt(2), implementedAt: null },
          ],
        }),
      ],
    ];
    for (const [label, carried] of cases) {
      const error = await refusal(
        h,
        request(`carried-structure-${label.replaceAll(" ", "-")}`, carried),
      );
      expect(error, label).toMatchObject({ reason: "history-invalid", attempt: "none" });
    }
    expect(writes).toEqual({ inserts: 0, transitions: 0 });
  });
});

describe("carried forks into a new chat", () => {
  it("creates the fork from the carried conversation, and replays or refuses its key", async () => {
    const { h } = await chatHarness();
    const forkKey = "carried-chat-key-0001";
    const carried = history({
      turnOutcomes: [{ turnId: turn(1), state: "interrupted" }],
      proposedPlans: [
        {
          turnId: turn(1),
          planMarkdown: "1. Look",
          createdAt: historyAt(2),
          implementedAt: historyAt(12),
        },
      ],
    });
    const result = await h.run(h.forks.forkCarried(request(forkKey, carried)));
    const forkThreadId = threadForkIdentity(forkKey).forkThreadId;
    expect(result).toMatchObject({
      threadId: forkThreadId,
      replayed: false,
      providerContext: "handoff",
      checkout: { kind: "new-chat" },
    });

    const fork = await h.detail(forkThreadId);
    expect(fork?.title).toBe("Fix the login bug (fork)");
    // This node's own instance of the source's driver; the access mode travels with it.
    expect(fork?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-fixture" });
    expect(fork?.runtimeMode).toBe("approval-required");
    expect(fork?.messages.map((message) => [message.role, message.text, message.turnId])).toEqual(
      carried.messages.map((message) => [message.role, message.text, message.turnId]),
    );
    expect(
      fork?.messages.every((message) => message.id.startsWith(`${forkThreadId}:inherited:`)),
    ).toBe(true);
    expect(fork?.proposedPlans).toMatchObject([
      { planMarkdown: "1. Look", implementedAt: historyAt(12) },
    ]);
    // Provenance: display-only, a placeholder source that is no thread here, no handoff reason.
    const provenance = fork?.activities.find(
      (activity) => activity.kind === THREAD_FORKED_ACTIVITY_KIND,
    );
    const payload = provenance === undefined ? null : readThreadForkedActivity(provenance);
    expect(payload).toMatchObject({
      sourceThreadId: `${forkThreadId}:origin`,
      sourceTitle: "Fix the login bug",
      inheritedMessageCount: 4,
      inheritedTurnOutcomes: [{ turnId: turn(1), state: "interrupted" }],
      providerContext: "handoff",
      origin: {
        kind: "other-machine",
        machineLabel: "Studio Mac",
        sourceEnvironmentId: "environment-studio",
        sourceThreadId: "thread-on-studio",
        sourceThreadTitle: "Fix the login bug",
      },
    });
    expect(payload).not.toHaveProperty("handoffReason");
    expect(fork?.activities.map((activity) => activity.kind)).toEqual([
      THREAD_FORKED_ACTIVITY_KIND,
    ]);
    expect(await h.threadIds()).not.toContain("thread-on-studio");

    // The same key and conversation answer with the same fork; the ledger dropped its history.
    const replay = await h.run(h.forks.forkCarried(request(forkKey, carried)));
    expect(replay).toMatchObject({ threadId: forkThreadId, replayed: true });
    const row = await h.run(h.ledger.getByKey({ forkKey }));
    expect(row._tag === "Some" ? row.value.plan.command.messages : null).toEqual([]);
    expect(row._tag === "Some" ? row.value.origin?.machineLabel : null).toBe("Studio Mac");

    // The same key with another conversation is refused, and so is a local fork under it.
    const changed = history({
      messages: [...carried.messages.slice(0, 3), { ...carried.messages[3]!, text: "Changed" }],
    });
    expect(await refusal(h, request(forkKey, changed))).toMatchObject({
      reason: "idempotency-conflict",
      attempt: "stopped",
    });
    expect((await h.threadIds()).filter((id) => id === forkThreadId)).toHaveLength(1);
  });

  it("picks this node's instance by driver and refuses a driver it has no instance of", async () => {
    const { h, writes } = await chatHarness();
    const claude = await h.run(
      h.forks.forkCarried(
        request(
          "carried-chat-claude-0001",
          history({
            model: {
              driver: "claudeAgent" as CarriedThreadHistory["model"]["driver"],
              model: "claude-fixture",
            },
          }),
        ),
      ),
    );
    // The driver's default instance here wins over the other enabled one ("claude").
    expect((await h.detail(claude.threadId))?.modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-fixture",
    });
    const inserts = writes.inserts;
    const missing = await refusal(
      h,
      request(
        "carried-chat-missing-0001",
        history({
          model: {
            driver: "fixtureDriver" as CarriedThreadHistory["model"]["driver"],
            model: "fixture-model",
          },
        }),
      ),
    );
    expect(missing).toMatchObject({ reason: "destination-unavailable", attempt: "none" });
    expect(writes.inserts).toBe(inserts);
  });
});
