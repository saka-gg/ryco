import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import { pinClaudeForkPlan, planForkProvider } from "./forkProvider.ts";
import { nativeForkConfigFingerprint } from "./nativeFork.ts";

const threadId = ThreadId.make("thread-source");
const boundary = {
  turnId: TurnId.make("turn-2"),
  inheritedUserTurnCount: 2,
};
const config = (driver: string, overrides: Partial<ProviderInstanceConfig> = {}) =>
  ({
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    config: { homePath: `/homes/${driver}` },
    ...overrides,
  }) satisfies ProviderInstanceConfig;
const binding = (
  driver: string,
  instance: string,
  resumeCursor: unknown,
  overrides: Partial<ProviderRuntimeBinding> = {},
): ProviderRuntimeBinding => ({
  threadId,
  provider: ProviderDriverKind.make(driver),
  providerInstanceId: ProviderInstanceId.make(instance),
  status: "stopped",
  resumeCursor,
  runtimePayload: { cwd: "/work/source" },
  ...overrides,
});
const claudeSession = "0b6c7c86-5c45-4f7e-9a51-6b0d6f1d2a9e";

describe("planForkProvider", () => {
  it("plans an exact native copy of a resumable Codex or Claude session", () => {
    const codexConfig = config("codex");
    expect(
      planForkProvider({
        instanceId: ProviderInstanceId.make("codex"),
        config: codexConfig,
        binding: binding("codex", "codex", { threadId: "codex-thread" }),
        boundary,
      }),
    ).toEqual({
      kind: "native",
      driver: "codex",
      instanceId: "codex",
      configFingerprint: nativeForkConfigFingerprint(codexConfig),
      sourceNativeId: "codex-thread",
      recordedCwd: "/work/source",
      turnId: boundary.turnId,
      inheritedUserTurnCount: 2,
    });
    // A Claude copy still needs its cutoff pinned against the source transcript.
    expect(
      planForkProvider({
        instanceId: ProviderInstanceId.make("claude-work"),
        config: config("claudeAgent"),
        binding: binding("claudeAgent", "claude-work", {
          threadId,
          resume: claudeSession,
          turnCount: 3,
        }),
        boundary,
      }),
    ).toMatchObject({
      kind: "claude-candidate",
      plan: { kind: "native", driver: "claudeAgent", sourceNativeId: claudeSession },
    });
  });

  it("keeps a Claude cutoff only when it is proven to end the boundary turn", () => {
    const candidate = planForkProvider({
      instanceId: ProviderInstanceId.make("claude"),
      config: config("claudeAgent"),
      binding: binding("claudeAgent", "claude", { threadId, resume: claudeSession, turnCount: 3 }),
      boundary,
    });
    if (candidate.kind !== "claude-candidate") throw new Error("expected a Claude candidate");
    const cutoff = { entryUuid: "entry-7", entryIndex: 7 };
    // Bounded by a later turn's prompt: always kept.
    expect(pinClaudeForkPlan(candidate, { kind: "pinned", cutoff, atTail: false }, false)).toEqual({
      ...candidate.plan,
      cutoff,
    });
    // The transcript's tail: only when nothing could have followed the turn into it.
    expect(pinClaudeForkPlan(candidate, { kind: "pinned", cutoff, atTail: true }, true)).toEqual({
      ...candidate.plan,
      cutoff,
    });
    expect(pinClaudeForkPlan(candidate, { kind: "pinned", cutoff, atTail: true }, false)).toEqual({
      kind: "handoff",
      reason: "turn-not-in-native-session",
    });
    expect(pinClaudeForkPlan(candidate, { kind: "turn-not-in-session" }, true)).toEqual({
      kind: "handoff",
      reason: "turn-not-in-native-session",
    });
    expect(pinClaudeForkPlan(candidate, { kind: "refused", detail: "unreadable" }, true)).toEqual({
      kind: "handoff",
      reason: "native-fork-failed",
    });
  });

  it("hands off providers without an exact native fork", () => {
    for (const driver of ["opencode", "copilot", "cursor", "grok", "acpRegistry"]) {
      expect(
        planForkProvider({
          instanceId: ProviderInstanceId.make(driver),
          config: config(driver),
          binding: binding(driver, driver, { sessionId: "native" }),
          boundary,
        }),
      ).toEqual({ kind: "handoff", reason: "provider-unsupported" });
    }
  });

  it("hands off when the session cannot be resumed exactly", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const plan = (
      overrides: Partial<Parameters<typeof planForkProvider>[0]>,
    ): ReturnType<typeof planForkProvider> =>
      planForkProvider({
        instanceId,
        config: config("codex"),
        binding: binding("codex", "codex", { threadId: "codex-thread" }),
        boundary,
        ...overrides,
      });
    const noSession = { kind: "handoff", reason: "no-native-session" };
    expect(plan({ config: undefined })).toEqual(noSession);
    expect(plan({ config: config("codex", { enabled: false }) })).toEqual(noSession);
    expect(plan({ binding: undefined })).toEqual(noSession);
    // A binding on another instance (e.g. after a model switch) holds another conversation.
    expect(plan({ binding: binding("codex", "codex-other", { threadId: "x" }) })).toEqual(
      noSession,
    );
    expect(plan({ binding: binding("codex", "codex", null) })).toEqual(noSession);
    expect(
      plan({ binding: binding("codex", "codex", { threadId: "x" }, { runtimePayload: {} }) }),
    ).toEqual(noSession);
    // A Claude transcript pinned by a checkpoint revert is not at the conversation's head.
    expect(
      planForkProvider({
        instanceId: ProviderInstanceId.make("claude"),
        config: config("claudeAgent"),
        binding: binding("claudeAgent", "claude", {
          threadId,
          resume: claudeSession,
          rewind: { at: "entry-uuid" },
        }),
        boundary,
      }),
    ).toEqual({ kind: "handoff", reason: "turn-not-in-native-session" });
  });
});
