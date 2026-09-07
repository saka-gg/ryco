import { page } from "vite-plus/test/browser";
import "../index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type {
  DesktopBridge,
  ProjectBrowserState,
  ProjectBrowserTab,
  ProjectBrowserSurface,
} from "@ryco/contracts";
import { BrowserPanel } from "./BrowserPanel";
import { ProjectBrowserPreview } from "./ProjectBrowserPreview";
import { useBrowserUi } from "./browserState";
const previous = window.desktopBridge;
afterEach(() => {
  if (previous) window.desktopBridge = previous;
  else delete window.desktopBridge;
  useBrowserUi.setState({ native: { tabs: [] }, fallback: [], selected: {} });
});
function setup() {
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
  };
  window.desktopBridge = { browser: api } as unknown as DesktopBridge;
  return api;
}
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
  await expect.element(view.getByRole("alert")).toHaveTextContent("HTTP(S)");
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
