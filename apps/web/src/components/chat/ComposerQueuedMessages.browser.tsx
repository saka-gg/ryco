import "../../index.css";

import type { FollowUpQueueRow } from "@ryco/client-runtime/state/message-queue";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { ComposerQueuedMessages } from "./ComposerQueuedMessages";

const row = (id: string): FollowUpQueueRow => ({
  id,
  source: "server",
  summary: `text of ${id}`,
  status: "queued",
  failureDetail: null,
  author: "user",
});

const actions = {
  onRemove: vi.fn(),
  onEdit: vi.fn(),
  getEditUnavailableReason: () => null,
  onMove: vi.fn(),
  showSteerAction: false,
  getSteerUnavailableReason: () => null,
  onSteer: vi.fn(),
  onCancelEdit: vi.fn(),
};

describe("ComposerQueuedMessages", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("lists the stored attachments the edited entry keeps, each one droppable", async () => {
    const onDropEditingAttachment = vi.fn();
    mounted = await render(
      <ComposerQueuedMessages
        rows={[row("a"), row("b")]}
        {...actions}
        editingId="a"
        editingAttachments={[
          { id: "img-1", name: "screenshot.png", kind: "image" },
          { id: "file-1", name: "notes.md", kind: "file" },
        ]}
        onDropEditingAttachment={onDropEditingAttachment}
      />,
    );
    const kept = page.getByRole("list", { name: "Attachments it keeps" });
    await expect.element(kept).toBeVisible();
    await expect.element(kept.getByText("screenshot.png")).toBeVisible();
    await page
      .getByRole("button", { name: "Drop notes.md from queued message 1 of 2: text of a" })
      .click();
    expect(onDropEditingAttachment).toHaveBeenCalledWith("file-1");
  });

  it("keeps the attachments while the edit saves, and shows none for other rows", async () => {
    mounted = await render(
      <ComposerQueuedMessages
        rows={[row("a")]}
        {...actions}
        editingId="a"
        editingAttachments={[{ id: "img-1", name: "screenshot.png", kind: "image" }]}
      />,
    );
    await expect
      .element(
        page.getByRole("button", {
          name: "Drop screenshot.png from queued message 1 of 1: text of a",
        }),
      )
      .toBeDisabled();
    await mounted.rerender(
      <ComposerQueuedMessages rows={[row("a")]} {...actions} editingId={null} />,
    );
    await expect
      .element(page.getByRole("list", { name: "Attachments it keeps" }))
      .not.toBeInTheDocument();
  });
});
