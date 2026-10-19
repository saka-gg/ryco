import {
  CheckpointRef,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  THREAD_FORKED_ACTIVITY_KIND,
  ThreadForkError,
  ThreadId,
  TurnId,
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationReadModel,
  type ThreadForkResult,
} from "@ryco/contracts";
import { RpcRequestRefusedError } from "@ryco/client-runtime/rpc";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  forgetThreadForkAttempt,
  selectThreadAvailabilityByRef,
  THREAD_FORK_COPY,
  THREAD_FORK_SHELL_TIMEOUT_MS,
} from "@ryco/client-runtime/state/threads";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { setGitStatusForCwdForTests, setGitStatusForTests } from "../../test/gitStatusStateMock";
import { WsRpcFailure, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import { __setEnvironmentApiOverrideForTests, readEnvironmentApi } from "../environmentApi";
import { useStore } from "../store";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  PHONE_VIEWPORT,
  PROJECT_ID,
  THREAD_ID,
  THREAD_TITLE,
  clickEnabledButton,
  createSnapshotForTargetUser,
  fixture,
  isoAt,
  mountChatView,
  rpcHarness,
  setupChatViewBrowserSuite,
  waitForElement,
  waitForServerConfigToApply,
  waitForURL,
  wsRequests,
} from "./ChatView.browser.helpers";
import { useForkThreadDialogStore } from "./chat/forkThreadDialogStore";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/**
 * What the hosted capability check answers for `threads.fork` while a test overrides it (the
 * hosted session went stale, the relay is reconnecting); every other method reads the real one.
 */
const hostedForkCapability = vi.hoisted(() => {
  type Override = { readonly hosted: boolean; readonly allowed: boolean; readonly reason: string };
  let override: Override | null = null;
  const listeners = new Set<() => void>();
  return {
    read: (): Override | null => override,
    set: (next: Override | null) => {
      override = next;
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
vi.mock("../hostedHub/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hostedHub/capabilities")>();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useHostedRpcCapability: (method: string, environmentId: EnvironmentId | null = null) => {
      const override = useSyncExternalStore(
        hostedForkCapability.subscribe,
        hostedForkCapability.read,
      );
      const capability = actual.useHostedRpcCapability(method, environmentId);
      return override && method === "threads.fork" ? override : capability;
    },
  };
});

const TURN_1 = TurnId.make("turn-fork-source-1");
const TURN_2 = TurnId.make("turn-fork-source-2");
const USER_1 = MessageId.make("msg-fork-user-1");
const REPLY_1 = MessageId.make("msg-fork-reply-1");
const USER_2 = MessageId.make("msg-fork-user-2");
const REPLY_2 = MessageId.make("msg-fork-reply-2");
const FORK_THREAD_ID = ThreadId.make("fork-0f1e2d3c4b5a69788796a5b4c3d2e1f0");
const FORK_KEY_RE = /^fork-[0-9a-f]{32}$/;

type ReadModelThread = OrchestrationReadModel["threads"][number];

function message(input: {
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: TurnId | null;
  readonly offsetSeconds: number;
}): ReadModelThread["messages"][number] {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    turnId: input.turnId,
    streaming: false,
    createdAt: isoAt(input.offsetSeconds),
    updatedAt: isoAt(input.offsetSeconds + 1),
  };
}

/** A Git project thread with two completed turns; turn 1 has a ready checkpoint. */
function createForkSourceSnapshot(
  source: { readonly worktreePath?: string | null } = {},
): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: MessageId.make("msg-fork-unused"),
    targetText: "unused",
  });
  const thread = snapshot.threads[0]!;
  return {
    ...snapshot,
    threads: [
      {
        ...thread,
        worktreePath: source.worktreePath ?? thread.worktreePath,
        messages: [
          message({
            id: USER_1,
            role: "user",
            text: "Plan the refactor",
            turnId: null,
            offsetSeconds: 0,
          }),
          message({
            id: REPLY_1,
            role: "assistant",
            text: "Here is the plan: split the auth module first.",
            turnId: TURN_1,
            offsetSeconds: 5,
          }),
          message({ id: USER_2, role: "user", text: "Now do it", turnId: null, offsetSeconds: 10 }),
          message({
            id: REPLY_2,
            role: "assistant",
            text: "Done, the module is split.",
            turnId: TURN_2,
            offsetSeconds: 15,
          }),
        ],
        latestTurn: {
          turnId: TURN_2,
          state: "completed",
          requestedAt: isoAt(10),
          startedAt: isoAt(10),
          completedAt: isoAt(16),
          assistantMessageId: REPLY_2,
        },
        checkpoints: [
          {
            turnId: TURN_1,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/ryco/checkpoints/thread/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: REPLY_1,
            completedAt: isoAt(6),
          },
        ],
      },
    ],
  };
}

/** The thread the node publishes for a current-checkout fork of reply 1. */
function createForkThread(source: ReadModelThread): ReadModelThread {
  const inherited = (id: MessageId) => MessageId.make(`${FORK_THREAD_ID}:inherited:${id}`);
  return {
    ...source,
    id: FORK_THREAD_ID,
    title: `${THREAD_TITLE} (fork)`,
    latestTurn: null,
    session: null,
    checkpoints: [],
    lineage: {
      parentThreadId: THREAD_ID,
      rootThreadId: THREAD_ID,
      relationship: "forked",
      sourceMessageId: REPLY_1,
      sourceTurnId: TURN_1,
    },
    messages: source.messages
      .slice(0, 2)
      .map((entry) => Object.assign({}, entry, { id: inherited(entry.id) })),
    activities: [
      {
        id: EventId.make(`${FORK_THREAD_ID}:forked`),
        tone: "info",
        kind: THREAD_FORKED_ACTIVITY_KIND,
        summary: `Forked from ${THREAD_TITLE}`,
        turnId: null,
        // Appended when the fork was published, after everything it inherited.
        createdAt: isoAt(30),
        payload: {
          schemaVersion: 1,
          sourceThreadId: THREAD_ID,
          sourceMessageId: REPLY_1,
          sourceTurnId: TURN_1,
          sourceTitle: THREAD_TITLE,
          inheritedMessageCount: 2,
          providerContext: "native",
          checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
          notices: [],
        },
      },
    ],
  };
}

/**
 * The node publishes the fork before it answers: its shell reaches the store.
 * A repeated key answers the stored result without publishing again.
 */
function publishForkThread(): ThreadForkResult {
  const result: ThreadForkResult = {
    threadId: FORK_THREAD_ID,
    projectId: PROJECT_ID,
    replayed: false,
    providerContext: "native",
    checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
    notices: [],
  };
  if (fixture.snapshot.threads.some((thread) => thread.id === FORK_THREAD_ID)) {
    return { ...result, replayed: true };
  }
  const source = fixture.snapshot.threads.find((thread) => thread.id === THREAD_ID)!;
  const fork = createForkThread(source);
  fixture.snapshot = {
    ...fixture.snapshot,
    snapshotSequence: fixture.snapshot.snapshotSequence + 1,
    threads: [...fixture.snapshot.threads, fork],
  };
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
    kind: "thread-upserted",
    sequence: fixture.snapshot.snapshotSequence,
    thread: {
      id: fork.id,
      projectId: fork.projectId,
      title: fork.title,
      modelSelection: fork.modelSelection,
      runtimeMode: fork.runtimeMode,
      interactionMode: fork.interactionMode,
      branch: fork.branch,
      worktreePath: fork.worktreePath,
      latestTurn: null,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      // As the server sends it: inherited prompts are not the fork's own recency.
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      lineage: fork.lineage,
    },
  });
  return result;
}

const REPO_STATUS = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
} as const;

async function mountForkSource(input: {
  readonly resolveFork: (body: NormalizedWsRpcRequestBody, attempt: number) => unknown;
  readonly viewport?: typeof DEFAULT_VIEWPORT;
  readonly sourceWorktreePath?: string | null;
}) {
  setGitStatusForTests(REPO_STATUS);
  let attempts = 0;
  const mounted = await mountChatView({
    viewport: input.viewport ?? DEFAULT_VIEWPORT,
    snapshot: createForkSourceSnapshot({ worktreePath: input.sourceWorktreePath ?? null }),
    configureFixture: (nextFixture) => {
      nextFixture.serverConfig = {
        ...nextFixture.serverConfig,
        environment: {
          ...nextFixture.serverConfig.environment,
          capabilities: { ...nextFixture.serverConfig.environment.capabilities, threadFork: true },
        },
      };
    },
    resolveRpc: (body) => {
      if (body._tag !== WS_METHODS.threadsFork) return undefined;
      attempts += 1;
      return input.resolveFork(body, attempts);
    },
  });
  await waitForServerConfigToApply();
  return mounted;
}

function forkRequests(): NormalizedWsRpcRequestBody[] {
  return wsRequests.filter((request) => request._tag === WS_METHODS.threadsFork);
}

async function openForkDialogFrom(messageId: MessageId): Promise<void> {
  const button = await waitForElement(
    () =>
      document.querySelector<HTMLButtonElement>(`button[data-fork-from-message="${messageId}"]`),
    `Unable to find Fork from here on ${messageId}.`,
  );
  await clickEnabledButton(button, "Fork from here stayed disabled.");
  await expect.element(page.getByTestId("fork-thread-dialog")).toBeVisible();
}

async function expectTextIn(testId: string, text: string): Promise<void> {
  await vi.waitFor(() =>
    expect(document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "").toContain(text),
  );
}

function dialogOpen(): boolean {
  return document.querySelector('[data-testid="fork-thread-dialog"]') !== null;
}

function forkError(
  reason: ThreadForkError["reason"],
  retryable: boolean,
  attempt: ThreadForkError["attempt"] = "none",
): WsRpcFailure {
  return new WsRpcFailure(
    new ThreadForkError({ message: `node: ${reason}`, reason, retryable, attempt }),
  );
}

function isDisabled(testId: string): boolean {
  return page.getByTestId(testId).element().hasAttribute("data-disabled");
}

/**
 * Wraps the node's fork API: each call runs `answer` with the call's number and the node's
 * own fork, so a test can lose an answer (the node created the fork) or refuse a call before
 * it is sent.
 */
function interceptForkApi(
  answer: (
    call: number,
    nodeFork: (input: Parameters<NonNullable<ForkApi["fork"]>>[0]) => Promise<ThreadForkResult>,
    input: Parameters<NonNullable<ForkApi["fork"]>>[0],
  ) => Promise<ThreadForkResult>,
): void {
  const nodeApi = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
  const nodeFork = nodeApi.threads!.fork!;
  let calls = 0;
  __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
    ...nodeApi,
    threads: {
      ...nodeApi.threads!,
      fork: (input) => {
        calls += 1;
        return answer(calls, nodeFork, input);
      },
    },
  });
}

type ForkApi = NonNullable<NonNullable<ReturnType<typeof readEnvironmentApi>>["threads"]>;

const DROPPED_ANSWER = "The connection dropped before the answer arrived.";

describe("Fork from here (full app)", () => {
  setupChatViewBrowserSuite();
  beforeEach(() => {
    // The dialog's store is app-wide; a test that ends with it open must not leak it.
    useForkThreadDialogStore.setState({ open: false, token: 0, request: null, origin: null });
    hostedForkCapability.set(null);
    // So is the attempt registry: an unsettled attempt would reopen in the next test.
    for (const sourceMessageId of [REPLY_1, REPLY_2]) {
      forgetThreadForkAttempt({
        environmentId: LOCAL_ENVIRONMENT_ID,
        sourceThreadId: THREAD_ID,
        sourceMessageId,
      });
    }
  });

  it("forks into the current checkout, opens the fork, and links back to the reply", async () => {
    const mounted = await mountForkSource({ resolveFork: () => publishForkThread() });
    try {
      // Both replies end completed turns; the commentary-free user rows offer nothing.
      await vi.waitFor(() =>
        expect(document.querySelectorAll("button[data-fork-from-message]")).toHaveLength(2),
      );
      await openForkDialogFrom(REPLY_1);
      await expectTextIn("fork-thread-boundary", "Here is the plan: split the auth module first.");
      await expect
        .element(page.getByTestId("fork-thread-destination-current-checkout"))
        .toHaveAttribute("aria-checked", "true");
      // The fork opens with its inherited history on the way: it must never
      // present as a new thread (hero and work location) in the meantime.
      let heroShown = false;
      const heroWatch = new MutationObserver(() => {
        if (document.querySelector('[data-testid="new-thread-hero"]')) heroShown = true;
      });
      heroWatch.observe(document.body, { childList: true, subtree: true });
      await page.getByTestId("fork-thread-submit").click();

      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
      const [request] = forkRequests();
      expect(request).toMatchObject({
        sourceThreadId: THREAD_ID,
        sourceMessageId: REPLY_1,
        destination: { kind: "current-checkout" },
      });
      expect(String(request?.forkKey)).toMatch(FORK_KEY_RE);

      // A new history entry for the fork; Back would return to the source.
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${LOCAL_ENVIRONMENT_ID}/${FORK_THREAD_ID}`,
        "The fork never opened.",
      );
      await vi.waitFor(() => expect(dialogOpen()).toBe(false));

      const divider = page.getByRole("group", { name: `Forked from “${THREAD_TITLE}”` });
      await expect.element(divider).toBeVisible();
      heroWatch.disconnect();
      expect(heroShown).toBe(false);
      expect(divider.element().textContent).toContain(
        "Continues an independent copy of the provider's session",
      );
      await page.getByRole("button", { name: /at the reply this fork starts from/ }).click();
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`,
        "The divider did not link back to the source thread.",
      );
      expect(mounted.router.state.location.search).toMatchObject({ messageId: REPLY_1 });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to a branch when the checkpoint cannot start a worktree, and retries with the same key", async () => {
    const mounted = await mountForkSource({
      resolveFork: (_body, attempt) =>
        attempt === 1
          ? forkError("checkpoint-unavailable", false)
          : forkError("preparation-failed", true),
    });
    try {
      await openForkDialogFrom(REPLY_1);
      await page.getByTestId("fork-thread-destination-new-worktree").click();
      await expect
        .element(page.getByTestId("fork-thread-start-checkpoint"))
        .toHaveAttribute("aria-checked", "true");
      await page.getByTestId("fork-thread-submit").click();

      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
      expect(forkRequests()[0]?.destination).toEqual({
        kind: "new-worktree",
        start: { kind: "checkpoint" },
      });
      // The node refused the checkpoint: the dialog switches to the source's branch.
      await expect
        .element(page.getByTestId("fork-thread-notice"))
        .toHaveAttribute("data-reason", "checkpoint-unavailable");
      await expect
        .element(page.getByTestId("fork-thread-start-base-ref"))
        .toHaveAttribute("aria-checked", "true");
      await expect.element(page.getByTestId("fork-thread-base-ref")).toHaveValue("main");
      expect(
        page.getByTestId("fork-thread-start-checkpoint").element().hasAttribute("data-disabled"),
      ).toBe(true);
      await page.getByTestId("fork-thread-submit").click();

      await vi.waitFor(() => expect(forkRequests()).toHaveLength(2));
      const branchRequest = forkRequests()[1]!;
      expect(branchRequest.destination).toEqual({
        kind: "new-worktree",
        start: { kind: "base-ref", baseRef: "main" },
      });
      // The node recorded nothing under the key ("none"): the changed request reuses it.
      expect(branchRequest.forkKey).toBe(forkRequests()[0]?.forkKey);

      // Preparing the worktree failed but can be retried: the same request, same key.
      await expect
        .element(page.getByTestId("fork-thread-notice"))
        .toHaveAttribute("data-reason", "preparation-failed");
      await page.getByTestId("fork-thread-retry").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(3));
      expect(forkRequests()[2]).toEqual(branchRequest);

      await page.getByTestId("fork-thread-cancel").click();
      await vi.waitFor(() => expect(dialogOpen()).toBe(false));
      expect(forkRequests()).toHaveLength(3);
      expect(mounted.router.state.location.pathname).toBe(`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("locks an attempt whose outcome is unknown and retries it with the same key", async () => {
    const mounted = await mountForkSource({ resolveFork: () => publishForkThread() });
    try {
      // The node creates the fork, but its answer is lost on the way back.
      interceptForkApi(async (call, nodeFork, input) => {
        const result = await nodeFork(input);
        if (call > 1) return result;
        throw new Error(DROPPED_ANSWER);
      });
      await openForkDialogFrom(REPLY_2);
      await page.getByTestId("fork-thread-submit").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));

      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.titles.uncertain);
      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.uncertain);
      // Only the same request may follow: no Fork button, the destinations are locked.
      expect(document.querySelector('[data-testid="fork-thread-submit"]')).toBeNull();
      expect(
        page
          .getByTestId("fork-thread-destination-new-worktree")
          .element()
          .hasAttribute("data-disabled"),
      ).toBe(true);
      await page.getByTestId("fork-thread-retry").click();

      await vi.waitFor(() => expect(forkRequests()).toHaveLength(2));
      expect(forkRequests()[1]).toEqual(forkRequests()[0]);
      expect(forkRequests()[1]?.sourceMessageId).toBe(REPLY_2);
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${LOCAL_ENVIRONMENT_ID}/${FORK_THREAD_ID}`,
        "The fork never opened after the retry.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the dialog up while the request is in flight", async () => {
    let answer!: (result: ThreadForkResult) => void;
    const mounted = await mountForkSource({
      resolveFork: () =>
        new Promise<ThreadForkResult>((resolve) => {
          answer = resolve;
        }),
    });
    try {
      await openForkDialogFrom(REPLY_1);
      await page.getByTestId("fork-thread-submit").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
      await expectTextIn("fork-thread-status", THREAD_FORK_COPY.busy.creating);
      await expect.element(page.getByTestId("fork-thread-cancel")).toBeDisabled();
      expect(isDisabled("fork-thread-destination-new-worktree")).toBe(true);
      // Escape cannot dismiss it: the answer decides what happens next.
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(dialogOpen()).toBe(true);

      answer(publishForkThread());
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${LOCAL_ENVIRONMENT_ID}/${FORK_THREAD_ID}`,
        "The fork never opened.",
      );
      expect(forkRequests()).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("locks an attempt the node is still preparing, and checks on it with the same key", async () => {
    const mounted = await mountForkSource({
      resolveFork: (_body, attempt) =>
        attempt === 1 ? forkError("preparation-failed", true, "running") : publishForkThread(),
    });
    try {
      await openForkDialogFrom(REPLY_1);
      await page.getByTestId("fork-thread-submit").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));

      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.titles.running);
      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.running);
      expect(document.querySelector('[data-testid="fork-thread-notice"]')?.textContent).not.toMatch(
        /wasn't created|left behind/,
      );
      // No other request may go out under any key until the node answers for this one.
      expect(document.querySelector('[data-testid="fork-thread-submit"]')).toBeNull();
      expect(isDisabled("fork-thread-destination-new-worktree")).toBe(true);
      const checkAgain = page.getByTestId("fork-thread-retry");
      await expect.element(checkAgain).toHaveTextContent(THREAD_FORK_COPY.checkAgain);
      await checkAgain.click();

      await vi.waitFor(() => expect(forkRequests()).toHaveLength(2));
      expect(forkRequests()[1]).toEqual(forkRequests()[0]);
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${LOCAL_ENVIRONMENT_ID}/${FORK_THREAD_ID}`,
        "The fork never opened after checking again.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts a changed request under a new key once the node stopped the attempt", async () => {
    const mounted = await mountForkSource({
      resolveFork: (_body, attempt) =>
        attempt === 1 ? forkError("preparation-failed", true, "stopped") : publishForkThread(),
    });
    try {
      await openForkDialogFrom(REPLY_1);
      await page.getByTestId("fork-thread-submit").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
      await expect
        .element(page.getByTestId("fork-thread-notice"))
        .toHaveAttribute("data-reason", "preparation-failed");
      // The same request is a retry under the same key.
      await expect.element(page.getByTestId("fork-thread-retry")).toBeVisible();

      // A different request: the stopped key would answer it with a conflict.
      await page.getByTestId("fork-thread-destination-new-worktree").click();
      const submit = page.getByTestId("fork-thread-submit");
      await expect.element(submit).toHaveTextContent(THREAD_FORK_COPY.submit);
      await submit.click();

      await vi.waitFor(() => expect(forkRequests()).toHaveLength(2));
      const [first, second] = forkRequests();
      expect(second?.destination).toEqual({ kind: "new-worktree", start: { kind: "checkpoint" } });
      expect(String(second?.forkKey)).toMatch(FORK_KEY_RE);
      expect(second?.forkKey).not.toBe(first?.forkKey);
    } finally {
      await mounted.cleanup();
    }
  });

  it("reopens an attempt whose outcome is unknown with the same key and request", async () => {
    const mounted = await mountForkSource({ resolveFork: () => publishForkThread() });
    try {
      interceptForkApi(async (call, nodeFork, input) => {
        const result = await nodeFork(input);
        if (call > 1) return result;
        throw new Error(DROPPED_ANSWER);
      });
      await openForkDialogFrom(REPLY_2);
      await page.getByTestId("fork-thread-submit").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.titles.uncertain);

      // Closing the dialog does not forget the attempt: the fork may exist.
      await page.getByTestId("fork-thread-cancel").click();
      await vi.waitFor(() => expect(dialogOpen()).toBe(false));
      await openForkDialogFrom(REPLY_2);
      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.titles.uncertain);
      expect(document.querySelector('[data-testid="fork-thread-submit"]')).toBeNull();
      expect(isDisabled("fork-thread-destination-new-worktree")).toBe(true);
      await page.getByTestId("fork-thread-retry").click();

      await vi.waitFor(() => expect(forkRequests()).toHaveLength(2));
      expect(forkRequests()[1]).toEqual(forkRequests()[0]);
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${LOCAL_ENVIRONMENT_ID}/${FORK_THREAD_ID}`,
        "The fork never opened after the reopened retry.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an unknown outcome when a retry is refused before it was sent", async () => {
    const mounted = await mountForkSource({ resolveFork: () => publishForkThread() });
    try {
      interceptForkApi(async (call, nodeFork, input) => {
        if (call === 2) throw new RpcRequestRefusedError("awaiting-acknowledgement");
        const result = await nodeFork(input);
        if (call > 1) return result;
        throw new Error(DROPPED_ANSWER);
      });
      await openForkDialogFrom(REPLY_2);
      await page.getByTestId("fork-thread-submit").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.titles.uncertain);

      await page.getByTestId("fork-thread-retry").click();
      // Refused before sending: still "may have been created", still locked to the same request.
      await expectTextIn(
        "fork-thread-notice",
        new RpcRequestRefusedError("awaiting-acknowledgement").message,
      );
      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.titles.uncertain);
      await expectTextIn("fork-thread-notice-detail", THREAD_FORK_COPY.uncertain);
      expect(forkRequests()).toHaveLength(1);
      expect(document.querySelector('[data-testid="fork-thread-submit"]')).toBeNull();
      expect(isDisabled("fork-thread-destination-new-worktree")).toBe(true);

      await page.getByTestId("fork-thread-retry").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(2));
      expect(forkRequests()[1]).toEqual(forkRequests()[0]);
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${LOCAL_ENVIRONMENT_ID}/${FORK_THREAD_ID}`,
        "The fork never opened after the refused retry.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a fork created while its dialog was gone instead of starting a second one", async () => {
    let answer!: (result: ThreadForkResult) => void;
    const mounted = await mountForkSource({
      resolveFork: () =>
        new Promise<ThreadForkResult>((resolve) => {
          answer = resolve;
        }),
    });
    try {
      await openForkDialogFrom(REPLY_1);
      await page.getByTestId("fork-thread-submit").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
      // The app shell unmounts the dialog while the request is in flight (a hosted session
      // revalidation hides the chat surface), then the node creates the fork.
      useForkThreadDialogStore.setState({ open: false, request: null, origin: null });
      await vi.waitFor(() => expect(dialogOpen()).toBe(false));
      answer(publishForkThread());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mounted.router.state.location.pathname).toBe(`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`);

      // "Fork from here" again on the same reply opens the fork that exists.
      await openForkDialogFrom(REPLY_1);
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${LOCAL_ENVIRONMENT_ID}/${FORK_THREAD_ID}`,
        "The reopened dialog never opened the fork created while it was gone.",
      );
      await vi.waitFor(() => expect(dialogOpen()).toBe(false));
      expect(forkRequests()).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts a new fork when the one created while its dialog was gone was deleted since", async () => {
    let answer!: (result: ThreadForkResult) => void;
    const mounted = await mountForkSource({
      resolveFork: (_body, attempt) =>
        attempt === 1
          ? new Promise<ThreadForkResult>((resolve) => {
              answer = resolve;
            })
          : publishForkThread(),
    });
    const realNow = Date.now.bind(Date);
    const forkRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, FORK_THREAD_ID);
    try {
      await openForkDialogFrom(REPLY_1);
      await page.getByTestId("fork-thread-submit").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
      useForkThreadDialogStore.setState({ open: false, request: null, origin: null });
      await vi.waitFor(() => expect(dialogOpen()).toBe(false));
      answer(publishForkThread());
      await vi.waitFor(() =>
        expect(selectThreadAvailabilityByRef(useStore.getState(), forkRef)).toBe("available"),
      );
      // The user deletes that fork; a while later they fork from the same reply again.
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: fixture.snapshot.snapshotSequence + 1,
        threads: fixture.snapshot.threads.filter((thread) => thread.id !== FORK_THREAD_ID),
      };
      rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
        kind: "thread-removed",
        sequence: fixture.snapshot.snapshotSequence,
        threadId: FORK_THREAD_ID,
      });
      await vi.waitFor(() =>
        expect(selectThreadAvailabilityByRef(useStore.getState(), forkRef)).toBe("missing"),
      );
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + THREAD_FORK_SHELL_TIMEOUT_MS);

      await openForkDialogFrom(REPLY_1);
      // A fresh form at once: no locked "Opening the fork…", no "Fork created", no navigation.
      const submit = page.getByTestId("fork-thread-submit");
      await expect.element(submit).toBeEnabled();
      expect(document.querySelector('[data-testid="fork-thread-status"]')?.textContent).toBe("");
      await expect.element(page.getByTestId("fork-thread-cancel")).toBeEnabled();
      expect(mounted.router.state.location.pathname).toBe(`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`);

      // Forking again sends a new request under a key of its own.
      await submit.click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(2));
      const [first, second] = forkRequests();
      expect(String(second?.forkKey)).toMatch(FORK_KEY_RE);
      expect(second?.forkKey).not.toBe(first?.forkKey);
    } finally {
      vi.restoreAllMocks();
      await mounted.cleanup();
    }
  });

  it("keeps a locked attempt's warning visible while forking is blocked", async () => {
    const mounted = await mountForkSource({ resolveFork: () => publishForkThread() });
    const stale = "This action is unavailable while Hub authorization or the relay is stale.";
    try {
      interceptForkApi(async (call, nodeFork, input) => {
        const result = await nodeFork(input);
        if (call > 1) return result;
        throw new Error(DROPPED_ANSWER);
      });
      await openForkDialogFrom(REPLY_2);
      await page.getByTestId("fork-thread-submit").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.titles.uncertain);

      // The same drop leaves the hosted session stale while the dialog is still open.
      hostedForkCapability.set({ hosted: true, allowed: false, reason: stale });
      await expectTextIn("fork-thread-blocked", stale);
      // The fork may exist: that stays on screen, above why nothing can be sent now.
      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.titles.uncertain);
      await expectTextIn("fork-thread-notice", THREAD_FORK_COPY.uncertain);
      await expect.element(page.getByTestId("fork-thread-retry")).toBeDisabled();

      hostedForkCapability.set(null);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="fork-thread-blocked"]')).toBeNull(),
      );
      await page.getByTestId("fork-thread-retry").click();
      await vi.waitFor(() => expect(forkRequests()).toHaveLength(2));
      expect(forkRequests()[1]).toEqual(forkRequests()[0]);
    } finally {
      hostedForkCapability.set(null);
      await mounted.cleanup();
    }
  });

  it("decides on a new worktree from the project root, not the thread's removed worktree", async () => {
    const removedWorktree = "/repo/project/.ryco/worktrees/gone";
    const mounted = await mountForkSource({
      sourceWorktreePath: removedWorktree,
      resolveFork: () => publishForkThread(),
    });
    try {
      // Git status reads a missing folder as "not a repository"; the project root still is one.
      setGitStatusForCwdForTests(removedWorktree, { ...REPO_STATUS, isRepo: false });
      await openForkDialogFrom(REPLY_1);
      await expect
        .element(page.getByTestId("fork-thread-destination-new-worktree"))
        .toBeInTheDocument();
      expect(isDisabled("fork-thread-destination-new-worktree")).toBe(false);
      await expectTextIn("fork-thread-destination-current-checkout", "This worktree");
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates nothing when the dialog is cancelled", async () => {
    const mounted = await mountForkSource({ resolveFork: () => publishForkThread() });
    try {
      await openForkDialogFrom(REPLY_1);
      await page.getByTestId("fork-thread-cancel").click();
      await vi.waitFor(() => expect(dialogOpen()).toBe(false));

      // Escape dismisses it too.
      await openForkDialogFrom(REPLY_1);
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await vi.waitFor(() => expect(dialogOpen()).toBe(false));

      expect(forkRequests()).toHaveLength(0);
      expect(mounted.router.state.location.pathname).toBe(`/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers no fork action on the frozen phone tier", async () => {
    const mounted = await mountForkSource({
      viewport: PHONE_VIEWPORT,
      resolveFork: () => publishForkThread(),
    });
    try {
      await expect.element(page.getByText("Done, the module is split.")).toBeInTheDocument();
      expect(document.querySelectorAll("button[data-fork-from-message]")).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });
});
