import { ORCHESTRATION_WS_METHODS, type MessageId, type ThreadId } from "@ryco/contracts";
import type { ChatFileUploadTransport } from "@ryco/client-runtime/state/composer";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { composerFileUploadEngine } from "../composerFileUpload";
import {
  DEFAULT_VIEWPORT,
  THREAD_ID,
  THREAD_KEY,
  createSnapshotForTargetUser,
  fixture,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForComposerText,
  waitForElement,
  waitForLayout,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/**
 * The upload transport, under the test's control: minting a token answers at once, and each
 * byte transfer waits until the test finishes or fails it.
 */
const uploads = vi.hoisted(() => {
  interface Transfer {
    readonly uploadToken: string;
    readonly progress: (value: number) => void;
    readonly finish: () => void;
    readonly fail: (message: string) => void;
  }
  const transfers: Transfer[] = [];
  let minted = 0;
  const transport = {
    createFileUploadUrl: async () => {
      minted += 1;
      return {
        uploadToken: `upload-token-${minted}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        maxUploadBytes: 10 * 1024 * 1024,
      };
    },
    transferBytes: (input: {
      readonly uploadToken: string;
      readonly signal?: AbortSignal;
      readonly bytes: Uint8Array;
      readonly onProgress?: (progress: number) => void;
    }) =>
      new Promise<{ name?: string; mimeType?: string; sizeBytes?: number }>((resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => reject(new Error("The upload was cancelled.")),
          {
            once: true,
          },
        );
        transfers.push({
          uploadToken: input.uploadToken,
          progress: (value) => input.onProgress?.(value),
          finish: () => {
            input.onProgress?.(1);
            resolve({ sizeBytes: input.bytes.byteLength });
          },
          fail: (message) => reject(new Error(message)),
        });
      }),
  };
  return {
    transfers,
    transport,
    reset: () => {
      transfers.length = 0;
      minted = 0;
    },
  };
});

vi.mock("../platform/attachmentUpload", () => ({
  buildChatAttachmentUploadUrl: (input: { readonly uploadToken: string }) =>
    `/attachments/upload?token=${input.uploadToken}`,
  webChatFileUploadTransport: uploads.transport satisfies ChatFileUploadTransport,
}));

const EXISTING_TEXT = "Existing conversation";
const FILE_NAME = "notes.txt";
const FILE_TEXT = "release notes draft";

interface DispatchedTurnStart {
  readonly _tag: string;
  readonly type?: string;
  readonly threadId?: string;
  readonly message?: {
    readonly messageId?: string;
    readonly text?: string;
    readonly attachments?: ReadonlyArray<Record<string, unknown>>;
  };
}

function turnStartsFor(threadId: ThreadId): DispatchedTurnStart[] {
  return (wsRequests as ReadonlyArray<DispatchedTurnStart>).filter(
    (request) =>
      request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      request.type === "thread.turn.start" &&
      request.threadId === threadId,
  );
}

type TestFixture = Parameters<
  NonNullable<Parameters<typeof mountChatView>[0]["configureFixture"]>
>[0];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An environment that streams file attachments under upload tokens. */
function enableFileUploads(nextFixture: TestFixture): void {
  const capabilities = {
    ...nextFixture.serverConfig.environment.capabilities,
    fileAttachments: { maxUploadBytes: 10 * 1024 * 1024 },
  };
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    environment: { ...nextFixture.serverConfig.environment, capabilities },
  };
  nextFixture.welcome = {
    ...nextFixture.welcome,
    environment: { ...nextFixture.welcome.environment, capabilities },
  };
}

async function mountIdleThread() {
  // The upload engine is process-wide: a failed upload an earlier test left behind would retry
  // on this mount's fresh connection and take this test's first transfer.
  composerFileUploadEngine.releaseAll();
  uploads.reset();
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot: createSnapshotForTargetUser({
      targetMessageId: "msg-send-during-upload-existing" as MessageId,
      targetText: EXISTING_TEXT,
    }),
    configureFixture: enableFileUploads,
    resolveRpc: (body) =>
      body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
        ? { sequence: fixture.snapshot.snapshotSequence + 1 }
        : undefined,
  });
  await waitForComposerEditor();
  return {
    cleanup: async () => {
      await mounted.cleanup();
      composerFileUploadEngine.releaseAll();
    },
  };
}

function draftAttachments() {
  return useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.images ?? [];
}

function draftPrompt(): string {
  return useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "";
}

/** Pastes a file from disk into the composer and waits for its upload to be in flight. */
async function attachFileAndWaitForUpload(): Promise<void> {
  const editor = await waitForComposerEditor();
  editor.focus();
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File([FILE_TEXT], FILE_NAME, { type: "text/plain" }));
  editor.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
  );
  await vi.waitFor(
    () => {
      expect(draftAttachments().map(({ type, name }) => ({ type, name }))).toEqual([
        { type: "file", name: FILE_NAME },
      ]);
      expect(uploads.transfers).toHaveLength(1);
    },
    { timeout: 8_000, interval: 16 },
  );
}

/** Types `text` into the composer as a person would. */
async function typeIntoComposer(text: string): Promise<void> {
  const editor = await waitForComposerEditor();
  editor.focus();
  document.execCommand("insertText", false, text);
  await waitForComposerText(text);
}

async function pressSend(): Promise<void> {
  const button = await waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find the send button.",
  );
  await vi.waitFor(() => expect(button.disabled).toBe(false), { timeout: 8_000, interval: 16 });
  button.click();
  await waitForLayout();
}

function heldStatus(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-held-send-state]");
}

async function waitForHeldState(state: "waiting" | "failed" | "sending"): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>(`[data-held-send-state="${state}"]`),
    `The held message should show its ${state} state.`,
  );
}

function heldActionButton(label: string): HTMLButtonElement | null {
  return heldStatus()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? null;
}

/** Sends `prompt` with the attached file while it uploads; returns the held status line. */
async function sendWhileUploading(prompt: string): Promise<HTMLElement> {
  await attachFileAndWaitForUpload();
  await typeIntoComposer(prompt);
  await pressSend();
  // Accepted at once: the composer is empty and the message waits in the timeline.
  await waitForComposerText("");
  expect(draftAttachments()).toHaveLength(0);
  const status = await waitForHeldState("waiting");
  expect(document.body.textContent ?? "").toContain(prompt);
  expect(turnStartsFor(THREAD_ID)).toEqual([]);
  return status;
}

describe("ChatView send while attachments upload", () => {
  setupChatViewBrowserSuite();

  it("accepts the send at once and sends it with the file once the upload finishes", async () => {
    const mounted = await mountIdleThread();
    try {
      const status = await sendWhileUploading("Read these notes");
      expect(status.textContent ?? "").toContain(`Uploading ${FILE_NAME}`);

      uploads.transfers[0]!.progress(0.5);
      await vi.waitFor(
        () => expect(heldStatus()?.textContent ?? "").toContain(`Uploading ${FILE_NAME} · 50%`),
        { timeout: 8_000, interval: 16 },
      );

      // The next message is typed meanwhile and stays in the composer.
      await typeIntoComposer("And the follow-up");
      await sleep(300);
      expect(turnStartsFor(THREAD_ID)).toEqual([]);
      expect(heldStatus()?.getAttribute("data-held-send-state")).toBe("waiting");

      uploads.transfers[0]!.finish();
      await vi.waitFor(() => expect(turnStartsFor(THREAD_ID)).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      const [start] = turnStartsFor(THREAD_ID);
      expect(start?.message?.text).toContain("Read these notes");
      expect(start?.message?.attachments).toEqual([
        expect.objectContaining({
          type: "file",
          name: FILE_NAME,
          mimeType: "text/plain",
          uploadToken: "upload-token-1",
        }),
      ]);
      expect(start?.message?.attachments?.[0]).not.toHaveProperty("dataUrl");

      await vi.waitFor(() => expect(heldStatus()).toBeNull(), { timeout: 8_000, interval: 16 });
      // Exactly once, and the newly typed text is untouched.
      await sleep(400);
      expect(turnStartsFor(THREAD_ID)).toHaveLength(1);
      expect(draftPrompt()).toBe("And the follow-up");
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers Retry, Send without it and Cancel when the upload fails; Cancel brings the message back after what was typed since", async () => {
    const mounted = await mountIdleThread();
    try {
      await sendWhileUploading("Summarize the file");
      await typeIntoComposer("Typed since");

      uploads.transfers[0]!.fail("The upload could not reach the server.");
      const status = await waitForHeldState("failed");
      expect(status.textContent ?? "").toContain(`${FILE_NAME} failed to upload`);
      expect(heldActionButton(`Retry uploading ${FILE_NAME}`)?.textContent).toContain("Retry");
      expect(heldActionButton(`Send without ${FILE_NAME}`)?.textContent).toContain(
        "Send without it",
      );
      expect(heldActionButton("Cancel sending this message")?.textContent).toContain("Cancel");
      await sleep(300);
      expect(turnStartsFor(THREAD_ID)).toEqual([]);

      heldActionButton("Cancel sending this message")!.click();
      await vi.waitFor(
        () => {
          expect(draftPrompt()).toBe("Typed since\n\nSummarize the file");
          expect(draftAttachments().map(({ type, name }) => ({ type, name }))).toEqual([
            { type: "file", name: FILE_NAME },
          ]);
          expect(heldStatus()).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      await sleep(400);
      expect(turnStartsFor(THREAD_ID)).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends the message without the file that failed to upload", async () => {
    const mounted = await mountIdleThread();
    try {
      await sendWhileUploading("Send it anyway");
      uploads.transfers[0]!.fail("The upload could not reach the server.");
      await waitForHeldState("failed");

      heldActionButton(`Send without ${FILE_NAME}`)!.click();
      await vi.waitFor(() => expect(turnStartsFor(THREAD_ID)).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      const [start] = turnStartsFor(THREAD_ID);
      expect(start?.message?.text).toContain("Send it anyway");
      expect(start?.message?.attachments ?? []).toEqual([]);
      await vi.waitFor(() => expect(heldStatus()).toBeNull(), { timeout: 8_000, interval: 16 });
      await sleep(400);
      expect(turnStartsFor(THREAD_ID)).toHaveLength(1);
      expect(draftPrompt()).toBe("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("retries the failed upload and sends with the file once it finishes", async () => {
    const mounted = await mountIdleThread();
    try {
      await sendWhileUploading("Try the upload again");
      uploads.transfers[0]!.fail("The upload could not reach the server.");
      await waitForHeldState("failed");

      heldActionButton(`Retry uploading ${FILE_NAME}`)!.click();
      await vi.waitFor(() => expect(uploads.transfers).toHaveLength(2), {
        timeout: 8_000,
        interval: 16,
      });
      await waitForHeldState("waiting");
      expect(turnStartsFor(THREAD_ID)).toEqual([]);

      uploads.transfers[1]!.finish();
      await vi.waitFor(() => expect(turnStartsFor(THREAD_ID)).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      expect(turnStartsFor(THREAD_ID)[0]?.message?.attachments).toEqual([
        expect.objectContaining({ type: "file", name: FILE_NAME, uploadToken: "upload-token-2" }),
      ]);
    } finally {
      await mounted.cleanup();
    }
  });
});
