import {
  EnvironmentId,
  NOTE_BODY_MAX_LENGTH,
  NotesError,
  ProjectId,
  ThreadId,
  WorktreeId,
  type EnvironmentApi,
  type WorktreeNote,
} from "@ryco/contracts";
import { useNotesStore } from "@ryco/client-runtime/state/notes";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

vi.mock("../../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({ allowed: true, reason: null }),
}));

import {
  NOTES_CREATE_UNCONFIRMED,
  NOTES_DRAFT_REASON,
  NOTES_TOO_LONG,
  NOTES_UNCONFIRMED,
  useWorktreeNotes,
  type WorktreeNotes,
  type WorktreeNotesTarget,
} from "./useWorktreeNotes";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../../environmentApi";
import { createFakeNotesNode } from "../crown/crownTestFixtures";

const ENV = EnvironmentId.make("env-notes");
const PROJECT = ProjectId.make("project-notes");
const FEATURE = WorktreeId.make("wt-feature");
const THREAD = ThreadId.make("thread-notes");

const target = (overrides: Partial<WorktreeNotesTarget> = {}): WorktreeNotesTarget => ({
  environmentId: ENV,
  projectId: PROJECT,
  checkout: { worktreeId: FEATURE, origin: "branch" },
  threadId: THREAD,
  available: true,
  ...overrides,
});

const fake = createFakeNotesNode(PROJECT);
const node = fake.node;
/** Lists in seed order: the first seeded note is the newest. */
function seedAll(...notes: Array<[string, Partial<WorktreeNote>?]>) {
  for (const [noteId, overrides] of notes.toReversed())
    fake.seed(noteId, { worktreeId: FEATURE, ...overrides });
}

let latest: WorktreeNotes | null = null;
function Probe(props: { readonly target: WorktreeNotesTarget | null }) {
  const notes = useWorktreeNotes(props.target);
  useEffect(() => {
    latest = notes;
  });
  return <p data-testid="notes">{notes.worktreeNotes.map((note) => note.id).join(",")}</p>;
}
const state = () => latest!;
const ids = (notes: ReadonlyArray<{ id: string }>) => notes.map((note) => note.id);

beforeEach(() => {
  fake.reset();
  latest = null;
  __setEnvironmentApiOverrideForTests(ENV, { notes: fake.api } as unknown as EnvironmentApi);
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  useNotesStore.setState({ byKey: {} });
  __resetEnvironmentApiOverridesForTests();
});

describe("useWorktreeNotes", () => {
  it("lists this worktree's notes with pinned ones first and every note in the project view", async () => {
    seedAll(
      ["pinned", { worktreeId: null, scope: "project", threadId: ThreadId.make("gone") }],
      ["here"],
      ["main", { worktreeId: null }],
      ["other", { worktreeId: WorktreeId.make("wt-gone") }],
    );
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    expect(ids(state().worktreeNotes)).toEqual(["pinned", "here"]);
    expect(ids(state().projectNotes)).toEqual(["pinned", "here", "main", "other"]);
    expect(state().counts).toEqual({ worktree: 2, project: 4 });
    const byId = new Map(state().projectNotes.map((note) => [note.id, note]));
    // A thread that no longer exists keeps its chip with no title.
    expect(byId.get("pinned")!.thread).toEqual({ id: "gone", title: null });
    expect(byId.get("main")!.worktreeLabel).toBe("main");
    expect(byId.get("other")!.worktreeLabel).toBe("Removed worktree");
    expect(byId.get("here")!.worktreeLabel).toBeNull();
    expect(state().available).toBe(true);
    expect(state().composerDisabledReason).toBeNull();
    await screen.unmount();
  });

  it("shows a save at once as pending, then confirms it from the node's reply", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    state().save("  [ ] Ship the crown  ", "worktree");
    await expect.poll(() => state().worktreeNotes.length).toBe(1);
    const [command] = node.commands;
    expect(command).toMatchObject({
      kind: "create",
      projectId: PROJECT,
      worktreeId: FEATURE,
      scope: "worktree",
      body: "[ ] Ship the crown",
      threadId: THREAD,
    });
    await expect.poll(() => state().worktreeNotes[0]?.pending).toBeUndefined();
    expect(state().worktreeNotes[0]!.id).toBe(command!.noteId);
    expect(state().ownNoteIds.has(command!.noteId)).toBe(true);
    await screen.unmount();
  });

  it("keeps a create whose reply was lost pending and resends it with the same id", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    node.dropReplies = 1;
    state().save("Lost reply", "project");
    await expect.poll(() => node.commands.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state().worktreeNotes[0]?.pending).toBe(true);

    expect(state().error).toBe(NOTES_CREATE_UNCONFIRMED);

    state().refresh();
    await expect.poll(() => node.commands.length).toBe(2);
    expect(node.commands[1]!.noteId).toBe(node.commands[0]!.noteId);
    await expect.poll(() => state().worktreeNotes[0]?.pending).toBeUndefined();
    expect(node.notes).toHaveLength(1);
    expect(state().error).toBeNull();
    await screen.unmount();
  });

  it("resends a create whose reply was lost on its own, after a short backoff", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    node.dropReplies = 1;
    await expect(state().save("Retried", "worktree")).resolves.toBe("unconfirmed");
    await expect.poll(() => node.commands.length, { timeout: 4000 }).toBe(2);
    expect(node.commands[1]!.noteId).toBe(node.commands[0]!.noteId);
    await expect.poll(() => state().worktreeNotes[0]?.pending).toBeUndefined();
    await screen.unmount();
  });

  it("drops a retried create quietly when its note was deleted elsewhere meanwhile", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    node.dropReplies = 1;
    await state().save("Deleted elsewhere", "worktree");
    const noteId = node.commands[0]!.noteId;
    node.notes = [];
    node.deleted.add(noteId);

    state().refresh();
    await expect.poll(() => node.commands.length).toBe(2);
    await expect.poll(() => state().worktreeNotes.length).toBe(0);
    expect(state().error).toBeNull();
    await screen.unmount();
  });

  it("refuses an over-long note before sending, without leaving it pending", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    await expect(state().save("x".repeat(NOTE_BODY_MAX_LENGTH + 1), "worktree")).resolves.toBe(
      "refused",
    );
    await expect.poll(() => state().error).toBe(NOTES_TOO_LONG);
    expect(state().worktreeNotes).toEqual([]);
    expect(node.commands).toEqual([]);
    await screen.unmount();
  });

  it("reports a rejected create so the composer can take its text back", async () => {
    __setEnvironmentApiOverrideForTests(ENV, {
      notes: {
        ...fake.api,
        command: async () => {
          throw new NotesError({ reason: "invalid", message: "The note worktree is unavailable." });
        },
      },
    } as unknown as EnvironmentApi);
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    await expect(state().save("Gone worktree", "worktree")).resolves.toBe("rejected");
    await expect.poll(() => state().error).toBe("The note worktree is unavailable.");
    expect(state().worktreeNotes).toEqual([]);
    await screen.unmount();
  });

  it("shows a fixed message for a change that could not be confirmed, until a later read", async () => {
    seedAll(["todo", { body: "[ ] Fix the ring" }]);
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    node.dropReplies = 1;
    state().toggleTodo("todo");
    await expect.poll(() => state().error).toBe(NOTES_UNCONFIRMED);
    // The follow-up read reconciles the list but keeps the message up...
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state().error).toBe(NOTES_UNCONFIRMED);
    // ...until a later read lists the notes again.
    window.dispatchEvent(new Event("focus"));
    await expect.poll(() => state().error).toBeNull();
    await screen.unmount();
  });

  it("edits against the last seen revision and re-reads on a conflict", async () => {
    seedAll(["todo", { body: "[ ] Fix the ring" }]);
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    state().toggleTodo("todo");
    await expect.poll(() => node.notes[0]!.body).toBe("[x] Fix the ring");
    expect(node.commands[0]).toMatchObject({ kind: "update", expectedRevision: 0 });
    await expect.poll(() => state().worktreeNotes[0]!.body).toBe("[x] Fix the ring");

    // Someone else moved the note on; this client still holds revision 1.
    node.notes[0] = { ...node.notes[0]!, revision: 5 };
    const readsBefore = node.reads;
    state().togglePin("todo");
    await expect.poll(() => node.reads).toBeGreaterThan(readsBefore);
    await expect.poll(() => state().worktreeNotes[0]!.scope).toBe("worktree");
    expect(state().error).toBeNull();

    state().remove("todo");
    await expect.poll(() => node.notes.length).toBe(0);
    await expect.poll(() => state().worktreeNotes.length).toBe(0);
    await screen.unmount();
  });

  it("counts a note pinned here from another worktree as this client's own", async () => {
    seedAll(["other", { worktreeId: WorktreeId.make("wt-other") }]);
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);
    expect(ids(state().worktreeNotes)).toEqual([]);

    state().togglePin("other");
    // It appears in this worktree's list, so it must not alert as saved elsewhere.
    await expect.poll(() => ids(state().worktreeNotes)).toEqual(["other"]);
    expect(state().ownNoteIds.has("other")).toBe(true);
    await expect.poll(() => node.notes[0]!.scope).toBe("project");
    await screen.unmount();
  });

  it("re-reads when the window regains focus", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => node.reads).toBe(1);
    seedAll(["elsewhere"]);
    window.dispatchEvent(new Event("focus"));
    await expect.poll(() => ids(state().worktreeNotes)).toEqual(["elsewhere"]);
    await screen.unmount();
  });

  it("gives a draft without a checkout the Project view with the composer off", async () => {
    seedAll(["pinned", { scope: "project" }], ["here"]);
    const screen = await render(<Probe target={target({ checkout: null, threadId: null })} />);
    await expect.poll(() => state().loaded).toBe(true);

    expect(state().view).toBe("project");
    expect(state().composerDisabledReason).toBe(NOTES_DRAFT_REASON);
    expect(state().worktreeViewDisabledReason).toBe(NOTES_DRAFT_REASON);
    state().setView("worktree");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state().view).toBe("project");
    expect(ids(state().worktreeNotes)).toEqual(["pinned"]);
    state().save("Nope", "worktree");
    expect(node.commands).toEqual([]);
    await screen.unmount();
  });

  it("stays unavailable without the node's capability and never reads", async () => {
    const screen = await render(<Probe target={target({ available: false })} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state().available).toBe(false);
    expect(state().disabledReason).not.toBeNull();
    expect(node.reads).toBe(0);
    await screen.unmount();
  });
});
