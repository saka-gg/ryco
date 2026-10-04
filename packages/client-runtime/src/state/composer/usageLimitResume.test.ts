import {
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type ThreadUsageLimit,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { buildUsageLimitResumeDispatch, type UsageLimitResumeThread } from "./usageLimitResume.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const limit: ThreadUsageLimit = {
  limitId: "usage-limit:thread-1:turn-1",
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: claude,
  turnId: TurnId.make("turn-1"),
  message: "Claude usage limit reached.",
  limitedAt: "2026-10-04T10:00:00.000Z",
  resetAt: "2026-10-04T15:00:00.000Z",
  autoResume: null,
  updatedAt: "2026-10-04T10:00:00.000Z",
};
const thread: UsageLimitResumeThread = {
  id: ThreadId.make("thread-1"),
  title: "Limited thread",
  modelSelection: createModelSelection(claude, "claude-sonnet-4-5"),
  runtimeMode: "full-access",
  interactionMode: "default",
  tokenMode: "balanced",
  usageLimit: limit,
  session: { provider: ProviderDriverKind.make("claudeAgent") },
};
const api = {} as EnvironmentApi;

describe("buildUsageLimitResumeDispatch", () => {
  it("resumes with the thread's model and modes and the shared resume identity", () => {
    const dispatch = buildUsageLimitResumeDispatch({
      api,
      thread,
      createdAt: "2026-10-04T15:01:00.000Z",
      newCommandId: () => CommandId.make("unused"),
    });
    expect(dispatch).toMatchObject({
      threadId: "thread-1",
      commandId: "usage-limit-resume:usage-limit:thread-1:turn-1",
      messageId: "usage-limit-resume:usage-limit:thread-1:turn-1",
      usageLimitResumeGuard: { limitId: limit.limitId, origin: "manual" },
      outgoingMessageText: "Continue where you left off.",
      modelSelection: thread.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      tokenMode: "balanced",
      providerDriver: "claudeAgent",
      isFirstMessage: false,
      isServerThread: true,
      turnAttachments: [],
    });
  });

  it("returns null without an applicable limit", () => {
    expect(
      buildUsageLimitResumeDispatch({
        api,
        thread: {
          ...thread,
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
        },
        createdAt: "2026-10-04T15:01:00.000Z",
        newCommandId: () => CommandId.make("unused"),
      }),
    ).toBeNull();
    expect(
      buildUsageLimitResumeDispatch({
        api,
        thread: { ...thread, usageLimit: null },
        createdAt: "2026-10-04T15:01:00.000Z",
        newCommandId: () => CommandId.make("unused"),
      }),
    ).toBeNull();
  });
});
