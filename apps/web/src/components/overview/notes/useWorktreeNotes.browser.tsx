import {
  EnvironmentId,
  NOTE_BODY_MAX_LENGTH,
  NotesError,
  ProjectId,
  WorktreeId,
  type EnvironmentApi,
} from "@ryco/contracts";
import { useNotesStore } from "@ryco/client-runtime/state/notes";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

vi.mock("../../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({ allowed: true, reason: null }),
}));

import {
  NOTES_DRAFT_REASON,
  NOTES_SAVE_DEBOUNCE_MS,
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

const target = (overrides: Partial<WorktreeNotesTarget> = {}): WorktreeNotesTarget => ({
  environmentId: ENV,
  projectId: PROJECT,
  checkout: { worktreeId: FEATURE, origin: "branch" },
  available: true,
  ...overrides,
});

const fake = createFakeNotesNode(PROJECT);
const node = fake.node;

let latest: WorktreeNotes | null = null;
function Probe(props: { readonly target: WorktreeNotesTarget | null }) {
  const notes = useWorktreeNotes(props.target);
  useEffect(() => {
    latest = notes;
  });
  return <p data-testid="notes">{notes.bodyFor(notes.view)}</p>;
}
const state = () => latest!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  fake.reset();
  latest = null;
  __setEnvironmentApiOverrideForTests(ENV, { notes: fake.api } as unknown as EnvironmentApi);
});
afterEach(async () => {
  await settle();
  useNotesStore.setState({ byKey: {} });
  __resetEnvironmentApiOverridesForTests();
});

describe("useWorktreeNotes", () => {
  it("shows this checkout's document and the project's, each in its own view", async () => {
    fake.seed("worktree", "Feature notes", FEATURE);
    fake.seed("worktree", "Main notes");
    fake.seed("project", "Project notes");
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    expect(state().bodyFor("worktree")).toBe("Feature notes");
    expect(state().bodyFor("project")).toBe("Project notes");
    expect(state().saveStateFor("worktree")).toBe("saved");
    expect(state().filled).toBe(true);
    expect(state().editDisabledReasonFor("worktree")).toBeNull();
    expect(state().alertDocuments).toEqual([
      { key: "worktree:wt-feature", view: "worktree", revision: 1, own: false },
      { key: "project", view: "project", revision: 1, own: false },
    ]);
    await screen.unmount();
  });

  it("shows an edit at once and saves it once typing stops, as this client's own", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);
    expect(state().filled).toBe(false);

    state().edit("worktree", "Ship");
    state().edit("worktree", "Ship the crown");
    await expect.poll(() => state().bodyFor("worktree")).toBe("Ship the crown");
    expect(state().saveStateFor("worktree")).toBe("unsaved");
    expect(node.commands).toEqual([]);

    await expect
      .poll(() => node.commands.length, { timeout: NOTES_SAVE_DEBOUNCE_MS + 2000 })
      .toBe(1);
    expect(node.commands[0]).toEqual({
      kind: "save",
      projectId: PROJECT,
      scope: "worktree",
      worktreeId: FEATURE,
      body: "Ship the crown",
      expectedRevision: 0,
    });
    await expect.poll(() => state().saveStateFor("worktree")).toBe("saved");
    expect(state().bodyFor("worktree")).toBe("Ship the crown");
    expect(state().alertDocuments).toEqual([
      { key: "worktree:wt-feature", view: "worktree", revision: 1, own: true },
    ]);
    await screen.unmount();
  });

  it("saves on flush and sends text typed during a save after it, on the new revision", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    state().edit("project", "First");
    await settle();
    state().flush("project");
    state().edit("project", "First and second");
    state().flush("project");
    await expect
      .poll(() => node.commands.length, { timeout: NOTES_SAVE_DEBOUNCE_MS + 2000 })
      .toBe(2);
    expect(node.commands.map((command) => [command.body, command.expectedRevision])).toEqual([
      ["First", 0],
      ["First and second", 1],
    ]);
    await expect.poll(() => state().saveStateFor("project")).toBe("saved");
    expect(node.documents[0]).toMatchObject({ body: "First and second", revision: 2 });
    await screen.unmount();
  });

  it("drops an edit that returns to the saved text", async () => {
    fake.seed("project", "Same");
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    state().edit("project", "Same");
    await settle();
    expect(state().saveStateFor("project")).toBe("saved");
    state().flush("project");
    await settle();
    expect(node.commands).toEqual([]);
    await screen.unmount();
  });

  it("keeps the text typed here when the document changed elsewhere meanwhile", async () => {
    fake.seed("worktree", "Base", FEATURE);
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    state().edit("worktree", "Mine");
    await settle();
    fake.seed("worktree", "Theirs", FEATURE);
    const readsBefore = node.reads;
    state().flush("worktree");
    await expect.poll(() => node.commands.length).toBe(2);
    expect(node.reads).toBeGreaterThan(readsBefore);
    expect(node.commands.map((command) => command.expectedRevision)).toEqual([1, 2]);
    await expect.poll(() => state().saveStateFor("worktree")).toBe("saved");
    expect(state().bodyFor("worktree")).toBe("Mine");
    expect(state().error).toBeNull();
    await screen.unmount();
  });

  it("follows the node's text while nothing is typed here", async () => {
    fake.seed("project", "Before");
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().bodyFor("project")).toBe("Before");
    fake.seed("project", "After");
    window.dispatchEvent(new Event("focus"));
    await expect.poll(() => state().bodyFor("project")).toBe("After");
    await screen.unmount();
  });

  it("resends a save whose reply was lost and settles once the node shows it", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    node.dropReplies = 1;
    state().edit("worktree", "Lost reply");
    state().flush("worktree");
    await expect.poll(() => state().error).toBe(NOTES_UNCONFIRMED);
    expect(state().saveStateFor("worktree")).toBe("unsaved");

    state().refresh();
    // The resend meets its own landed revision, re-reads and finds the text saved.
    await expect.poll(() => state().saveStateFor("worktree")).toBe("saved");
    expect(node.commands).toHaveLength(2);
    expect(node.documents).toHaveLength(1);
    expect(state().error).toBeNull();
    expect(state().alertDocuments[0]?.own).toBe(true);
    await screen.unmount();
  });

  it("refuses over-long text before sending", async () => {
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    state().edit("worktree", "x".repeat(NOTE_BODY_MAX_LENGTH + 1));
    state().flush("worktree");
    await expect.poll(() => state().error).toBe(NOTES_TOO_LONG);
    expect(node.commands).toEqual([]);
    await screen.unmount();
  });

  it("reports a refused save and keeps the text", async () => {
    __setEnvironmentApiOverrideForTests(ENV, {
      notes: {
        ...fake.api,
        command: async () => {
          throw new NotesError({
            reason: "invalid",
            message: "The notes worktree is unavailable.",
          });
        },
      },
    } as unknown as EnvironmentApi);
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    state().edit("worktree", "Gone worktree");
    state().flush("worktree");
    await expect.poll(() => state().error).toBe("The notes worktree is unavailable.");
    expect(state().bodyFor("worktree")).toBe("Gone worktree");
    expect(state().saveStateFor("worktree")).toBe("unsaved");
    await screen.unmount();
  });

  it("gives a draft without a checkout only the Project view", async () => {
    fake.seed("project", "Shared");
    const screen = await render(<Probe target={target({ checkout: null })} />);
    await expect.poll(() => state().loaded).toBe(true);

    expect(state().view).toBe("project");
    expect(state().worktreeViewDisabledReason).toBe(NOTES_DRAFT_REASON);
    expect(state().editDisabledReasonFor("worktree")).toBe(NOTES_DRAFT_REASON);
    expect(state().editDisabledReasonFor("project")).toBeNull();
    state().setView("worktree");
    await settle();
    expect(state().view).toBe("project");
    state().edit("worktree", "Nope");
    state().flush("worktree");
    state().edit("project", "Shared, edited");
    state().flush("project");
    await expect.poll(() => node.commands.length).toBe(1);
    expect(node.commands[0]).toMatchObject({ scope: "project", worktreeId: null });
    await screen.unmount();
  });

  it("saves unsaved text when the thread moves to another project", async () => {
    const other = ProjectId.make("project-other");
    const screen = await render(<Probe target={target()} />);
    await expect.poll(() => state().loaded).toBe(true);

    state().edit("project", "Before leaving");
    await screen.rerender(<Probe target={target({ projectId: other })} />);
    await expect.poll(() => node.commands.length).toBe(1);
    expect(node.commands[0]).toMatchObject({ projectId: PROJECT, body: "Before leaving" });
    expect(state().bodyFor("project")).toBe("");
    await screen.unmount();
  });

  it("stays unavailable without the node's capability and never reads", async () => {
    const screen = await render(<Probe target={target({ available: false })} />);
    await settle();
    expect(state().available).toBe(false);
    expect(state().editDisabledReasonFor("project")).not.toBeNull();
    expect(node.reads).toBe(0);
    await screen.unmount();
  });
});
