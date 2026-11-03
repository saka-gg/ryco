import {
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  WS_METHODS,
} from "@ryco/contracts";
import type { ProjectBrowserPickedElement } from "@ryco/contracts/project-browser";
import {
  type BrowserElementReference,
  type ComposerContextDelivery,
  composeOutgoingPrompt,
  createBrowserElementReference,
  createFileReference,
} from "@ryco/client-runtime/state/composer";
import { describe, expect, it, vi } from "vite-plus/test";

import { composerContextIntake } from "../composerContextIntake";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  readEnvironmentApi,
} from "../environmentApi";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  THREAD_KEY,
  THREAD_REF,
  createSnapshotForTargetUser,
  createUserMessage,
  fixture,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForComposerText,
  wsRequests,
} from "./ChatView.browser.helpers";
import { toastManager } from "./ui/toast";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const picked: ProjectBrowserPickedElement = {
  url: "http://localhost:3000/settings",
  pageTitle: "Settings · Acme",
  selector: "#settings-form > button:nth-of-type(2)",
  tagName: "button",
  role: "button",
  name: "Save changes",
  text: "Save changes",
  box: { x: 640, y: 412, width: 120, height: 32 },
};

function pageElement(selector = picked.selector, comment?: string): BrowserElementReference {
  const element = createBrowserElementReference({ ...picked, selector, comment });
  if (!element) throw new Error("Expected a page element.");
  return element;
}

const fileLines = createFileReference({
  path: "src/app.ts",
  lineStart: 12,
  lineEnd: 13,
  side: "new",
  lines: ["for (const item of items) {", "  run(item);"],
})!;

function deliver(element: BrowserElementReference): ComposerContextDelivery {
  return composerContextIntake.deliver(THREAD_REF, { kind: "browser-element", element });
}

function draftReferences() {
  return useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.fileReferences ?? [];
}

async function waitForChipLabels(
  selector: "[data-browser-element-chip]" | "[data-file-reference-chip]",
  expected: ReadonlyArray<string>,
): Promise<void> {
  await vi.waitFor(
    () => {
      const labels = [
        ...document.querySelectorAll<HTMLElement>(`[data-chat-composer-form] ${selector}`),
      ].map((element) => element.textContent?.trim());
      expect(labels).toEqual(expected);
    },
    { timeout: 8_000, interval: 16 },
  );
}

const turnStarts = () =>
  wsRequests.filter(
    (request) =>
      request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      request.type === "thread.turn.start",
  ) as unknown as ReadonlyArray<{ readonly message: { readonly text: string } }>;

async function sendWithEnter(text: string): Promise<void> {
  useComposerDraftStore.getState().setPrompt(THREAD_REF, text);
  await waitForComposerText(text);
  const editor = await waitForComposerEditor();
  editor.focus();
  editor.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}

function snapshotWithUserText(text: string): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: MessageId.make("msg-browser-element-target"),
    targetText: "unused",
  });
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      Object.assign({}, thread, {
        messages: [
          createUserMessage({
            id: MessageId.make("msg-browser-element-user"),
            text,
            offsetSeconds: 0,
          }),
        ],
      }),
    ),
  };
}

describe("ChatView page elements", () => {
  setupChatViewBrowserSuite();

  it("takes picked page elements as chips, updates repeats, and removes them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.make("msg-browser-element-chips"),
        targetText: "chips",
      }),
    });
    try {
      await waitForComposerEditor();
      await vi.waitFor(() => expect(composerContextIntake.canDeliver(THREAD_REF)).toBe(true));

      expect(deliver(pageElement(undefined, "Make it primary"))).toBe("added");
      expect(deliver(pageElement("main > h1"))).toBe("added");
      await waitForChipLabels("[data-browser-element-chip]", [
        'button "Save changes"',
        'button "Save changes"',
      ]);
      expect(
        composerContextIntake.deliver(THREAD_REF, { kind: "file-reference", reference: fileLines }),
      ).toBe("added");
      await waitForChipLabels("[data-file-reference-chip]", ["app.ts:12-13"]);

      // The same element of the same page with the same note refreshes its chip in place.
      expect(deliver(pageElement(undefined, "Make it primary"))).toBe("added");
      expect(draftReferences()).toHaveLength(3);
      // With another note it is another chip, so no note is replaced.
      expect(deliver(pageElement(undefined, "Make it purple"))).toBe("added");
      expect(draftReferences()).toMatchObject([
        { kind: "browser-element", comment: "Make it primary" },
        { kind: "browser-element", selector: "main > h1" },
        { path: "src/app.ts" },
        { kind: "browser-element", comment: "Make it purple" },
      ]);
      await waitForChipLabels("[data-browser-element-chip]", [
        'button "Save changes"',
        'button "Save changes"',
        'button "Save changes"',
      ]);

      const remove = document.querySelectorAll<HTMLButtonElement>(
        '[data-chat-composer-form] button[aria-label="Remove button \\"Save changes\\""]',
      );
      expect(remove).toHaveLength(3);
      remove[1]!.click();
      await waitForChipLabels("[data-browser-element-chip]", [
        'button "Save changes"',
        'button "Save changes"',
      ]);

      // A message carries 32 page elements, next to its file references.
      for (let index = 2; index < 32; index++) {
        expect(deliver(pageElement(`#item-${index}`))).toBe("added");
      }
      expect(deliver(pageElement("#one-more"))).toBe("full");
      expect(draftReferences()).toHaveLength(33);
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends the page elements before the file lines and shows them as chips", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.make("msg-browser-element-send"),
        targetText: "send",
      }),
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { sequence: fixture.snapshot.snapshotSequence + 1 }
          : undefined,
    });
    try {
      await waitForComposerEditor();
      await vi.waitFor(() => expect(composerContextIntake.canDeliver(THREAD_REF)).toBe(true));
      expect(
        composerContextIntake.deliver(THREAD_REF, { kind: "file-reference", reference: fileLines }),
      ).toBe("added");
      const element = pageElement(undefined, "Make it primary");
      expect(deliver(element)).toBe("added");
      await waitForChipLabels("[data-browser-element-chip]", ['button "Save changes"']);

      await sendWithEnter("Restyle this");
      await vi.waitFor(() => expect(turnStarts()).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      const text = turnStarts()[0]!.message.text;
      expect(text).toBe(
        composeOutgoingPrompt({ prompt: "Restyle this", fileReferences: [fileLines, element] }),
      );
      expect(text.indexOf("<browser_context>")).toBeGreaterThan(0);
      expect(text.indexOf("<browser_context>")).toBeLessThan(text.indexOf("<file_context>"));
      await waitForChipLabels("[data-browser-element-chip]", []);
      expect(draftReferences()).toEqual([]);

      await vi.waitFor(
        () =>
          expect(
            document.querySelector(
              "[data-user-message-file-references] [data-browser-element-chip]",
            )?.textContent,
          ).toContain('button "Save changes"'),
        { timeout: 8_000, interval: 16 },
      );
      expect(document.body.textContent ?? "").not.toContain("<browser_context>");
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a sent block as a chip, never as text", async () => {
    const sent = composeOutgoingPrompt({
      prompt: "Why is this grey?",
      fileReferences: [pageElement(undefined, "It should be blue")],
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: snapshotWithUserText(sent),
    });
    try {
      await vi.waitFor(
        () => expect(document.body.textContent ?? "").toContain("Why is this grey?"),
        { timeout: 8_000, interval: 16 },
      );
      expect(document.body.textContent ?? "").not.toContain("<browser_context>");
      expect(document.body.textContent ?? "").not.toContain("untrusted page data");
      expect(
        document.querySelector("[data-user-message-file-references] [data-browser-element-chip]")
          ?.textContent,
      ).toContain('button "Save changes"');
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a /btw side question to text while page elements wait, and says so", async () => {
    const toast = vi.spyOn(toastManager, "add");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.make("msg-browser-element-btw"),
        targetText: "btw",
      }),
    });
    try {
      await waitForComposerEditor();
      await vi.waitFor(() => expect(composerContextIntake.canDeliver(THREAD_REF)).toBe(true));
      expect(deliver(pageElement())).toBe("added");
      await waitForChipLabels("[data-browser-element-chip]", ['button "Save changes"']);

      await sendWithEnter("/btw why is this grey?");
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Side questions accept text only",
            description: expect.stringContaining("page elements"),
          }),
        ),
      );
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.textGenerationAskSideQuestion),
      ).toBe(false);
      expect(draftReferences()).toHaveLength(1);
    } finally {
      toast.mockRestore();
      await mounted.cleanup();
    }
  });

  it("puts the chips back when the send fails", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: MessageId.make("msg-browser-element-fail"),
        targetText: "fail",
      }),
    });
    try {
      await waitForComposerEditor();
      await vi.waitFor(() => expect(composerContextIntake.canDeliver(THREAD_REF)).toBe(true));
      const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
      let attempts = 0;
      __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
        ...api,
        orchestration: {
          ...api.orchestration,
          dispatchCommand: async () => {
            attempts += 1;
            throw new Error("The node went away.");
          },
        },
      });
      expect(deliver(pageElement(undefined, "Make it primary"))).toBe("added");
      await waitForChipLabels("[data-browser-element-chip]", ['button "Save changes"']);

      await sendWithEnter("Restyle this");
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(0), {
        timeout: 8_000,
        interval: 16,
      });
      await waitForComposerText("Restyle this");
      await waitForChipLabels("[data-browser-element-chip]", ['button "Save changes"']);
      expect(draftReferences()[0]).toMatchObject({
        kind: "browser-element",
        comment: "Make it primary",
      });
    } finally {
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });
});
