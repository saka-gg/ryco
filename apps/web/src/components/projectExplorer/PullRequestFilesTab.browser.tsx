import "../../index.css";
import type { SourceControlChangeRequestFilesViewed } from "@ryco/contracts";
import { createPullRequestReviewController } from "@ryco/client-runtime/state/pull-request-review";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { PullRequestFilesList } from "./PullRequestFilesTab";

const files = [
  { path: "src/current.ts", additions: 2, deletions: 1 },
  { path: "src/changed.ts", additions: 1, deletions: 0 },
];
const data: SourceControlChangeRequestFilesViewed = {
  provider: "github",
  capability: { storage: "host" },
  headSha: "head-1",
  files: [
    { path: files[0]!.path, state: "unviewed" },
    { path: files[1]!.path, state: "stale" },
  ],
};
type Controller = ReturnType<typeof createPullRequestReviewController>;
function Harness({ controller, headSha = "head-1" }: { controller: Controller; headSha?: string }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return (
    <PullRequestFilesList
      files={files}
      headSha={headSha}
      viewed={{ ...snapshot, refresh: controller.refresh, setViewed: controller.setViewed }}
      expanded={new Set()}
      onToggle={() => undefined}
      onRefresh={() => void controller.refresh()}
      renderDiff={() => null}
    />
  );
}

describe("pull request file review progress", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("optimistically updates progress and hiding, then restores the row on failure", async () => {
    let rejectWrite!: (error: Error) => void;
    const write = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const read = vi.fn(async () => data);
    const controller = createPullRequestReviewController({ read, write });
    await controller.refresh();
    const screen = await render(<Harness controller={controller} />);
    await expect.element(screen.getByText("Changed since viewed")).toBeVisible();
    await screen.getByRole("checkbox", { name: "Hide viewed" }).click();
    await screen.getByRole("checkbox", { name: "Viewed src/current.ts", exact: true }).click();
    await expect.element(screen.getByText("1/2 files viewed")).toBeVisible();
    await expect
      .element(screen.getByRole("checkbox", { name: "Viewed src/current.ts", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("checkbox", { name: "Viewed src/changed.ts", exact: true }))
      .toBeVisible();
    rejectWrite(new Error("GitHub could not save review progress"));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("GitHub could not save review progress");
    await expect
      .element(screen.getByRole("checkbox", { name: "Viewed src/current.ts", exact: true }))
      .not.toBeChecked();
    await expect.element(screen.getByText("0/2 files viewed")).toBeVisible();
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      path: "src/current.ts",
      viewed: true,
      expectedHeadSha: "head-1",
    });
    controller.dispose();
  });

  it("does not offer viewed controls for unsupported providers", async () => {
    const controller = createPullRequestReviewController({
      read: async () => ({ ...data, provider: "gitlab", capability: { storage: "unsupported" } }),
      write: vi.fn(),
    });
    await controller.refresh();
    const screen = await render(<Harness controller={controller} />);
    await expect.element(screen.getByRole("checkbox")).not.toBeInTheDocument();
    await expect.element(screen.getByText("src/current.ts")).toBeVisible();
    controller.dispose();
  });

  it("prevents viewing an old displayed head and keeps changed files visible", async () => {
    const controller = createPullRequestReviewController({
      read: async () => ({ ...data, headSha: "head-2" }),
      write: vi.fn(),
    });
    await controller.refresh();
    const screen = await render(<Harness controller={controller} />);
    await expect
      .element(screen.getByRole("checkbox", { name: "Viewed src/current.ts", exact: true }))
      .toBeDisabled();
    await expect
      .element(
        screen.getByText("The pull request changed. Refresh files before continuing your review."),
      )
      .toBeVisible();
    controller.dispose();
  });
});
