import "../../index.css";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useRef } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { TranscriptSelectionActions, readTranscriptSelection } from "./TranscriptSelectionActions";

const source = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("source") };
const text = "Keep the draft until the turn is accepted.";
const current = vi.fn();
const side = vi.fn();
const create = vi.fn(async () => {});
function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="relative min-h-screen bg-background p-12 text-foreground">
      <h1 className="mb-8 text-xl">Selection actions</h1>
      <p data-selection-message-id="assistant" tabIndex={0}>
        {text}
      </p>
      <p data-selection-message-id="other">Another message.</p>
      <p data-testid="streaming">Streaming text is excluded.</p>
      <button type="button" className="fixed bottom-4 right-4">
        Outside
      </button>
      <TranscriptSelectionActions
        containerRef={ref}
        source={source}
        canCreate
        canUseSide
        canUseWorktree
        onCurrent={current}
        onSide={side}
        onNew={create}
      />
    </div>
  );
}
let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  create.mockResolvedValue(undefined);
});
async function select() {
  const node = document.querySelector<HTMLElement>('[data-selection-message-id="assistant"]')!;
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  // The keyboard path must work while browser focus remains in the transcript.
  await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
  await expect.element(page.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
}
describe("TranscriptSelectionActions", () => {
  it("captures only a single completed message and supports keyboard current/Side actions", async () => {
    mounted = await render(<Harness />);
    await select();
    await expect
      .element(page.getByRole("button", { name: "Add to chat", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(current).toHaveBeenCalledWith({ source, messageId: "assistant", text });
    await select();
    await userEvent.keyboard("{Tab}{Enter}");
    expect(side).toHaveBeenCalledWith({ source, messageId: "assistant", text });
    const range = document.createRange();
    range.setStart(
      document.querySelector('[data-selection-message-id="assistant"]')!.firstChild!,
      0,
    );
    range.setEnd(document.querySelector('[data-selection-message-id="other"]')!.firstChild!, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(readTranscriptSelection(document.body, source)).toBeNull();
    range.selectNodeContents(document.querySelector('[data-testid="streaming"]')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(readTranscriptSelection(document.body, source)).toBeNull();
  });
  it("retains quote, prompt and location on failure, dismissal and explicit retry", async () => {
    create.mockRejectedValueOnce(new Error("File save failed"));
    mounted = await render(<Harness />);
    await select();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message for new chat" }).fill("Explain recovery");
    await page.getByLabelText("Work location").selectOptions("worktree");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("File save failed");
    await expect
      .element(page.getByRole("textbox", { name: "Message for new chat" }))
      .toHaveTextContent("Explain recovery");
    await page.getByRole("textbox", { name: "Message for new chat" }).click();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: "Resume new chat draft" }).click();
    await expect.element(page.getByLabelText("Work location")).toHaveValue("worktree");
    await expect.element(page.getByRole("blockquote")).toHaveTextContent(text);
    await page.getByRole("button", { name: "Outside", exact: true }).click();
    await page.getByRole("button", { name: "Resume new chat draft" }).click();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
  it("allows empty-prompt Open in chat and blocks duplicate submits and dismissal while pending", async () => {
    let finish!: () => void;
    create.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mounted = await render(<Harness />);
    await select();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Open in chat" }).click();
    await userEvent.keyboard("{Escape}{Enter}");
    await page.getByRole("button", { name: "Outside", exact: true }).click();
    expect(create).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "",
        intent: "compose",
        quote: { source, messageId: "assistant", text },
      }),
    );
    finish();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
});
