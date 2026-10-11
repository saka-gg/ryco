import { EnvironmentId, WorktreeId, type ChangeRequest } from "@ryco/contracts";
import type { WorktreePullRequestLink } from "@ryco/shared/worktreePullRequests";
import { Option } from "effect";
import { useRef, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const rpc = vi.hoisted(() => ({
  link: vi.fn(),
  dismiss: vi.fn(),
  openExternal: vi.fn(),
  openList: [] as ChangeRequest[],
  detail: null as unknown,
}));

vi.mock("~/lib/openExternalLink", () => ({ openExternalLink: rpc.openExternal }));

// The toast host reads the route's thread; this harness has no router.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
}));
vi.mock("~/rpc/useSourceControl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/rpc/useSourceControl")>()),
  useSourceControlChangeRequestDetail: () => ({
    data: rpc.detail,
    isLoading: false,
    isFetching: false,
    error: null,
  }),
  useLinkWorktreePullRequestMutation: () => ({ mutateAsync: rpc.link }),
  useDismissWorktreePullRequestMutation: () => ({ mutateAsync: rpc.dismiss }),
}));
vi.mock("~/rpc/useOverview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/rpc/useOverview")>()),
  useOverviewChangeRequestList: () => ({
    data: rpc.openList,
    isLoading: false,
    isFetching: false,
    error: null,
  }),
}));
vi.mock("~/rpc/useGit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/rpc/useGit")>()),
  useResolvePullRequest: () => ({
    data: null,
    isPending: false,
    isFetching: false,
    isError: false,
    error: null,
  }),
}));

import { ToastProvider } from "../ui/toast";
import {
  WorkspacePullRequestsPopover,
  type WorkspacePullRequestsView,
} from "./WorkspacePullRequestsPopover";

function link(
  number: number,
  title: string,
  state: WorktreePullRequestLink["state"],
  terminalAt: string | null = null,
): WorktreePullRequestLink {
  return {
    number,
    title,
    url: `https://github.com/acme/ryco/pull/${number}`,
    state,
    isDraft: false,
    terminalAt,
    headRefName: `feature/${number}`,
    baseRefName: "main",
    source: "created",
    linkedAt: "2026-10-05T08:00:00.000Z",
    dismissedAt: null,
  };
}

function candidate(number: number, title: string, headRefName: string): ChangeRequest {
  return {
    provider: "github",
    number,
    title,
    url: `https://github.com/acme/ryco/pull/${number}`,
    baseRefName: "main",
    headRefName,
    state: "open",
    updatedAt: Option.none(),
  } as unknown as ChangeRequest;
}

const LINKS = [
  link(677, "Projects map follow-up", "open"),
  link(675, "Ship the lifecycle", "merged", "2026-10-05T09:00:00.000Z"),
];

function Harness(props: {
  readonly links?: ReadonlyArray<WorktreePullRequestLink>;
  readonly canEdit?: boolean;
  readonly initialView?: WorkspacePullRequestsView;
  readonly onOpenPullRequest?: (number: number) => void;
  readonly onLinked?: (number: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<WorkspacePullRequestsView>(props.initialView ?? "list");
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      {/* The surface's own toggle, as the sidebar and header chips are. */}
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Pull requests
      </button>
      {/* Opens it without the toggle, as the PR tab's \ shortcut does. */}
      <button type="button" onClick={() => setOpen(true)}>
        Open elsewhere
      </button>
      <WorkspacePullRequestsPopover
        environmentId={EnvironmentId.make("environment-local")}
        worktreeId={WorktreeId.make("wt-follow-up")}
        cwd="/repo/follow-up"
        workspaceTitle="lifecycle"
        workspaceBranch="feature/677"
        links={props.links ?? LINKS}
        shownNumber={(props.links ?? LINKS)[0]?.number ?? null}
        showStack
        canEdit={props.canEdit ?? true}
        open={open}
        onOpenChange={setOpen}
        view={view}
        onViewChange={setView}
        anchor={toggleRef}
        toggle={() => toggleRef.current}
        onOpenPullRequest={props.onOpenPullRequest ?? vi.fn()}
        onLinked={props.onLinked}
      />
    </>
  );
}

describe("WorkspacePullRequestsPopover", () => {
  beforeEach(() => {
    rpc.link.mockReset();
    rpc.dismiss.mockReset();
    rpc.openExternal.mockReset();
    rpc.openList = [];
    rpc.detail = null;
  });

  it("lists the current pull request first and the finished ones under Earlier", async () => {
    const onOpenPullRequest = vi.fn();
    await render(<Harness onOpenPullRequest={onOpenPullRequest} />);
    await page.getByRole("button", { name: "Pull requests", exact: true }).click();

    const current = page.getByRole("button", { name: "#677 Projects map follow-up, Open" });
    await expect.element(current).toHaveFocus();
    expect(current.element().closest("[role=listitem]")?.getAttribute("aria-current")).toBe("true");
    await expect.element(page.getByText("Earlier")).toBeInTheDocument();

    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("button", { name: "#675 Ship the lifecycle, Merged" }))
      .toHaveFocus();
    await userEvent.keyboard("{End}");
    await expect.element(page.getByRole("button", { name: "Link pull request…" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect.element(current).toHaveFocus();

    await page.getByRole("button", { name: "#675 Ship the lifecycle, Merged" }).click();
    expect(onOpenPullRequest).toHaveBeenCalledWith(675);
  });

  it("unlinks with Undo, writing nothing optimistically", async () => {
    rpc.dismiss.mockResolvedValue(undefined);
    rpc.link.mockResolvedValue(LINKS[1]);
    await render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await page.getByRole("button", { name: "Pull requests", exact: true }).click();

    await page.getByRole("button", { name: "Unlink #675" }).click();

    expect(rpc.dismiss).toHaveBeenCalledWith({
      worktreeId: WorktreeId.make("wt-follow-up"),
      number: 675,
    });
    // The row stays until the server's event says otherwise.
    await expect
      .element(page.getByRole("button", { name: "#675 Ship the lifecycle, Merged" }))
      .toBeInTheDocument();
    const undo = page.getByRole("button", { name: "Undo" });
    await expect.element(undo).toBeInTheDocument();
    // The toast host animates without the app's styles; skip actionability waits.
    (undo.element() as HTMLElement).click();
    expect(rpc.link).toHaveBeenCalledWith({
      worktreeId: WorktreeId.make("wt-follow-up"),
      reference: "675",
    });
  });

  it("closes from its own toggle, and every close lands back on the list", async () => {
    await render(<Harness />);
    const toggle = page.getByRole("button", { name: "Pull requests", exact: true });
    await toggle.click();
    await expect.element(page.getByText("Earlier")).toBeInTheDocument();
    // A press on the toggle is not an outside press: its click closes.
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.body.textContent).not.toContain("Earlier");

    await toggle.click();
    await page.getByRole("button", { name: "Link pull request…" }).click();
    await expect
      .element(page.getByRole("combobox", { name: "Pull request to link" }))
      .toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await toggle.click();
    await expect.element(page.getByText("Earlier")).toBeInTheDocument();
  });

  it("closes from its toggle even when something else opened it", async () => {
    await render(<Harness />);
    await page.getByRole("button", { name: "Open elsewhere" }).click();
    await expect
      .element(page.getByRole("button", { name: "#677 Projects map follow-up, Open" }))
      .toHaveFocus();
    // Focus moving onto the toggle is not a dismissal: its click closes it.
    const toggle = page.getByRole("button", { name: "Pull requests", exact: true });
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.body.textContent).not.toContain("Earlier");
  });

  it("keeps the arrow keys working after the focused row left the list", async () => {
    await render(<Harness />);
    await page.getByRole("button", { name: "Pull requests", exact: true }).click();
    const current = page.getByRole("button", { name: "#677 Projects map follow-up, Open" });
    await expect.element(current).toHaveFocus();
    // Focus falls back to the popup (as when a row unmounts).
    (document.querySelector('[data-slot="popover-popup"]') as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(current).toHaveFocus();
  });

  it("draws the stack first, and ⌘-click on a layer opens it on the host", async () => {
    rpc.detail = {
      provider: "github",
      number: 677,
      stackMetadataIncomplete: false,
      stack: {
        number: 14,
        size: 2,
        position: 2,
        baseRefName: "main",
        entries: [676, 677].map((number, index) => ({
          position: index + 1,
          number,
          title: `Layer ${number}`,
          url: `https://github.com/acme/ryco/pull/${number}`,
          headRefName: `layer-${number}`,
          baseRefName: index === 0 ? "main" : "layer-676",
          state: "open",
          isDraft: false,
          mergeability: "mergeable",
        })),
      },
    };
    const onOpenPullRequest = vi.fn();
    await render(<Harness onOpenPullRequest={onOpenPullRequest} />);
    await page.getByRole("button", { name: "Pull requests", exact: true }).click();

    await expect.element(page.getByText("Stack #14")).toBeInTheDocument();
    // The stack owns its layers: #677 shows once, as the stack's current layer.
    expect(document.querySelectorAll('[data-layer-number="677"]')).toHaveLength(1);
    expect(document.querySelector('[data-link-number="677"]')).toBeNull();
    expect(document.querySelector('[data-link-number="675"]')).not.toBeNull();
    const layer = document.querySelector<HTMLElement>('[data-layer-number="676"]')!;
    layer.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(rpc.openExternal).toHaveBeenCalledWith(
      "https://github.com/acme/ryco/pull/676",
      "Unable to open pull request link",
    );
    expect(onOpenPullRequest).not.toHaveBeenCalled();
    // A plain click opens it in the app.
    layer.click();
    expect(onOpenPullRequest).toHaveBeenCalledWith(676);
  });

  it("offers no editing when the environment cannot take it", async () => {
    await render(<Harness canEdit={false} />);
    await page.getByRole("button", { name: "Pull requests", exact: true }).click();

    await expect
      .element(page.getByRole("button", { name: "#675 Ship the lifecycle, Merged" }))
      .toBeInTheDocument();
    expect(document.querySelector('[aria-label^="Unlink"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Link pull request…");
  });

  it("links an open pull request, ranks the workspace branch first, and marks linked ones", async () => {
    rpc.openList = [
      candidate(690, "Unrelated change", "other"),
      candidate(680, "Stacked on the workspace", "feature/680"),
      candidate(681, "Same branch", "feature/677"),
    ];
    const onLinked = vi.fn();
    rpc.link.mockResolvedValue(link(681, "Same branch", "open"));
    await render(<Harness onLinked={onLinked} />);
    await page.getByRole("button", { name: "Pull requests", exact: true }).click();
    await page.getByRole("button", { name: "Link pull request…" }).click();

    const input = page.getByRole("combobox", { name: "Pull request to link" });
    await expect.element(input).toHaveFocus();
    const options = [...document.querySelectorAll("[role=option]")].map(
      (option) => option.textContent,
    );
    expect(options[0]).toContain("#681");
    expect(options[0]).toContain("this branch");

    await userEvent.keyboard("#675");
    await expect.element(page.getByRole("option", { name: /Already linked/ })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(rpc.link).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Linked #681")).toBeInTheDocument();
    expect(rpc.link).toHaveBeenCalledWith({
      worktreeId: WorktreeId.make("wt-follow-up"),
      reference: "681",
    });
    expect(onLinked).toHaveBeenCalledWith(681);
  });

  it("keeps the query and says why when linking fails", async () => {
    rpc.link.mockRejectedValue(new Error("No pull request #999 in acme/ryco."));
    await render(<Harness initialView="link" />);
    await page.getByRole("button", { name: "Pull requests", exact: true }).click();

    await userEvent.keyboard("999{Enter}");

    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent("Couldn't link #999: No pull request #999 in acme/ryco.");
    await expect
      .element(page.getByRole("combobox", { name: "Pull request to link" }))
      .toHaveValue("999");
  });
});
