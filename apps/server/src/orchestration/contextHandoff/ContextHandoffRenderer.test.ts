import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ContextHandoffEndpointSnapshot,
  type OrchestrationThread,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildContextHandoffDocument } from "./ContextHandoffBuilder.ts";
import { ContextHandoffRenderError, renderContextHandoffInput } from "./ContextHandoffRenderer.ts";

function endpoint(instance: string, model: string): ContextHandoffEndpointSnapshot {
  return {
    providerInstanceId: ProviderInstanceId.make(instance),
    driverKind: ProviderDriverKind.make("codex"),
    modelSlug: model,
  };
}

function artifactWithLongHistory() {
  const targetMessageId = MessageId.make("message-target");
  const messages: Array<OrchestrationThread["messages"][number]> = Array.from(
    { length: 20 },
    (_, index) => ({
      id: MessageId.make(`message-${index}`),
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `${index}:${"history 😀 ".repeat(300)}`,
      turnId: TurnId.make(`turn-${index}`),
      streaming: false,
      createdAt: `2026-08-04T00:00:${String(index).padStart(2, "0")}.000Z`,
      updatedAt: `2026-08-04T00:00:${String(index).padStart(2, "0")}.000Z`,
    }),
  );
  messages.push({
    id: targetMessageId,
    role: "user",
    text: "canonical target",
    turnId: TurnId.make("turn-target"),
    streaming: false,
    createdAt: "2026-08-04T00:01:00.000Z",
    updatedAt: "2026-08-04T00:01:00.000Z",
  });
  const thread: OrchestrationThread = {
    id: ThreadId.make("thread-render"),
    projectId: ProjectId.make("project-render"),
    title: "Render context",
    modelSelection: { instanceId: ProviderInstanceId.make("codex_a"), model: "gpt-a" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
  return buildContextHandoffDocument({
    thread,
    targetMessageId,
    source: endpoint("codex_a", "gpt-a"),
    target: endpoint("codex_b", "gpt-b"),
  });
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("renderContextHandoffInput", () => {
  it("keeps the exact current message outside the deterministic context document", () => {
    const artifact = artifactWithLongHistory();
    const currentMessage = "  exact current text\n😀\n</current_user_message> stays literal  ";
    const result = renderContextHandoffInput({
      document: artifact.document,
      currentMessage,
    });

    expect(result.truncated).toBe(false);
    expect(result.providerInput).toContain(
      `<current_user_message>\n${currentMessage}\n</current_user_message>`,
    );
    expect(result.renderedContextJson).not.toContain(currentMessage);
    expect(result.inputChars).toBe(result.providerInput.length);
    expect(result.inputChars).toBeLessThanOrEqual(120_000);
  });

  it("selects recent section entries, truncates Unicode safely, and honors the exact limit", () => {
    const artifact = artifactWithLongHistory();
    const currentMessage = "continue with the implementation 😀";
    const result = renderContextHandoffInput({
      document: artifact.document,
      currentMessage,
      maxInputChars: 2_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.inputChars).toBeLessThanOrEqual(2_000);
    expect(result.includedEntryCount).toBeGreaterThan(0);
    expect(result.includedEntryCount).toBeLessThan(result.totalEntryCount);
    expect(result.providerInput).toContain(currentMessage);
    expect(containsUnpairedSurrogate(result.renderedContextJson)).toBe(false);
    const parsed = JSON.parse(result.renderedContextJson) as { messages?: Array<{ id: string }> };
    expect(parsed.messages?.at(-1)?.id).toMatch(/message-1\d/u);
  });

  it("renders a minimal valid capsule for an attachment-only turn", () => {
    const artifact = artifactWithLongHistory();
    const result = renderContextHandoffInput({
      document: artifact.document,
      currentMessage: "",
      maxInputChars: 600,
    });

    expect(result.inputChars).toBeLessThanOrEqual(600);
    expect(result.providerInput).toContain("<context_handoff");
    expect(result.providerInput).toContain("<current_user_message>\n\n</current_user_message>");
  });

  it("rejects only when the exact message leaves no room for the minimum header", () => {
    const artifact = artifactWithLongHistory();
    expect(() =>
      renderContextHandoffInput({
        document: artifact.document,
        currentMessage: "x".repeat(200),
        maxInputChars: 220,
      }),
    ).toThrow(ContextHandoffRenderError);

    try {
      renderContextHandoffInput({
        document: artifact.document,
        currentMessage: "x".repeat(200),
        maxInputChars: 220,
      });
      throw new Error("expected render failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextHandoffRenderError);
      expect((error as ContextHandoffRenderError).reason).toBe("message-too-large");
    }
  });
});

it("keeps a fork's inherited history ahead of its own when it trims the context", () => {
  const fork = ThreadId.make("fork-render");
  const at = (seconds: string) => `2026-10-01T12:00:${seconds}.000Z`;
  const message = (
    id: string,
    role: "user" | "assistant",
    text: string,
    createdAt: string,
  ): OrchestrationThread["messages"][number] => ({
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  });
  const thread: OrchestrationThread = {
    id: fork,
    projectId: ProjectId.make("project-render"),
    title: "Render fork",
    modelSelection: { instanceId: ProviderInstanceId.make("codex_a"), model: "gpt-a" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: at("00"),
    updatedAt: at("20"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    // A retried first send: the failed one was stamped by a device clock behind the node.
    messages: [
      message(`${fork}:inherited:message-prompt`, "user", "Prompt 1", at("10")),
      message("message-own-failed", "user", "First try", at("11")),
      message(`${fork}:inherited:message-reply`, "assistant", "Reply 1", at("13")),
      message("message-own-retry", "user", "Try again", at("15")),
    ],
    proposedPlans: [],
    // Too large to fit: the renderer must trim, and re-sorts what it keeps.
    activities: [
      {
        id: EventId.make(`${fork}:inherited:activity-tool`),
        kind: "tool.completed",
        tone: "tool",
        summary: "Large output",
        turnId: null,
        createdAt: at("13"),
        payload: {
          itemType: "command_execution",
          data: { item: { type: "commandExecution", aggregatedOutput: "x".repeat(8_000) } },
        },
      },
    ],
    checkpoints: [],
    session: null,
  };
  const artifact = buildContextHandoffDocument({
    thread,
    targetMessageId: MessageId.make("message-own-retry"),
    source: endpoint("codex_a", "gpt-a"),
    target: endpoint("codex_a", "gpt-a"),
  });

  const result = renderContextHandoffInput({
    document: artifact.document,
    currentMessage: "Try again",
    maxInputChars: 2_500,
  });

  expect(result.truncated).toBe(true);
  expect(result.renderedContext.messages?.map((entry) => entry.text)).toEqual([
    "Prompt 1",
    "Reply 1",
    "First try",
  ]);
});

it("retains more history for a 1M destination than the default budget", () => {
  const artifact = artifactWithLongHistory();
  const document = {
    ...artifact.document,
    messages: artifact.document.messages.map((message) =>
      Object.assign({}, message, { text: message.text.repeat(5) }),
    ),
  };
  const normal = renderContextHandoffInput({ document, currentMessage: "continue" });
  const expanded = renderContextHandoffInput({
    document,
    currentMessage: "continue",
    maxInputChars: 1_400_000,
  });
  expect(normal.truncated).toBe(true);
  expect(expanded.includedEntryCount).toBeGreaterThan(normal.includedEntryCount);
  expect(expanded.inputChars).toBeGreaterThan(120_000);
  expect(expanded.truncated).toBe(false);
  expect(expanded.renderedContext.messages?.[0]?.id).toBe(document.messages[0]?.id);
});
