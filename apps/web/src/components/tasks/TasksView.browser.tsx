import "../../index.css";

import { ProjectId, ThreadId } from "@ryco/contracts";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  applyAppearancePreferencesToDocument,
  resetAppearancePreference,
  setAppearancePreference,
} from "../../themes/appearancePreferences";
import { TaskNotes } from "./TaskNotes";
import { TaskStartButton } from "./TaskStartButton";
import { TasksView } from "./TasksView";
import { dueAtForDay } from "./taskDue.logic";
import { TASK_COMPLETE_SETTLE_MS } from "./taskListSettle.logic";
import type {
  TaskChatOption,
  TaskProjectOption,
  TaskView,
  TaskWhereOption,
  TasksViewHandlers,
  TasksViewModel,
} from "./tasksViewModel";

// Sunday, Oct 18 2026, 10:00 local time.
const NOW = new Date(2026, 9, 18, 10).getTime();
const dueIn = (days: number) => dueAtForDay(new Date(2026, 9, 18 + days).getTime());

const project = (id: string, name: string, color: string): TaskProjectOption => ({
  projectId: ProjectId.make(id),
  name,
  color,
});
const RYCO = project("p-ryco", "ryco", "#6366f1");
const INSPECT = project("p-inspect", "cs2inspect-web", "#0ea5e9");
const PAINTS = project("p-paints", "weaponpaints", "#f97316");
const PROJECTS = [RYCO, INSPECT, PAINTS];

const NEW_WORKTREE: TaskWhereOption = {
  id: "worktree",
  kind: "worktree",
  label: "New worktree",
  detail: "task/fix-login-redirect-loop from main",
  hintPrefix: "a new worktree",
  hintRef: "task/fix-login-redirect-loop",
};
const PROJECT_FOLDER: TaskWhereOption = {
  id: "project",
  kind: "project",
  label: "Project folder",
  detail: "No worktree, current branch",
  hintPrefix: "the project folder",
  hintRef: null,
};

function task(overrides: Partial<TaskView> & Pick<TaskView, "id" | "title">): TaskView {
  return {
    notes: "",
    done: false,
    projectId: null,
    dueAt: null,
    links: [],
    files: [],
    chats: [],
    status: null,
    whereOptions: [NEW_WORKTREE, PROJECT_FOLDER],
    starting: false,
    projectLocked: false,
    ...overrides,
  };
}

const EFFECT_THREAD = ThreadId.make("thread-effect");

function fixtures(): TaskView[] {
  return [
    task({
      id: "t1",
      title: "Fix login redirect loop on hosted Hub",
      notes: "After the session cookie expires, /pair redirects to / and back.",
      projectId: RYCO.projectId,
      dueAt: dueIn(2),
      links: [{ kind: "issue", number: 231 }],
      files: [{ key: "f1", name: "loop.png", type: "image", progress: null, error: null }],
    }),
    task({
      id: "t2",
      title: "Upgrade Effect to 4.1 in the server",
      projectId: RYCO.projectId,
      status: "needs-you",
      projectLocked: true,
      links: [
        { kind: "branch", name: "effect-4-1-prep" },
        { kind: "thread", threadId: EFFECT_THREAD },
      ],
      chats: [
        {
          key: "c1",
          threadId: EFFECT_THREAD,
          title: "Effect migration chat",
          modelLabel: "Opus 5.5",
          status: "needs-you",
          branch: "task/effect-4-1",
          linked: false,
          error: null,
        },
      ],
    }),
    task({
      id: "t3",
      title: "Float range filter in skin search",
      projectId: INSPECT.projectId,
      dueAt: dueIn(6),
      files: [{ key: "up-1", name: "spec.pdf", type: "file", progress: 0.4, error: null }],
    }),
    task({ id: "t4", title: "Renew Apple developer certificate", dueAt: dueIn(-1) }),
    task({
      id: "t6",
      title: "Migrate weapon paints store to Pinia",
      projectId: PAINTS.projectId,
      status: "running",
      projectLocked: true,
      chats: [
        {
          key: "c2",
          threadId: ThreadId.make("thread-pinia"),
          title: null,
          modelLabel: "GPT-5.6",
          status: "running",
          branch: "task/pinia-store",
          linked: false,
          error: null,
        },
      ],
    }),
    task({
      id: "t5",
      title: "Simplify chat header breadcrumbs",
      projectId: RYCO.projectId,
      done: true,
      links: [{ kind: "pr", number: 745 }],
    }),
  ];
}

const CHAT_OPTIONS: ReadonlyArray<TaskChatOption> = [
  { threadId: ThreadId.make("thread-hub"), title: "Hub reconnect investigation", subtitle: "ryco" },
  { threadId: ThreadId.make("thread-pwa"), title: "PWA install prompt", subtitle: "ryco" },
];

type Handler<K extends keyof TasksViewHandlers> = TasksViewHandlers[K];

function makeSpies() {
  return {
    onFilterChange: vi.fn<Handler<"onFilterChange">>(),
    onAdd: vi.fn<Handler<"onAdd">>(),
    onToggleDone: vi.fn<Handler<"onToggleDone">>(),
    onToggleExpanded: vi.fn<Handler<"onToggleExpanded">>(),
    onToggleShowDone: vi.fn<Handler<"onToggleShowDone">>(),
    onTitleChange: vi.fn<Handler<"onTitleChange">>(),
    onNotesChange: vi.fn<Handler<"onNotesChange">>(),
    onProjectChange: vi.fn<Handler<"onProjectChange">>(),
    onDueChange: vi.fn<Handler<"onDueChange">>(),
    onAddLink: vi.fn<Handler<"onAddLink">>(),
    onRemoveLink: vi.fn<Handler<"onRemoveLink">>(),
    onAddFiles: vi.fn<Handler<"onAddFiles">>(),
    onRemoveFile: vi.fn<Handler<"onRemoveFile">>(),
    onStart: vi.fn<Handler<"onStart">>(),
    onOpenChat: vi.fn<Handler<"onOpenChat">>(),
    onDelete: vi.fn<Handler<"onDelete">>(),
    onPrepareStart: vi.fn<Handler<"onPrepareStart">>(),
    getChatOptions: vi.fn<Handler<"getChatOptions">>(() => CHAT_OPTIONS),
  } satisfies TasksViewHandlers;
}
type Spies = ReturnType<typeof makeSpies>;

/** Plays the integration's part: applies every change at once, as the optimistic store does. */
function Harness(props: { readonly spies: Spies }) {
  const { spies } = props;
  const [tasks, setTasks] = useState(fixtures);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [filterProjectId, setFilterProjectId] = useState<ProjectId | null>(null);
  const handlers = useMemo<TasksViewHandlers>(() => {
    let created = 0;
    return {
      ...spies,
      onFilterChange: (projectId) => {
        spies.onFilterChange(projectId);
        setFilterProjectId(projectId);
      },
      onAdd: (inputs, options) => {
        spies.onAdd(inputs, options);
        const added = inputs.map((input) => task({ id: `new-${++created}`, ...input }));
        setTasks((previous) => [...added, ...previous]);
      },
      onToggleDone: (taskId, done) => {
        spies.onToggleDone(taskId, done);
        setTasks((previous) =>
          previous.map((entry) => (entry.id === taskId ? { ...entry, done } : entry)),
        );
      },
      onToggleExpanded: (taskId) => {
        spies.onToggleExpanded(taskId);
        setExpandedTaskId((current) => (current === taskId ? null : taskId));
      },
      onToggleShowDone: () => {
        spies.onToggleShowDone();
        setShowDone((current) => !current);
      },
    };
  }, [spies]);
  const model = useMemo<TasksViewModel>(() => {
    const visible = tasks.filter(
      (entry) => filterProjectId === null || entry.projectId === filterProjectId,
    );
    return {
      openTasks: visible.filter((entry) => !entry.done),
      doneTasks: visible.filter((entry) => entry.done),
      projects: PROJECTS,
      filterProjects: PROJECTS,
      filterProjectId,
      expandedTaskId,
      showDone,
      now: NOW,
      loading: false,
    };
  }, [expandedTaskId, filterProjectId, showDone, tasks]);
  return <TasksView model={model} handlers={handlers} />;
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mount(width = 680): Promise<Spies> {
  const spies = makeSpies();
  mounted = await render(
    <div style={{ width, padding: 24 }}>
      <Harness spies={spies} />
    </div>,
  );
  return spies;
}

function rowElement(taskId: string, list?: "open" | "done"): HTMLElement | null {
  const scope = list ? `[data-task-list="${list}"] ` : "";
  return document.querySelector<HTMLElement>(`${scope}[data-task-id="${taskId}"]`);
}

// Rows are queried in the DOM rather than through locators: a locator for a
// row is keyed on its text, which changes as the row is edited.

/** A button in a row by its accessible name: its label, else its text. */
function rowButton(taskId: string, name: string | RegExp): HTMLButtonElement {
  const buttons = Array.from(rowElement(taskId)?.querySelectorAll("button") ?? []);
  const found = buttons.find((button) => {
    const label = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!found) throw new Error(`no button ${String(name)} in ${taskId}`);
  return found;
}

/** A labelled field in a row. */
function rowField(taskId: string, label: string): HTMLInputElement | HTMLTextAreaElement {
  const field = rowElement(taskId)?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `input[aria-label="${label}"], textarea[aria-label="${label}"]`,
  );
  if (!field) throw new Error(`no field ${label} in ${taskId}`);
  return field;
}

const addInput = () => page.getByRole("textbox", { name: "Add a task" });

function paste(text: string): boolean {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  return addInput()
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
}

async function openRow(taskId: string, title: string) {
  await userEvent.click(rowButton(taskId, title));
  await vi.waitFor(() => {
    expect(rowElement(taskId)?.hasAttribute("data-open")).toBe(true);
  });
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
  resetAppearancePreference("motion");
  applyAppearancePreferencesToDocument();
});

describe("TasksView", () => {
  it("lists the open tasks with their meta and counts them", async () => {
    await mount();
    await expect.element(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await expect.element(page.getByText("5 open")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Completed · 1" })).toBeVisible();
    expect(rowElement("t5", "open")).toBeNull();
    // The meta line: the issue, the file count, the due day and the project.
    const meta = rowElement("t1")!.textContent ?? "";
    expect(meta).toContain("#231");
    expect(meta).toContain("Tue");
    expect(meta).toContain("ryco");
    expect(rowElement("t2")!.textContent).toContain("Needs you");
  });

  it("adds a task on Enter, reading #project and due: as chips while typing", async () => {
    const spies = await mount();
    const input = addInput();
    await input.click();
    expect(input.element().getAttribute("placeholder")).toBe("Add a task…   #project  due:fri");
    await input.fill("Fix login #ryco due:fri");
    const label = input.element().closest("label")!;
    await vi.waitFor(() => {
      expect(label.textContent).toContain("ryco");
      expect(label.textContent).toContain("Fri");
    });

    await userEvent.keyboard("{Enter}");
    expect(spies.onAdd).toHaveBeenCalledWith(
      [{ title: "Fix login", projectId: RYCO.projectId, dueAt: dueIn(5) }],
      { start: false },
    );
    expect((input.element() as HTMLInputElement).value).toBe("");
    // The new row settles in; rows that were already there don't.
    await vi.waitFor(() => {
      expect(rowElement("new-1", "open")?.hasAttribute("data-enter")).toBe(true);
    });
    expect(rowElement("t1")?.hasAttribute("data-enter")).toBe(false);
    await expect.element(page.getByText("6 open")).toBeVisible();
  });

  it("adds and starts with Ctrl+Enter", async () => {
    const spies = await mount();
    await addInput().fill("Write release notes");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(spies.onAdd).toHaveBeenCalledWith(
      [{ title: "Write release notes", projectId: null, dueAt: null }],
      { start: true },
    );
  });

  it("adds one task per pasted line, in the filtered project", async () => {
    const spies = await mount();
    await page.getByRole("button", { name: "cs2inspect-web", exact: true }).click();
    expect(spies.onFilterChange).toHaveBeenCalledWith(INSPECT.projectId);
    await expect.element(page.getByText("1 open")).toBeVisible();

    await addInput().click();
    const pastedByBrowser = paste(
      "- Two-thumb slider\n- Persist in the URL #ryco\n3. Reset button",
    );
    expect(pastedByBrowser).toBe(false);
    expect(spies.onAdd).toHaveBeenCalledWith(
      [
        { title: "Two-thumb slider", projectId: INSPECT.projectId, dueAt: null },
        { title: "Persist in the URL", projectId: RYCO.projectId, dueAt: null },
        { title: "Reset button", projectId: INSPECT.projectId, dueAt: null },
      ],
      { start: false },
    );
    // The ryco task is filtered out; the other two settle in.
    await vi.waitFor(() => {
      expect(rowElement("new-1")?.hasAttribute("data-enter")).toBe(true);
      expect(rowElement("new-3")?.hasAttribute("data-enter")).toBe(true);
    });
    expect(rowElement("new-2")).toBeNull();

    // A single line pastes as text.
    expect(paste("just one line")).toBe(true);
  });

  it("holds a checked task in place before it moves to Completed", async () => {
    const spies = await mount();
    let clickedAt = 0;
    document.addEventListener("click", () => (clickedAt = performance.now()), {
      capture: true,
      once: true,
    });
    let movedAt = 0;
    const list = document.querySelector('[data-task-list="open"]')!;
    const observer = new MutationObserver(() => {
      if (movedAt === 0 && !rowElement("t1", "open")) movedAt = performance.now();
    });
    observer.observe(list, { childList: true });

    const box = page.getByRole("button", { name: "Done: Fix login redirect loop on hosted Hub" });
    await box.click();
    expect(spies.onToggleDone).toHaveBeenCalledWith("t1", true);
    // Still in its place among the open tasks, already checked and struck through.
    const held = rowElement("t1", "open");
    expect(held?.hasAttribute("data-done")).toBe(true);
    expect(box.element().getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(held!.querySelector(".tsk-title")!).textDecorationLine).toBe(
      "line-through",
    );
    expect(rowElement("t2", "open")).not.toBeNull();

    await vi.waitFor(() => expect(movedAt).toBeGreaterThan(0), { timeout: 3_000 });
    observer.disconnect();
    expect(movedAt - clickedAt).toBeGreaterThanOrEqual(TASK_COMPLETE_SETTLE_MS - 5);
    await expect.element(page.getByText("4 open")).toBeVisible();

    const completed = page.getByRole("button", { name: "Completed · 2" });
    await completed.click();
    expect(completed.element().getAttribute("aria-expanded")).toBe("true");
    await vi.waitFor(() => {
      expect(rowElement("t1", "done")?.hasAttribute("data-done")).toBe(true);
    });
    // Unchecking holds it in the Completed list the same way.
    await userEvent.click(rowButton("t1", /^Done:/));
    expect(spies.onToggleDone).toHaveBeenLastCalledWith("t1", false);
    expect(rowElement("t1", "done")?.hasAttribute("data-done")).toBe(false);
    await vi.waitFor(() => expect(rowElement("t1", "open")).not.toBeNull(), { timeout: 3_000 });
  });

  it("opens a row from its line, warms Start, and closes with Escape", async () => {
    const spies = await mount();
    const line = rowButton("t1", "Fix login redirect loop on hosted Hub");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(line);
    expect(spies.onToggleExpanded).toHaveBeenCalledWith("t1");
    await vi.waitFor(() => expect(line.getAttribute("aria-expanded")).toBe("true"));
    await vi.waitFor(() => expect(spies.onPrepareStart).toHaveBeenCalledWith("t1"));

    const details = document.getElementById(line.getAttribute("aria-controls")!)!;
    expect(details.inert).toBe(false);
    // Height only, on the disclosure token and the house curve.
    expect(getComputedStyle(details).transitionProperty).toBe("grid-template-rows");
    expect(getComputedStyle(details).transitionDuration).toBe("0.32s");
    expect(getComputedStyle(details).transitionTimingFunction).toBe(
      "cubic-bezier(0.16, 1, 0.3, 1)",
    );
    expect(rowField("t1", "Notes").value).toBe(
      "After the session cookie expires, /pair redirects to / and back.",
    );
    expect(details.textContent).toContain("in a new worktree · task/fix-login-redirect-loop");

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(line.getAttribute("aria-expanded")).toBe("false"));
    expect(details.inert).toBe(true);
  });

  it("starts in the default place, or in the one picked from the ▾ menu", async () => {
    const spies = await mount();
    await openRow("t1", "Fix login redirect loop on hosted Hub");
    await userEvent.click(rowButton("t1", "Start chat"));
    expect(spies.onStart).toHaveBeenLastCalledWith("t1");

    await userEvent.click(rowButton("t1", "Where"));
    await expect.element(page.getByRole("menuitem", { name: /New worktree/ })).toBeVisible();
    await expect.element(page.getByText("task/fix-login-redirect-loop from main")).toBeVisible();
    await page.getByRole("menuitem", { name: /Project folder/ }).click();
    expect(spies.onStart).toHaveBeenLastCalledWith("t1", "project");
  });

  it("starts from the row's hover Start, and only while the task has no chats", async () => {
    const spies = await mount();
    const start = rowButton("t1", "Start");
    await userEvent.hover(page.getByRole("heading", { name: "Tasks" }));
    await vi.waitFor(() => expect(getComputedStyle(start).opacity).toBe("0"));
    await userEvent.hover(rowElement("t1")!);
    await vi.waitFor(() => expect(getComputedStyle(start).opacity).toBe("1"));
    await userEvent.click(start);
    expect(spies.onStart).toHaveBeenLastCalledWith("t1");
    expect(rowElement("t2")!.querySelector(".tsk-go")).toBeNull();
  });

  it("deletes a task and opens its chats", async () => {
    const spies = await mount();
    await openRow("t2", "Upgrade Effect to 4.1 in the server");
    expect(rowButton("t2", "Another chat")).toBeTruthy();
    await userEvent.click(rowButton("t2", /Open chat/));
    expect(spies.onOpenChat).toHaveBeenCalledWith("t2", EFFECT_THREAD);
    await userEvent.click(rowButton("t2", "Delete"));
    expect(spies.onDelete).toHaveBeenCalledWith("t2");
  });

  it("shows Overdue in amber for a past due date, and close dates in amber", async () => {
    await mount();
    const overdue = rowElement("t4")!.querySelector<HTMLElement>("[data-task-due]")!;
    expect(overdue.textContent).toBe("Overdue");
    const soon = rowElement("t1")!.querySelector<HTMLElement>("[data-task-due]")!;
    const later = rowElement("t3")!.querySelector<HTMLElement>("[data-task-due]")!;
    expect(later.textContent).toBe("Sat");
    expect(getComputedStyle(overdue).color).toBe(getComputedStyle(soon).color);
    expect(getComputedStyle(overdue).color).not.toBe(getComputedStyle(later).color);
  });

  it("edits the title inline while open, and Escape undoes the edit", async () => {
    const spies = await mount();
    await openRow("t3", "Float range filter in skin search");
    const title = rowField("t3", "Title");
    await userEvent.fill(title, "Float range filter");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(title.value).toBe("Float range filter in skin search"));
    expect(rowElement("t3")?.hasAttribute("data-open")).toBe(true);
    expect(spies.onTitleChange).not.toHaveBeenCalled();

    await userEvent.fill(title, "Float range filter");
    await userEvent.keyboard("{Enter}");
    expect(spies.onTitleChange).toHaveBeenCalledWith("t3", "Float range filter");

    // With nothing left to undo, Escape closes the row and focus stays on its line.
    await userEvent.fill(title, "Float range filter in skin search");
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(rowElement("t3")?.hasAttribute("data-open")).toBe(false));
    expect(document.activeElement).toBe(rowButton("t3", "Float range filter in skin search"));
  });

  it("saves notes after a pause, and at once when the row closes", async () => {
    const spies = await mount();
    await openRow("t3", "Float range filter in skin search");
    const notes = rowField("t3", "Notes");
    await userEvent.fill(notes, "Two thumbs");
    expect(spies.onNotesChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(spies.onNotesChange).toHaveBeenCalledWith("t3", "Two thumbs"));

    await userEvent.fill(notes, "Two thumbs, persisted");
    await userEvent.keyboard("{Escape}");
    expect(spies.onNotesChange).toHaveBeenLastCalledWith("t3", "Two thumbs, persisted");
    expect(spies.onNotesChange).toHaveBeenCalledTimes(2);
    // Focus goes back to the row's line rather than to the page.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(rowButton("t3", "Float range filter in skin search")),
    );
  });

  it("shows the task's notes again on blur when a save was undone while typing", async () => {
    const onNotesChange = vi.fn();
    const notesOf = (notes: string) => (
      <TaskNotes taskId="t1" notes={notes} open onNotesChange={onNotesChange} />
    );
    mounted = await render(notesOf(""));
    const field = page.getByRole("textbox", { name: "Notes" });
    await field.fill("abc");
    await vi.waitFor(() => expect(onNotesChange).toHaveBeenCalledWith("t1", "abc"));
    // The save shows at once, then is rolled back while the field still has focus.
    await mounted.rerender(notesOf("abc"));
    await mounted.rerender(notesOf(""));
    expect(field.element()).toHaveValue("abc");
    (field.element() as HTMLTextAreaElement).blur();
    await vi.waitFor(() => expect(field.element()).toHaveValue(""));
    // Someone else's edit that lands while it is focused shows once it is left.
    (field.element() as HTMLTextAreaElement).focus();
    await mounted.rerender(notesOf("Theirs"));
    (field.element() as HTMLTextAreaElement).blur();
    await vi.waitFor(() => expect(field.element()).toHaveValue("Theirs"));
    expect(onNotesChange).toHaveBeenCalledTimes(1);
  });

  it("holds Delete while a start is in flight", async () => {
    const onDelete = vi.fn();
    const handlers = { onStart: vi.fn(), onDelete, onPrepareStart: vi.fn() };
    const starting = task({ id: "t-start", title: "Starting", starting: true });
    mounted = await render(<TaskStartButton task={starting} handlers={handlers} />);
    const remove = page.getByRole("button", { name: "Delete" });
    await expect.element(remove).toBeDisabled();
    await mounted.rerender(
      <TaskStartButton task={{ ...starting, starting: false }} handlers={handlers} />,
    );
    await remove.click();
    expect(onDelete).toHaveBeenCalledWith("t-start");
  });

  it("links a pull request and an existing chat from the Link popover", async () => {
    const spies = await mount();
    await openRow("t3", "Float range filter in skin search");
    await userEvent.click(rowButton("t3", "Link"));
    await page.getByRole("button", { name: /Pull request/ }).click();
    const field = page.getByRole("textbox", { name: "Pull request" });
    await field.fill("https://github.com/acme/app/issues/9");
    await expect.element(page.getByText("Adds Issue #9")).toBeVisible();
    await field.fill("#752");
    await expect.element(page.getByText("Adds Pull request #752")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(spies.onAddLink).toHaveBeenCalledWith("t3", { kind: "pr", number: 752 });

    await userEvent.click(rowButton("t3", "Link"));
    await page.getByRole("button", { name: /Existing chat/ }).click();
    await page.getByRole("combobox", { name: "Search chats" }).fill("pwa");
    await page.getByRole("option", { name: /PWA install prompt/ }).click();
    expect(spies.onAddLink).toHaveBeenLastCalledWith("t3", {
      kind: "thread",
      threadId: ThreadId.make("thread-pwa"),
    });
  });

  it("sets a due day from the calendar's quick picks", async () => {
    const spies = await mount();
    await openRow("t3", "Float range filter in skin search");
    await userEvent.click(rowButton("t3", "Sat"));
    await page.getByRole("button", { name: "Tomorrow" }).click();
    expect(spies.onDueChange).toHaveBeenCalledWith("t3", dueIn(1));
  });

  it("shows every link in the meta line, a linked chat by its title", async () => {
    await mount();
    const meta = rowElement("t2")!.textContent ?? "";
    expect(meta).toContain("effect-4-1-prep");
    expect(meta).toContain("Effect migration chat");
    await openRow("t2", "Upgrade Effect to 4.1 in the server");
    // The chip follows the chat's own title, not a list read once.
    expect(rowButton("t2", "Unlink Chat").parentElement!.textContent).toContain(
      "Effect migration chat",
    );
  });

  it("keeps the project fixed once a task has chats", async () => {
    const spies = await mount();
    await openRow("t2", "Upgrade Effect to 4.1 in the server");
    const chip = rowButton("t2", "Project: ryco");
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    // Playwright won't click an aria-disabled control; a real click would still land.
    chip.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(page.getByRole("menu").elements()).toHaveLength(0);
    expect(spies.onProjectChange).not.toHaveBeenCalled();
  });

  it("shows upload progress, removes files, and adds dropped ones", async () => {
    const spies = await mount();
    await openRow("t3", "Float range filter in skin search");
    const chip = rowButton("t3", "Remove spec.pdf").parentElement!;
    expect(chip.hasAttribute("data-uploading")).toBe(true);
    expect(chip.getAttribute("aria-busy")).toBe("true");
    expect(chip.style.getPropertyValue("--tsk-progress")).toBe("0.4");
    await userEvent.click(rowButton("t3", "Remove spec.pdf"));
    expect(spies.onRemoveFile).toHaveBeenCalledWith("t3", "up-1");

    const area = rowElement("t3")!.querySelector<HTMLElement>(".tsk-inner")!;
    const dataTransfer = new DataTransfer();
    const file = new File(["# notes"], "notes.md", { type: "text/markdown" });
    dataTransfer.items.add(file);
    const over = new DragEvent("dragover", { dataTransfer, bubbles: true, cancelable: true });
    area.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(area.hasAttribute("data-drop")).toBe(true));
    area.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
    expect(spies.onAddFiles).toHaveBeenCalledWith("t3", [file]);
    await vi.waitFor(() => expect(area.hasAttribute("data-drop")).toBe(false));
  });

  it("hides the project name in the meta line when the column is narrow", async () => {
    await mount(520);
    const meta = rowElement("t3")!.querySelector("[data-task-due]")!.parentElement!;
    const projectName = Array.from(meta.children).find((child) =>
      child.textContent?.includes("cs2inspect-web"),
    )!;
    expect(getComputedStyle(projectName).display).toBe("none");
    await mounted?.unmount();
    await mount(680);
    const wide = rowElement("t3")!.querySelector("[data-task-due]")!.parentElement!;
    const shown = Array.from(wide.children).find((child) =>
      child.textContent?.includes("cs2inspect-web"),
    )!;
    expect(getComputedStyle(shown).display).not.toBe("none");
  });

  it("stays still under reduced motion: no entrance, no disclosure, paused status", async () => {
    setAppearancePreference("motion", "reduce");
    applyAppearancePreferencesToDocument();
    const spies = await mount();
    await addInput().fill("Quiet task");
    await userEvent.keyboard("{Enter}");
    expect(spies.onAdd).toHaveBeenCalledOnce();
    const added = await vi.waitFor(() => {
      const element = rowElement("new-1");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(getComputedStyle(added).animationDuration).toBe("0s");
    expect(getComputedStyle(added).opacity).toBe("1");

    await openRow("t1", "Fix login redirect loop on hosted Hub");
    const details = rowElement("t1")!.querySelector<HTMLElement>(".tsk-more")!;
    expect(getComputedStyle(details).transitionDuration).toBe("0s");
    const dot = rowElement("t6")!.querySelector<HTMLElement>(".tsk-st-dot")!;
    expect(getComputedStyle(dot).animationPlayState).toBe("paused");
  });
});
