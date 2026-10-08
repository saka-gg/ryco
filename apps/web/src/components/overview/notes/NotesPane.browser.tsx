import "../../../index.css";

import type { ReactElement } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { NOTE_BODY_MAX_LENGTH } from "@ryco/contracts";

import { isMacPlatform } from "~/lib/utils";
import {
  resetAppearancePreference,
  setAppearancePreference,
} from "../../../themes/appearancePreferences";
import { ISLAND_DARK_TOKEN_STYLE } from "../crown/islandTheme";
import type { NoteView } from "./noteView";
import { NOTES_EXIT_MS, NotesPane, type NotesPaneProps } from "./NotesPane";

const NOW = new Date().toISOString();

function note(id: string, overrides: Partial<NoteView> = {}): NoteView {
  return {
    id,
    body: `Note ${id}`,
    scope: "worktree",
    worktreeLabel: null,
    thread: { id: `thread-${id}`, title: `Thread ${id}` },
    createdAt: NOW,
    ...overrides,
  };
}

function paneProps(overrides: Partial<NotesPaneProps> = {}): NotesPaneProps {
  return {
    view: "worktree",
    onViewChange: vi.fn(),
    notes: [note("a"), note("b")],
    breadcrumb: { project: "ryco", worktree: "notes-panel" },
    threadTitle: "Overview rail + notes",
    composerDisabledReason: null,
    onSave: vi.fn(),
    onToggleTodo: vi.fn(),
    onTogglePin: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

/** `scroller`: the pane sits in a short scroller inside a clipped box (like the crown card). */
function island(props: NotesPaneProps, scroller = false): ReactElement {
  const root = (
    <div
      className="dark crown-root"
      data-testid="pane-root"
      style={{
        ...ISLAND_DARK_TOKEN_STYLE,
        width: 340,
        ...(scroller ? { height: 160, overflowY: "auto" } : {}),
      }}
    >
      <NotesPane {...props} />
    </div>
  );
  return scroller ? (
    <div data-testid="pane-clip" style={{ overflow: "hidden" }}>
      {root}
    </div>
  ) : (
    root
  );
}

async function mount(props: NotesPaneProps, scroller = false) {
  const screen = await render(island(props, scroller));
  return {
    ...screen,
    rerenderPane: (next: NotesPaneProps) => screen.rerender(island(next, scroller)),
  };
}

const pane = () => document.querySelector<HTMLElement>('[data-slot="notes-pane"]')!;
const textarea = () => document.querySelector<HTMLTextAreaElement>(".notes-textarea")!;
const row = (id: string) => document.querySelector<HTMLLIElement>(`[data-note-id="${id}"]`);
const thumb = () => document.querySelector<HTMLElement>('.notes-seg > [aria-hidden="true"]')!;
const saveChord = () =>
  isMacPlatform(navigator.platform) ? "{Meta>}{Enter}{/Meta}" : "{Control>}{Enter}{/Control}";

describe("NotesPane", () => {
  afterEach(() => {
    resetAppearancePreference("motion");
    vi.restoreAllMocks();
  });

  it("switches scope with a sliding thumb", async () => {
    const props = paneProps();
    const screen = await mount(props);
    await expect.poll(() => thumb().style.width).not.toBe("0px");
    const before = thumb().style.transform;
    expect(document.querySelector(".notes-crumb")?.textContent).toContain("›");

    await page.getByRole("tab", { name: "Project" }).click();
    expect(props.onViewChange).toHaveBeenCalledWith("project");

    await screen.rerenderPane({ ...props, view: "project" });
    await expect.poll(() => thumb().style.transform).not.toBe(before);
    expect(getComputedStyle(thumb()).transitionDuration).toContain("0.4s");
    expect(textarea().placeholder).toBe("Pin a note to the whole project…");
    expect(document.querySelector(".notes-crumb")?.textContent).toContain("all worktrees");
    expect(document.querySelector('[data-slot="notes-count"]')?.textContent).toBe("2");
    expect(document.querySelector(".notes-crumb")?.textContent).toContain("2 notes");
  });

  it("turns the Worktree tab off with a reason", async () => {
    const props = paneProps({ view: "project", worktreeViewDisabledReason: "No checkout yet" });
    await mount(props);
    const worktreeTab = page.getByRole("tab", { name: "Worktree" });
    expect(worktreeTab.element().getAttribute("aria-disabled")).toBe("true");
    expect(worktreeTab.element().getAttribute("title")).toBe("No checkout yet");
    (worktreeTab.element() as HTMLElement).click();
    await page.getByRole("tab", { name: "Project" }).click();
    await userEvent.keyboard("{ArrowRight}");
    expect(props.onViewChange).not.toHaveBeenCalledWith("worktree");
  });

  it("caps the composer at the note limit and gives back a body the save refused", async () => {
    const onSave = vi.fn(async () => "rejected" as const);
    await mount(paneProps({ onSave }));
    expect(textarea().maxLength).toBe(NOTE_BODY_MAX_LENGTH);
    await userEvent.click(textarea());
    await userEvent.keyboard("Kept for later");
    await userEvent.keyboard(saveChord());
    expect(onSave).toHaveBeenCalledWith("Kept for later", "worktree");
    await expect.poll(() => textarea().value).toBe("Kept for later");
  });

  it("notes a truncated list in the Project view only", async () => {
    const props = paneProps({ truncatedLimit: 500 });
    const screen = await mount(props);
    expect(document.querySelector('[data-slot="notes-truncated"]')).toBeNull();
    await screen.rerenderPane({ ...props, view: "project" });
    expect(document.querySelector('[data-slot="notes-truncated"]')?.textContent).toBe(
      "Showing the 500 newest notes",
    );
  });

  it("saves with the mod+Enter chord, clears and keeps focus", async () => {
    const props = paneProps({ view: "project" });
    await mount(props);
    await userEvent.click(textarea());
    await userEvent.keyboard("  remember `bun fmt`  ");
    await userEvent.keyboard(saveChord());
    expect(props.onSave).toHaveBeenCalledWith("remember `bun fmt`", "project");
    expect(textarea().value).toBe("");
    expect(document.activeElement).toBe(textarea());
  });

  it("saves from the button without losing focus and ignores blank drafts", async () => {
    const props = paneProps();
    await mount(props);
    await userEvent.click(textarea());
    await userEvent.keyboard(saveChord());
    expect(props.onSave).not.toHaveBeenCalled();
    await userEvent.keyboard("todo");
    await page.getByRole("button", { name: /Save/ }).click();
    expect(props.onSave).toHaveBeenCalledWith("todo", "worktree");
    expect(document.activeElement).toBe(textarea());
  });

  it("reveals the composer footer and autosizes the textarea", async () => {
    await mount(paneProps());
    const foot = document.querySelector<HTMLElement>(".notes-cfoot")!;
    expect(getComputedStyle(foot).maxHeight).toBe("0px");
    await userEvent.click(textarea());
    await expect.poll(() => getComputedStyle(foot).opacity).toBe("1");
    expect(foot.textContent).toContain("Overview rail + notes");
    expect(textarea().getBoundingClientRect().height).toBeCloseTo(19, 0);
    await userEvent.keyboard("one{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{/Shift}three");
    expect(textarea().getBoundingClientRect().height).toBeGreaterThan(19);
    expect(textarea().getBoundingClientRect().height).toBeLessThanOrEqual(120);
  });

  it("blurs on Escape without letting it reach the crown", async () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      await mount(paneProps());
      await userEvent.click(textarea());
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).not.toBe(textarea());
      expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });

  it("animates notes in and keeps removed notes during their exit", async () => {
    const props = paneProps();
    const screen = await mount(props);
    expect(row("a")?.dataset.phase).toBe("present");

    await screen.rerenderPane({ ...props, notes: [note("c"), ...props.notes] });
    expect(row("c")?.dataset.phase).toBe("enter");
    expect(getComputedStyle(row("c")!).opacity).toBe("0");
    await expect.poll(() => row("c")?.dataset.phase).toBe("present");
    expect(getComputedStyle(row("c")!).transitionDuration).toContain("0.36s");

    const removedAt = performance.now();
    await screen.rerenderPane({ ...props, notes: [note("c"), note("b")] });
    expect(row("a")?.dataset.phase).toBe("exit");
    expect(
      [...document.querySelectorAll("[data-note-id]")].map((el) => el.getAttribute("data-note-id")),
    ).toEqual(["c", "a", "b"]);
    await expect.poll(() => row("a"), { timeout: 2000 }).toBeNull();
    expect(performance.now() - removedAt).toBeGreaterThanOrEqual(NOTES_EXIT_MS - 30);
  });

  it("removes notes at once under reduced motion", async () => {
    setAppearancePreference("motion", "reduce");
    const props = paneProps();
    const screen = await mount(props);
    expect(pane().dataset.motion).toBe("reduced");
    await screen.rerenderPane({ ...props, notes: [note("b"), note("c")] });
    expect(row("a")).toBeNull();
    expect(row("c")?.dataset.phase).toBe("present");
  });

  it("renders todos, chips and pending notes", async () => {
    await mount(
      paneProps({
        view: "project",
        notes: [
          note("t", { body: "[x] ship `NotesPane`" }),
          note("p", { scope: "project", thread: { id: "gone", title: null } }),
          note("o", { worktreeLabel: "other-tree", thread: null, pending: true }),
        ],
      }),
    );
    expect(row("t")?.dataset.todo).toBe("done");
    expect(row("t")?.querySelector(".notes-text")?.textContent).toBe("ship NotesPane");
    expect(row("t")?.querySelector("code")?.textContent).toBe("NotesPane");
    expect(getComputedStyle(row("t")!.querySelector(".notes-text")!).textDecorationLine).toBe(
      "line-through",
    );
    expect(row("p")?.querySelector(".notes-chip-pin")?.textContent).toBe("project");
    expect(row("p")?.textContent).toContain("Deleted thread");
    expect(row("o")?.querySelector('[data-slot="notes-worktree-chip"]')?.textContent).toBe(
      "other-tree",
    );
    expect(row("o")?.dataset.pending).toBe("");
    expect(Number(getComputedStyle(row("o")!.firstElementChild!).opacity)).toBeLessThan(1);
    expect(row("o")?.querySelector<HTMLButtonElement>('[aria-label="Delete note"]')?.disabled).toBe(
      true,
    );
  });

  it("calls the todo, pin, delete and open-thread callbacks", async () => {
    const onOpenThread = vi.fn();
    const props = paneProps({
      notes: [note("t", { body: "[ ] follow up" }), note("p", { scope: "project" })],
      onOpenThread,
    });
    await mount(props);

    // Each todo is named by its text.
    await page.getByRole("checkbox", { name: "follow up" }).click();
    expect(props.onToggleTodo).toHaveBeenCalledWith("t");

    await userEvent.hover(row("p")!);
    await expect
      .poll(() => getComputedStyle(row("p")!.querySelector(".notes-acts")!).opacity)
      .toBe("1");
    const pinOf = (id: string) => row(id)!.querySelector<HTMLButtonElement>(".notes-pin-btn")!;
    // One name; the pressed state says whether it is pinned.
    expect(pinOf("p").getAttribute("aria-label")).toBe("Pinned to project");
    expect(pinOf("p").getAttribute("aria-pressed")).toBe("true");
    expect(pinOf("t").getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(pinOf("p"));
    expect(props.onTogglePin).toHaveBeenCalledWith("p");

    await userEvent.hover(row("t")!);
    await userEvent.click(pinOf("t"));
    expect(props.onTogglePin).toHaveBeenCalledWith("t");

    await page.getByRole("button", { name: "Delete note" }).first().click();
    expect(props.onDelete).toHaveBeenCalledWith("t");

    await page.getByRole("button", { name: "Thread p" }).click();
    expect(onOpenThread).toHaveBeenCalledWith("thread-p");
  });

  it("flashes the highlighted note and scrolls only its own scroller to it", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const props = paneProps({
      notes: ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => note(id)),
    });
    const screen = await mount(props, true);
    const scroller = document.querySelector<HTMLElement>('[data-testid="pane-root"]')!;
    const clip = document.querySelector<HTMLElement>('[data-testid="pane-clip"]')!;

    await screen.rerenderPane({ ...props, highlightId: "b" });
    expect(row("b")?.dataset.highlight).toBe("");
    expect(row("a")?.dataset.highlight).toBeUndefined();
    const card = row("b")!.querySelector(".notes-card")!;
    expect(getComputedStyle(card, "::before").animationName).toBe("notes-flash");

    await screen.rerenderPane({ ...props, highlightId: "h" });
    // Nearest edge: the row ends at the scroller's bottom once the smooth scroll settles.
    await expect
      .poll(
        () =>
          row("h")!.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom <= 1,
      )
      .toBe(true);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(clip.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("disables the composer with a reason", async () => {
    await mount(paneProps({ composerDisabledReason: "Notes are read-only on this connection" }));
    expect(textarea().disabled).toBe(true);
    expect(textarea().placeholder).toBe("Notes are read-only on this connection");
    expect(textarea().title).toBe("Notes are read-only on this connection");
  });

  it("locks note actions when read-only and shows the last error", async () => {
    const props = paneProps({
      notes: [note("a", { body: "[ ] Ship it" })],
      actionsDisabledReason: "Notes are read-only here.",
      error: "Note storage is unavailable.",
    });
    await mount(props);
    const buttons = [
      ...row("a")!.querySelectorAll<HTMLButtonElement>(".notes-check, .notes-acts button"),
    ];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Notes are read-only here.");
    }
    expect(document.querySelector('[data-slot="notes-error"]')?.textContent).toBe(
      "Note storage is unavailable.",
    );
  });

  it("shows the empty state", async () => {
    await mount(paneProps({ notes: [] }));
    expect(document.querySelector('[data-slot="notes-empty"]')?.textContent).toBe(
      "No notes here yet",
    );
  });

  it("hides the title row content when compact", async () => {
    await mount(paneProps({ compact: true }));
    expect(getComputedStyle(document.querySelector(".notes-title")!).display).toBe("none");
    expect(getComputedStyle(document.querySelector(".notes-head-icon")!).display).toBe("none");
    expect(page.getByRole("tablist", { name: "Notes scope" }).element()).toBeTruthy();
  });

  it("focuses the composer when asked", async () => {
    await mount(paneProps({ autoFocusComposer: true }));
    await expect.poll(() => document.activeElement).toBe(textarea());
  });
});
