import "../../../index.css";

import { useState, type ReactElement } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { NOTE_BODY_MAX_LENGTH } from "@ryco/contracts";

import { isMacPlatform } from "~/lib/utils";
import { resetAppearancePreference } from "../../../themes/appearancePreferences";
import { ISLAND_DARK_TOKEN_STYLE } from "../crown/islandTheme";
import { NotesPane, type NotesPaneProps } from "./NotesPane";

function paneProps(overrides: Partial<NotesPaneProps> = {}): NotesPaneProps {
  return {
    view: "worktree",
    onViewChange: vi.fn(),
    body: "",
    onChange: vi.fn(),
    onFlush: vi.fn(),
    saveState: "saved",
    breadcrumb: { project: "ryco", worktree: "notes-panel" },
    disabledReason: null,
    ...overrides,
  };
}

function island(props: NotesPaneProps): ReactElement {
  return (
    <div
      className="dark crown-root"
      data-testid="pane-root"
      style={{ ...ISLAND_DARK_TOKEN_STYLE, width: 340 }}
    >
      <NotesPane {...props} />
    </div>
  );
}

/** Owns the text like the notes binding does, so typing round-trips. */
function Controlled(props: { readonly initial: NotesPaneProps }) {
  const [body, setBody] = useState(props.initial.body);
  return island({
    ...props.initial,
    body,
    onChange: (view, next) => {
      props.initial.onChange(view, next);
      setBody(next);
    },
  });
}

async function mount(props: NotesPaneProps) {
  const screen = await render(island(props));
  return { ...screen, rerenderPane: (next: NotesPaneProps) => screen.rerender(island(next)) };
}

const textarea = () => document.querySelector<HTMLTextAreaElement>(".notes-textarea")!;
const saveState = () => document.querySelector<HTMLElement>('[data-slot="notes-save-state"]');
const thumb = () => document.querySelector<HTMLElement>('.notes-seg > [aria-hidden="true"]')!;
const saveChord = () =>
  isMacPlatform(navigator.platform) ? "{Meta>}{Enter}{/Meta}" : "{Control>}{Enter}{/Control}";

describe("NotesPane", () => {
  afterEach(() => {
    resetAppearancePreference("motion");
    vi.restoreAllMocks();
  });

  it("renders one editor for the view's document, without per-note rows", async () => {
    await mount(paneProps({ body: "First line\n\nSecond paragraph" }));
    expect(document.querySelectorAll(".notes-textarea")).toHaveLength(1);
    expect(textarea().value).toBe("First line\n\nSecond paragraph");
    expect(textarea().getAttribute("aria-label")).toBe("Worktree notes");
    expect(textarea().maxLength).toBe(NOTE_BODY_MAX_LENGTH);
    expect(document.querySelector("[data-note-id], .notes-list, .notes-acts")).toBeNull();
    expect(document.querySelector(".notes-crumb")?.textContent).toContain("›");
    expect(saveState()?.textContent).toBe("Saved");
  });

  it("switches scope with a sliding thumb, saving the view it leaves", async () => {
    const props = paneProps({ body: "Worktree text" });
    const screen = await mount(props);
    await expect.poll(() => thumb().style.width).not.toBe("0px");
    const before = thumb().style.transform;

    await page.getByRole("tab", { name: "Project" }).click();
    expect(props.onFlush).toHaveBeenCalledWith("worktree");
    expect(props.onViewChange).toHaveBeenCalledWith("project");

    await screen.rerenderPane({ ...props, view: "project", body: "" });
    await expect.poll(() => thumb().style.transform).not.toBe(before);
    expect(textarea().placeholder).toBe("Notes for the whole project…");
    expect(textarea().getAttribute("aria-label")).toBe("Project notes");
    expect(document.querySelector(".notes-crumb")?.textContent).toContain("all worktrees");
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

  it("reports typing for the current view and saves on blur and on the save chord", async () => {
    const props = paneProps({ view: "project" });
    await render(<Controlled initial={props} />);
    await userEvent.click(textarea());
    await userEvent.keyboard("Hello");
    expect(textarea().value).toBe("Hello");
    expect(props.onChange).toHaveBeenLastCalledWith("project", "Hello");

    await userEvent.keyboard(saveChord());
    expect(props.onFlush).toHaveBeenCalledWith("project");
    // The chord saves; it does not add a line.
    expect(textarea().value).toBe("Hello");

    vi.mocked(props.onFlush).mockClear();
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(textarea());
    expect(props.onFlush).toHaveBeenCalledWith("project");
  });

  it("grows with its text up to a cap", async () => {
    const props = paneProps();
    const screen = await mount(props);
    const short = textarea().getBoundingClientRect().height;
    await screen.rerenderPane({ ...props, body: "line\n".repeat(80) });
    await expect.poll(() => textarea().getBoundingClientRect().height).toBeGreaterThan(short);
    expect(textarea().getBoundingClientRect().height).toBeLessThanOrEqual(420);
  });

  it("shows where the text stands", async () => {
    const props = paneProps({ saveState: "unsaved" });
    const screen = await mount(props);
    expect(saveState()?.textContent).toBe("Edited");
    await screen.rerenderPane({ ...props, saveState: "saving" });
    expect(saveState()?.textContent).toBe("Saving…");
    expect(saveState()?.dataset.state).toBe("saving");
  });

  it("goes read-only with a reason and shows errors", async () => {
    const props = paneProps({
      body: "Kept",
      disabledReason: "Notes are read-only here.",
      error: "Notes changed elsewhere.",
    });
    await render(<Controlled initial={props} />);
    expect(textarea().readOnly).toBe(true);
    expect(textarea().title).toBe("Notes are read-only here.");
    expect(saveState()).toBeNull();
    // aria-disabled: still focusable and selectable, never editable.
    textarea().focus();
    await userEvent.keyboard("x");
    expect(textarea().value).toBe("Kept");
    expect(props.onChange).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="notes-error"]')?.textContent).toBe(
      "Notes changed elsewhere.",
    );
  });

  it("focuses the editor when asked", async () => {
    await mount(paneProps({ autoFocus: true }));
    await expect.poll(() => document.activeElement).toBe(textarea());
  });
});
