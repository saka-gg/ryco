import "../../index.css";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@ryco/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import { endPaneDrag, startPaneDrag } from "../../chatPanesStore";
import {
  THREAD_MENTION_DROP_ZONE_PROPS,
  ThreadMentionDropHint,
  useComposerThreadMentionDrop,
} from "./ComposerThreadMentionDrop";

const environmentId = EnvironmentId.make("mention-env");
const writing = { environmentId, threadId: ThreadId.make("writing") };
const other = { environmentId, threadId: ThreadId.make("other") };
const elsewhere = { environmentId: EnvironmentId.make("other-env"), threadId: ThreadId.make("x") };

function Composer(props: { readonly onMention: (threadId: ThreadId) => void }) {
  const drop = useComposerThreadMentionDrop({
    environmentId,
    threadId: writing.threadId,
    disabled: false,
    onMention: props.onMention,
  });
  return (
    <div
      {...THREAD_MENTION_DROP_ZONE_PROPS}
      data-testid="composer"
      style={{ position: "relative", width: 400, height: 120, marginTop: 40 }}
      onDragOver={(event) => void drop.onDragOver(event)}
      onDragLeave={(event) => void drop.onDragLeave(event)}
      onDrop={(event) => void drop.onDrop(event)}
    >
      {drop.verdict ? <ThreadMentionDropHint verdict={drop.verdict} /> : null}
    </div>
  );
}

function dragOnto(target: Element, source: ScopedThreadRef, type: "dragover" | "drop") {
  const transfer = new DataTransfer();
  startPaneDrag(transfer, source, "copyMove");
  const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
  target.dispatchEvent(event);
  return event;
}

afterEach(async () => {
  endPaneDrag();
  await cleanup();
});

it("offers to mention another thread of the same machine and inserts it on drop", async () => {
  const onMention = vi.fn();
  await render(<Composer onMention={onMention} />);
  const composer = page.getByTestId("composer").element();

  expect(dragOnto(composer, other, "dragover").defaultPrevented).toBe(true);
  await expect.element(page.getByText("Mention thread")).toBeVisible();

  dragOnto(composer, other, "drop");
  expect(onMention).toHaveBeenCalledWith(other.threadId);
  await expect.element(page.getByText("Mention thread")).not.toBeInTheDocument();
});

it("refuses the thread being written in and threads of another machine", async () => {
  const onMention = vi.fn();
  await render(<Composer onMention={onMention} />);
  const composer = page.getByTestId("composer").element();

  expect(dragOnto(composer, writing, "dragover").defaultPrevented).toBe(false);
  await expect.element(page.getByText("This is the thread you are writing in")).toBeVisible();

  expect(dragOnto(composer, elsewhere, "dragover").defaultPrevented).toBe(false);
  await expect
    .element(page.getByText("Only threads from the same machine can be mentioned"))
    .toBeVisible();

  // A drop the browser still delivers (another window) is refused by the drop itself.
  dragOnto(composer, elsewhere, "drop");
  expect(onMention).not.toHaveBeenCalled();
});

it("hands file drags back to the caller", async () => {
  const onMention = vi.fn();
  let handled: boolean | null = null;
  function FileProbe() {
    const drop = useComposerThreadMentionDrop({
      environmentId,
      threadId: writing.threadId,
      disabled: false,
      onMention,
    });
    return (
      <div
        data-testid="probe"
        style={{ width: 100, height: 40 }}
        onDragOver={(event) => {
          handled = drop.onDragOver(event);
        }}
      />
    );
  }
  await render(<FileProbe />);
  const transfer = new DataTransfer();
  transfer.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
  page
    .getByTestId("probe")
    .element()
    .dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  expect(handled).toBe(false);
});
