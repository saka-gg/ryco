import {
  applyThreadForkOutcome,
  beginThreadForkAttempt,
  prepareThreadForkSubmit,
  THREAD_FORK_COPY,
  threadForkAttemptView,
  type ThreadForkAttemptState,
} from "@ryco/client-runtime/state/threads";
import { EnvironmentId, MessageId, ThreadId, type ThreadForkKey } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { FORK_BLOCKED_TITLE, forkDialogNotices, forkSourceGitCwd } from "./ForkThreadDialog.logic";
import { threadForkSupported } from "./forkThreadDialogStore";

function keys() {
  let next = 0;
  return (): ThreadForkKey => {
    next += 1;
    return `fork-${String(next).padStart(16, "0")}`;
  };
}

function begin(mintKey = keys()): ThreadForkAttemptState {
  return beginThreadForkAttempt({
    boundary: {
      environmentId: EnvironmentId.make("environment-local"),
      sourceThreadId: ThreadId.make("source"),
      sourceMessageId: MessageId.make("reply"),
    },
    selection: { destination: "current-checkout" },
    defaultBaseRef: "main",
    mintKey,
  });
}

/** The attempt after one send whose outcome is `outcome`. */
function settled(outcome: Parameters<typeof applyThreadForkOutcome>[1]): ThreadForkAttemptState {
  const mintKey = keys();
  const sent = prepareThreadForkSubmit(begin(mintKey), mintKey);
  if (!sent.ok) throw new Error("not submittable");
  return applyThreadForkOutcome(sent.state, outcome);
}

describe("forkSourceGitCwd", () => {
  it("asks the project root, as the node does, never a chat folder", () => {
    expect(forkSourceGitCwd({ project: { cwd: "/repo" }, isChat: false })).toBe("/repo");
    expect(forkSourceGitCwd({ project: { cwd: "/chats/one" }, isChat: true })).toBeNull();
    expect(forkSourceGitCwd({ project: undefined, isChat: false })).toBeNull();
  });
});

describe("forkDialogNotices", () => {
  const blocked = "This action is unavailable while Hub authorization or the relay is stale.";
  const uncertain = threadForkAttemptView(
    settled({ status: "uncertain", message: THREAD_FORK_COPY.uncertain, error: null }),
  );

  it("keeps a locked attempt's warning visible above why forking is blocked", () => {
    const shown = forkDialogNotices({ view: uncertain, blocked });
    expect(shown.map((entry) => [entry.kind, entry.notice.title])).toEqual([
      ["attempt", THREAD_FORK_COPY.titles.uncertain],
      ["blocked", FORK_BLOCKED_TITLE],
    ]);
    expect(shown[0]?.notice.message).toBe(THREAD_FORK_COPY.uncertain);
    expect(shown[1]?.notice.message).toBe(blocked);
  });

  it("lets the blocked reason replace an editable attempt's notice", () => {
    const refused = threadForkAttemptView(
      settled({ status: "refused", awaiting: true, message: "Reconnecting", error: null }),
    );
    expect(refused.locked).toBe(false);
    expect(forkDialogNotices({ view: refused, blocked }).map((entry) => entry.kind)).toEqual([
      "blocked",
    ]);
    expect(forkDialogNotices({ view: refused, blocked: null }).map((entry) => entry.kind)).toEqual([
      "attempt",
    ]);
    expect(forkDialogNotices({ view: threadForkAttemptView(begin()), blocked: null })).toEqual([]);
  });
});

describe("threadForkSupported", () => {
  const config = (threadFork: boolean | undefined) => ({
    environment: {
      environmentId: "env" as never,
      label: "Mac",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
        ...(threadFork === undefined ? {} : { threadFork }),
      },
    },
  });
  it("needs the node's capability, the session's permission and a non-phone tier", () => {
    expect(threadForkSupported(config(true), true, "desktop")).toBe(true);
    expect(threadForkSupported(config(true), true, "phone")).toBe(false);
    expect(threadForkSupported(config(true), false, "desktop")).toBe(false);
    expect(threadForkSupported(config(false), true, "desktop")).toBe(false);
    expect(threadForkSupported(config(undefined), true, "desktop")).toBe(false);
    expect(threadForkSupported(null, true, "desktop")).toBe(false);
  });
});
