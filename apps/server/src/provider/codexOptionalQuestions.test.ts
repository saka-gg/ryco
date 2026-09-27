import { describe, expect, it } from "vite-plus/test";
import {
  CodexOptionalQuestions,
  formatCodexOptionalAnswer,
  readCodexOptionalQuestions,
} from "./codexOptionalQuestions.ts";

const native = {
  type: "agentMessage",
  delivery: "async",
  questions: [
    { title: "Audience?", options: ["Engineers", "Managers"] },
    { title: "Any constraints?", options: null },
  ],
};
const questions = readCodexOptionalQuestions(native)!;
const source = { providerThreadId: "provider-1", turnId: "turn-1", itemId: "item-1", questions };

describe("native optional question capability and delivery authority", () => {
  it("requires explicit native metadata and validates all questions", () => {
    expect(questions).toHaveLength(2);
    for (const value of [
      { ...native, delivery: undefined },
      { ...native, type: "requestUserInput", autoResolutionMs: 100 },
      { ...native, questions: [{ title: "" }] },
      { ...native, questions: [{ title: "Q", options: [] }] },
      { ...native, questions: [{ title: "Q", options: [42] }] },
    ])
      expect(readCodexOptionalQuestions(value)).toBeUndefined();
  });
  it("admits each native item once and consumes exactly one matching answer", () => {
    const registry = new CodexOptionalQuestions();
    registry.startTurn("provider-1", "turn-1");
    const pending = registry.register(source)!;
    expect(registry.register(source)).toBeUndefined();
    expect(registry.claim(pending.requestId, "provider-1", "turn-1", {})).toEqual({
      question: pending,
      prompt: undefined,
    });
    expect(registry.claim(pending.requestId, "provider-1", "turn-1", {})).toBeUndefined();
    expect(registry.register(source)).toBeUndefined();
    expect(formatCodexOptionalAnswer(pending, { "0": "Managers", "1": "Short" })).toContain(
      "Audience?\nAnswer: Managers",
    );
    expect(formatCodexOptionalAnswer(pending, {})).toBeUndefined();
    expect(() => formatCodexOptionalAnswer(pending, { "0": "Managers" })).toThrow();
  });
  it("allows correction before dispatch but does not release a consumed claim", () => {
    const registry = new CodexOptionalQuestions();
    registry.startTurn("provider-1", "turn-1");
    const pending = registry.register(source)!;
    expect(() =>
      registry.claim(pending.requestId, "provider-1", "turn-1", { "0": "Managers" }),
    ).toThrow();
    expect(
      registry.claim(pending.requestId, "provider-1", "turn-1", { "0": "Managers", "1": "Short" })
        ?.prompt,
    ).toContain("Answer: Managers");
    // An uncertain transport result must not reset the registry.
    expect(
      registry.claim(pending.requestId, "provider-1", "turn-1", { "0": "Managers", "1": "Short" }),
    ).toBeUndefined();
  });
  it("rejects foreign, superseded, completed and restarted requests", () => {
    for (const [thread, turn] of [
      ["provider-2", "turn-1"],
      ["provider-1", "turn-2"],
      ["provider-1", undefined],
    ] as const) {
      const registry = new CodexOptionalQuestions();
      registry.startTurn("provider-1", "turn-1");
      const pending = registry.register(source)!;
      expect(registry.claim(pending.requestId, thread, turn, {})).toBeUndefined();
    }
    const registry = new CodexOptionalQuestions();
    registry.startTurn("provider-1", "turn-1");
    const pending = registry.register(source)!;
    registry.invalidateTurn("turn-1");
    registry.startTurn("provider-1", "turn-1");
    expect(registry.register(source)).toBeUndefined();
    registry.startTurn("provider-1", "turn-2");
    expect(registry.register(source)).toBeUndefined();
    expect(registry.register({ ...source, turnId: "turn-2" })).toBeDefined();
    expect(registry.claim(pending.requestId, "provider-1", "turn-1", {})).toBeUndefined();
    expect(
      new CodexOptionalQuestions().claim(pending.requestId, "provider-1", "turn-1", {}),
    ).toBeUndefined();
  });
});
