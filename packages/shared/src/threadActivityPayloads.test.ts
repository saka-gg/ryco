import { describe, expect, it } from "vite-plus/test";
import { ThreadActivityKind } from "@ryco/contracts/orchestration";
import { CHECKPOINT_REVERT_ACTIVITY_KIND, CONTEXT_HANDOFF_ACTIVITY_KIND } from "@ryco/contracts";
import { THREAD_FORKED_ACTIVITY_KIND } from "@ryco/contracts/thread-fork";
import { THREAD_MOVED_ACTIVITY_KIND } from "@ryco/contracts/thread-move";
import { SECRET_REQUEST_ACTIVITY_KINDS } from "@ryco/contracts/secret-request";
import {
  COMPUTER_CONTROL_DENIED_ACTIVITY_KIND,
  COMPUTER_SETUP_REQUIRED_ACTIVITY_KIND,
} from "@ryco/contracts/computer";

import { BACKGROUND_WORK_BOUNDARY, BACKGROUND_WORK_CHECKPOINT } from "./backgroundWork.ts";
import { FAST_MODE_STATE_ACTIVITY_KIND } from "./claudeFastMode.ts";
import { LATEST_STATE_ACTIVITY_GROUPS } from "./latestStateActivities.ts";
import { PROMPT_SUGGESTION_ACTIVITY_KIND } from "./promptSuggestion.ts";
import {
  CONTEXT_COMPACTION_ACTIVITY_KIND,
  PENDING_REQUEST_ACTIVITY_KINDS,
} from "./threadActivity.ts";
import {
  activityPayloadRecord,
  isApprovalActivity,
  isTaskActivity,
  isThreadActivityKind,
  readApprovalActivityPayload,
  readContextWindowActivityPayload,
  readRuntimeErrorActivityPayload,
  readTaskActivityPayload,
  readToolActivityPayload,
  readTurnPlanActivityPayload,
  readUserInputActivityPayload,
} from "./threadActivityPayloads.ts";
import { TURN_STEER_FAILED_ACTIVITY_KIND } from "./turnSteer.ts";
import {
  USER_INPUT_REQUESTED_ACTIVITY_KIND,
  USER_INPUT_RESOLVED_ACTIVITY_KIND,
} from "./userInputExchange.ts";

describe("ThreadActivityKind", () => {
  it("names every kind constant the packages export", () => {
    const constants: ReadonlyArray<string> = [
      CHECKPOINT_REVERT_ACTIVITY_KIND,
      CONTEXT_HANDOFF_ACTIVITY_KIND,
      THREAD_FORKED_ACTIVITY_KIND,
      THREAD_MOVED_ACTIVITY_KIND,
      ...SECRET_REQUEST_ACTIVITY_KINDS,
      COMPUTER_CONTROL_DENIED_ACTIVITY_KIND,
      COMPUTER_SETUP_REQUIRED_ACTIVITY_KIND,
      BACKGROUND_WORK_BOUNDARY,
      BACKGROUND_WORK_CHECKPOINT,
      FAST_MODE_STATE_ACTIVITY_KIND,
      PROMPT_SUGGESTION_ACTIVITY_KIND,
      CONTEXT_COMPACTION_ACTIVITY_KIND,
      ...PENDING_REQUEST_ACTIVITY_KINDS,
      TURN_STEER_FAILED_ACTIVITY_KIND,
      USER_INPUT_REQUESTED_ACTIVITY_KIND,
      USER_INPUT_RESOLVED_ACTIVITY_KIND,
      ...Object.values(LATEST_STATE_ACTIVITY_GROUPS).map((group) => group.kind),
    ];
    expect(constants.filter((kind) => !isThreadActivityKind(kind))).toEqual([]);
  });

  it("guards known kinds and leaves unknown ones to the caller", () => {
    expect(isThreadActivityKind("task.progress")).toBe(true);
    expect(isThreadActivityKind("task.progres")).toBe(false);
    expect(isThreadActivityKind("future.kind")).toBe(false);
    expect(ThreadActivityKind.literals.length).toBe(new Set(ThreadActivityKind.literals).size);
  });

  it("narrows by kind family", () => {
    expect(isApprovalActivity({ kind: "provider.approval.respond.failed" })).toBe(true);
    expect(isApprovalActivity({ kind: "user-input.requested" })).toBe(false);
    expect(isTaskActivity({ kind: "task.updated" })).toBe(true);
    expect(isTaskActivity({ kind: "tool.updated" })).toBe(false);
  });
});

describe("activityPayloadRecord", () => {
  it("accepts plain objects only", () => {
    expect(activityPayloadRecord({ a: 1 })).toEqual({ a: 1 });
    expect(activityPayloadRecord([1])).toBeNull();
    expect(activityPayloadRecord(null)).toBeNull();
    expect(activityPayloadRecord("text")).toBeNull();
  });
});

describe("payload readers", () => {
  it("return undefined for another kind or a payload that is not a record", () => {
    expect(readTaskActivityPayload({ kind: "tool.started", payload: { taskId: "t" } })).toBe(
      undefined,
    );
    expect(readTaskActivityPayload({ kind: "task.started", payload: null })).toBe(undefined);
    expect(readTaskActivityPayload({ kind: "task.started", payload: ["t"] })).toBe(undefined);
    expect(readTaskActivityPayload({ kind: "task.started", payload: "t" })).toBe(undefined);
  });

  it("return a well-formed payload itself, without copying", () => {
    const payload = { taskId: "t", status: "completed", agentIndex: 2, extra: { kept: true } };
    expect(readTaskActivityPayload({ kind: "task.completed", payload })).toBe(payload);
  });

  it("drop only the fields whose type is wrong, without touching the stored payload", () => {
    const payload = { taskId: 7, title: "Build", agentIndex: "2", phases: {}, typedUsage: [] };
    const view = readTaskActivityPayload({ kind: "task.progress", payload });
    expect(view).toEqual({ title: "Build" });
    expect(payload.taskId).toBe(7);
  });

  it("check numbers and booleans by type", () => {
    expect(
      readContextWindowActivityPayload({
        kind: "context-window.updated",
        payload: { usedTokens: "12", compactsAutomatically: 1, inputTokens: 3 },
      }),
    ).toEqual({ inputTokens: 3 });
  });

  it("read approval and question payloads by family", () => {
    const approval = { requestId: "r1", requestKind: "command", detail: "rm -rf" };
    expect(readApprovalActivityPayload({ kind: "approval.requested", payload: approval })).toBe(
      approval,
    );
    expect(readApprovalActivityPayload({ kind: "user-input.requested", payload: approval })).toBe(
      undefined,
    );
    expect(
      readUserInputActivityPayload({
        kind: "user-input.requested",
        payload: { requestId: "q1", nonBlocking: "yes", questions: [{ id: "a" }] },
      }),
    ).toEqual({ requestId: "q1", questions: [{ id: "a" }] });
    expect(
      readUserInputActivityPayload({
        kind: "provider.user-input.respond.failed",
        payload: { requestId: "q1", responseState: "invalidated" },
      }),
    ).toEqual({ requestId: "q1", responseState: "invalidated" });
    expect(readUserInputActivityPayload({ kind: "secret.requested", payload: approval })).toBe(
      undefined,
    );
  });

  it("read tool, plan and runtime error payloads", () => {
    expect(
      readToolActivityPayload({
        kind: "tool.progress",
        payload: { taskId: "t", elapsedSeconds: 4, data: "anything" },
      }),
    ).toEqual({ taskId: "t", elapsedSeconds: 4, data: "anything" });
    expect(
      readTurnPlanActivityPayload({
        kind: "turn.plan.updated",
        payload: { plan: "step", explanation: null },
      }),
    ).toEqual({ explanation: null });
    expect(
      readRuntimeErrorActivityPayload({
        kind: "runtime.error",
        payload: { message: "Limit", class: "usage_limit", resetAt: null },
      }),
    ).toEqual({ message: "Limit", class: "usage_limit", resetAt: null });
    expect(
      readRuntimeErrorActivityPayload({ kind: "runtime.error", payload: { message: 5 } }),
    ).toEqual({});
  });
});
