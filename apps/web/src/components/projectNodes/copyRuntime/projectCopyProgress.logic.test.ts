import type { ProjectCopyProgress } from "@ryco/client-runtime/projectCopy";
import type { ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { describe, expect, it } from "vite-plus/test";

import {
  formatCopyTransfer,
  projectCopyPercent,
  projectCopyView,
  type ProjectCopyLabels,
} from "./projectCopyProgress.logic";

const labels: ProjectCopyLabels = { title: "ryco", sourceLabel: "Laptop", targetLabel: "Mac mini" };

function progress(patch: Partial<ProjectCopyProgress>): ProjectCopyProgress {
  return {
    copyId: "copy-1",
    phase: "acquire",
    uploadedBytes: 0,
    totalBytes: 0,
    importSnapshot: null,
    canCloseClient: false,
    error: null,
    ...patch,
  };
}

function importing(
  steps: ProjectImportSnapshot["steps"],
  patch: Partial<ProjectImportSnapshot> = {},
): ProjectImportSnapshot {
  return {
    title: "ryco",
    status: "running",
    destinationPath: "/Users/me/Code/ryco",
    steps,
    warnings: [],
    ...patch,
  } as unknown as ProjectImportSnapshot;
}

const MB = 1024 * 1024;

describe("project copy progress", () => {
  it("asks to keep Ryco open while the upload needs it, with its size and share", () => {
    const view = projectCopyView(
      progress({ phase: "upload", uploadedBytes: 12 * MB, totalBytes: 38 * MB }),
      labels,
    );
    expect(view).toEqual({
      kind: "progress",
      title: "Copying ryco to Mac mini",
      description: "Sending 12 of 38 MB. Keep Ryco open until the upload finishes.",
      percent: 32,
      keepOpen: true,
      retryLabel: null,
    });
    expect(formatCopyTransfer(0.5 * MB, 3 * MB)).toBe("0.5 of 3.0 MB");
  });

  it("names the destination's running step once the copy runs there by itself", () => {
    const view = projectCopyView(
      progress({
        phase: "import",
        canCloseClient: true,
        importSnapshot: importing([
          { id: "preflight", status: "done", progressPercent: null, detail: null },
          { id: "clone", status: "running", progressPercent: 42.4, detail: null },
          { id: "setup", status: "pending", progressPercent: null, detail: null },
        ]),
      }),
      labels,
    );
    expect(view.description).toBe("Cloning the repository. Runs on Mac mini; you can close Ryco.");
    expect(view.percent).toBe(42);
    expect(view.keepOpen).toBe(false);
  });

  it("measures an import without step progress by the steps that finished", () => {
    expect(
      projectCopyPercent(
        progress({
          phase: "import",
          importSnapshot: importing([
            { id: "clone", status: "done", progressPercent: null, detail: null },
            { id: "commits", status: "skipped", progressPercent: null, detail: null },
            { id: "register", status: "running", progressPercent: null, detail: null },
          ]),
        }),
      ),
    ).toBe(50);
    expect(projectCopyPercent(progress({ phase: "export" }))).toBeNull();
  });

  it("words how a copy ended, with the retry a failure offers", () => {
    expect(
      projectCopyView(
        progress({ phase: "done", importSnapshot: importing([], { status: "completed" }) }),
        labels,
      ),
    ).toMatchObject({ kind: "done", title: "ryco is ready on Mac mini" });
    expect(
      projectCopyView(
        progress({
          phase: "failed",
          error: { code: "remote-unreachable", message: "No route.", retry: "send-files" },
        }),
        labels,
      ),
    ).toMatchObject({
      kind: "failed",
      title: "Couldn't copy ryco to Mac mini",
      description: "No route.",
      retryLabel: "Send files instead",
    });
    expect(projectCopyView(progress({ phase: "cancelled" }), labels)).toMatchObject({
      kind: "cancelled",
      title: "Stopped copying ryco",
    });
  });

  it("names a resumed copy by the destination's import until it knows more", () => {
    const view = projectCopyView(progress({ phase: "acquire", canCloseClient: true }), {
      title: null,
      sourceLabel: null,
      targetLabel: null,
    });
    expect(view).toMatchObject({
      title: "Copying to the destination",
      description: "Reconnecting to the destination…",
    });
  });
});
