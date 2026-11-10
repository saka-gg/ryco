import { questionDraftKey } from "@ryco/client-runtime/state/user-input";
import { EnvironmentId, EventId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decideNotificationThreadAction } from "../notificationActionsModel";
import { ALERT_EXCERPT_MAX_AGE_MS, alertExcerptPrompts } from "./alertExcerpts";

const environmentId = EnvironmentId.make("env_excerpt000000000000");
const threadId = ThreadId.make("thread-1");
const AT = Date.parse("2026-11-10T12:00:00.000Z");

/** A record as `AlertExcerptStore` saves it (`PushAlertOpener.excerptRecord`). */
const record = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    e: environmentId,
    th: threadId,
    tu: "turn-1",
    k: "approval",
    rq: "approval-1",
    at: AT,
    x: { a: { k: "command", d: "npm run deploy", r: "Ships it" } },
    ...patch,
  });

const read = (json: string, nowMs = AT + 1_000) =>
  alertExcerptPrompts({ json, environmentId, threadId, nowMs });

describe("alert excerpts on the phone", () => {
  it("shapes an approval like the live one, so its card and the alert's action agree", () => {
    const prompts = read(record())!;
    expect(prompts.userInputs).toEqual([]);
    expect(prompts.approvals).toEqual([
      {
        requestId: "approval-1",
        requestKind: "command",
        createdAt: new Date(AT).toISOString(),
        turnId: "turn-1",
        detail: "npm run deploy",
        reason: "Ships it",
      },
    ]);
    // Allow on the card is the alert's own Approve: once live, it answers this request only.
    const approval = prompts.approvals[0]!;
    const step = decideNotificationThreadAction({
      pending: {
        action: { kind: "approve", turnId: "turn-1", requestId: approval.requestId },
        at: AT,
      },
      nowMs: AT + 2_000,
      threadLoaded: true,
      ready: true,
      pendingApprovals: [{ ...approval, approvalIdentity: { requestEventId: EventId.make("e") } }],
      pendingUserInputs: [],
      composer: { disabled: false, editingQueuedMessage: false },
    });
    expect(step).toMatchObject({ kind: "respond", decision: "accept" });
  });

  it("shapes a question so its choices land in the live card's draft", () => {
    const prompts = read(
      record({
        k: "input",
        rq: undefined,
        x: {
          u: {
            rq: "question-1",
            ev: "event-1",
            qs: [{ id: "target", h: "Target", q: "Where?", o: ["Staging", "Prod"], m: true }],
            c: true,
          },
        },
      }),
    )!;
    expect(prompts.partial).toBe(true);
    const question = prompts.userInputs[0]!;
    expect(question.questions).toEqual([
      {
        id: "target",
        header: "Target",
        question: "Where?",
        options: [
          { label: "Staging", description: "" },
          { label: "Prod", description: "" },
        ],
        multiSelect: true,
      },
    ]);
    const key = (userInputIdentity: { requestEventId: EventId } | undefined) =>
      questionDraftKey({ environmentId, threadId, requestId: "question-1", userInputIdentity });
    expect(key(question.userInputIdentity as { requestEventId: EventId })).toBe(
      key({ requestEventId: EventId.make("event-1") }),
    );
  });

  it("ignores a record for another thread, a stale one, and one it cannot read", () => {
    expect(read(record({ th: "thread-2" }))).toBeNull();
    expect(read(record({ e: "env_other" }))).toBeNull();
    expect(read(record(), AT + ALERT_EXCERPT_MAX_AGE_MS + 1)).toBeNull();
    expect(read(record({ v: 2 }))).toBeNull();
    expect(read(record({ x: { a: { k: "launch" } } }))).toBeNull();
    expect(read("not json")).toBeNull();
    // An approval the alert does not name cannot be answered from a card.
    expect(read(record({ rq: undefined }))).toBeNull();
    // The excerpt must match the alert's kind.
    expect(read(record({ k: "input" }))).toBeNull();
  });
});
