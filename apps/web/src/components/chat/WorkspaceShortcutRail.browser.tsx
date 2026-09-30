import "../../index.css";

import { EnvironmentId, type ResolvedKeybindingsConfig } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import ProjectScriptsControl from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { WorkspaceShortcutRail } from "./WorkspaceShortcutRail";

describe("WorkspaceShortcutRail", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  beforeEach(async () => {
    await page.viewport(900, 700);
  });
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  function callbacks() {
    return {
      overviewOpen: false,
      workspaceMode: null,
      overview: {
        activePlan: null,
        activeProposedPlan: null,
        environmentId: EnvironmentId.make("local"),
        markdownCwd: undefined,
        workspaceRoot: undefined,
      },
      canBrowseFiles: true,
      onToggleOverview: vi.fn(),
      onOpenFiles: vi.fn(),
      onOpenTerminal: vi.fn(),
      onOpenBrowser: vi.fn(),
    } as const;
  }

  it("reveals labels without opening a panel or taking up a full-height sidebar", async () => {
    const props = callbacks();
    mounted = await render(
      <div style={{ position: "relative", height: 550, width: 650 }}>
        <button type="button">Conversation</button>
        <WorkspaceShortcutRail {...props} />
      </div>,
    );
    const rail = document.querySelector<HTMLElement>('[aria-label="Overview"]')!;
    expect(rail.getBoundingClientRect().width).toBe(44);
    expect(rail.getBoundingClientRect().height).toBeLessThan(300);
    const icon = page
      .getByRole("button", { name: "Files", exact: true })
      .element()
      .querySelector("svg")!;
    const iconX = icon.getBoundingClientRect().x;
    await page.getByRole("button", { name: "Files", exact: true }).hover();
    await expect.poll(() => rail.getBoundingClientRect().width).toBe(256);
    expect(icon.getBoundingClientRect().x).toBeCloseTo(iconX, 0);
    expect(props.onOpenFiles).not.toHaveBeenCalled();
    expect(props.onToggleOverview).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Conversation", exact: true }).hover();
    await expect.poll(() => rail.getBoundingClientRect().width).toBe(44);
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    expect(props.onOpenBrowser).toHaveBeenCalledOnce();
    expect(props.onOpenFiles).not.toHaveBeenCalled();
  });

  it("opens overview details directly from their own icon", async () => {
    const props = callbacks();
    mounted = await render(
      <WorkspaceShortcutRail
        {...props}
        overview={{
          ...props.overview,
          changes: {
            files: [{ path: "src/app.tsx", insertions: 8, deletions: 2 }],
            insertions: 8,
            deletions: 2,
            refName: "main",
            aheadCount: 0,
            behindCount: 0,
          },
        }}
      />,
    );
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await expect.element(page.getByRole("dialog", { name: "Changes", exact: true })).toBeVisible();
    await expect.element(page.getByText("Uncommitted", { exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Changes", exact: true }).element(),
    );
  });

  it("supports keyboard activation and Escape without replacing the focused control", async () => {
    const props = callbacks();
    mounted = await render(<WorkspaceShortcutRail {...props} />);
    const files = page.getByRole("button", { name: "Files", exact: true });
    (files.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(props.onOpenFiles).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(files.element());
    expect(document.querySelector('[aria-label="Overview"]')?.getAttribute("data-expanded")).toBe(
      "false",
    );
    await userEvent.keyboard("{Tab}{Enter}");
    expect(props.onOpenTerminal).toHaveBeenCalledOnce();
  });

  it("keeps existing script and editor menus usable in a compact rail", async () => {
    const props = callbacks();
    const run = vi.fn();
    const script = {
      id: "dev",
      name: "Dev",
      command: "bun run dev",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    mounted = await render(
      <div style={{ position: "relative", height: 550, width: 650 }}>
        <WorkspaceShortcutRail {...props}>
          <ProjectScriptsControl
            presentation="shortcut"
            scripts={[script]}
            keybindings={{} as ResolvedKeybindingsConfig}
            onRunScript={run}
            onAddScript={vi.fn()}
            onUpdateScript={vi.fn()}
            onDeleteScript={vi.fn()}
          />
          <OpenInPicker
            presentation="shortcut"
            keybindings={{} as ResolvedKeybindingsConfig}
            availableEditors={["vscode"]}
            openInCwd="/project/ryco"
          />
        </WorkspaceShortcutRail>
      </div>,
    );
    const rail = document.querySelector<HTMLElement>('[aria-label="Overview"]')!;
    await page.getByRole("button", { name: "Script actions", exact: true }).hover();
    await expect.poll(() => rail.getAttribute("data-expanded")).toBe("true");
    await page.getByRole("button", { name: "Script actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Dev" }).hover();
    expect(rail.getAttribute("data-expanded")).toBe("true");
    expect(run).not.toHaveBeenCalled();
    await page.getByRole("menuitem", { name: "Dev" }).click();
    expect(run).toHaveBeenCalledWith(script);
    await page.getByRole("button", { name: "Open in editor", exact: true }).click();
    await expect.element(page.getByRole("menuitem", { name: "VS Code" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Open in editor", exact: true }).element(),
    );
  });
});
