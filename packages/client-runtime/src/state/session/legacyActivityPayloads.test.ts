/**
 * Legacy and malformed activity payloads. Rows from older nodes, bounded previews and payloads
 * with a mistyped field must render the same as they did before the client read payloads through
 * `@ryco/shared/threadActivityPayloads`: these cases pin that rendering.
 */
import { EventId, TurnId, type OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "./contextWindow.ts";
import {
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveWorkLogEntries,
} from "./session-logic.ts";

let nextId = 0;

function activity(
  kind: string,
  payload: unknown,
  overrides: { readonly turnId?: string; readonly createdAt?: string } = {},
): OrchestrationThreadActivity {
  nextId += 1;
  return {
    id: EventId.make(`legacy-${nextId}`),
    createdAt: overrides.createdAt ?? `2026-01-01T00:00:${String(nextId).padStart(2, "0")}.000Z`,
    kind,
    summary: kind,
    tone: "info",
    payload,
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    sequence: nextId,
  };
}

const QUESTIONS = [
  {
    id: "q1",
    header: "Pick",
    question: "Which one?",
    options: [{ label: "A", description: "First" }],
  },
];

describe("legacy approval payloads", () => {
  it("derives the request kind from the provider request type when the row has none", () => {
    const pending = derivePendingApprovals([
      activity("approval.requested", {
        requestId: "req-legacy",
        requestType: "apply_patch_approval",
        detail: "Apply the patch",
      }),
      activity("approval.requested", {
        requestId: "req-unknown-kind",
        requestKind: "network",
        requestType: "file_read_approval",
      }),
    ]);
    expect(
      pending.map(({ requestId, requestKind, detail }) => ({ requestId, requestKind, detail })),
    ).toMatchInlineSnapshot(`
        [
          {
            "detail": "Apply the patch",
            "requestId": "req-legacy",
            "requestKind": "file-change",
          },
          {
            "detail": undefined,
            "requestId": "req-unknown-kind",
            "requestKind": "file-read",
          },
        ]
      `);
  });

  it("skips rows without a usable request id or kind and drops mistyped optional fields", () => {
    const pending = derivePendingApprovals([
      activity("approval.requested", null),
      activity("approval.requested", ["req-array"]),
      activity("approval.requested", "req-string"),
      activity("approval.requested", { requestId: 42, requestKind: "command" }),
      activity("approval.requested", { requestId: "req-no-kind" }),
      activity("approval.requested", {
        requestId: "req-mistyped",
        requestKind: "command",
        detail: 7,
        reason: { text: "why" },
        acceptForSessionOffered: "false",
        approvalIdentity: { requestEventId: 1 },
      }),
    ]);
    expect(pending).toMatchInlineSnapshot(`
      [
        {
          "createdAt": "2026-01-01T00:00:08.000Z",
          "requestId": "req-mistyped",
          "requestKind": "command",
        },
      ]
    `);
  });

  it("clears a request on a stale-request failure and on its resolution", () => {
    const pending = derivePendingApprovals([
      activity("approval.requested", { requestId: "req-stale", requestKind: "command" }),
      activity("approval.requested", { requestId: "req-resolved", requestKind: "file-change" }),
      activity("approval.requested", { requestId: "req-kept", requestKind: "file-read" }),
      activity("provider.approval.respond.failed", {
        requestId: "req-stale",
        detail: "Stale pending approval request: req-stale",
      }),
      activity("approval.resolved", { requestId: "req-resolved" }),
      activity("provider.approval.respond.failed", { requestId: "req-kept", detail: 404 }),
      activity("approval.resolved", { requestId: "req-kept", runtimeSessionId: "other" }),
    ]);
    expect(pending.map((entry) => entry.requestId)).toMatchInlineSnapshot(`
      [
        "req-kept",
      ]
    `);
  });
});

describe("legacy question payloads", () => {
  it("keeps a question with mistyped optional fields and skips one without questions", () => {
    const pending = derivePendingUserInputs([
      activity("user-input.requested", {
        requestId: "q-mistyped",
        questions: QUESTIONS,
        nonBlocking: "true",
        itemId: 12,
        userInputIdentity: "not-an-identity",
      }),
      activity("user-input.requested", {
        requestId: "q-non-blocking",
        questions: QUESTIONS,
        nonBlocking: true,
        itemId: 12,
      }),
      activity("user-input.requested", { requestId: "q-no-questions" }),
      activity("user-input.requested", { requestId: 9, questions: QUESTIONS }),
    ]);
    expect(pending).toMatchInlineSnapshot(`
      [
        {
          "createdAt": "2026-01-01T00:00:16.000Z",
          "questions": [
            {
              "header": "Pick",
              "id": "q1",
              "multiSelect": false,
              "options": [
                {
                  "description": "First",
                  "label": "A",
                },
              ],
              "question": "Which one?",
            },
          ],
          "requestId": "q-mistyped",
        },
        {
          "createdAt": "2026-01-01T00:00:17.000Z",
          "nonBlocking": true,
          "questions": [
            {
              "header": "Pick",
              "id": "q1",
              "multiSelect": false,
              "options": [
                {
                  "description": "First",
                  "label": "A",
                },
              ],
              "question": "Which one?",
            },
          ],
          "requestId": "q-non-blocking",
        },
      ]
    `);
  });

  it("clears a question on a stale-request failure and on its resolution", () => {
    const pending = derivePendingUserInputs([
      activity("user-input.requested", { requestId: "q-stale", questions: QUESTIONS }),
      activity("user-input.requested", { requestId: "q-resolved", questions: QUESTIONS }),
      activity("provider.user-input.respond.failed", {
        requestId: "q-stale",
        detail: "Unknown pending user-input request",
      }),
      activity("user-input.resolved", { requestId: "q-resolved", answers: {} }),
    ]);
    expect(pending.map((entry) => entry.requestId)).toMatchInlineSnapshot(`[]`);
  });
});

describe("legacy plan payloads", () => {
  it("keeps the well-formed steps of a plan with malformed entries", () => {
    expect(
      deriveActivePlanState(
        [
          activity(
            "turn.plan.updated",
            {
              explanation: null,
              plan: [
                null,
                "loose string",
                { step: 3, status: "completed" },
                { step: "Read the code", status: "completed" },
                { step: "Write the fix", status: "inProgress" },
                { step: "Ship it", status: "blocked" },
              ],
            },
            { turnId: "turn-1" },
          ),
        ],
        TurnId.make("turn-1"),
      ),
    ).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-01-01T00:00:24.000Z",
        "explanation": null,
        "steps": [
          {
            "status": "completed",
            "step": "Read the code",
          },
          {
            "status": "inProgress",
            "step": "Write the fix",
          },
          {
            "status": "pending",
            "step": "Ship it",
          },
        ],
        "turnId": "turn-1",
      }
    `);
  });

  it("has no plan when the plan is not a list or has no usable step", () => {
    const states = [
      { plan: "do things" },
      { plan: [{ status: "pending" }] },
      null,
      ["array payload"],
    ].map((payload) => deriveActivePlanState([activity("turn.plan.updated", payload)], undefined));
    expect(states).toEqual([null, null, null, null]);
  });

  it("keeps a legacy non-string explanation as it was", () => {
    const state = deriveActivePlanState(
      [activity("turn.plan.updated", { explanation: 5, plan: [{ step: "One" }] })],
      undefined,
    );
    expect(state?.explanation).toMatchInlineSnapshot(`5`);
  });
});

describe("legacy task rows in the work log", () => {
  it("treats a task row with a mistyped task id or owner as before", () => {
    const entries = deriveWorkLogEntries(
      [
        activity("task.started", { taskId: 5, title: "Mistyped id" }, { turnId: "turn-1" }),
        activity("task.started", { taskId: "task-1", agentId: "   " }, { turnId: "turn-1" }),
        activity(
          "task.completed",
          { taskId: "task-2", agentId: 3, timelineBypass: "true", summary: "Done" },
          { turnId: "turn-1" },
        ),
        activity("task.progress", { taskId: "task-3", agentId: "agent-1" }, { turnId: "turn-1" }),
        activity("tool.completed", { detail: 12, agentId: "" }, { turnId: "turn-1" }),
      ],
      TurnId.make("turn-1"),
    );
    expect(entries.map(({ label, tone, detail }) => ({ label, tone, detail })))
      .toMatchInlineSnapshot(`
        [
          {
            "detail": undefined,
            "label": "Done",
            "tone": "info",
          },
          {
            "detail": undefined,
            "label": "tool.completed",
            "tone": "info",
          },
        ]
      `);
  });
});

describe("legacy context-window payloads", () => {
  it("skips snapshots without usable token counts and drops mistyped fields", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      activity("context-window.updated", {
        usedTokens: 1200,
        maxTokens: "200000",
        inputTokens: Number.NaN,
        compactsAutomatically: "yes",
      }),
      activity("context-window.updated", { usedTokens: "5" }),
      activity("context-window.updated", [1, 2]),
    ]);
    expect(snapshot).toMatchInlineSnapshot(`
      {
        "cachedInputTokens": null,
        "compactsAutomatically": false,
        "durationMs": null,
        "inputTokens": null,
        "lastCachedInputTokens": null,
        "lastInputTokens": null,
        "lastOutputTokens": null,
        "lastReasoningOutputTokens": null,
        "lastUsedTokens": null,
        "maxTokens": null,
        "outputTokens": null,
        "reasoningOutputTokens": null,
        "remainingPercentage": null,
        "remainingTokens": null,
        "toolUses": null,
        "totalProcessedTokens": null,
        "updatedAt": "2026-01-01T00:00:35.000Z",
        "usedPercentage": null,
        "usedTokens": 1200,
      }
    `);
  });
});

describe("resolutions with a non-string session id", () => {
  // The one deliberate difference from before the readers: a resolution whose runtimeSessionId is
  // not a string (null, a number) reads as carrying none, so it resolves a request recorded
  // without an identity. It used to leave the request pending forever. Requests that carry a
  // session id still refuse it, as before.
  it("resolves an identity-less approval and question", () => {
    expect(
      derivePendingApprovals([
        activity("approval.requested", { requestId: "r-null", requestKind: "command" }),
        activity("approval.resolved", { requestId: "r-null", runtimeSessionId: null }),
      ]),
    ).toEqual([]);
    expect(
      derivePendingUserInputs([
        activity("user-input.requested", { requestId: "q-null", questions: QUESTIONS }),
        activity("user-input.resolved", { requestId: "q-null", runtimeSessionId: 5 }),
      ]),
    ).toEqual([]);
  });
});
