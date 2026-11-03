/**
 * The text an answer to a Codex optional question reaches the agent as. While the question's
 * turn runs, the node steers it into that turn; once the turn ended, a client sends it as an
 * ordinary user message that starts the next one. Both read it from here, so the agent sees one
 * shape either way.
 *
 * Pure module.
 */

export interface OptionalQuestionAnswerSource {
  /** The provider item that asked (Codex's `agentMessage` item id). */
  readonly itemId: string;
  /** The provider turn that asked. */
  readonly turnId: string;
  readonly questions: ReadonlyArray<{ readonly id: string; readonly question: string }>;
}

export const OPTIONAL_QUESTION_ANSWER_INCOMPLETE =
  "Answer every optional question before submitting.";

/**
 * The reply, or undefined for an empty answer map: that is an explicit dismissal and never
 * reaches the agent. Throws when an answer is missing or blank.
 */
export function formatOptionalQuestionAnswer(
  source: OptionalQuestionAnswerSource,
  answers: Readonly<Record<string, unknown>>,
): string | undefined {
  if (Object.keys(answers).length === 0) return undefined;
  if (Object.keys(answers).length !== source.questions.length)
    throw new Error(OPTIONAL_QUESTION_ANSWER_INCOMPLETE);
  const lines = source.questions.map((entry) => {
    const answer = answers[entry.id];
    const values = typeof answer === "string" ? [answer] : answer;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => typeof value !== "string" || !value.trim())
    )
      throw new Error(OPTIONAL_QUESTION_ANSWER_INCOMPLETE);
    return `${entry.question}\nAnswer: ${values.join("; ")}`;
  });
  return `Reply to your optional questions (item ${source.itemId}, turn ${source.turnId}):\n\n${lines.join("\n\n")}`;
}
