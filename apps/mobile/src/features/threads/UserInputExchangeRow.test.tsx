import type { ReactElement } from "react";
import type { UserInputExchangeTimelineEntry } from "@ryco/client-runtime/state/session";
import { TurnId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
import { UserInputExchangeRow } from "./UserInputExchangeRow";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children)];
}

function texts(tree: ReactElement): string[] {
  return elements(tree)
    .filter((element) => element.type === "Text")
    .map((element) => [element.props.children].flat().join(""));
}

function exchange(
  overrides: Partial<UserInputExchangeTimelineEntry> = {},
): UserInputExchangeTimelineEntry {
  return {
    id: "user-input:answer-1",
    activityId: "answer-1",
    requestActivityId: "ask-1",
    createdAt: "2026-10-22T10:00:00.000Z",
    turnId: TurnId.make("turn-1"),
    cancelled: false,
    questions: [
      {
        id: "Which library?",
        header: "Library",
        question: "Which library?",
        options: ["React", "Vue"],
        answer: "React",
      },
      {
        id: "Tests?",
        header: "Tests",
        question: "Add tests?",
        options: [],
        answer: null,
      },
    ],
    ...overrides,
  };
}

describe("answered agent question row", () => {
  it("shows each question with its answer", () => {
    const tree = UserInputExchangeRow({ exchange: exchange() });
    expect(texts(tree)).toEqual([
      "Library",
      "Which library?",
      "React · Vue",
      "React",
      "Tests",
      "Add tests?",
      "No answer",
    ]);
    expect(
      elements(tree)
        .map((element) => element.props.accessibilityLabel)
        .filter(Boolean),
    ).toEqual(["Answer: React", "Answer: No answer"]);
  });

  it("keeps a cancelled question's text and says it was cancelled", () => {
    const tree = UserInputExchangeRow({
      exchange: exchange({ cancelled: true, questions: exchange().questions.slice(0, 1) }),
    });
    expect(texts(tree)).toEqual(["Library", "Which library?", "React · Vue", "Question cancelled"]);
  });
});
