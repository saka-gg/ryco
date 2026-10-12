import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vite-plus/test";

import { WorktreeSourceControlBadges } from "./WorktreeSourceControlBadges";

describe("WorktreeSourceControlBadges intent", () => {
  it("reports intent when the pointer or focus reaches a badge that opens a linked item", async () => {
    const onOpenLinkedItem = vi.fn();
    const onOpenLinkedItemIntent = vi.fn();
    await render(
      <WorktreeSourceControlBadges
        issueNumber={101}
        issueState="open"
        prNumber={202}
        prState="open"
        workItemProvider="jira"
        workItemKey="RY-7"
        workItemState="open"
        onOpenLinkedItem={onOpenLinkedItem}
        onOpenLinkedItemIntent={onOpenLinkedItemIntent}
      />,
    );

    await userEvent.hover(page.getByLabelText("Pull request #202 — Open"));
    expect(onOpenLinkedItemIntent).toHaveBeenCalled();

    onOpenLinkedItemIntent.mockClear();
    (page.getByLabelText("Issue #101 — Open").element() as HTMLButtonElement).focus();
    expect(onOpenLinkedItemIntent).toHaveBeenCalled();

    onOpenLinkedItemIntent.mockClear();
    await userEvent.hover(page.getByLabelText("Jira RY-7 — Open"));
    expect(onOpenLinkedItemIntent).toHaveBeenCalled();
    // Intent only preloads; it never opens anything.
    expect(onOpenLinkedItem).not.toHaveBeenCalled();
  });

  it("reports no intent from read-only badges", async () => {
    const onOpenLinkedItemIntent = vi.fn();
    await render(
      <WorktreeSourceControlBadges
        prNumber={202}
        prState="open"
        onOpenLinkedItemIntent={onOpenLinkedItemIntent}
      />,
    );

    await userEvent.hover(page.getByLabelText("Pull request #202 — Open"));
    expect(onOpenLinkedItemIntent).not.toHaveBeenCalled();
  });
});
