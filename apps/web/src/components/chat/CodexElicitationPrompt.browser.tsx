import "../../index.css";
import { useRef } from "react";
import { ApprovalRequestId, EventId, RuntimeSessionId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { PendingUserInput } from "../../session-logic";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { useChatPendingUserInput } from "./useChatPendingUserInput";

// The question a node builds from OpenAI's Computer Use app approval in a Codex chat
// (apps/server/src/provider/codexMcpElicitation.ts).
const identity = {
  requestEventId: EventId.make("elicitation-event"),
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
};
const computerUse: PendingUserInput = {
  requestId: ApprovalRequestId.make("elicitation-1"),
  userInputIdentity: identity,
  createdAt: "2026-11-06T00:00:00.000Z",
  questions: [
    {
      id: "decision",
      header: "Codex Computer Use",
      question: 'Allow Computer Use to use "TextEdit"?',
      options: [
        { label: "Allow once", description: "Ask again next time" },
        { label: "Allow for this chat", description: "Don't ask again in this chat" },
        { label: "Always allow", description: "Don't ask again" },
        { label: "Deny", description: "Don't allow it" },
      ],
      multiSelect: false,
    },
  ],
};

function Fixture({
  respond,
}: {
  respond: Parameters<typeof useChatPendingUserInput>[0]["onRespondToUserInput"];
}) {
  const state = useChatPendingUserInput({
    pendingUserInputs: [computerUse],
    respondingUserInputRequestIds: [],
    promptRef: useRef(""),
    readComposer: () => null,
    onRespondToUserInput: respond,
  });
  return (
    <div style={{ width: 600 }}>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[computerUse]}
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

it("shows Codex Computer Use's app approval and sends the chosen option", async () => {
  await page.viewport(1280, 720);
  const respond = vi.fn(async () => undefined);
  mounted = await render(<Fixture respond={respond} />);

  await expect.element(page.getByText("Codex Computer Use")).toBeVisible();
  await expect.element(page.getByText('Allow Computer Use to use "TextEdit"?')).toBeVisible();
  for (const label of ["Allow once", "Allow for this chat", "Always allow", "Deny"]) {
    await expect
      .element(page.getByRole("button", { name: new RegExp(`^\\d?\\s*${label}`) }))
      .toBeVisible();
  }

  await page.getByRole("button", { name: /Always allow/ }).click();
  await expect
    .poll(() => respond.mock.calls)
    .toEqual([[computerUse.requestId, { decision: "Always allow" }, identity]]);
});
