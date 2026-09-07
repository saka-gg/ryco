import "../../index.css";

import { EnvironmentId, type ResolvedKeybindingsConfig } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "../ui/sidebar";
import ProjectScriptsControl from "../ProjectScriptsControl";
import { ChatHeader } from "./ChatHeader";
import { OpenInPicker } from "./OpenInPicker";

describe("ChatHeader", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("renders overview and workspace toggles as borderless highlighted header controls", async () => {
    const onToggleOverviewSidebar = vi.fn();
    const onToggleWorkspacePanel = vi.fn();

    mounted = await render(
      <SidebarProvider>
        <ChatHeader
          activeThreadEnvironmentId={EnvironmentId.make("environment-thread")}
          activeThreadTitle="Implement overview polish"
          activeProjectName="Ryco"
          isGitRepo
          openInCwd={null}
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={{} as ResolvedKeybindingsConfig}
          availableEditors={[]}
          worktreeBranch="feature/header-polish"
          worktreeTitle="Header polish"
          worktreeOrigin="manual"
          workspacePanelOpen={false}
          liveAgentCount={3}
          onToggleWorkspacePanel={onToggleWorkspacePanel}
          overviewSidebarOpen={false}
          onToggleOverviewSidebar={onToggleOverviewSidebar}
          onRunProjectScript={vi.fn()}
          onAddProjectScript={vi.fn()}
          onUpdateProjectScript={vi.fn()}
          onDeleteProjectScript={vi.fn()}
        />
      </SidebarProvider>,
    );

    const overviewToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle overview panel"]',
    );
    const workspaceToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle workspace panel, 3 agents active"]',
    );

    expect(overviewToggle).not.toBeNull();
    expect(workspaceToggle).not.toBeNull();
    expect(overviewToggle!.className).toContain("border-0");
    expect(workspaceToggle!.className).toContain("border-0");
    expect(overviewToggle!.className).not.toContain("border-input");
    expect(workspaceToggle!.className).not.toContain("border-input");
    expect(overviewToggle!.className).toContain("hover:bg-foreground/8");
    expect(workspaceToggle!.className).toContain("hover:bg-foreground/8");
    expect(overviewToggle!.querySelector("svg")?.className.baseVal).toContain("size-4");
    expect(workspaceToggle!.querySelector("svg")?.className.baseVal).toContain("size-4");

    await page.getByRole("button", { name: "Toggle overview panel" }).click();
    expect(workspaceToggle!.textContent).toContain("3");
    await page.getByRole("button", { name: "Toggle workspace panel, 3 agents active" }).click();

    expect(onToggleOverviewSidebar.mock.calls[0]?.[0]).toBe(true);
    expect(onToggleWorkspacePanel.mock.calls[0]?.[0]).toBe(true);
  });

  it("renders project and open actions with the same borderless header chrome", async () => {
    const keybindings = {} as ResolvedKeybindingsConfig;

    mounted = await render(
      <div className="@container/header-actions flex items-center gap-2">
        <ProjectScriptsControl
          scripts={[
            {
              id: "build",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ]}
          keybindings={keybindings}
          preferredScriptId={null}
          onRunScript={vi.fn()}
          onAddScript={vi.fn()}
          onUpdateScript={vi.fn()}
          onDeleteScript={vi.fn()}
        />
        <OpenInPicker
          keybindings={keybindings}
          availableEditors={["vscode"]}
          openInCwd="/Users/laurinfrank/Dropbox/Code/ryco"
        />
      </div>,
    );

    const projectGroup = document.querySelector<HTMLElement>('[aria-label="Project scripts"]');
    const openGroup = document.querySelector<HTMLElement>('[aria-label="Subscription actions"]');
    const runButton = document.querySelector<HTMLButtonElement>('button[title="Run Build"]');
    const scriptMenuButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Script actions"]',
    );
    const openButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Open"),
    );
    const openMenuButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy options"]',
    );

    expect(projectGroup?.className).toContain("gap-1");
    expect(openGroup?.className).toContain("gap-1");
    for (const button of [runButton, scriptMenuButton, openButton, openMenuButton]) {
      expect(button).not.toBeNull();
      expect(button!.className).toContain("border-0");
      expect(button!.className).toContain("hover:bg-foreground/8");
      expect(button!.className).not.toContain("border-input");
    }
  });
});
