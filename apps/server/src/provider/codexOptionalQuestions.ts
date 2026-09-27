import {
  ApprovalRequestId,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from "@ryco/contracts";

/** Native request_user_input_async emits a completed agentMessage, not an RPC
 * request. Enable only on explicit structured payloads, never on timeouts. */
export function readCodexOptionalQuestions(
  item: unknown,
): ReadonlyArray<UserInputQuestion> | undefined {
  if (!item || typeof item !== "object") return;
  const value = item as Record<string, unknown>;
  if (
    value.type !== "agentMessage" ||
    value.delivery !== "async" ||
    !Array.isArray(value.questions) ||
    value.questions.length === 0 ||
    value.questions.length > 20
  )
    return;
  const questions: UserInputQuestion[] = [];
  for (const [index, raw] of value.questions.entries()) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.title !== "string" ||
      !raw.title.trim() ||
      raw.title.length > 10_000
    )
      return;
    if (
      raw.options != null &&
      (!Array.isArray(raw.options) ||
        raw.options.length === 0 ||
        raw.options.length > 50 ||
        raw.options.some(
          (option: unknown) =>
            typeof option !== "string" || !option.trim() || option.length > 10_000,
        ))
    )
      return;
    questions.push({
      id: String(index),
      header: `Question ${index + 1}`,
      question: raw.title,
      options: (raw.options ?? []).map((label: string) => ({ label, description: label })),
      multiSelect: false,
    });
  }
  return questions;
}

export interface CodexOptionalQuestion {
  readonly requestId: ApprovalRequestId;
  readonly providerThreadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

/** Process-local delivery authority. Durable admission/settlement remains in the
 * orchestration question ledger. Taking a request is synchronous and single-use,
 * including uncertain transport failures; never retry a possibly delivered steer. */
export class CodexOptionalQuestions {
  private readonly pending = new Map<ApprovalRequestId, CodexOptionalQuestion>();
  private readonly seen = new Map<string, string>();
  private activeTurn: { providerThreadId: string; turnId: string } | undefined;
  private lastTurnKey: string | undefined;

  startTurn(providerThreadId: string, turnId: string): void {
    const key = JSON.stringify([providerThreadId, turnId]);
    if (key === this.lastTurnKey) return;
    this.pending.clear();
    this.seen.clear();
    this.lastTurnKey = key;
    this.activeTurn = { providerThreadId, turnId };
  }

  register(input: Omit<CodexOptionalQuestion, "requestId">): CodexOptionalQuestion | undefined {
    if (
      input.turnId !== this.activeTurn?.turnId ||
      input.providerThreadId !== this.activeTurn.providerThreadId
    )
      return;
    const key = JSON.stringify([input.providerThreadId, input.turnId, input.itemId]);
    if (this.seen.has(key)) return;
    this.seen.set(key, input.turnId);
    const question = {
      ...input,
      requestId: ApprovalRequestId.make(`optional:${crypto.randomUUID()}`),
    };
    this.pending.set(question.requestId, question);
    return question;
  }

  claim(
    requestId: ApprovalRequestId,
    providerThreadId: string,
    activeTurnId: string | undefined,
    answers: ProviderUserInputAnswers,
  ): { question: CodexOptionalQuestion; prompt: string | undefined } | undefined {
    const question = this.pending.get(requestId);
    if (!question) return;
    if (question.providerThreadId !== providerThreadId || question.turnId !== activeTurnId) {
      this.pending.delete(requestId);
      return;
    }
    // Validation and claim are one synchronous operation. Bad input leaves the
    // authority intact; once claimed, transport failure must never release it.
    const prompt = formatCodexOptionalAnswer(question, answers);
    this.pending.delete(requestId);
    return { question, prompt };
  }

  invalidateTurn(turnId: string): void {
    if (this.activeTurn?.turnId === turnId) this.activeTurn = undefined;
    for (const [id, question] of this.pending)
      if (question.turnId === turnId) this.pending.delete(id);
    for (const [key, owner] of this.seen) if (owner === turnId) this.seen.delete(key);
  }
}

export function formatCodexOptionalAnswer(
  question: CodexOptionalQuestion,
  answers: ProviderUserInputAnswers,
): string | undefined {
  // Empty answer map is an explicit local dismissal, never an approval decision.
  if (Object.keys(answers).length === 0) return undefined;
  if (Object.keys(answers).length !== question.questions.length)
    throw new Error("Answer every optional question before submitting.");
  const lines = question.questions.map((entry) => {
    const answer = answers[entry.id];
    const values = typeof answer === "string" ? [answer] : answer;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => typeof value !== "string" || !value.trim())
    )
      throw new Error("Answer every optional question before submitting.");
    return `${entry.question}\nAnswer: ${values.join("; ")}`;
  });
  return `Reply to your optional questions (item ${question.itemId}, turn ${question.turnId}):\n\n${lines.join("\n\n")}`;
}
