import { ApprovalRequestId, EventId, RuntimeSessionId } from "@ryco/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { OptionalQuestionCard } from "./OptionalQuestionCard";

const input = {
  requestId: ApprovalRequestId.make("optional:test"),
  userInputIdentity: {
    requestEventId: EventId.make("event"),
    runtimeSessionId: RuntimeSessionId.make("runtime"),
  },
  nonBlocking: true,
  createdAt: "2026-09-27T10:00:00.000Z",
  questions: [
    {
      id: "0",
      header: "Audience",
      question: "Who is this for?",
      options: [{ label: "Engineers", description: "Engineers" }],
      multiSelect: false,
    },
  ],
};
it("keeps the composer available, preserves drafts on collapse, and requires explicit submission", async () => {
  const onRespond = vi.fn(async () => {});
  const view = await render(
    <>
      <input aria-label="Composer" />
      <OptionalQuestionCard input={input} disabled={false} onRespond={onRespond} />
    </>,
  );
  await view.getByText("Optional question · agent continues working").click();
  await expect.element(view.getByRole("button", { name: "Send answer" })).toBeDisabled();
  await view.getByRole("button", { name: "Engineers" }).click();
  expect(onRespond).not.toHaveBeenCalled();
  await view.getByText("Optional question · agent continues working").click();
  await view.getByRole("textbox", { name: "Composer", exact: true }).fill("Independent work");
  await view.getByText("Optional question · agent continues working").click();
  await expect
    .element(view.getByRole("button", { name: "Engineers" }))
    .toHaveAttribute("aria-pressed", "true");
  await view.getByRole("button", { name: "Send answer" }).click();
  expect(onRespond).toHaveBeenCalledExactlyOnceWith(
    input.requestId,
    { "0": "Engineers" },
    input.userInputIdentity,
  );
  await view.unmount();
});
it("supports custom answers and explicit dismissal, and locks disconnected cards", async () => {
  const onRespond = vi.fn(async () => {});
  const view = await render(
    <OptionalQuestionCard input={input} disabled={false} onRespond={onRespond} />,
  );
  await view.getByText("Optional question · agent continues working").click();
  await view.getByRole("textbox").fill("Designers");
  await view.getByRole("button", { name: "Send answer" }).click();
  expect(onRespond).toHaveBeenCalledWith(
    input.requestId,
    { "0": "Designers" },
    input.userInputIdentity,
  );
  await view.getByRole("button", { name: "Dismiss" }).click();
  expect(onRespond).toHaveBeenLastCalledWith(input.requestId, {}, input.userInputIdentity);
  await view.rerender(<OptionalQuestionCard input={input} disabled={true} onRespond={onRespond} />);
  await expect.element(view.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  await view.unmount();
});
