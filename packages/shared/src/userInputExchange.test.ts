import { describe, expect, it } from "vitest";

import {
  answerUserInputQuestions,
  createUserInputExchangePairing,
  readUserInputLifecycleRecord,
  type UserInputLifecycleRecord,
} from "./userInputExchange.ts";

const question = (id: string, text = `${id}?`) => ({
  id,
  header: id.toUpperCase(),
  question: text,
  options: [
    { label: "Yes", description: "Do it." },
    { label: "No", description: "Skip it." },
  ],
});

function requested(id: string, requestId: string, questions: unknown[]) {
  return readUserInputLifecycleRecord({
    id,
    kind: "user-input.requested",
    payload: { requestId, questions },
  })!;
}

function resolved(id: string, requestId: string, payload: Record<string, unknown> = {}) {
  return readUserInputLifecycleRecord({
    id,
    kind: "user-input.resolved",
    payload: { requestId, answers: {}, ...payload },
  })! as Extract<UserInputLifecycleRecord, { kind: "resolved" }>;
}

describe("user input exchanges", () => {
  it("reads only user-input activities that carry a request id", () => {
    expect(readUserInputLifecycleRecord({ id: "a", kind: "tool.completed", payload: {} })).toBe(
      null,
    );
    expect(
      readUserInputLifecycleRecord({ id: "a", kind: "user-input.resolved", payload: {} }),
    ).toBe(null);
    expect(requested("a", "req", [question("scope")]).kind).toBe("requested");
  });

  it("formats strings, multi-select lists and Codex answer records, dropping blanks", () => {
    const record = resolved("r", "req", {
      answers: {
        single: " Yes ",
        multi: ["Yes", "", "No"],
        codex: { answers: ["Later"] },
        blank: "  ",
        other: 42,
      },
    });
    expect(record.answers).toEqual({ single: "Yes", multi: "Yes, No", codex: "Later" });
    expect(record.cancelled).toBe(false);
  });

  it("puts answers under their questions by id, or by question text as Claude keys them", () => {
    const exchange = answerUserInputQuestions(
      [question("scope", "Which scope?"), question("q-1", "Ship it?")],
      resolved("r", "req", { answers: { scope: "Yes", "Ship it?": "No" } }),
    );
    expect(exchange.cancelled).toBe(false);
    expect(exchange.questions).toEqual([
      {
        id: "scope",
        header: "SCOPE",
        question: "Which scope?",
        options: ["Yes", "No"],
        answer: "Yes",
      },
      { id: "q-1", header: "Q-1", question: "Ship it?", options: ["Yes", "No"], answer: "No" },
    ]);
  });

  it("reads only answers the provider gave, never inherited keys", () => {
    const exchange = answerUserInputQuestions(
      [question("constructor", "toString")],
      resolved("r", "req"),
    );
    expect(exchange).toMatchObject({ cancelled: true, questions: [{ answer: null }] });
  });

  it("reads a cancelled or wholly unanswered resolution as cancelled", () => {
    const questions = [question("scope")];
    expect(
      answerUserInputQuestions(questions, resolved("r", "req", { cancelled: true })).cancelled,
    ).toBe(true);
    expect(answerUserInputQuestions(questions, resolved("r", "req")).cancelled).toBe(true);
    expect(
      answerUserInputQuestions(
        [question("scope"), question("other")],
        resolved("r", "req", { answers: { scope: "Yes" } }),
      ),
    ).toMatchObject({ cancelled: false, questions: [{ answer: "Yes" }, { answer: null }] });
  });

  it("pairs each resolution with the request it answered", () => {
    const pair = createUserInputExchangePairing<string>();
    expect(pair(requested("ask-1", "req-1", [question("one")]), "source-1")).toBe(null);
    expect(pair(requested("ask-2", "req-2", [question("two")]), "source-2")).toBe(null);
    expect(pair(resolved("answer-2", "req-2"), "answer-source")?.request).toBe("source-2");
    expect(pair(resolved("answer-1", "req-1"), "answer-source")?.request).toBe("source-1");
    // A request is answered once.
    expect(pair(resolved("answer-1-again", "req-1"), "answer-source")).toBe(null);
  });

  it("never pairs an answer with a newer question that reused the request id", () => {
    const pair = createUserInputExchangePairing<string>();
    pair(requested("ask-old", "req", [question("old")]), "old");
    pair(requested("ask-new", "req", [question("new")]), "new");
    expect(
      pair(
        resolved("answer-old", "req", { userInputIdentity: { requestEventId: "ask-old" } }),
        "a",
      ),
    ).toBe(null);
    expect(pair(resolved("answer-new", "req"), "a")?.request).toBe("new");
  });

  it("drops an open question that an unreadable request replaced", () => {
    const pair = createUserInputExchangePairing<string>();
    pair(requested("ask-old", "req", [question("old")]), "old");
    pair(requested("ask-bad", "req", [{ id: "bad" }]), "bad");
    expect(pair(resolved("answer", "req"), "a")).toBe(null);
  });
});
