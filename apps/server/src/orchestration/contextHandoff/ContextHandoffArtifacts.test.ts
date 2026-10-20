import { MessageId, ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ContextHandoffDeliveryArtifact,
  ContextHandoffRenderedDocument,
  digestContextHandoffUtf8,
  hasValidContextHandoffDeliveryDigests,
  makeContextHandoffDeliveryArtifact,
} from "./ContextHandoffArtifacts.ts";
import { ContextHandoffDocument, stableStringifyContextHandoff } from "./ContextHandoffBuilder.ts";
import {
  type ContextHandoffRenderResult,
  renderContextHandoffInput,
} from "./ContextHandoffRenderer.ts";

const renderedContext: ContextHandoffRenderedDocument = {
  version: 1,
  mode: "full-context-fresh-session",
  provenance: {
    sources: [
      {
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        driverKind: ProviderDriverKind.make("codex"),
        modelSlug: "gpt-5.6-sol",
        modelDisplayName: "GPT-5.6 Sol",
      },
    ],
    target: {
      providerInstanceId: ProviderInstanceId.make("claude_work"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      modelSlug: "claude-fable-5",
      modelDisplayName: "Fable 5",
    },
  },
  messages: [],
};

describe("ContextHandoffDeliveryArtifact", () => {
  it("preserves and hashes the exact provider input and triggering message", () => {
    const renderedContextJson = stableStringifyContextHandoff(renderedContext);
    const providerInput = "<context>😀</context>\n\n  exact message  ";
    const artifact = makeContextHandoffDeliveryArtifact({
      renderedContext,
      renderedContextJson,
      providerInput,
      triggeringMessageId: MessageId.make("message-trigger"),
      triggeringMessage: "  exact message  ",
      includedEntryCount: 0,
      totalEntryCount: 0,
      contextChars: renderedContextJson.length,
      inputChars: providerInput.length,
      truncated: false,
      preparedAt: "2026-08-05T10:00:00.000Z",
    });

    const { maxInputChars, budgetSource, contextWindowTokens, ...legacy } = artifact;
    expect(Schema.decodeUnknownSync(ContextHandoffDeliveryArtifact)(legacy)).toEqual(legacy);
    const withBudget = Schema.decodeUnknownSync(ContextHandoffDeliveryArtifact)({
      ...legacy,
      maxInputChars: 1_400_000,
      budgetSource: "manifest",
      contextWindowTokens: 1_000_000,
    });
    expect(withBudget.providerInputDigest).toBe(legacy.providerInputDigest);
    expect(withBudget.renderedContextDigest).toBe(legacy.renderedContextDigest);
    expect([maxInputChars, budgetSource, contextWindowTokens]).toEqual([null, null, null]);
    expect(artifact.providerInput).toBe(providerInput);
    expect(artifact.triggeringMessage.text).toBe("  exact message  ");
    expect(artifact.renderedContextDigest).toBe(digestContextHandoffUtf8(renderedContextJson));
    expect(artifact.providerInputDigest).toBe(digestContextHandoffUtf8(providerInput));
  });

  it("refuses a rendered JSON string that differs from the typed document", () => {
    expect(() =>
      makeContextHandoffDeliveryArtifact({
        renderedContext,
        renderedContextJson: "{}",
        providerInput: "payload",
        triggeringMessageId: MessageId.make("message-trigger"),
        triggeringMessage: "message",
        includedEntryCount: 0,
        totalEntryCount: 0,
        contextChars: 2,
        inputChars: 7,
        truncated: false,
        preparedAt: "2026-08-05T10:00:00.000Z",
      }),
    ).toThrow("Rendered context JSON does not match");
  });
});

const currentMessage = "  continue  ";

const longDocument = Schema.decodeUnknownSync(ContextHandoffDocument)({
  version: 1,
  mode: "full-context-fresh-session",
  thread: { id: "thread-artifact", title: "Artifact", branch: null, worktreePath: null },
  provenance: {
    sources: [renderedContext.provenance.sources[0]],
    target: renderedContext.provenance.target,
  },
  messages: [],
  plans: [],
  tools: [
    {
      id: "tool-1",
      createdAt: "2026-08-04T00:00:02.000Z",
      turnId: null,
      lifecycle: "completed",
      itemType: "command_execution",
      summary: "Ran command",
      // A compacted copy cut at 256 characters ends with this space.
      output: `${"a".repeat(255)} ${"b".repeat(6_000)}`,
      paths: [],
      fileChanges: [{ path: "src/a.ts", additions: 1 }],
    },
  ],
  checkpoints: [
    {
      id: "turn-1",
      createdAt: "2026-08-04T00:00:01.000Z",
      checkpointTurnCount: 1,
      status: "ready",
      files: [{ path: "p".repeat(5_000), kind: "modified", additions: 1, deletions: 0 }],
    },
  ],
  notices: [],
  subagents: [],
  priorHandoffs: [
    {
      id: "handoff-prior",
      createdAt: "2026-08-04T00:00:00.500Z",
      status: "failed",
      targetMessageId: "message-prior",
      sources: [renderedContext.provenance.sources[0]],
      target: renderedContext.provenance.target,
      error: `${"e".repeat(63)} ${"f".repeat(3_000)}`,
    },
  ],
});

function artifactFor(rendered: ContextHandoffRenderResult, maxInputChars: number) {
  return makeContextHandoffDeliveryArtifact({
    maxInputChars,
    budgetSource: null,
    contextWindowTokens: null,
    renderedContext: rendered.renderedContext,
    renderedContextJson: rendered.renderedContextJson,
    providerInput: rendered.providerInput,
    triggeringMessageId: MessageId.make("message-trigger"),
    triggeringMessage: currentMessage,
    includedEntryCount: rendered.includedEntryCount,
    totalEntryCount: rendered.totalEntryCount,
    contextChars: rendered.contextChars,
    inputChars: rendered.inputChars,
    truncated: rendered.truncated,
    preparedAt: "2026-08-05T10:00:00.000Z",
  });
}

/** What the repository hands back: the stored JSON, parsed and decoded. */
function reloaded(artifact: unknown) {
  return Schema.decodeUnknownSync(ContextHandoffDeliveryArtifact)(
    JSON.parse(JSON.stringify(artifact)),
  );
}

/**
 * A compacted rendered context as earlier versions wrote it: every compacted object, nested
 * ones included, carried `truncated`, and content cut after whitespace kept it.
 */
const legacyCompactedContext = {
  version: 1,
  mode: "full-context-fresh-session",
  provenance: renderedContext.provenance,
  tools: [
    {
      ...longDocument.tools[0],
      output: `${"a".repeat(255)} `,
      fileChanges: [{ path: "src/a.ts", additions: 1, truncated: true }],
      truncated: true,
    },
  ],
  checkpoints: [
    {
      ...longDocument.checkpoints[0],
      files: [
        { path: "p".repeat(64), kind: "modified", additions: 1, deletions: 0, truncated: true },
      ],
      truncated: true,
    },
  ],
};

function legacyCompactedArtifact() {
  const legacyJson = stableStringifyContextHandoff(legacyCompactedContext);
  const shell = renderContextHandoffInput({ document: longDocument, currentMessage });
  const providerInput = shell.providerInput.replace(shell.renderedContextJson, () => legacyJson);
  return {
    legacyJson,
    artifact: reloaded({
      ...artifactFor(shell, 120_000),
      renderedContext: legacyCompactedContext,
      renderedContextDigest: digestContextHandoffUtf8(legacyJson),
      providerInput,
      providerInputDigest: digestContextHandoffUtf8(providerInput),
    }),
  };
}

describe("compacted delivery artifacts", () => {
  it("store a rendered context that reloads with valid digests", () => {
    for (const maxInputChars of [1_200, 2_000, 4_000, 8_000]) {
      const rendered = renderContextHandoffInput({
        document: longDocument,
        currentMessage,
        maxInputChars,
      });
      const stored = reloaded(artifactFor(rendered, maxInputChars));

      expect(rendered.truncated).toBe(true);
      expect(stableStringifyContextHandoff(stored.renderedContext)).toBe(
        rendered.renderedContextJson,
      );
      expect(hasValidContextHandoffDeliveryDigests(stored)).toBe(true);
    }
  });

  it("refuse a rendered context that decoding would change", () => {
    const shell = renderContextHandoffInput({ document: longDocument, currentMessage });
    expect(() =>
      artifactFor(
        {
          ...shell,
          renderedContext: legacyCompactedContext as ContextHandoffRenderedDocument,
          renderedContextJson: stableStringifyContextHandoff(legacyCompactedContext),
        },
        120_000,
      ),
    ).toThrow("does not survive decoding");
  });

  it("still validate when stored by an earlier version", () => {
    const { legacyJson, artifact } = legacyCompactedArtifact();

    expect(stableStringifyContextHandoff(artifact.renderedContext)).not.toBe(legacyJson);
    expect(hasValidContextHandoffDeliveryDigests(artifact)).toBe(true);
  });

  it("reject an earlier version's artifact whose stored context or sent input was edited", () => {
    const { legacyJson, artifact } = legacyCompactedArtifact();
    const editedInput = artifact.providerInput.replace(legacyJson, () =>
      legacyJson.replace("modified", "deleted!"),
    );

    for (const edited of [
      { ...artifact, renderedContext: { ...artifact.renderedContext, tools: [] } },
      {
        ...artifact,
        providerInput: editedInput,
        providerInputDigest: digestContextHandoffUtf8(editedInput),
      },
      { ...artifact, triggeringMessage: { ...artifact.triggeringMessage, text: "other" } },
    ]) {
      expect(hasValidContextHandoffDeliveryDigests(edited)).toBe(false);
    }
  });
});
