import type { ProjectCopyProgress } from "./index.ts";
import type { ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { describe, expect, it } from "vite-plus/test";

import {
  copyThroughput,
  formatCopySpeed,
  formatCopyThroughput,
  formatCopyTimeLeft,
  formatCopyTransfer,
  nextCopyByteSamples,
  projectCopyPercent,
  projectCopyView,
  type ProjectCopyLabels,
} from "./progressView.ts";

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

  it("words a clone and a link the add-project dialog handed over as what they are", () => {
    const clone = { ...labels, sourceLabel: null, action: "clone" as const };
    expect(
      projectCopyView(progress({ phase: "import", canCloseClient: true }), clone),
    ).toMatchObject({ kind: "progress", title: "Cloning ryco to Mac mini" });
    expect(
      projectCopyView(
        progress({
          phase: "failed",
          error: { code: "clone-failed", message: "No route.", retry: null },
        }),
        clone,
      ),
    ).toMatchObject({ title: "Couldn't clone ryco to Mac mini", retryLabel: null });
    const link = { ...labels, action: "link" as const };
    expect(
      projectCopyView(progress({ phase: "cancelled", canCloseClient: true }), link),
    ).toMatchObject({ title: "Stopped linking ryco", description: "Mac mini cancelled the link." });
    expect(projectCopyView(progress({ phase: "acquire" }), link).title).toBe(
      "Linking ryco on Mac mini",
    );
  });

  it("measures the upload's speed over its last few seconds", () => {
    let samples = nextCopyByteSamples([], { at: 0, bytes: 0 });
    // Under a second says nothing yet.
    samples = nextCopyByteSamples(samples, { at: 500, bytes: MB });
    expect(copyThroughput(samples, 10 * MB)).toBeNull();
    samples = nextCopyByteSamples(samples, { at: 2_000, bytes: 4 * MB });
    expect(copyThroughput(samples, 10 * MB)).toEqual({ bytesPerSecond: 2 * MB, secondsLeft: 3 });
    // Old readings drop out of the window, keeping one from just before it.
    samples = nextCopyByteSamples(samples, { at: 6_000, bytes: 6 * MB });
    samples = nextCopyByteSamples(samples, { at: 8_000, bytes: 10 * MB });
    expect(samples.map((sample) => sample.at)).toEqual([2_000, 6_000, 8_000]);
    expect(copyThroughput(samples, 12 * MB)).toEqual({ bytesPerSecond: MB, secondsLeft: 2 });
    // An upload that started over starts the readings afresh.
    expect(nextCopyByteSamples(samples, { at: 9_000, bytes: MB })).toEqual([
      { at: 9_000, bytes: MB },
    ]);
    // Nothing moved: a speed of zero and no time left to tell.
    expect(
      copyThroughput(
        [
          { at: 0, bytes: MB },
          { at: 2_000, bytes: MB },
        ],
        10 * MB,
      ),
    ).toEqual({ bytesPerSecond: 0, secondsLeft: null });
  });

  it("formats the speed and the time left", () => {
    expect(formatCopySpeed(640 * 1024)).toBe("640 KB/s");
    expect(formatCopySpeed(3.24 * MB)).toBe("3.2 MB/s");
    expect(formatCopySpeed(42.6 * MB)).toBe("43 MB/s");
    expect(formatCopyTimeLeft(0.2)).toBe("1 s left");
    expect(formatCopyTimeLeft(8)).toBe("8 s left");
    expect(formatCopyTimeLeft(61)).toBe("2 min left");
    expect(formatCopyTimeLeft(3_600)).toBe("1 h left");
    expect(formatCopyTimeLeft(3_900)).toBe("1 h 5 min left");
    expect(formatCopyThroughput({ bytesPerSecond: 3.2 * MB, secondsLeft: 8 })).toBe(
      "3.2 MB/s · 8 s left",
    );
    expect(formatCopyThroughput({ bytesPerSecond: 0, secondsLeft: null })).toBe("0 KB/s");
  });

  it("says the upload's speed and time left once they are known", () => {
    const view = projectCopyView(
      progress({ phase: "upload", uploadedBytes: 12 * MB, totalBytes: 38 * MB }),
      labels,
      { bytesPerSecond: 3.2 * MB, secondsLeft: 9 },
    );
    expect(view.description).toBe(
      "Sending 12 of 38 MB · 3.2 MB/s · 9 s left. Keep Ryco open until the upload finishes.",
    );
  });
});
