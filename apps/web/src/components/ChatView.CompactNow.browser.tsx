import {
  EventId,
  ProviderInstanceId,
  RuntimeSessionId,
  type EnvironmentApi,
  type MessageId,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  readEnvironmentApi,
} from "../environmentApi";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  THREAD_ID,
  configureContextHandoffProviders,
  createSnapshotForTargetUser,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const BUSY = "Wait until the current turn finishes and the session is ready.";

/** A thread on a ready, idle runtime of `provider`, whose latest context usage is `usage`. */
function threadSnapshot(input: {
  readonly provider: "claudeAgent" | "codex";
  readonly model: string;
  readonly usage: Record<string, unknown>;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-compact-now" as MessageId,
    targetText: "compact this conversation",
  });
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id !== THREAD_ID || thread.session === null
        ? thread
        : Object.assign({}, thread, {
            modelSelection: {
              instanceId: ProviderInstanceId.make(input.provider),
              model: input.model,
            },
            activities: [
              {
                id: EventId.make("activity-context-usage"),
                tone: "info" as const,
                kind: "context-window.updated",
                summary: "Context window updated",
                payload: { usedTokens: 150_000, maxTokens: 200_000, ...input.usage },
                turnId: null,
                createdAt: NOW_ISO,
              },
            ],
            session: Object.assign({}, thread.session, {
              providerName: input.provider,
              runtimeSessionId: RuntimeSessionId.make("runtime-compact-now"),
            }),
          }),
    ),
  };
}

/** A Claude thread on a ready, idle runtime whose Claude Code lists `/compact`. */
function claudeThreadSnapshot(): OrchestrationReadModel {
  return threadSnapshot({
    provider: "claudeAgent",
    model: "claude-sonnet-4-6",
    usage: { compactsAutomatically: true },
  });
}

interface Command {
  readonly type: string;
  readonly message?: { readonly text?: string };
}

/** Serves the thread window the action reads and records what it sends. */
function serveCompaction(
  snapshot: OrchestrationReadModel,
  dispatch: (command: Command) => Promise<void> = async () => undefined,
) {
  const commands: Command[] = [];
  const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
  const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID)!;
  __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
    ...api,
    orchestration: {
      ...api.orchestration,
      getThreadWindow: (async () => ({ thread })) as unknown as NonNullable<
        EnvironmentApi["orchestration"]["getThreadWindow"]
      >,
      dispatchCommand: async (command) => {
        commands.push(command as Command);
        await dispatch(command as Command);
        return { sequence: snapshot.snapshotSequence + commands.length };
      },
    },
  });
  const compactions = () =>
    commands.filter(
      (command) => command.type === "thread.turn.start" && command.message?.text === "/compact",
    );
  return { compactions };
}

async function openContextMeter() {
  await page.getByRole("button", { name: /Context window/ }).click();
  await expect.element(page.getByRole("button", { name: "Compact now" })).toBeVisible();
}

describe("ChatView Compact now (full app)", () => {
  setupChatViewBrowserSuite();

  it("stays busy after the node takes the request, until the session reports the turn", async () => {
    const snapshot = claudeThreadSnapshot();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: configureContextHandoffProviders,
    });
    const serving = serveCompaction(snapshot);
    try {
      await waitForComposerEditor();
      await openContextMeter();
      const compactNow = page.getByRole("button", { name: "Compact now" });
      await expect.element(compactNow).toBeEnabled();

      await compactNow.click();
      await vi.waitFor(() => expect(serving.compactions()).toHaveLength(1));
      // The request is settled, but this client still sees the session ready and idle: a
      // second click now would start a second `/compact` turn the node accepts.
      await expect
        .element(page.getByRole("button", { name: "Compacting…" }))
        .not.toBeInTheDocument();
      await expect.element(compactNow).toBeDisabled();
      await expect.element(page.getByText(BUSY)).toBeVisible();
      expect(serving.compactions()).toHaveLength(1);
    } finally {
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("lets the user try again once the node refuses the request", async () => {
    const snapshot = claudeThreadSnapshot();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: configureContextHandoffProviders,
    });
    const serving = serveCompaction(snapshot, async () => {
      throw new Error(
        "Claude resume review is stale. The session, model, context settings, or latest turn changed. Review and send again.",
      );
    });
    try {
      await waitForComposerEditor();
      await openContextMeter();
      await page.getByRole("button", { name: "Compact now" }).click();

      await vi.waitFor(() => expect(serving.compactions()).toHaveLength(1));
      await expect
        .element(page.getByText("The conversation changed. Try Compact now again.").first())
        .toBeVisible();
      await openContextMeterIfClosed();
      await expect.element(page.getByRole("button", { name: "Compact now" })).toBeEnabled();
    } finally {
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });
});

describe("ChatView Compact now on Codex (full app)", () => {
  setupChatViewBrowserSuite();

  it.each([
    // A node from before Codex compaction marks Codex usage this way, and sends `/compact` to
    // the model as a prompt.
    ["withholds it on a node that sends /compact to the model", {}, false],
    ["offers it on a node that runs Codex's compaction", { compactsOnRequest: true }, true],
  ] as const)("%s", async (_name, usage, offered) => {
    const snapshot = threadSnapshot({
      provider: "codex",
      model: "gpt-5",
      usage: { compactsAutomatically: true, ...usage },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: configureContextHandoffProviders,
    });
    const serving = serveCompaction(snapshot);
    try {
      await waitForComposerEditor();
      await page.getByRole("button", { name: /Context window/ }).click();
      await expect
        .element(page.getByText("Automatically compacts its context when needed."))
        .toBeVisible();
      const compactNow = page.getByRole("button", { name: "Compact now" });
      if (!offered) {
        await expect.element(compactNow).not.toBeInTheDocument();
        return;
      }
      await compactNow.click();
      await vi.waitFor(() => expect(serving.compactions()).toHaveLength(1));
    } finally {
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });
});

/** Reopens the popup only if the error's layout shift closed it: another click would close it. */
async function openContextMeterIfClosed() {
  if (document.body.textContent?.includes("Summarizes older context.")) return;
  await openContextMeter();
}
