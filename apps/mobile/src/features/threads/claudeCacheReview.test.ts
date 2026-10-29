import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RuntimeSessionId } from "@ryco/contracts/base-schemas";
import type { ClaudeCacheObservation } from "@ryco/contracts/claude-cache";
import { ProviderInstanceId } from "@ryco/contracts/provider-instance";
import type { ClaudeCacheReview } from "@ryco/client-runtime/state/composer";
import type { AlertButton } from "react-native";

const mocks = vi.hoisted(() => ({ alert: vi.fn(), kv: new Map<string, string>() }));

vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async (key: string) => mocks.kv.get(key) ?? null,
    setItem: async (key: string, value: string) => void mocks.kv.set(key, value),
    removeItem: async (key: string) => void mocks.kv.delete(key),
  },
}));

import {
  getPreferencesSnapshot,
  isClaudeResumeReviewEnabled,
  resetPreferencesStoreForTests,
} from "../../state/preferencesStore";
import { mobileClaudeCacheReview } from "./claudeCacheReview";

const observation: ClaudeCacheObservation = {
  source: "assistant-usage",
  observedAt: "2026-09-27T10:00:00.000Z",
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  model: "sonnet",
  messageId: "request-1",
  directInputTokens: 100,
  cacheReadInputTokens: 50_000,
  cacheWriteInputTokens: 2_000,
};

function review(compactUnavailableReason: string | null): ClaudeCacheReview {
  return {
    observation,
    reason: "This conversation has been idle for 2 hours.",
    promptTokens: 52_100,
    compactUnavailableReason,
  };
}

function shownButtons(): ReadonlyArray<AlertButton> {
  expect(mocks.alert).toHaveBeenCalledTimes(1);
  return mocks.alert.mock.calls[0]?.[2] as ReadonlyArray<AlertButton>;
}

/** The slots React Native's Android Alert gives the buttons, as Libraries/Alert/Alert.js does. */
function androidSlots(buttons: ReadonlyArray<AlertButton>) {
  const shown = buttons.slice(0, 3);
  const positive = shown.pop();
  const negative = shown.pop();
  const neutral = shown.pop();
  return { neutral: neutral?.text, negative: negative?.text, positive: positive?.text };
}

function press(buttons: ReadonlyArray<AlertButton>, text: string): void {
  const button = buttons.find((candidate) => candidate.text === text);
  expect(button).toBeDefined();
  button?.onPress?.();
}

beforeEach(() => {
  mocks.alert.mockReset();
  mocks.kv.clear();
  resetPreferencesStoreForTests();
});

describe("mobileClaudeCacheReview", () => {
  it("keeps Cancel in Android's positive slot when compaction is unavailable", async () => {
    const choice = mobileClaudeCacheReview.review(review("The Claude session is stopped."));
    const buttons = shownButtons();

    expect(buttons.map(({ text, style }) => ({ text, style }))).toEqual([
      { text: "Continue with full context", style: undefined },
      { text: "Don't ask again", style: undefined },
      { text: "Cancel", style: "cancel" },
    ]);
    expect(androidSlots(buttons)).toEqual({
      neutral: "Continue with full context",
      negative: "Don't ask again",
      positive: "Cancel",
    });

    press(buttons, "Cancel");
    await expect(choice).resolves.toBe("cancel");
    expect(isClaudeResumeReviewEnabled()).toBe(true);
  });

  it("offers compaction ahead of Cancel and leaves Don't ask again out on Android", async () => {
    const choice = mobileClaudeCacheReview.review(review(null));
    const buttons = shownButtons();

    expect(buttons.map(({ text, style }) => ({ text, style }))).toEqual([
      { text: "Continue with full context", style: undefined },
      { text: "Compact then send", style: undefined },
      { text: "Cancel", style: "cancel" },
      { text: "Don't ask again", style: undefined },
    ]);
    expect(androidSlots(buttons)).toEqual({
      neutral: "Continue with full context",
      negative: "Compact then send",
      positive: "Cancel",
    });

    press(buttons, "Compact then send");
    await expect(choice).resolves.toBe("compact");
  });

  it.each([
    ["compaction is unavailable", "The Claude session is stopped."],
    ["compaction is offered", null],
  ])(
    "continues and turns the review off on this device from Don't ask again when %s",
    async (_label, compactUnavailableReason) => {
      const choice = mobileClaudeCacheReview.review(review(compactUnavailableReason));

      press(shownButtons(), "Don't ask again");

      await expect(choice).resolves.toBe("continue");
      expect(getPreferencesSnapshot().claudeResumeReview).toBe(false);
      expect(isClaudeResumeReviewEnabled()).toBe(false);
      expect(JSON.parse(mocks.kv.get("ryco.preferences") ?? "{}")).toMatchObject({
        claudeResumeReview: false,
      });
    },
  );

  it("treats a dismissed alert as Cancel", async () => {
    const choice = mobileClaudeCacheReview.review(review(null));
    const options = mocks.alert.mock.calls[0]?.[3] as { onDismiss?: () => void };

    options.onDismiss?.();

    await expect(choice).resolves.toBe("cancel");
    expect(isClaudeResumeReviewEnabled()).toBe(true);
  });
});
