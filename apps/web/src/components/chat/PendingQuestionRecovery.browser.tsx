import "../../index.css";
import { useRef } from "react";
import { ApprovalRequestId, EventId, RuntimeSessionId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { PendingUserInput } from "../../session-logic";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { useChatPendingUserInput } from "./useChatPendingUserInput";

const identity = {
  requestEventId: EventId.make("displayed-question"),
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
};
const prompt: PendingUserInput = {
  requestId: ApprovalRequestId.make("provider-reused-id"),
  userInputIdentity: identity,
  createdAt: "2026-09-15T00:00:00.000Z",
  questions: [
    {
      id: "answer",
      question: "Continue with the proposed changes?",
      header: "Continue",
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" },
      ],
    },
  ],
};

function Fixture({
  question,
  respond,
}: {
  question: PendingUserInput;
  respond: Parameters<typeof useChatPendingUserInput>[0]["onRespondToUserInput"];
}) {
  const state = useChatPendingUserInput({
    pendingUserInputs: [question],
    respondingUserInputRequestIds: [],
    promptRef: useRef(""),
    readComposer: () => null,
    onRespondToUserInput: respond,
  });
  return (
    <div style={{ width: 600 }}>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[question]}
        respondingRequestIds={[]}
        answers={state.activePendingDraftAnswers}
        questionIndex={state.activePendingQuestionIndex}
        onToggleOption={state.onSelectActivePendingUserInputOption}
        onAdvance={state.onAdvanceActivePendingUserInput}
      />
    </div>
  );
}

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it("submits the displayed identity and never carries drafts into a replacement callback", async () => {
  await page.viewport(1280, 720);
  const respond = vi.fn(async () => undefined);
  mounted = await render(<Fixture question={prompt} respond={respond} />);
  await page.getByRole("button", { name: /Yes/ }).click();
  await expect
    .poll(() => respond.mock.calls)
    .toEqual([[prompt.requestId, { answer: "Yes" }, identity]]);
  await mounted.rerender(
    <Fixture
      question={{
        ...prompt,
        userInputIdentity: {
          requestEventId: EventId.make("replacement"),
          runtimeSessionId: RuntimeSessionId.make("runtime-2"),
        },
      }}
      respond={respond}
    />,
  );
  await page.getByRole("button", { name: /No/ }).click();
  await expect.poll(() => respond.mock.calls.length).toBe(2);
  expect(respond.mock.calls[1]).toEqual([
    prompt.requestId,
    { answer: "No" },
    { requestEventId: "replacement", runtimeSessionId: "runtime-2" },
  ]);
});

it("shows an uncertain outcome without allowing a replay", async () => {
  const respond = vi.fn();
  mounted = await render(
    <Fixture
      question={{ ...prompt, responseState: "uncertain", responseAttemptId: "attempt" }}
      respond={respond}
    />,
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Answer delivery is unconfirmed");
  await expect.element(page.getByRole("button", { name: /Yes/ })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: /No/ })).toBeDisabled();
  expect(respond).not.toHaveBeenCalled();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
