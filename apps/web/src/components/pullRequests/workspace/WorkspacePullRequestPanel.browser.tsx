import "../../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});
vi.mock("~/lib/gitStatusState", () => {
  const idle = { data: null, error: null, cause: null, isPending: false };
  return {
    useGitStatus: () => ({
      ...idle,
      data: {
        sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      },
    }),
    getGitStatusSnapshot: () => idle,
    watchGitStatus: () => () => undefined,
    refreshGitStatus: () => Promise.resolve(null),
    resetGitStatusStateForTests: () => undefined,
  };
});
const routerNavigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => routerNavigate,
}));

import { AppAtomRegistryProvider } from "../../../rpc/atomRegistry";
import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { SidebarProvider } from "../../ui/sidebar";
import type { WorkspacePullRequestReveal } from "../../../workspaceRouteSearch";
import { fixtureRepositoryOption } from "../testing/pullRequestFixtures";
import { resetPullRequestsTestState } from "../testing/PullRequestsTestProvider";
import WorkspacePullRequestPanel from "./WorkspacePullRequestPanel";

const project = {
  id: fixtureRepositoryOption.projectId,
  name: fixtureRepositoryOption.name,
  cwd: fixtureRepositoryOption.cwd,
  customAvatarContentHash: null,
};

function Harness(props: {
  readonly number: number | null;
  readonly resolving?: boolean;
  readonly onSelectNumber?: (number: number) => void;
  readonly reveal?: WorkspacePullRequestReveal | null;
  readonly onRevealHandled?: () => void;
}) {
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider open onOpenChange={() => undefined} className="min-h-0 w-auto">
        <DiffWorkerPoolProvider>
          <div className="flex flex-col gap-2">
            <button type="button">Outside the panel</button>
            <div className="flex h-[640px] w-[520px] min-h-0 flex-col">
              <WorkspacePullRequestPanel
                environmentId={fixtureRepositoryOption.environmentId}
                project={project}
                number={props.number}
                resolving={props.resolving ?? false}
                onSelectNumber={props.onSelectNumber ?? (() => undefined)}
                reveal={props.reveal ?? null}
                {...(props.onRevealHandled ? { onRevealHandled: props.onRevealHandled } : {})}
              />
            </div>
          </div>
        </DiffWorkerPoolProvider>
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}

function typecheckRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-checks-job="CI#0/Typecheck"] > div');
}

function flashedRows(): number {
  return document.querySelectorAll(
    '[data-slot="workspace-pull-request"] .landing-flash, [data-slot="workspace-pull-request"] .landing-flash-static',
  ).length;
}

function activeReaderTab(): string | null {
  return (
    document
      .querySelector<HTMLElement>(
        '[data-slot="workspace-pull-request"] [role="tabpanel"]:not([inert])',
      )
      ?.getAttribute("data-tab") ?? null
  );
}

describe("WorkspacePullRequestPanel", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount().catch(() => {});
    mounted = null;
    routerNavigate.mockReset();
    resetPullRequestsTestState();
    document.body.innerHTML = "";
  });

  it("reads one change request without the list and hands off to the full page", async () => {
    mounted = await render(<Harness number={703} />);

    await expect
      .element(page.getByRole("tablist", { name: "Pull request sections" }))
      .toBeVisible();
    // No list here: the page's list toggle never renders.
    expect(document.querySelector('[aria-label="Pull requests"]')).toBeNull();
    expect(activeReaderTab()).toBe("conversation");

    await page.getByRole("button", { name: "Open in Pull requests" }).click();
    expect(routerNavigate).toHaveBeenCalledWith({
      to: "/pull-requests",
      search: {
        env: fixtureRepositoryOption.environmentId,
        project: fixtureRepositoryOption.projectId,
        pr: 703,
      },
    });
  });

  it("only takes its keys while focus is inside the panel", async () => {
    mounted = await render(<Harness number={703} />);
    await expect
      .element(page.getByRole("tablist", { name: "Pull request sections" }))
      .toBeVisible();

    await page.getByRole("button", { name: "Outside the panel" }).click();
    await userEvent.keyboard("3");
    expect(activeReaderTab()).toBe("conversation");

    await page.getByRole("tab", { name: "Conversation" }).click();
    await userEvent.keyboard("3");
    await expect.poll(activeReaderTab).toBe("checks");

    // A click on plain reader content (nothing focusable) keeps keys in scope.
    await page.getByRole("button", { name: "Outside the panel" }).click();
    document
      .querySelector<HTMLElement>('[data-slot="workspace-pull-request"]')
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.querySelector<HTMLElement>('[data-slot="workspace-pull-request"]')?.focus();
    await userEvent.keyboard("4");
    await expect.poll(activeReaderTab).toBe("commits");
  });

  it("resumes the reader where it was after the workspace tab remounts", async () => {
    mounted = await render(<Harness number={703} />);
    await page.getByRole("tab", { name: "Commits" }).click();
    await expect.poll(activeReaderTab).toBe("commits");

    await mounted.unmount();
    mounted = await render(<Harness number={703} />);
    await expect.poll(activeReaderTab).toBe("commits");
  });

  it("explains a thread without a change request, and one still resolving", async () => {
    mounted = await render(<Harness number={null} resolving />);
    await expect.element(page.getByText("Looking for this thread's pull request…")).toBeVisible();
    await mounted.rerender(<Harness number={null} />);
    await expect.element(page.getByText("No pull request yet")).toBeVisible();
  });

  it("reveals a job once per link: expands it, flashes it, and hands the link back", async () => {
    const onRevealHandled = vi.fn();
    const reveal: WorkspacePullRequestReveal = { kind: "job", job: "CI/Typecheck" };
    mounted = await render(
      <Harness number={703} reveal={reveal} onRevealHandled={onRevealHandled} />,
    );

    await expect.poll(activeReaderTab).toBe("checks");
    await expect
      .element(page.getByRole("button", { name: /^\S+ Typecheck$/u }))
      .toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => typecheckRow()?.className ?? "").toMatch(/\blanding-flash\b/u);
    expect(onRevealHandled).toHaveBeenCalledTimes(1);

    // Re-renders with the reveal still pending never act on it twice.
    await mounted.rerender(
      <Harness number={703} reveal={{ ...reveal }} onRevealHandled={onRevealHandled} />,
    );
    expect(onRevealHandled).toHaveBeenCalledTimes(1);

    // The route strips the handled key; the same link again lands again.
    await mounted.rerender(
      <Harness number={703} reveal={null} onRevealHandled={onRevealHandled} />,
    );
    await expect
      .poll(() => typecheckRow()?.className ?? "", { timeout: 4000 })
      .not.toMatch(/landing-flash/u);
    await mounted.rerender(
      <Harness number={703} reveal={reveal} onRevealHandled={onRevealHandled} />,
    );
    await expect.poll(() => typecheckRow()?.className ?? "").toMatch(/\blanding-flash\b/u);
    expect(onRevealHandled).toHaveBeenCalledTimes(2);
  });

  it("re-flashes a job revealed again while it is still flashing", async () => {
    const onRevealHandled = vi.fn();
    const reveal: WorkspacePullRequestReveal = { kind: "job", job: "CI/Typecheck" };
    mounted = await render(
      <Harness number={703} reveal={reveal} onRevealHandled={onRevealHandled} />,
    );
    await expect.poll(() => typecheckRow()?.className ?? "").toMatch(/\blanding-flash\b/u);
    await mounted.rerender(
      <Harness number={703} reveal={null} onRevealHandled={onRevealHandled} />,
    );
    await mounted.rerender(
      <Harness number={703} reveal={reveal} onRevealHandled={onRevealHandled} />,
    );
    await expect.poll(() => typecheckRow()?.className ?? "").toMatch(/landing-flash-replay/u);
    expect(onRevealHandled).toHaveBeenCalledTimes(2);
  });

  it("never replays a handled job landing when the workspace tab remounts", async () => {
    const reveal: WorkspacePullRequestReveal = { kind: "job", job: "CI/Typecheck" };
    mounted = await render(
      <Harness number={703} reveal={reveal} onRevealHandled={() => undefined} />,
    );
    await expect.poll(() => typecheckRow()?.className ?? "").toMatch(/\blanding-flash\b/u);

    // Switching the workspace tab away and back remounts the reader.
    await mounted.unmount();
    mounted = await render(<Harness number={703} />);
    await expect.poll(activeReaderTab).toBe("checks");
    await expect
      .element(page.getByRole("button", { name: /^\S+ Typecheck$/u }))
      .toHaveAttribute("aria-expanded", "true");
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(flashedRows()).toBe(0);
  });

  it("lands on the Checks tab without flashing anything for a checks reveal", async () => {
    const onRevealHandled = vi.fn();
    mounted = await render(<Harness number={703} onRevealHandled={onRevealHandled} />);
    await page.getByRole("tab", { name: "Conversation" }).click();
    await expect.poll(activeReaderTab).toBe("conversation");
    // The reader resumes where an earlier test left it; let any landing settle.
    await expect.poll(flashedRows, { timeout: 4000 }).toBe(0);

    await mounted.rerender(
      <Harness number={703} reveal={{ kind: "checks" }} onRevealHandled={onRevealHandled} />,
    );
    await expect.poll(activeReaderTab).toBe("checks");
    await expect.element(page.getByRole("button", { name: /^\S+ Typecheck$/u })).toBeVisible();
    expect(onRevealHandled).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(flashedRows()).toBe(0);
  });
});
