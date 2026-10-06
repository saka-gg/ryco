import "../../index.css";

import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

import {
  FIXTURE_NOW_MS,
  LOCAL_ENV,
  RYCO_LOCAL,
  RYCO_STUDIO,
  STUDIO_ENV,
  resetProjectsFixtureState,
  seedProjectsFixtureStore,
} from "./testing/projectFixtures";
import { ProjectsTestHarness, projectsTestSearchLog } from "./testing/ProjectsTestHarness";
import type { ProjectsSearch } from "./projectsSearch";

async function renderPage(input: { width?: number; search?: ProjectsSearch } = {}) {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(input.width ?? 1280, 800);
  return render(
    <ProjectsTestHarness
      width={input.width ?? 1280}
      height={800}
      {...(input.search ? { initialSearch: input.search } : {})}
    />,
  );
}

describe("ProjectsPage shell", () => {
  beforeEach(() => {
    seedProjectsFixtureStore();
  });
  afterEach(() => {
    resetProjectsFixtureState();
    projectsTestSearchLog.clear();
    navigate.mockClear();
    vi.useRealTimers();
  });

  it("lists every logical project and opens the representative checkout", async () => {
    const screen = await renderPage();
    const rows = screen.container.querySelectorAll("[data-project-row]");
    expect(rows).toHaveLength(3);
    await expect.element(screen.getByRole("button", { name: /ryco-hub/ })).toBeVisible();
    // No URL checkout: the most recently active checkout (ryco on this device) opens.
    await expect
      .poll(() => screen.container.querySelector("[data-project-row][aria-current]")?.textContent)
      .toContain("ryco");
    // It opens on the map: the project across its devices.
    await expect.poll(() => document.querySelector("[data-project-map]")).not.toBeNull();
    await expect
      .element(screen.getByRole("radio", { name: "Map" }))
      .toHaveAttribute("aria-checked", "true");
    await screen.getByRole("radio", { name: "Settings" }).click();
    expect(projectsTestSearchLog.entries.at(-1)).toMatchObject({
      replace: false,
      search: { view: "settings" },
    });
    await expect.element(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("ryco");
  });

  it("filters the list", async () => {
    const screen = await renderPage();
    await userEvent.fill(screen.getByRole("textbox", { name: "Filter projects" }), "scratch");
    await expect.poll(() => screen.container.querySelectorAll("[data-project-row]").length).toBe(1);
  });

  it("selects a project with a push, staying in the current view", async () => {
    const screen = await renderPage({
      search: { env: LOCAL_ENV, project: RYCO_LOCAL, view: "settings" },
    });
    await screen.getByRole("button", { name: /ryco-hub/ }).click();
    expect(projectsTestSearchLog.entries.at(-1)).toMatchObject({ replace: false });
    expect(projectsTestSearchLog.last()).toMatchObject({
      project: "project-hub-local",
      view: "settings",
    });
    await expect
      .element(screen.getByRole("textbox", { name: "Project name" }))
      .toHaveValue("ryco-hub");
  });

  it("switches the checkout scope for a project on two devices", async () => {
    const screen = await renderPage({
      search: { env: LOCAL_ENV, project: RYCO_LOCAL, view: "settings" },
    });
    await screen.getByRole("button", { name: /Change checkout/ }).click();
    await screen.getByRole("menuitem", { name: /src\/ryco/ }).click();
    expect(projectsTestSearchLog.last()).toMatchObject({ env: STUDIO_ENV, project: RYCO_STUDIO });
  });

  it("moves between projects with j and k", async () => {
    await renderPage({ search: { env: LOCAL_ENV, project: RYCO_LOCAL } });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    await expect.poll(() => projectsTestSearchLog.last()?.project).toBe("project-hub-local");
    expect(projectsTestSearchLog.entries.at(-1)).toMatchObject({ replace: true });
  });

  it("puts the list in a drawer on a narrow page", async () => {
    const screen = await renderPage({
      width: 820,
      search: { env: LOCAL_ENV, project: RYCO_LOCAL },
    });
    expect(screen.container.querySelector("[data-projects-list-pane='docked']")).toBeNull();
    await screen.getByRole("button", { name: "Show projects" }).click();
    await expect
      .poll(() => document.querySelector("[data-projects-list-pane='drawer']"))
      .not.toBeNull();
  });

  it("says when a linked checkout is missing instead of substituting one", async () => {
    const screen = await renderPage({ search: { env: LOCAL_ENV, project: "gone" } });
    await expect.element(screen.getByText("This project isn’t available here")).toBeVisible();
  });
});
