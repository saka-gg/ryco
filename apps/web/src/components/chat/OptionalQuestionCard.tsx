import { useState } from "react";
import type { ApprovalRequestId, ApprovalResponseIdentity } from "@ryco/contracts";
import type { PendingUserInput } from "@ryco/client-runtime/state/session";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@ryco/client-runtime/state/user-input";

export function OptionalQuestionCard({
  input,
  disabled,
  onRespond,
}: {
  input: PendingUserInput;
  disabled: boolean;
  onRespond: (
    requestId: ApprovalRequestId,
    answers: Record<string, unknown>,
    identity?: ApprovalResponseIdentity,
  ) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answers = buildPendingUserInputAnswers(input.questions, drafts);
  const locked =
    disabled ||
    sending ||
    input.responseState === "submitting" ||
    input.responseState === "uncertain";
  const submit = async (value: Record<string, unknown>) => {
    if (locked) return;
    setSending(true);
    setError(null);
    try {
      await onRespond(input.requestId, value, input.userInputIdentity);
    } catch {
      setError("Could not submit the answer. Check the connection and question status.");
    } finally {
      setSending(false);
    }
  };
  return (
    <details className="mx-auto mb-2 w-full max-w-208 rounded-lg border border-border bg-background px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">
        Optional question · agent continues working
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        Answer while this turn is running. This is not an approval request.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (answers) void submit(answers);
        }}
      >
        <fieldset disabled={locked} className="space-y-3 py-3">
          {input.questions.map((question) => (
            <div key={question.id}>
              <label htmlFor={`${input.requestId}-${question.id}`} className="block text-sm">
                {question.question}
              </label>
              <div className="my-2 flex flex-wrap gap-2">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={
                      drafts[question.id]?.selectedOptionLabels?.includes(option.label) ?? false
                    }
                    className="rounded-md border border-border px-3 py-1 text-sm aria-pressed:bg-accent"
                    onClick={() =>
                      setDrafts((current) => ({
                        ...current,
                        [question.id]: togglePendingUserInputOptionSelection(
                          question,
                          current[question.id],
                          option.label,
                        ),
                      }))
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <input
                id={`${input.requestId}-${question.id}`}
                aria-label={`Custom answer: ${question.question}`}
                placeholder="Write an answer"
                value={drafts[question.id]?.customAnswer ?? ""}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [question.id]: setPendingUserInputCustomAnswer(
                      current[question.id],
                      event.target.value,
                    ),
                  }))
                }
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
          ))}
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={!answers}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              Send answer
            </button>
            <button
              type="button"
              onClick={() => void submit({})}
              className="text-sm text-muted-foreground"
            >
              Dismiss
            </button>
          </div>
        </fieldset>
      </form>
      {input.responseState === "uncertain" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Delivery is unconfirmed. This answer will not be resent automatically.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </details>
  );
}
