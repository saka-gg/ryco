import type {
  HostedCapabilityKind,
  HostedRpcCapability,
} from "@ryco/client-runtime/authorization/capabilities";
import { HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS } from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";
import { ORCHESTRATION_WS_METHODS, ThreadId, type MessageId } from "@ryco/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { composerFileUploadEngine } from "../composerFileUpload";
import { useComposerDraftStore } from "../composerDraftStore";
import { hostedHubStore } from "../hostedHub/state";
import type { QueuedMessage } from "../messageQueue.logic";
import { useMessageQueueStore } from "../messageQueueStore";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  THREAD_ID,
  THREAD_KEY,
  THREAD_REF,
  addThreadToSnapshot,
  createDraftOnlySnapshot,
  createSnapshotForTargetUser,
  createSnapshotWithPendingApproval,
  createSnapshotWithPendingUserInput,
  fixture,
  mountChatView,
  serverThreadPath,
  setDraftThreadWithoutWorktree,
  setupChatViewBrowserSuite,
  waitForButtonContainingText,
  waitForComposerEditor,
  waitForElement,
  waitForLayout,
  waitForURL,
  wsRequests,
} from "./ChatView.browser.helpers";
import { CONNECTING_WAIT_DEADLINE_MS, ComposerQueuedMessages } from "./chat/ComposerQueuedMessages";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/**
 * The hosted connection phase a test puts the thread's environment in: the
 * capability every method answers with, and the node the chat names. `null`
 * leaves the real (standard build) answers in place, which are ready.
 */
const hostedPhase = vi.hoisted(() => {
  type Phase = {
    readonly kind: "establishing" | "stale" | "role";
    readonly label: string;
    readonly queued?: boolean;
  };
  let phase: Phase | null = null;
  const listeners = new Set<() => void>();
  return {
    read: (): Phase | null => phase,
    set: (next: Phase | null) => {
      phase = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

const STALE_REASON = "This action is unavailable while Hub authorization or the relay is stale.";
const ROLE_REASON = "This action is unavailable for your role on the selected node.";

/** One frozen capability per kind, as the real resolver returns. */
const hostedCapabilities = vi.hoisted(() => new Map<string, unknown>());
function hostedCapabilityFor(kind: HostedCapabilityKind): HostedRpcCapability {
  let capability = hostedCapabilities.get(kind) as HostedRpcCapability | undefined;
  if (!capability) {
    capability = Object.freeze({
      hosted: true,
      allowed: false,
      reason: kind === "role" ? ROLE_REASON : STALE_REASON,
      kind,
    });
    hostedCapabilities.set(kind, capability);
  }
  return capability;
}

vi.mock("../hostedHub/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hostedHub/capabilities")>();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useHostedRpcCapability: (
      method: string,
      environmentId?: Parameters<typeof actual.useHostedRpcCapability>[1],
    ) => {
      const phase = useSyncExternalStore(hostedPhase.subscribe, hostedPhase.read);
      const capability = actual.useHostedRpcCapability(method, environmentId);
      return phase ? hostedCapabilityFor(phase.kind) : capability;
    },
    readHostedRpcCapability: (...args: Parameters<typeof actual.readHostedRpcCapability>) => {
      const phase = hostedPhase.read();
      return phase ? hostedCapabilityFor(phase.kind) : actual.readHostedRpcCapability(...args);
    },
  };
});

vi.mock("../hostedHub/switchTarget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hostedHub/switchTarget")>();
  const { useMemo, useSyncExternalStore } = await import("react");
  return {
    ...actual,
    hostedSwitchTargetLabel: (...args: Parameters<typeof actual.hostedSwitchTargetLabel>) =>
      hostedPhase.read()?.label ?? actual.hostedSwitchTargetLabel(...args),
    useHostedSwitchTarget: (environmentId?: Parameters<typeof actual.useHostedSwitchTarget>[0]) => {
      const phase = useSyncExternalStore(hostedPhase.subscribe, hostedPhase.read);
      const target = actual.useHostedSwitchTarget(environmentId);
      return useMemo(
        () =>
          phase ? { label: phase.label, kind: phase.kind, queued: phase.queued === true } : target,
        [phase, target],
      );
    },
  };
});

const NODE_LABEL = "Studio Mac";
const OTHER_THREAD_ID = ThreadId.make("thread-hosted-sync-other");

interface DispatchedCommand {
  readonly _tag: string;
  readonly type?: string;
  readonly threadId?: string;
  readonly message?: { readonly messageId?: string };
  readonly bootstrap?: { readonly createThread?: unknown };
}

function turnStartsFor(threadId: ThreadId): DispatchedCommand[] {
  return (wsRequests as ReadonlyArray<DispatchedCommand>).filter(
    (request) =>
      request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      request.type === "thread.turn.start" &&
      request.threadId === threadId,
  );
}

function queuedEntries(): ReadonlyArray<QueuedMessage> {
  return useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY] ?? [];
}

const acceptDispatches = {
  resolveRpc: (body: { readonly _tag: string }) =>
    body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
      ? { sequence: fixture.snapshot.snapshotSequence + 1 }
      : undefined,
};

async function setHostedPhase(next: Parameters<typeof hostedPhase.set>[0]) {
  await act(async () => {
    hostedPhase.set(next);
  });
  await waitForLayout();
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

function toastText(): string {
  return document.querySelector('[data-slot="toast-viewport"]')?.textContent ?? "";
}

function userInputResponses(): DispatchedCommand[] {
  return (wsRequests as ReadonlyArray<DispatchedCommand>).filter(
    (request) =>
      request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      request.type === "thread.user-input.respond",
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Types into the thread's composer and presses Send; returns how long it took to be queued. */
async function sendAndTimeQueueing(prompt: string): Promise<number> {
  useComposerDraftStore.getState().setPrompt(THREAD_REF, prompt);
  await waitForLayout();
  const button = await waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find the send button.",
  );
  expect(button.disabled).toBe(false);
  let queuedAt: number | null = null;
  const unsubscribe = useMessageQueueStore.subscribe((state) => {
    if (queuedAt === null && (state.queuesByThreadKey[THREAD_KEY]?.length ?? 0) > 0) {
      queuedAt = performance.now();
    }
  });
  const clickedAt = performance.now();
  try {
    button.click();
    await vi.waitFor(() => expect(queuedAt).not.toBeNull(), { timeout: 8_000, interval: 4 });
  } finally {
    unsubscribe();
  }
  return queuedAt! - clickedAt;
}

describe("ChatView while its node's connection is being established (full app)", () => {
  setupChatViewBrowserSuite();

  it("stays quiet, queues a send at once, and sends it once the node is ready", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-hosted-sync-existing" as MessageId,
        targetText: "Existing conversation",
      }),
      ...acceptDispatches,
    });
    try {
      await waitForComposerEditor();
      await setHostedPhase({ kind: "establishing", label: NODE_LABEL });

      await vi.waitFor(() => {
        expect(bodyText()).toContain(`Syncing with ${NODE_LABEL}…`);
        expect(bodyText()).not.toContain("Read-only hosted session");
        expect(document.querySelector('button[aria-label="Sending"]')).toBeNull();
      });
      const chatRoot = () => document.querySelector("[data-mutation-ready]");
      expect(chatRoot()?.getAttribute("data-mutation-ready")).toBe("false");
      expect(chatRoot()?.getAttribute("data-thread-detail-state")).toBe("live");

      const elapsedMs = await sendAndTimeQueueing("Sent while the node connects");
      expect(elapsedMs).toBeLessThan(100);
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-queued-messages-wait="connecting"]')?.textContent,
        ).toBe(`Sends when ${NODE_LABEL} is ready`);
      });
      const queuedId = queuedEntries()[0]?.id;
      expect(queuedId).toBeDefined();

      // Nothing leaves the tab while the node is not ready.
      await sleep(600);
      expect(turnStartsFor(THREAD_ID)).toEqual([]);
      expect(queuedEntries()).toHaveLength(1);

      await setHostedPhase(null);
      await vi.waitFor(
        () => {
          const starts = turnStartsFor(THREAD_ID);
          expect(starts).toHaveLength(1);
          expect(starts[0]?.message?.messageId).toBe(queuedId);
          expect(queuedEntries()).toHaveLength(0);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(bodyText()).not.toContain(`Syncing with ${NODE_LABEL}…`);
      expect(chatRoot()?.getAttribute("data-mutation-ready")).toBe("true");
    } finally {
      await setHostedPhase(null);
      await mounted.cleanup();
    }
  });

  it("shows the waiting send button caption while the node connects", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-hosted-sync-caption" as MessageId,
        targetText: "Send button caption",
      }),
    });
    try {
      await waitForComposerEditor();
      await setHostedPhase({ kind: "establishing", label: NODE_LABEL });
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Not sent yet");
      await waitForLayout();
      await vi.waitFor(() => {
        const button = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Send message"]',
        );
        expect(button?.disabled).toBe(false);
        expect(button?.title).toBe(`Sends when ${NODE_LABEL} is ready`);
      });
    } finally {
      await setHostedPhase(null);
      await mounted.cleanup();
    }
  });

  it("says when the node waits for a free connection", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-hosted-sync-slot" as MessageId,
        targetText: "Waiting for a slot",
      }),
    });
    try {
      await waitForComposerEditor();
      await setHostedPhase({ kind: "establishing", label: NODE_LABEL, queued: true });
      await vi.waitFor(() => {
        expect(bodyText()).toContain(`Waiting for a free connection to ${NODE_LABEL}…`);
        expect(bodyText()).not.toContain(`Syncing with ${NODE_LABEL}…`);
      });
    } finally {
      await setHostedPhase(null);
      await mounted.cleanup();
    }
  });

  it("keeps refusing sends on a stale connection or for the role, and says why a queued send cannot go", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-hosted-sync-refused" as MessageId,
        targetText: "Refused sends",
      }),
      ...acceptDispatches,
    });
    try {
      const editor = await waitForComposerEditor();
      for (const kind of ["stale", "role"] as const) {
        await setHostedPhase({ kind, label: NODE_LABEL });
        await vi.waitFor(() => {
          expect(bodyText()).toContain("Read-only hosted session");
          expect(document.querySelector('button[aria-label="Sending"]')).not.toBeNull();
        });
        useComposerDraftStore.getState().setPrompt(THREAD_REF, `Refused while ${kind}`);
        await waitForLayout();
        editor.focus();
        editor.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        await sleep(200);
        expect(queuedEntries()).toHaveLength(0);
      }

      // Queued while connecting, then the node's role turns out not to allow it.
      await setHostedPhase({ kind: "establishing", label: NODE_LABEL });
      await sendAndTimeQueueing("Queued before the role was known");
      await setHostedPhase({ kind: "role", label: NODE_LABEL });
      await vi.waitFor(() =>
        expect(bodyText()).toContain(`Can't send — your role on ${NODE_LABEL} doesn't allow it`),
      );
      expect(turnStartsFor(THREAD_ID)).toEqual([]);
    } finally {
      await setHostedPhase(null);
      useMessageQueueStore.getState().clear(THREAD_KEY);
      await mounted.cleanup();
    }
  });

  it("keeps approvals unavailable until the node is connected", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingApproval(),
    });
    try {
      const approve = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent?.trim() === "Approve once",
          ) ?? null,
        "Unable to find the approve button.",
      );
      expect(approve.disabled).toBe(false);

      await setHostedPhase({ kind: "establishing", label: NODE_LABEL });
      await vi.waitFor(() => {
        expect(approve.disabled).toBe(true);
        expect(approve.title).toBe(`Available when ${NODE_LABEL} is connected`);
      });

      await setHostedPhase(null);
      await vi.waitFor(() => expect(approve.disabled).toBe(false));
    } finally {
      await setHostedPhase(null);
      await mounted.cleanup();
    }
  });

  it("moves between questions locally but holds the answer until the node is connected", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
      ...acceptDispatches,
    });
    try {
      await waitForButtonContainingText("Tight");
      await setHostedPhase({ kind: "establishing", label: NODE_LABEL });

      // Choosing an option on a question that is not the last moves on.
      (await waitForButtonContainingText("Tight")).click();
      await waitForButtonContainingText("Conservative");

      // So does the submit button, back on the first question.
      (
        await waitForElement(
          () =>
            Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
              (button) =>
                button.textContent?.trim() === "Previous" ||
                button.getAttribute("aria-label") === "Previous question",
            ) ?? null,
          "Unable to find the previous question button.",
        )
      ).click();
      const next = await waitForButtonContainingText("Next");
      expect(next.disabled).toBe(false);
      next.click();
      await waitForButtonContainingText("Conservative");

      // The last question's option answers at once, so it is refused.
      (await waitForButtonContainingText("Conservative")).click();
      await vi.waitFor(() =>
        expect(toastText()).toContain(`Available when ${NODE_LABEL} is connected`),
      );
      await sleep(400);
      expect(userInputResponses()).toEqual([]);
      const submit = await waitForButtonContainingText("Submit");
      expect(submit.disabled).toBe(true);
      expect(submit.title).toBe(`Available when ${NODE_LABEL} is connected`);

      // Connected: the kept answers go out.
      await setHostedPhase(null);
      await vi.waitFor(() => expect(submit.disabled).toBe(false));
      submit.click();
      await vi.waitFor(
        () =>
          expect(userInputResponses()).toEqual([
            expect.objectContaining({
              requestId: "req-browser-user-input",
              answers: { scope: "Tight", risk: "Conservative" },
            }),
          ]),
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await setHostedPhase(null);
      await mounted.cleanup();
    }
  });

  it("queues a draft's first send and creates its thread once the node is ready", async () => {
    setDraftThreadWithoutWorktree();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      ...acceptDispatches,
    });
    try {
      await waitForComposerEditor();
      await setHostedPhase({ kind: "establishing", label: NODE_LABEL });
      const elapsedMs = await sendAndTimeQueueing("First message while the node connects");
      expect(elapsedMs).toBeLessThan(100);
      await sleep(400);
      expect(turnStartsFor(THREAD_ID)).toEqual([]);

      await setHostedPhase(null);
      await vi.waitFor(
        () => {
          const starts = turnStartsFor(THREAD_ID);
          expect(starts).toHaveLength(1);
          expect(starts[0]?.bootstrap?.createThread).toBeDefined();
        },
        { timeout: 8_000, interval: 16 },
      );
      await sleep(400);
      expect(turnStartsFor(THREAD_ID)).toHaveLength(1);
    } finally {
      await setHostedPhase(null);
      await mounted.cleanup();
    }
  });

  it("sends a draft's queued first send only from the open draft, exactly once", async () => {
    setDraftThreadWithoutWorktree();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(createDraftOnlySnapshot(), OTHER_THREAD_ID),
      ...acceptDispatches,
    });
    try {
      await waitForComposerEditor();
      await setHostedPhase({ kind: "establishing", label: NODE_LABEL });
      await sendAndTimeQueueing("Queued, then the draft is left");

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: OTHER_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(OTHER_THREAD_ID),
        "The other thread should open.",
      );
      await waitForComposerEditor();

      // Ready, but the draft is not open: nothing is sent and no thread is created.
      await setHostedPhase(null);
      await sleep(1_000);
      expect(turnStartsFor(THREAD_ID)).toEqual([]);
      expect(queuedEntries()).toHaveLength(1);

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THREAD_ID),
        "The draft should open again.",
      );
      await vi.waitFor(() => expect(turnStartsFor(THREAD_ID)).toHaveLength(1), {
        timeout: 8_000,
        interval: 16,
      });
      await sleep(600);
      expect(turnStartsFor(THREAD_ID)).toHaveLength(1);
      expect(turnStartsFor(THREAD_ID)[0]?.bootstrap?.createThread).toBeDefined();
    } finally {
      await setHostedPhase(null);
      await mounted.cleanup();
    }
  });

  it("shows the connection's own reason once a queued send waits past the sync deadline", async () => {
    // The queue's deadline is the hosted session's synchronization deadline.
    expect(CONNECTING_WAIT_DEADLINE_MS).toBe(HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS);
    const message = {
      id: "queued-hosted-sync-deadline",
      createdAt: "2026-03-04T12:00:00.000Z",
      composer: { trimmedPrompt: "First message", images: [], sendableTerminalContexts: [] },
    } as unknown as QueuedMessage;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const connecting = await render(
        <ComposerQueuedMessages
          messages={[message]}
          wait={{
            kind: "connecting",
            copy: `Sends when ${NODE_LABEL} is ready`,
            failure: STALE_REASON,
          }}
          onRemove={() => undefined}
          onEdit={() => undefined}
          getEditUnavailableReason={() => null}
          onMove={() => undefined}
          showSteerAction={false}
          steeringIds={[]}
          getSteerUnavailableReason={() => null}
          onSteer={() => undefined}
        />,
      );
      expect(bodyText()).toContain(`Sends when ${NODE_LABEL} is ready`);
      await act(async () => {
        vi.advanceTimersByTime(CONNECTING_WAIT_DEADLINE_MS - 1_000);
      });
      expect(bodyText()).not.toContain(STALE_REASON);
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(bodyText()).toContain(STALE_REASON);
      await connecting.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("words an upload waiting on its node's connection as syncing", async () => {
    vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
    const attachmentId = "attachment-hosted-sync";
    try {
      hostedPhase.set({ kind: "establishing", label: NODE_LABEL });
      composerFileUploadEngine.enqueue({
        attachmentId,
        threadId: THREAD_ID,
        environmentId: LOCAL_ENVIRONMENT_ID,
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
        readBytes: () => new Uint8Array(4),
      });
      await vi.waitFor(() =>
        expect(composerFileUploadEngine.get(attachmentId)?.status).toMatchObject({
          kind: "failed",
          label: "Syncing",
          message: "Waiting for this node to connect.",
        }),
      );

      // The hosted state changes: the wait follows the connection and never readies the upload.
      hostedPhase.set(null);
      hostedHubStore.setState({ ...hostedHubStore.getState() }, true);
      await vi.waitFor(() => {
        const status = composerFileUploadEngine.get(attachmentId)?.status;
        expect(status?.kind).toBe("failed");
        expect(status?.kind === "failed" ? status.label : null).not.toBe("Syncing");
      });
    } finally {
      composerFileUploadEngine.release(attachmentId);
      hostedPhase.set(null);
      vi.unstubAllEnvs();
    }
  });
});
