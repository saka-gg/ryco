import { page } from "vite-plus/test/browser";
import "../index.css";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { render } from "vitest-browser-react";
import {
  EnvironmentId,
  ThreadId,
  type DesktopBridge,
  type ProjectBrowserPickResult,
  type ProjectBrowserState,
  type ProjectBrowserTab,
  type ProjectBrowserSurface,
} from "@ryco/contracts";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type {
  ComposerContextDelivery,
  ComposerContextItem,
} from "@ryco/client-runtime/state/composer";
import { composerContextIntake } from "../composerContextIntake";
import { BROWSER_PICK_NOTICE_MS } from "./BrowserElementPicker";
import { BrowserPanel } from "./BrowserPanel";
import { ProjectBrowserPreview } from "./ProjectBrowserPreview";
import { BackgroundBrowserPreview } from "./BackgroundBrowserPreview";
import { useBrowserUi } from "./browserState";
const previous = window.desktopBridge;
afterEach(() => {
  if (previous) window.desktopBridge = previous;
  else delete window.desktopBridge;
  useBrowserUi.setState({ native: { tabs: [] }, fallback: [], selected: {} });
});
function setup(options: { readonly pick?: boolean } = {}) {
  let state: ProjectBrowserState = { tabs: [] };
  const listeners = new Set<(state: ProjectBrowserState) => void>();
  const open = vi.fn(async ({ url, project }: { url: string; project: string }) => {
    const tab: ProjectBrowserTab = {
      id: "tab-1",
      title: "Fixture",
      url,
      project,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoom: 1,
      presentation: "background",
      error: null,
    };
    state = { tabs: [tab] };
    listeners.forEach((listener) => listener(state));
    return tab.id;
  });
  const api = {
    getState: async () => state,
    open,
    onState: (listener: (state: ProjectBrowserState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onFocusAddress: () => () => {},
    discover: vi.fn(async () => [
      { url: "http://localhost:3000/", port: 3000, process: "node", projectMatch: false },
    ]),
    command: vi.fn(async () => {}),
    surface: vi.fn(async (_input: ProjectBrowserSurface) => {}),
    capture: vi.fn(async () => ""),
    // Pending until a test settles it, like a pick waiting for the user's click.
    pick: vi.fn((_tab: string) => new Promise<ProjectBrowserPickResult>(() => {})),
  };
  window.desktopBridge = {
    browser: options.pick === false ? { ...api, pick: undefined } : api,
  } as unknown as DesktopBridge;
  return api;
}

it("shows a background thumbnail without mounting the page and opens the workspace only on click", async () => {
  const api = setup();
  const src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="teal"/></svg>')}`;
  api.capture.mockResolvedValue(src);
  await api.open({ url: "http://localhost:3000/", project: '[null,"/project"]' });
  const onOpen = vi.fn();
  const view = await render(
    <BackgroundBrowserPreview environmentId={null} cwd="/project" onOpen={onOpen} />,
  );
  await expect.element(view.getByRole("img", { name: "Browser preview" })).toBeVisible();
  expect(api.surface).not.toHaveBeenCalled();
  expect(api.command).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  await view.getByRole("button", { name: "Open browser in workspace" }).click();
  expect(onOpen).toHaveBeenCalledOnce();
  const before = api.capture.mock.calls.length;
  await view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect(api.capture).toHaveBeenCalledTimes(before);
});
it("discovers a local site and opens it in the same project browser", async () => {
  await page.viewport(1200, 900);
  const api = setup();
  const view = await render(
    <div style={{ display: "flex", height: 600, width: 800 }}>
      <BrowserPanel environmentId={null} cwd="/project" />
    </div>,
  );
  await expect
    .element(view.getByRole("button", { name: "http://localhost:3000/ node" }))
    .toBeVisible();
  await view.getByRole("button", { name: "http://localhost:3000/ node" }).click();
  expect(api.open).toHaveBeenCalledWith({
    url: "http://localhost:3000/",
    project: '[null,"/project"]',
  });
  await expect.element(view.getByRole("tab", { name: "Fixture" })).toBeVisible();
  await expect
    .element(view.getByRole("textbox", { name: "Browser address" }))
    .toHaveValue("http://localhost:3000/");
  await expect.poll(() => api.surface.mock.calls.at(-1)?.[0]).toMatchObject({ tab: "tab-1" });
  await view.unmount();
  expect(api.surface).toHaveBeenLastCalledWith(expect.objectContaining({ tab: null }));
});
it("rejects unsupported URL schemes before desktop IPC", async () => {
  await page.viewport(1200, 900);
  const api = setup();
  const view = await render(
    <div style={{ display: "flex", height: 600, width: 800 }}>
      <BrowserPanel environmentId={null} cwd="/project" />
    </div>,
  );
  await view.getByRole("textbox", { name: "Browser address" }).fill("file:///etc/passwd");
  await view.getByRole("button", { name: "Go", exact: true }).click();
  await expect.element(view.getByRole("alert")).toMatchTextContent("HTTP(S)");
  expect(api.open).not.toHaveBeenCalled();
});
it("ignores discovery results from the previous project", async () => {
  await page.viewport(1200, 900);
  const api = setup();
  let finishOld: ((sites: Awaited<ReturnType<typeof api.discover>>) => void) | undefined;
  api.discover.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const view = await render(<BrowserPanel environmentId={null} cwd="/old-project" />);
  await expect.poll(() => api.discover.mock.calls.length).toBe(1);
  await view.rerender(<BrowserPanel environmentId={null} cwd="/new-project" />);
  await expect
    .element(view.getByRole("button", { name: "http://localhost:3000/ node" }))
    .toBeVisible();
  finishOld?.([{ url: "http://localhost:9999/", port: 9999, process: "old", projectMatch: true }]);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await expect
    .element(view.getByRole("button", { name: "http://localhost:3000/ node" }))
    .toBeVisible();
  await expect
    .element(view.getByRole("button", { name: /localhost:9999/ }))
    .not.toBeInTheDocument();
});
it("keeps agent permissions separate from manual browsing and exposes stop", async () => {
  await page.viewport(1200, 900);
  const api = setup();
  const stop = vi.fn(async () => {});
  window.desktopBridge = {
    ...window.desktopBridge,
    computerUse: { stop },
  } as unknown as DesktopBridge;
  const view = await render(
    <div style={{ display: "flex", height: 600, width: 800 }}>
      <BrowserPanel environmentId={null} cwd="/project" />
    </div>,
  );
  await view.getByRole("textbox", { name: "Browser address" }).fill("localhost:3000");
  await view.getByRole("button", { name: "Go", exact: true }).click();
  await expect.element(view.getByRole("button", { name: "Stop agent" })).toBeVisible();
  await view.getByRole("button", { name: "Stop agent" }).click();
  expect(stop).toHaveBeenCalledOnce();
  await view.getByRole("button", { name: "Pop out" }).click();
  expect(api.command).toHaveBeenCalledWith({ action: "popout", tab: "tab-1" });
});

it("hides the native view while another dialog covers Ryco and restores it afterward", async () => {
  await page.viewport(1200, 900);
  const api = setup();
  const view = await render(
    <div style={{ display: "flex", height: 600, width: 800 }}>
      <BrowserPanel environmentId={null} cwd="/project" />
    </div>,
  );
  await view.getByRole("textbox", { name: "Browser address" }).fill("localhost:3000");
  await view.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => api.surface.mock.calls.at(-1)?.[0].tab).toBe("tab-1");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  try {
    await expect.poll(() => api.surface.mock.calls.at(-1)?.[0].tab).toBeNull();
  } finally {
    dialog.remove();
  }
  await expect.poll(() => api.surface.mock.calls.at(-1)?.[0].tab).toBe("tab-1");
});

it("attaches the live preview inside its own popup and detaches when closed", async () => {
  await page.viewport(1200, 900);
  const api = setup();
  const view = await render(<ProjectBrowserPreview environmentId={null} cwd="/project" />);
  await view.getByRole("button", { name: "Live preview" }).click();
  await page.getByRole("textbox", { name: "Browser address" }).fill("localhost:3000");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => api.surface.mock.calls.at(-1)?.[0].tab).toBe("tab-1");
  await view.getByRole("button", { name: "Live preview" }).click();
  await expect.poll(() => api.surface.mock.calls.at(-1)?.[0].tab).toBeNull();
});

it("navigates the current web preview instead of creating another tab", async () => {
  await page.viewport(1200, 900);
  delete window.desktopBridge;
  const view = await render(<BrowserPanel environmentId={null} cwd="/project" />);
  const address = view.getByRole("textbox", { name: "Browser address" });
  await address.fill(`${location.origin}/first-preview`);
  await view.getByRole("button", { name: "Go", exact: true }).click();
  const firstId = useBrowserUi.getState().fallback[0]?.id;
  await address.fill(`${location.origin}/second-preview`);
  await view.getByRole("button", { name: "Go", exact: true }).click();
  expect(useBrowserUi.getState().fallback).toHaveLength(1);
  expect(useBrowserUi.getState().fallback[0]).toMatchObject({
    id: firstId,
    url: `${location.origin}/second-preview`,
  });
});

it("offers explicit one-use popup consent, blocked recovery and cancellation", async () => {
  await page.viewport(1200, 900);
  const api = setup();
  const view = await render(<BrowserPanel environmentId={null} cwd="/project" />);
  await view.getByRole("textbox", { name: "Browser address" }).fill("localhost:3000");
  await view.getByRole("button", { name: "Go", exact: true }).click();
  const update = (signInPopup: NonNullable<ProjectBrowserTab["signInPopup"]>) => {
    const native = useBrowserUi.getState().native;
    useBrowserUi.setState({
      native: { tabs: native.tabs.map((tab) => Object.assign({}, tab, { signInPopup })) },
    });
  };
  update("blocked");
  await expect.element(view.getByRole("status")).toMatchTextContent("Popup blocked");
  await view.getByRole("button", { name: "Allow sign-in popup" }).click();
  expect(api.command).toHaveBeenLastCalledWith({ action: "allow-sign-in", tab: "tab-1" });
  update("armed");
  await expect.element(view.getByRole("status")).toMatchTextContent("30 seconds");
  await view.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  expect(api.command).toHaveBeenLastCalledWith({ action: "cancel-sign-in", tab: "tab-1" });
  update("open");
  await view.getByRole("button", { name: "Close sign-in popup" }).click();
  expect(api.command).toHaveBeenLastCalledWith({ action: "cancel-sign-in", tab: "tab-1" });
  update("failed");
  await expect.element(view.getByRole("status")).toMatchTextContent("could not load");
  api.command.mockRejectedValueOnce(
    new Error("Show and focus this browser tab before allowing sign-in."),
  );
  await view.getByRole("button", { name: "Allow sign-in popup" }).click();
  await expect.element(view.getByRole("alert")).toMatchTextContent("Show and focus");
});

it("marks suspended tabs and reloads them by showing them", async () => {
  await page.viewport(1200, 900);
  const api = setup();
  const view = await render(
    <div style={{ display: "flex", height: 600, width: 800 }}>
      <BrowserPanel environmentId={null} cwd="/project" />
    </div>,
  );
  await view.getByRole("textbox", { name: "Browser address" }).fill("localhost:3000");
  await view.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => api.surface.mock.calls.at(-1)?.[0].tab).toBe("tab-1");
  // The desktop suspended another tab of this project to save memory.
  const [live] = useBrowserUi.getState().native.tabs;
  if (!live) throw new Error("No browser tab.");
  useBrowserUi.setState({
    native: {
      tabs: [
        live,
        { ...live, id: "tab-2", title: "Docs", url: "http://localhost:3000/docs", suspended: true },
      ],
    },
  });
  const suspended = view.getByRole("tab", { name: /suspended/ });
  await expect.element(suspended).toBeVisible();
  await expect
    .element(suspended)
    .toHaveAttribute("title", "Suspended to save memory. Reloads when you open it.");
  await expect.element(view.getByRole("tab", { name: "Fixture" })).not.toHaveAttribute("title");
  // Showing it is what reloads it: the desktop revives a tab when it is surfaced.
  await suspended.click();
  await expect.poll(() => api.surface.mock.calls.at(-1)?.[0].tab).toBe("tab-2");
});

const PICK_THREAD = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const pickedElement = {
  url: "http://localhost:3000/settings",
  pageTitle: "Settings",
  selector: "#save",
  tagName: "button",
  role: "button",
  name: "Save changes",
  text: "Save changes",
  box: { x: 10, y: 20, width: 120, height: 32 },
} as const;

/** A composer for `PICK_THREAD` that answers with `result` and records what it got. */
function listen(result: ComposerContextDelivery = "added") {
  const received: ComposerContextItem[] = [];
  const release = composerContextIntake.register(PICK_THREAD, (item) => {
    received.push(item);
    return result;
  });
  return { received, release };
}

/** Opens a tab through the address bar of a thread's Browser panel. */
async function renderThreadPanel(thread: typeof PICK_THREAD | null = PICK_THREAD) {
  await page.viewport(1200, 900);
  const view = await render(
    <div style={{ display: "flex", height: 600, width: 800 }}>
      <BrowserPanel environmentId={null} cwd="/project" thread={thread} />
    </div>,
  );
  await view.getByRole("textbox", { name: "Browser address" }).fill("localhost:3000");
  await view.getByRole("button", { name: "Go", exact: true }).click();
  await expect.element(view.getByRole("tab", { name: "Fixture" })).toBeVisible();
  return view;
}

function setPicker(picker: ProjectBrowserTab["picker"] | undefined) {
  updateTabs({ picker });
}

function updateTabs(patch: {
  readonly [Key in keyof ProjectBrowserTab]?: ProjectBrowserTab[Key] | undefined;
}) {
  const native = useBrowserUi.getState().native;
  useBrowserUi.setState({
    native: { tabs: native.tabs.map((tab) => Object.assign({}, tab, patch)) },
  });
}

/** Starts a pick whose result the test decides. */
async function startPick(
  api: ReturnType<typeof setup>,
  view: Awaited<ReturnType<typeof renderThreadPanel>>,
) {
  let settle: (result: ProjectBrowserPickResult) => void = () => {};
  api.pick.mockImplementationOnce(
    () =>
      new Promise<ProjectBrowserPickResult>((resolve) => {
        settle = resolve;
      }),
  );
  await view.getByRole("button", { name: "Pick element" }).click();
  expect(api.pick).toHaveBeenCalledWith("tab-1");
  setPicker("picking");
  return (result: ProjectBrowserPickResult) => {
    setPicker(result.kind === "picked" ? "picked" : undefined);
    settle(result);
  };
}

describe("picking page elements", () => {
  let composer: ReturnType<typeof listen> | null = null;
  afterEach(() => {
    composer?.release();
    composer = null;
  });

  it("is offered only in a thread's panel, with a composer, on a docked tab of the desktop app", async () => {
    setup({ pick: false });
    composer = listen();
    const withoutPicker = await renderThreadPanel();
    await expect.element(withoutPicker.getByRole("button", { name: "DevTools" })).toBeVisible();
    expect(withoutPicker.getByRole("button", { name: "Pick element" }).query()).toBeNull();
    await withoutPicker.unmount();
    useBrowserUi.setState({ native: { tabs: [] }, fallback: [], selected: {} });

    setup();
    const withoutThread = await renderThreadPanel(null);
    await expect.element(withoutThread.getByRole("button", { name: "DevTools" })).toBeVisible();
    expect(withoutThread.getByRole("button", { name: "Pick element" }).query()).toBeNull();
    await withoutThread.unmount();
    useBrowserUi.setState({ native: { tabs: [] }, fallback: [], selected: {} });

    composer.release();
    setup();
    const view = await renderThreadPanel();
    await expect.element(view.getByRole("button", { name: "DevTools" })).toBeVisible();
    expect(view.getByRole("button", { name: "Pick element" }).query()).toBeNull();
    // A composer for the thread registers: now it is offered.
    composer = listen();
    await expect.element(view.getByRole("button", { name: "Pick element" })).toBeVisible();
    // A popped-out tab is not in the panel.
    const native = useBrowserUi.getState().native;
    useBrowserUi.setState({
      native: {
        tabs: native.tabs.map((tab) => Object.assign({}, tab, { presentation: "window" as const })),
      },
    });
    await expect.element(view.getByText("This tab is open in a separate window.")).toBeVisible();
    expect(view.getByRole("button", { name: "Pick element" }).query()).toBeNull();
  });

  it("shows a hint while picking, and Escape or Cancel picking ends the pick", async () => {
    const api = setup();
    composer = listen();
    const view = await renderThreadPanel();
    await startPick(api, view);
    await expect
      .element(view.getByRole("status"))
      .toHaveTextContent("Click an element on the page to add it to the chat. Esc cancels.");
    await expect
      .element(view.getByRole("button", { name: "Cancel picking" }))
      .toHaveAttribute("aria-pressed", "true");

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(api.command).toHaveBeenLastCalledWith({ action: "end-pick", tab: "tab-1" });

    api.command.mockClear();
    await view.getByRole("button", { name: "Cancel picking" }).click();
    expect(api.command).toHaveBeenLastCalledWith({ action: "end-pick", tab: "tab-1" });
  });

  it("opens the note above the page without moving the page, and adds the element to the chat", async () => {
    const api = setup();
    composer = listen();
    const view = await renderThreadPanel();
    await expect.poll(() => api.surface.mock.calls.at(-1)?.[0].tab).toBe("tab-1");
    const owner = api.surface.mock.calls.at(-1)?.[0].owner;
    const settle = await startPick(api, view);
    settle({ kind: "picked", element: pickedElement });

    const note = view.getByRole("textbox", {
      name: 'Note on button "Save changes" on localhost:3000/settings',
    });
    await expect.element(note).toBeVisible();
    await expect.element(note).toHaveFocus();
    // The page keeps its surface: no detach, the same owner, only a smaller slot.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(api.surface.mock.calls.some(([input]) => input.tab === null)).toBe(false);
    expect(new Set(api.surface.mock.calls.map(([input]) => input.owner))).toEqual(new Set([owner]));

    await note.fill("Make this the primary button");
    await view.getByRole("button", { name: /Add to chat/u }).click();
    expect(composer.received).toEqual([
      {
        kind: "browser-element",
        element: {
          kind: "browser-element",
          ...pickedElement,
          comment: "Make this the primary button",
        },
      },
    ]);
    expect(api.command).toHaveBeenLastCalledWith({ action: "end-pick", tab: "tab-1" });
    await expect.element(note).not.toBeInTheDocument();
  });

  it("keeps the note when the message is full, and says so", async () => {
    const api = setup();
    composer = listen("full");
    const view = await renderThreadPanel();
    const settle = await startPick(api, view);
    settle({ kind: "picked", element: pickedElement });
    const note = view.getByRole("textbox", { name: /^Note on button/u });
    await note.fill("Keep me");
    await view.getByRole("button", { name: /Add to chat/u }).click();
    await expect
      .element(view.getByText("This message already has 32 page elements. Remove one to add more."))
      .toBeVisible();
    await expect.element(note).toHaveValue("Keep me");
    expect(api.command).not.toHaveBeenCalledWith({ action: "end-pick", tab: "tab-1" });

    // Cancel drops the pick and ends the highlight.
    await view.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(note).not.toBeInTheDocument();
    expect(api.command).toHaveBeenLastCalledWith({ action: "end-pick", tab: "tab-1" });
  });

  it("ends its pick when the thread's composer goes away or the panel closes", async () => {
    const api = setup();
    composer = listen();
    const view = await renderThreadPanel();
    const settle = await startPick(api, view);
    settle({ kind: "picked", element: pickedElement });
    await expect.element(view.getByRole("textbox", { name: /^Note on button/u })).toBeVisible();
    api.command.mockClear();
    // No composer takes context any more: the note goes, and so does the highlight.
    composer.release();
    composer = null;
    await expect
      .poll(() => api.command.mock.calls)
      .toEqual([[{ action: "end-pick", tab: "tab-1" }]]);
    expect(view.getByRole("textbox", { name: /^Note on button/u }).query()).toBeNull();

    // The composer coming back does not bring back a note whose highlight ended.
    composer = listen();
    await expect.element(view.getByRole("button", { name: "Pick element" })).toBeVisible();
    expect(view.getByRole("textbox", { name: /^Note on button/u }).query()).toBeNull();

    await startPick(api, view);
    api.command.mockClear();
    await view.unmount();
    expect(api.command).toHaveBeenCalledWith({ action: "end-pick", tab: "tab-1" });
  });

  it("drops the note when its tab pops out, so docking it again shows no stale note", async () => {
    const api = setup();
    composer = listen();
    const view = await renderThreadPanel();
    const settle = await startPick(api, view);
    settle({ kind: "picked", element: pickedElement });
    await expect.element(view.getByRole("textbox", { name: /^Note on button/u })).toBeVisible();
    api.command.mockClear();

    updateTabs({ presentation: "window", picker: undefined });
    await expect.element(view.getByText("This tab is open in a separate window.")).toBeVisible();
    expect(api.command).toHaveBeenCalledWith({ action: "end-pick", tab: "tab-1" });
    updateTabs({ presentation: "panel" });
    await expect.element(view.getByRole("button", { name: "Pick element" })).toBeVisible();
    expect(view.getByRole("textbox", { name: /^Note on button/u }).query()).toBeNull();
  });

  it("says why picking stopped when the agent took the tab, and nothing when the user did", async () => {
    const api = setup();
    composer = listen();
    const view = await renderThreadPanel();
    let settle = await startPick(api, view);
    settle({ kind: "cancelled", reason: "agent" });
    await expect
      .element(view.getByRole("status"))
      .toHaveTextContent("The agent used this tab, so picking stopped.");
    await expect.element(view.getByRole("button", { name: "Pick element" })).toBeVisible();

    settle = await startPick(api, view);
    settle({ kind: "cancelled", reason: "user" });
    await expect.element(view.getByRole("button", { name: "Pick element" })).toBeVisible();
    expect(view.getByRole("status").query()).toBeNull();

    // A refused start reports the desktop's reason in the panel.
    api.pick.mockRejectedValueOnce(new Error("Load a page before picking an element."));
    await view.getByRole("button", { name: "Pick element" }).click();
    await expect
      .element(view.getByRole("alert"))
      .toHaveTextContent("Load a page before picking an element.");
  });

  it("says why picking stopped for a while, then gives the page its room back", async () => {
    const api = setup();
    composer = listen();
    const view = await renderThreadPanel();
    const settle = await startPick(api, view);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => {
        settle({ kind: "cancelled", reason: "navigation" });
      });
      expect(view.getByRole("status").query()).toHaveTextContent(
        "The page changed, so picking stopped.",
      );
      await act(async () => {
        vi.advanceTimersByTime(BROWSER_PICK_NOTICE_MS - 1);
      });
      expect(view.getByRole("status").query()).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(view.getByRole("status").query()).toBeNull();
      expect(view.getByRole("button", { name: "Pick element" }).query()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
