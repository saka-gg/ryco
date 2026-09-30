import "../../index.css";

import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

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

  it("keeps the workspace toggle as a borderless header control and leaves overview actions to the rail", async () => {
    const onToggleWorkspacePanel = vi.fn();

    mounted = await render(
      <SidebarProvider>
        <ChatHeader
          activeThreadTitle="Implement overview polish"
          activeProjectName="Ryco"
          isGitRepo
          worktreeBranch="feature/header-polish"
          worktreeTitle="Header polish"
          worktreeOrigin="manual"
          workspacePanelOpen={false}
          liveAgentCount={3}
          onToggleWorkspacePanel={onToggleWorkspacePanel}
        />
      </SidebarProvider>,
    );

    expect(document.querySelector('button[aria-label="Thread images"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Project memory"]')).toBeNull();
    // Relocated to the overview rail at the conversation's right edge.
    expect(document.querySelector('button[aria-label="Toggle overview panel"]')).toBeNull();
    expect(document.querySelector('[aria-label="Project scripts"]')).toBeNull();
    expect(document.querySelector('[aria-label="Subscription actions"]')).toBeNull();

    const workspaceToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle workspace panel, 3 agents active"]',
    );
    expect(workspaceToggle).not.toBeNull();
    expect(workspaceToggle!.className).toContain("border-0");
    expect(workspaceToggle!.className).not.toContain("border-input");
    expect(workspaceToggle!.className).toContain("hover:bg-foreground/8");
    expect(workspaceToggle!.querySelector("svg")?.className.baseVal).toContain("size-4");
    expect(workspaceToggle!.textContent).toContain("3");

    await page.getByRole("button", { name: "Toggle workspace panel, 3 agents active" }).click();
    expect(onToggleWorkspacePanel.mock.calls[0]?.[0]).toBe(true);
  });
});
