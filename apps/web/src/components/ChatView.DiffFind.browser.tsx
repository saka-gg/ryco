import type { MessageId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { isMacPlatform } from "../lib/utils";
import { DIFF_FIND_SURFACE_ATTRIBUTE } from "./diffSearch/diffFindSurface";
import {
  createSnapshotForTargetUser,
  DEFAULT_VIEWPORT,
  mountChatView,
  setupChatViewBrowserSuite,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/** The default thread-find key (⌘F, Ctrl+F off macOS), dispatched like a key press on `target`. */
function pressFindKey(target: Element): KeyboardEvent {
  const mac = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    metaKey: mac,
    ctrlKey: !mac,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function threadSearch(): Element | null {
  return document.querySelector('[data-thread-message-search="true"]');
}

describe("ChatView find with a diff open (full app)", () => {
  setupChatViewBrowserSuite();

  it("leaves the find key to a diff view that has focus, and opens thread find elsewhere", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-diff-find" as MessageId,
        targetText: "diff find",
      }),
    });
    try {
      // Stands in for the Diff panel, marked with the hook's attribute: ChatView matches it by a
      // literal selector (no new import on the chat route), which this keeps in step.
      const surface = document.createElement("div");
      surface.setAttribute(DIFF_FIND_SURFACE_ATTRIBUTE, "");
      surface.tabIndex = -1;
      const inner = document.createElement("div");
      inner.textContent = "diff text";
      surface.append(inner);
      document.body.append(surface);
      surface.focus();

      const fromDiff = pressFindKey(inner);
      expect(fromDiff.defaultPrevented).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(threadSearch()).toBeNull();

      surface.remove();
      (document.activeElement as HTMLElement | null)?.blur();
      const fromPage = pressFindKey(document.body);
      expect(fromPage.defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(threadSearch()).not.toBeNull());
    } finally {
      await mounted.cleanup();
    }
  });
});
