import { describe, expect, it } from "vite-plus/test";

import { formatOptionalQuestionAnswer } from "./optionalQuestionAnswer.ts";

const source = {
  itemId: "item-1",
  turnId: "turn-1",
  questions: [
    { id: "0", question: "Audience?" },
    { id: "1", question: "Any constraints?" },
  ],
};

describe("formatOptionalQuestionAnswer", () => {
  it("names the asking item and turn, and pairs each question with its answer", () => {
    expect(formatOptionalQuestionAnswer(source, { "0": ["Engineers", "Managers"], "1": "Short" }))
      .toBe(`Reply to your optional questions (item item-1, turn turn-1):

Audience?
Answer: Engineers; Managers

Any constraints?
Answer: Short`);
  });

  it("reads an empty answer map as a dismissal, which never reaches the agent", () => {
    expect(formatOptionalQuestionAnswer(source, {})).toBeUndefined();
  });

  it("refuses a missing or blank answer", () => {
    expect(() => formatOptionalQuestionAnswer(source, { "0": "Engineers" })).toThrow();
    expect(() => formatOptionalQuestionAnswer(source, { "0": "Engineers", "1": " " })).toThrow();
    expect(() => formatOptionalQuestionAnswer(source, { "0": [], "1": "Short" })).toThrow();
  });
});
