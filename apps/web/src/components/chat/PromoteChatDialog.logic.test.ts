import { ProjectChatError, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  BUSY_CHAT_REASON,
  chatActivitySignature,
  chatThreadLiveWork,
  describeChatBusy,
  describeDestinationStatus,
  describeFolderContents,
  describeGitPlan,
  describeMovePlan,
  describePromotionError,
  destinationLeaf,
  effectiveGitOptions,
  freeLeafCandidates,
  initialDestinationForName,
  isAutoLeafForName,
  isLocationFailure,
  joinDestination,
  planPromotionSteps,
  projectFolderLeafForName,
  promotionErrorStillApplies,
  promotionHasWarnings,
  readProjectChatErrorReason,
  replaceDestinationLeaf,
  resolvePromotionSteps,
  resolvePromotionSubmitBlocker,
  retargetDestinationForName,
  shouldShowGitIdentityNotice,
} from "./PromoteChatDialog.logic";

const ALL_GIT = { initializeGit: true, initialCommit: true, writeGitignore: true } as const;
const NO_GIT = { initializeGit: false, initialCommit: true, writeGitignore: true } as const;
const PROJECT_ID = ProjectId.make("chat-project");

describe("destination paths", () => {
  it("replaces and reads the last segment", () => {
    expect(destinationLeaf("/Users/me/Code/plan-a-trip")).toBe("plan-a-trip");
    expect(destinationLeaf("/Users/me/Code/plan-a-trip/")).toBe("plan-a-trip");
    expect(replaceDestinationLeaf("/Users/me/Code/plan-a-trip", "trip")).toBe(
      "/Users/me/Code/trip",
    );
    expect(replaceDestinationLeaf("C:\\Code\\plan", "trip")).toBe("C:\\Code\\trip");
    expect(replaceDestinationLeaf("plan", "trip")).toBe("trip");
    expect(replaceDestinationLeaf("", "trip")).toBe("trip");
    expect(replaceDestinationLeaf("/", "trip")).toBe("/trip");
  });

  it("joins a picked parent with the folder name", () => {
    expect(joinDestination("/Users/me/Work", "trip")).toBe("/Users/me/Work/trip");
    expect(joinDestination("/Users/me/Work/", "trip")).toBe("/Users/me/Work/trip");
    expect(joinDestination("C:\\Work", "trip")).toBe("C:\\Work\\trip");
  });
});

describe("folder name following the project name", () => {
  it("slugs the name like the server does", () => {
    expect(projectFolderLeafForName("Plan a Trip!")).toBe("plan-a-trip");
    expect(projectFolderLeafForName("   ")).toBe("project");
  });

  it("treats the slug and its collision suffixes as automatic", () => {
    expect(isAutoLeafForName("plan-a-trip", "Plan a trip")).toBe(true);
    expect(isAutoLeafForName("plan-a-trip-2", "Plan a trip")).toBe(true);
    expect(isAutoLeafForName("plan-a-trip-12", "Plan a trip")).toBe(true);
    expect(isAutoLeafForName("plan-a-trip-0", "Plan a trip")).toBe(false);
    expect(isAutoLeafForName("plan-a-trip-final", "Plan a trip")).toBe(false);
    expect(isAutoLeafForName("my-folder", "Plan a trip")).toBe(false);
  });

  it("keeps the server default, or renames it for a retitled chat", () => {
    expect(initialDestinationForName("/Code/plan-a-trip-2", "Plan a trip")).toBe(
      "/Code/plan-a-trip-2",
    );
    expect(initialDestinationForName("/Code/plan-a-trip", "Paris itinerary")).toBe(
      "/Code/paris-itinerary",
    );
  });

  it("moves an automatic folder name with the project name", () => {
    expect(
      retargetDestinationForName({
        destination: "/Code/plan-a-trip",
        previousName: "Plan a trip",
        nextName: "Paris",
      }),
    ).toBe("/Code/paris");
  });

  it("keeps a collision suffix while the name keeps the same slug", () => {
    expect(
      retargetDestinationForName({
        destination: "/Code/plan-a-trip-2",
        previousName: "Plan a trip",
        nextName: "Plan a trip ",
      }),
    ).toBe("/Code/plan-a-trip-2");
  });

  it("leaves a folder name the user typed alone", () => {
    expect(
      retargetDestinationForName({
        destination: "/Code/my-folder",
        previousName: "Plan a trip",
        nextName: "Paris",
      }),
    ).toBe("/Code/my-folder");
    expect(retargetDestinationForName({ destination: "", previousName: "a", nextName: "b" })).toBe(
      "",
    );
  });

  it("suggests the next free siblings", () => {
    expect(freeLeafCandidates("trip", 3)).toEqual(["trip-2", "trip-3", "trip-4"]);
    expect(freeLeafCandidates("trip-2", 2)).toEqual(["trip-3", "trip-4"]);
  });
});

describe("describeDestinationStatus", () => {
  it("speaks to every server verdict", () => {
    expect(describeDestinationStatus("available")).toEqual({
      tone: "positive",
      text: "Folder is available",
    });
    expect(describeDestinationStatus("exists").text).toBe("A folder already exists here");
    expect(describeDestinationStatus("inside-chats").text).toMatch(/^Inside the chats folder/);
    expect(describeDestinationStatus("inside-source")).toEqual({
      tone: "negative",
      text: "Inside this chat's own folder. Choose a location outside it",
    });
    expect(describeDestinationStatus("access-denied").tone).toBe("negative");
    expect(describeDestinationStatus("retired-checkout")).toEqual({
      tone: "negative",
      text: "A removed workspace used this location. Choose another one",
    });
    expect(describeDestinationStatus("invalid").tone).toBe("negative");
    expect(describeDestinationStatus("checking").tone).toBe("neutral");
  });
});

describe("what will happen", () => {
  const preview = { fileCount: 12, totalBytes: 3 * 1024 * 1024, countTruncated: false };

  it("counts the files that move", () => {
    expect(describeFolderContents(preview)).toBe("12 files (3.0 MB)");
    expect(describeFolderContents({ fileCount: 1, totalBytes: 0, countTruncated: false })).toBe(
      "1 file",
    );
    expect(
      describeFolderContents({ fileCount: 5000, totalBytes: 2048, countTruncated: true }),
    ).toBe("more than 5,000 files (2.0 KB)");
    expect(describeFolderContents({ fileCount: 0, totalBytes: 0, countTruncated: false })).toBe(
      "the empty chat folder",
    );
  });

  it("explains a copy across disks", () => {
    expect(describeMovePlan({ ...preview, crossDevice: false })).toEqual({
      title: "Move 12 files (3.0 MB)",
      detail: null,
    });
    const crossDevice = describeMovePlan({ ...preview, crossDevice: true });
    expect(crossDevice.title).toBe("Copy 12 files (3.0 MB), then remove the original");
    expect(crossDevice.detail).toMatch(/different disk/);
  });

  it("describes the Git setup that was chosen", () => {
    expect(describeGitPlan(ALL_GIT, true)).toEqual({
      title: "Initialize a Git repository",
      detail:
        "Then add a .gitignore and make an initial commit. Branches, worktrees, diffs and checkpoints turn on.",
    });
    expect(describeGitPlan(NO_GIT, true).title).toBe("No Git yet");
    expect(describeGitPlan(ALL_GIT, false).detail).toMatch(/not installed/);
  });

  it("sends no Git work when Git is off or missing", () => {
    expect(effectiveGitOptions(ALL_GIT, true)).toEqual(ALL_GIT);
    expect(effectiveGitOptions(NO_GIT, true)).toEqual({
      initializeGit: false,
      initialCommit: false,
      writeGitignore: false,
    });
    expect(effectiveGitOptions(ALL_GIT, false).initializeGit).toBe(false);
  });

  it("warns about a missing Git identity only when a commit is planned", () => {
    const base = { gitAvailable: true, gitIdentityConfigured: false };
    expect(shouldShowGitIdentityNotice({ ...base, options: ALL_GIT })).toBe(true);
    expect(
      shouldShowGitIdentityNotice({ ...base, options: { ...ALL_GIT, initialCommit: false } }),
    ).toBe(false);
    expect(shouldShowGitIdentityNotice({ ...base, options: NO_GIT })).toBe(false);
    expect(
      shouldShowGitIdentityNotice({ ...base, gitIdentityConfigured: true, options: ALL_GIT }),
    ).toBe(false);
  });
});

describe("promotion steps", () => {
  const result = {
    projectId: PROJECT_ID,
    workspaceRoot: "/Code/plan-a-trip",
    gitInitialized: true,
    initialCommitCreated: true,
  };

  it("plans only the chosen steps, with the move running", () => {
    expect(
      planPromotionSteps(ALL_GIT, { crossDevice: false }).map((step) => [step.id, step.status]),
    ).toEqual([
      ["move", "running"],
      ["git-init", "pending"],
      ["initial-commit", "pending"],
    ]);
    expect(planPromotionSteps(NO_GIT, { crossDevice: true })).toEqual([
      { id: "move", label: "Move files", status: "running", detail: "Copying to the other disk…" },
    ]);
  });

  it("settles every step from a clean result", () => {
    const steps = resolvePromotionSteps(ALL_GIT, result);
    expect(steps.map((step) => step.status)).toEqual(["done", "done", "done"]);
    expect(steps[0]?.detail).toBe("/Code/plan-a-trip");
    expect(promotionHasWarnings(steps)).toBe(false);
  });

  it("reports a failed commit as a warning with its reason", () => {
    const steps = resolvePromotionSteps(ALL_GIT, {
      ...result,
      initialCommitCreated: false,
      commitError: "Author identity unknown",
    });
    expect(steps[2]).toMatchObject({ status: "warning", detail: "Author identity unknown" });
    expect(promotionHasWarnings(steps)).toBe(true);
  });

  it("skips the commit when Git could not be set up", () => {
    const steps = resolvePromotionSteps(ALL_GIT, {
      ...result,
      gitInitialized: false,
      initialCommitCreated: false,
      commitError: "Git could not be initialized.",
    });
    expect(steps.map((step) => step.status)).toEqual(["done", "warning", "skipped"]);
  });

  it("calls an empty first commit skipped, not failed", () => {
    const steps = resolvePromotionSteps(
      { ...ALL_GIT, writeGitignore: false },
      { ...result, initialCommitCreated: false },
    );
    expect(steps[2]).toMatchObject({ status: "skipped", detail: "Nothing to commit yet" });
  });
});

describe("resolvePromotionSubmitBlocker", () => {
  const ready = { destinationStatus: "available" as const, busyThreadIds: [] };

  it("allows a named, available, idle chat", () => {
    expect(
      resolvePromotionSubmitBlocker({ name: "Trip", destination: "/Code/trip", preview: ready }),
    ).toBeNull();
  });

  it("explains each blocker", () => {
    expect(
      resolvePromotionSubmitBlocker({ name: " ", destination: "/Code/trip", preview: ready }),
    ).toMatchObject({ field: "name" });
    expect(
      resolvePromotionSubmitBlocker({ name: "Trip", destination: " ", preview: ready }),
    ).toMatchObject({ field: "location" });
    expect(
      resolvePromotionSubmitBlocker({ name: "Trip", destination: "/Code/trip", preview: null }),
    ).toMatchObject({ field: "pending" });
    expect(
      resolvePromotionSubmitBlocker({
        name: "Trip",
        destination: "/Code/trip",
        preview: { ...ready, busyThreadIds: [ThreadId.make("thread-1")] },
      }),
    ).toEqual({ field: "busy", reason: BUSY_CHAT_REASON });
    expect(
      resolvePromotionSubmitBlocker({
        name: "Trip",
        destination: "/Code/trip",
        preview: { ...ready, destinationStatus: "exists" },
      }),
    ).toEqual({ field: "location", reason: "A folder already exists here" });
  });
});

describe("describePromotionError", () => {
  const chatError = (reason: ProjectChatError["reason"], message = "Server message.") =>
    new ProjectChatError({ reason, message });

  it("reads the reason of a ProjectChatError only", () => {
    expect(readProjectChatErrorReason(chatError("busy"))).toBe("busy");
    expect(readProjectChatErrorReason(new Error("boom"))).toBeNull();
    expect(readProjectChatErrorReason({ _tag: "ProjectChatError", reason: "nope" })).toBeNull();
  });

  it("maps each recoverable reason to a recovery", () => {
    expect(describePromotionError(chatError("stale")).recovery).toBe("refresh-preview");
    expect(describePromotionError(chatError("busy"))).toMatchObject({
      recovery: "refresh-preview",
      message: BUSY_CHAT_REASON,
    });
    expect(describePromotionError(chatError("destination-exists"))).toMatchObject({
      recovery: "suggest-name",
      title: "That folder already exists",
    });
    expect(describePromotionError(chatError("destination-inside-chats")).recovery).toBe(
      "fix-location",
    );
    expect(describePromotionError(chatError("destination-inside-source"))).toEqual({
      reason: "destination-inside-source",
      title: "That location is inside this chat's folder",
      message: "A chat can't move into its own folder. Choose a location outside it.",
      recovery: "fix-location",
    });
    expect(describePromotionError(chatError("access-denied")).recovery).toBe("fix-location");
    expect(describePromotionError(chatError("destination-retired-checkout"))).toMatchObject({
      title: "That location belonged to a removed workspace",
      recovery: "fix-location",
    });
    expect(describePromotionError(chatError("move-failed", "Disk full. Nothing changed."))).toEqual(
      {
        reason: "move-failed",
        title: "The files could not be moved",
        message: "Disk full. Nothing changed.",
        recovery: "retry",
      },
    );
  });

  it("ends the dialog for a chat that cannot be promoted", () => {
    expect(describePromotionError(chatError("not-found")).recovery).toBe("none");
    expect(describePromotionError(chatError("not-chat")).title).toBe(
      "This chat is already a project",
    );
  });

  it("keeps a location refusal only while that location is shown", () => {
    const insideSource = describePromotionError(chatError("destination-inside-source"));
    const taken = describePromotionError(chatError("destination-exists"));
    const moveFailed = describePromotionError(chatError("move-failed"));
    expect([insideSource, taken, moveFailed].map(isLocationFailure)).toEqual([true, true, false]);

    const at = (failure: typeof insideSource, destination: string) =>
      promotionErrorStillApplies({
        failure,
        failedDestination: "/home/me/.ryco/chats/trip/inner",
        destination,
      });
    expect(at(insideSource, "/home/me/.ryco/chats/trip/inner")).toBe(true);
    expect(at(insideSource, "/home/me/Code/trip")).toBe(false);
    expect(at(taken, "/home/me/Code/trip-2")).toBe(false);
    // Anything else is about the request, not the location.
    expect(at(moveFailed, "/home/me/Code/trip")).toBe(true);
    expect(
      promotionErrorStillApplies({
        failure: insideSource,
        failedDestination: null,
        destination: "/anywhere",
      }),
    ).toBe(true);
  });

  it("treats transport failures as retryable", () => {
    expect(describePromotionError(new Error("Socket closed"))).toEqual({
      reason: null,
      title: "The request did not complete",
      message: "Socket closed",
      recovery: "retry",
    });
  });
});

describe("chatActivitySignature", () => {
  const idle = {
    id: ThreadId.make("thread-1"),
    session: null,
    latestTurn: null,
    interactionMode: "default" as const,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const noTerminals = () => 0;

  it("changes when a thread starts or stops waiting on the user", () => {
    expect(chatActivitySignature(chatThreadLiveWork([idle], noTerminals))).toBe("thread-1:idle:0");
    expect(
      chatActivitySignature(
        chatThreadLiveWork([{ ...idle, hasPendingApprovals: true }], noTerminals),
      ),
    ).toBe("thread-1:approval:0");
  });

  it("changes when a terminal command starts or ends", () => {
    const running = chatActivitySignature(chatThreadLiveWork([idle], () => 1));
    expect(running).toBe("thread-1:idle:1");
    expect(chatActivitySignature(chatThreadLiveWork([idle], noTerminals))).not.toBe(running);
  });
});

describe("describeChatBusy", () => {
  const agentThread = ThreadId.make("thread-agent");
  const terminalThread = ThreadId.make("thread-terminal");
  const quietThread = ThreadId.make("thread-quiet");
  const work = [
    { threadId: agentThread, activity: "working", runningTerminals: 0 },
    { threadId: terminalThread, activity: "idle", runningTerminals: 1 },
    { threadId: quietThread, activity: "plan-ready", runningTerminals: 0 },
  ] as const;

  it("is null for an idle chat", () => {
    expect(describeChatBusy({ busyThreadIds: [], work })).toBeNull();
  });

  it("offers to stop a working agent", () => {
    expect(describeChatBusy({ busyThreadIds: [agentThread], work })).toEqual({
      title: "The agent is still working in this chat",
      message: "Wait for the agent to finish (or stop it) before moving the chat.",
      stoppableThreadIds: [agentThread],
      offerRecheck: false,
    });
  });

  it("names a running terminal command and never offers to stop the agent for it", () => {
    expect(describeChatBusy({ busyThreadIds: [terminalThread], work })).toMatchObject({
      title: "A terminal is still running a command in this chat",
      stoppableThreadIds: [],
      offerRecheck: true,
    });
  });

  it("stops only the agents when an agent and a terminal are both busy", () => {
    expect(describeChatBusy({ busyThreadIds: [agentThread, terminalThread], work })).toMatchObject({
      title: "This chat is still busy",
      message:
        "Stop the agent or let it finish, and let the terminal command end, before moving the chat.",
      stoppableThreadIds: [agentThread],
      offerRecheck: true,
    });
  });

  it("offers a manual check for work this client cannot see", () => {
    for (const threadId of [quietThread, ThreadId.make("thread-unknown")]) {
      expect(describeChatBusy({ busyThreadIds: [threadId], work })).toMatchObject({
        title: "This chat is still busy",
        stoppableThreadIds: [],
        offerRecheck: true,
      });
    }
  });
});
