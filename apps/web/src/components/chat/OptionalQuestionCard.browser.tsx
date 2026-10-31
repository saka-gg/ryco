import { ApprovalRequestId, EventId, RuntimeSessionId, TurnId } from "@ryco/contracts";
import type { ChatFileUploadRecord } from "@ryco/client-runtime/state/composer";
import type { OptionalAnswerRoute } from "@ryco/client-runtime/state/user-input";
import { expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { OptionalQuestionCard, type OptionalQuestionUploads } from "./OptionalQuestionCard";

const input = {
  requestId: ApprovalRequestId.make("optional:test"),
  userInputIdentity: {
    requestEventId: EventId.make("event"),
    runtimeSessionId: RuntimeSessionId.make("runtime"),
  },
  nonBlocking: true,
  turnId: TurnId.make("turn-1"),
  itemId: "item-1",
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

let draftCount = 0;
/** Each test drafts under its own key: drafts outlive cards, by design. */
function cardProps(route: OptionalAnswerRoute = "steer") {
  draftCount += 1;
  return {
    input,
    draftKey: `draft-${draftCount}`,
    route,
    onRespond: vi.fn(async () => {}),
    onSendAsMessage: vi.fn(async () => {}),
  };
}

/** The composer's upload queue, in memory: a file stays "uploading" until the test settles it. */
function fakeUploads() {
  let records: ReadonlyMap<string, ChatFileUploadRecord> = new Map();
  const listeners = new Set<() => void>();
  const put = (id: string, record: ChatFileUploadRecord | null) => {
    const next = new Map(records);
    if (record) next.set(id, record);
    else next.delete(id);
    records = next;
    for (const listener of listeners) listener();
  };
  const uploads: OptionalQuestionUploads = {
    maxBytes: 1024 * 1024,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => records,
    enqueue: (attachmentId, file) =>
      put(attachmentId, {
        attachmentId,
        threadId: "thread" as never,
        environmentId: "environment" as never,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        readBytes: () => new Uint8Array(),
        status: { kind: "uploading", progress: 0.5 },
      }),
    release: vi.fn((attachmentId: string) => put(attachmentId, null)),
    usableToken: (attachmentId) => {
      const status = records.get(attachmentId)?.status;
      return status?.kind === "uploaded" ? status.uploadToken : null;
    },
  };
  const finishAll = () => {
    for (const [id, record] of records)
      put(id, {
        ...record,
        status: { kind: "uploaded", uploadToken: `token-${id}`, expiresAt: "2999-01-01T00:00:00Z" },
      });
  };
  return { uploads, finishAll };
}

function attachFile(file: File) {
  const field = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  field.files = transfer.files;
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

it("keeps the composer available, preserves drafts on collapse, and requires explicit submission", async () => {
  const props = cardProps();
  const view = await render(
    <>
      <input aria-label="Composer" />
      <OptionalQuestionCard {...props} disabled={false} />
    </>,
  );
  await view.getByText("Optional question · agent continues working").click();
  await expect.element(view.getByRole("button", { name: "Send answer" })).toBeDisabled();
  await view.getByRole("button", { name: "Engineers" }).click();
  expect(props.onRespond).not.toHaveBeenCalled();
  await view.getByText("Optional question · agent continues working").click();
  await view.getByRole("textbox", { name: "Composer", exact: true }).fill("Independent work");
  await view.getByText("Optional question · agent continues working").click();
  await expect
    .element(view.getByRole("button", { name: "Engineers" }))
    .toHaveAttribute("aria-pressed", "true");
  await view.getByRole("button", { name: "Send answer" }).click();
  expect(props.onRespond).toHaveBeenCalledExactlyOnceWith(
    input.requestId,
    { "0": "Engineers" },
    input.userInputIdentity,
  );
  // While its turn runs, an answer steers it: no message is sent, and no file can go along.
  expect(props.onSendAsMessage).not.toHaveBeenCalled();
  await expect.element(view.getByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
  await view.unmount();
});

it("keeps a draft when the card goes away and comes back, as on a thread switch or reconnect", async () => {
  const props = cardProps();
  const first = await render(<OptionalQuestionCard {...props} disabled={false} />);
  await first.getByText("Optional question · agent continues working").click();
  await first.getByRole("textbox").fill("Designers and writers");
  await first.unmount();

  const second = await render(<OptionalQuestionCard {...props} disabled={false} />);
  await second.getByText("Optional question · agent continues working").click();
  await expect.element(second.getByRole("textbox")).toHaveValue("Designers and writers");
  await second.unmount();
});

it("supports custom answers and explicit dismissal, and locks disconnected cards", async () => {
  const props = cardProps();
  const view = await render(<OptionalQuestionCard {...props} disabled={false} />);
  await view.getByText("Optional question · agent continues working").click();
  await view.getByRole("textbox").fill("Designers");
  await view.getByRole("button", { name: "Send answer" }).click();
  expect(props.onRespond).toHaveBeenCalledWith(
    input.requestId,
    { "0": "Designers" },
    input.userInputIdentity,
  );
  await view.getByRole("button", { name: "Dismiss" }).click();
  expect(props.onRespond).toHaveBeenLastCalledWith(input.requestId, {}, input.userInputIdentity);
  await view.rerender(<OptionalQuestionCard {...props} disabled={true} />);
  await expect.element(view.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  await view.unmount();
});

it("says why a disabled card cannot be answered", async () => {
  const props = cardProps();
  const reason = "Available when Studio Mac is connected";
  const view = await render(<OptionalQuestionCard {...props} disabled disabledReason={reason} />);
  await view.getByText("Optional question · agent continues working").click();
  await expect.element(view.getByText(reason)).toBeVisible();
  await expect.element(view.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  await view.rerender(<OptionalQuestionCard {...props} disabled={false} disabledReason={null} />);
  await expect.element(view.getByText(reason)).not.toBeInTheDocument();
  await view.unmount();
});

it("answers after the turn ended as a new message, with files, once their uploads are ready", async () => {
  const props = cardProps("message");
  const { uploads, finishAll } = fakeUploads();
  const view = await render(<OptionalQuestionCard {...props} disabled={false} uploads={uploads} />);
  await view.getByText("Optional question · turn ended").click();
  await expect
    .element(view.getByText("Your answer is sent as a new message", { exact: false }))
    .toBeVisible();
  await view.getByRole("button", { name: "Engineers" }).click();
  attachFile(new File(["mockup"], "mockup.png", { type: "image/png" }));
  await expect.element(view.getByText("mockup.png")).toBeVisible();
  // Submit waits for the upload, which the composer's queue prepares.
  await expect.element(view.getByRole("button", { name: "Send answer" })).toBeDisabled();
  await expect.element(view.getByText("Uploading 'mockup.png'…")).toBeVisible();
  finishAll();
  await expect.element(view.getByRole("button", { name: "Send answer" })).toBeEnabled();
  await view.getByRole("button", { name: "Send answer" }).click();
  await vi.waitFor(() => expect(props.onSendAsMessage).toHaveBeenCalledTimes(1));
  const [, answers, attachments] = props.onSendAsMessage.mock.calls[0] as unknown as [
    unknown,
    Record<string, unknown>,
    ReadonlyArray<Record<string, unknown>>,
  ];
  expect(answers).toEqual({ "0": "Engineers" });
  expect(attachments).toEqual([
    expect.objectContaining({
      type: "file",
      name: "mockup.png",
      mimeType: "image/png",
      uploadToken: expect.stringMatching(/^token-/),
    }),
  ]);
  expect(props.onRespond).not.toHaveBeenCalled();
  // Sent: the draft and its upload are gone.
  expect(uploads.release).toHaveBeenCalledTimes(1);
  await expect
    .element(view.getByRole("button", { name: "Engineers" }))
    .toHaveAttribute("aria-pressed", "false");
  await view.unmount();
});

it("keeps the draft when the node refuses a late answer", async () => {
  const props = cardProps("message");
  props.onSendAsMessage.mockRejectedValueOnce(new Error("already answered"));
  const view = await render(<OptionalQuestionCard {...props} disabled={false} />);
  await view.getByText("Optional question · turn ended").click();
  await view.getByRole("textbox").fill("Designers");
  await view.getByRole("button", { name: "Send answer" }).click();
  await expect.element(view.getByRole("alert")).toBeVisible();
  await expect.element(view.getByRole("textbox")).toHaveValue("Designers");
  await view.unmount();
});

it("waits while another turn runs, and can still be dismissed", async () => {
  const props = cardProps("wait");
  const view = await render(<OptionalQuestionCard {...props} disabled={false} />);
  await view.getByText("Optional question · turn ended").click();
  await expect.element(view.getByText("You can answer once the current turn ends.")).toBeVisible();
  await view.getByRole("textbox").fill("Designers");
  await expect.element(view.getByRole("button", { name: "Send answer" })).toBeDisabled();
  await view.getByRole("button", { name: "Dismiss" }).click();
  expect(props.onRespond).toHaveBeenCalledExactlyOnceWith(
    input.requestId,
    {},
    input.userInputIdentity,
  );
  expect(props.onSendAsMessage).not.toHaveBeenCalled();
  await view.unmount();
});
