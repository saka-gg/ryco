import {
  EnvironmentApi,
  OrchestrationThreadActivity,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { loadInboxContextHandoff } from "./inboxContextHandoff";

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
const target = {
  providerInstanceId: "codex",
  driverKind: "codex",
  modelSlug: "gpt-6-astra",
  modelDisplayName: "GPT 6 Astra",
};
const opus = {
  providerInstanceId: "claudeAgent",
  driverKind: "claudeAgent",
  modelSlug: "claude-opus-5",
  modelDisplayName: "Claude Opus 5",
};
const older = {
  providerInstanceId: "copilot",
  driverKind: "copilot",
  modelSlug: "older-model",
  modelDisplayName: "Older model",
};
function activity(
  sequence: number,
  status = "consumed",
  source = opus,
  extra: Record<string, unknown> = {},
) {
  return Schema.decodeUnknownSync(OrchestrationThreadActivity)({
    id: `handoff-${sequence}`,
    kind: "context-handoff",
    tone: "info",
    summary: "Context handoff",
    turnId: null,
    sequence,
    createdAt: "2026-09-05T00:00:00.000Z",
    payload: {
      schemaVersion: 1,
      handoffId: `handoff-${sequence}`,
      mode: "full-context-fresh-session",
      targetMessageId: "message",
      sourceSelection: { instanceId: source.providerInstanceId, model: source.modelSlug },
      targetSelection: selection,
      sources: [older, opus],
      target,
      status,
      contextVersion: 1,
      contextDigest: "a".repeat(64),
      ...(status === "failed" ? { error: "Failed" } : {}),
      ...extra,
    },
  });
}
/** A fresh session after the thread's folder moved: same model on both sides. */
function relocation(sequence: number) {
  return activity(sequence, "consumed", target, {
    reason: "cwd-relocation",
    sources: [target],
  });
}
const end = { hasMoreBefore: false, oldestCursor: null, newestCursor: null };
function apiWith(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  return {
    orchestration: {
      getThreadWindow: vi.fn(async () => ({
        thread: { activities },
        history: { activities: end },
      })),
      getThreadHistoryPage: vi.fn(),
    },
  };
}
const load = (api: ReturnType<typeof apiWith>, current = selection, cancelled = () => false) =>
  loadInboxContextHandoff(
    api as unknown as EnvironmentApi,
    ThreadId.make("thread"),
    current,
    cancelled,
  );

describe("inbox context handoff", () => {
  it("shows only the latest completed transfer and its immediate source with friendly names", async () => {
    const api = apiWith([activity(3, "failed"), activity(1, "consumed", older), activity(2)]);
    const result = await load(api);
    expect(result?.source.modelDisplayName).toBe("Opus 5");
    expect(result?.target.modelDisplayName).toBe("GPT 6 Astra");
    expect(result?.source.providerInstanceId).toBe("claudeAgent");
    expect(api.orchestration.getThreadHistoryPage).not.toHaveBeenCalled();
  });
  it("keeps naming the model transfer when a folder move came after it", async () => {
    const result = await load(
      apiWith([relocation(3), activity(2, "consumed", opus, { reason: "model-change" })]),
    );
    expect(result?.source.modelDisplayName).toBe("Opus 5");
    expect(result?.target.modelDisplayName).toBe("GPT 6 Astra");
  });
  it("never presents a folder move as a model transfer", async () => {
    expect(await load(apiWith([relocation(1)]))).toBeNull();
  });
  it("does not label an old target as the current model", async () => {
    expect(await load(apiWith([activity(1)]), { ...selection, model: "another-model" })).toBeNull();
  });
  it("loads older activity pages when the handoff is outside the recent window", async () => {
    const api = apiWith([]);
    api.orchestration.getThreadWindow.mockResolvedValueOnce({
      thread: { activities: [] },
      history: {
        activities: {
          ...end,
          hasMoreBefore: true,
          oldestCursor: "cursor",
        },
      },
    } as never);
    api.orchestration.getThreadHistoryPage.mockResolvedValueOnce({
      collection: "activities",
      items: [activity(1)],
      page: end,
    });
    expect((await load(api))?.source.modelDisplayName).toBe("Opus 5");
    expect(api.orchestration.getThreadHistoryPage).toHaveBeenCalledOnce();
  });
  it("stops looking through history after the preview closes", async () => {
    const api = apiWith([activity(1)]);
    expect(await load(api, selection, () => true)).toBeNull();
    expect(api.orchestration.getThreadHistoryPage).not.toHaveBeenCalled();
  });
  it("omits malformed, missing and unsuccessful handoffs", async () => {
    expect(await load(apiWith([activity(1, "failed")]))).toBeNull();
    expect(await load(apiWith([{ ...activity(1), payload: {} }]))).toBeNull();
    expect(await load(apiWith([]))).toBeNull();
  });
});
