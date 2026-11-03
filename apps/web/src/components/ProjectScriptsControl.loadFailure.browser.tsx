import "../index.css";

import {
  EnvironmentId,
  ThreadId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { syncDocumentPresentationTier } from "../lib/presentationTier";

const chunks = vi.hoisted(() => ({
  /** Components whose chunk fails to load (offline, or a deploy replaced it). */
  failing: new Set<unknown>(),
  /** Every component a load came back with, failed or not. */
  loaded: [] as unknown[],
  /** While set, loads come back only once it resolves (a slow link). */
  hold: null as Promise<void> | null,
  notify:
    vi.fn<
      (
        surface: string,
        error: unknown,
        retry: () => void,
        threadRef?: ScopedThreadRef | null,
      ) => void
    >(),
}));

// The app's own loaders, failing for the components in `chunks.failing`.
vi.mock("../lib/preloadableLazy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/preloadableLazy")>();
  return {
    ...actual,
    preloadableLazy: <P extends object>(load: () => Promise<React.ComponentType<P>>) =>
      actual.preloadableLazy(() =>
        load().then(async (component) => {
          await chunks.hold;
          chunks.loaded.push(component);
          if (chunks.failing.has(component)) {
            throw new Error("Failed to fetch dynamically imported module");
          }
          return component;
        }),
      ),
  };
});
vi.mock("./ui/surfaceLoadFailure", () => ({
  notifySurfaceLoadFailure: chunks.notify,
}));

import { ProjectScriptDialog } from "./ProjectScriptDialog";
import ProjectScriptsControl from "./ProjectScriptsControl";

const BUILD_SCRIPT: ProjectScript = {
  id: "build",
  name: "Build",
  command: "bun run build",
  icon: "build",
  runOnWorktreeCreate: false,
};
const LINT_SCRIPT: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "bun lint",
  icon: "lint",
  runOnWorktreeCreate: false,
};

const environmentId = EnvironmentId.make("environment-local");
const THREAD_A: ScopedThreadRef = { environmentId, threadId: ThreadId.make("thread-a") };
const THREAD_B: ScopedThreadRef = { environmentId, threadId: ThreadId.make("thread-b") };

function dialogPopup(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
}

describe("ProjectScriptsControl action dialog load failure", () => {
  let stopTierSync: (() => void) | null = null;

  beforeEach(async () => {
    await page.viewport(1_280, 800);
    stopTierSync = syncDocumentPresentationTier();
  });

  afterEach(() => {
    stopTierSync?.();
    stopTierSync = null;
    chunks.failing.clear();
    chunks.loaded.length = 0;
    chunks.hold = null;
    chunks.notify.mockClear();
    document.body.innerHTML = "";
  });

  /** The chat header's control, as it is for one thread of one project. */
  function control(
    threadRef: ScopedThreadRef,
    scripts: ProjectScript[],
    onUpdateScript: (scriptId: string) => void = vi.fn(),
  ) {
    return (
      <div className="@container/header-actions flex items-center gap-2 p-4">
        <ProjectScriptsControl
          scripts={scripts}
          keybindings={{} as ResolvedKeybindingsConfig}
          preferredScriptId={null}
          threadRef={threadRef}
          onRunScript={vi.fn()}
          onAddScript={vi.fn()}
          onUpdateScript={onUpdateScript}
          onDeleteScript={vi.fn()}
        />
      </div>
    );
  }

  // First in the file on purpose: no test has loaded the dialog yet.
  it("starts loading the dialog when the pointer reaches the scripts menu trigger", async () => {
    chunks.failing.add(ProjectScriptDialog);
    const mounted = await render(control(THREAD_A, [BUILD_SCRIPT]));

    try {
      await userEvent.hover(page.getByRole("button", { name: "Script actions" }));

      await vi.waitFor(() => expect(chunks.loaded).toContain(ProjectScriptDialog));
      // Nothing was opened: a speculative load that fails stays quiet.
      expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
      expect(chunks.notify).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("loads the dialog again on retry after the control that failed has remounted", async () => {
    chunks.failing.add(ProjectScriptDialog);
    const failed = await render(control(THREAD_A, [BUILD_SCRIPT]));
    let retry: () => void;
    try {
      await page.getByRole("button", { name: "Script actions" }).click();
      (page.getByRole("button", { name: "Edit Build" }).element() as HTMLElement).click();
      await vi.waitFor(() => expect(chunks.notify).toHaveBeenCalledOnce());
      retry = chunks.notify.mock.calls[0]![2];
    } finally {
      await failed.unmount();
    }
    // The same thread in a new view (a draft that became a server thread),
    // so its toast is still up. It sits away from the pointer, so no hover
    // loads the chunk, and the chunk keeps failing, so no later test finds it
    // loaded.
    const remounted = await render(
      <div className="pt-64">{control(THREAD_A, [BUILD_SCRIPT])}</div>,
    );

    try {
      const loads = chunks.loaded.length;
      retry();

      await vi.waitFor(() => expect(chunks.loaded.slice(loads)).toContain(ProjectScriptDialog));
    } finally {
      await remounted.unmount();
    }
  });

  it("reports a dialog chunk that fails to load for its thread and reopens the same action on retry", async () => {
    chunks.failing.add(ProjectScriptDialog);
    const onUpdateScript = vi.fn();
    const mounted = await render(control(THREAD_A, [BUILD_SCRIPT], onUpdateScript));

    try {
      await page.getByRole("button", { name: "Script actions" }).click();
      // Hover or keyboard focus reveals the edit button; CI's headless Linux
      // reports no hover, so activate it directly.
      (page.getByRole("button", { name: "Edit Build" }).element() as HTMLElement).click();

      // The open is dropped, nothing threw to an error boundary, and the toast
      // belongs to the thread the action was opened for.
      await vi.waitFor(() => expect(chunks.notify).toHaveBeenCalledOnce());
      const [surface, , retry, threadRef] = chunks.notify.mock.calls[0]!;
      expect(surface).toBe("action dialog");
      expect(threadRef).toEqual(THREAD_A);
      expect(dialogPopup()).toBeNull();
      // The menu it was chosen from is still open.
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull());

      // A plain thread switch keeps this control: another project's thread,
      // where another action is added, then back. An open still waiting for
      // its chunk does not survive the switch, so it never opens this
      // project's action over the other project's thread.
      chunks.failing.clear();
      let releaseChunk!: () => void;
      chunks.hold = new Promise<void>((resolve) => {
        releaseChunk = resolve;
      });
      await page.getByRole("button", { name: "Script actions" }).click();
      (page.getByRole("button", { name: "Edit Build" }).element() as HTMLElement).click();
      await mounted.rerender(control(THREAD_B, [LINT_SCRIPT]));
      const loads = chunks.loaded.length;
      releaseChunk();
      await vi.waitFor(() => expect(chunks.loaded.length).toBeGreaterThan(loads));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(dialogPopup()).toBeNull();
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull());

      // The chunk is in now, so the dialog opens at once.
      await page.getByRole("button", { name: "Script actions" }).click();
      await page.getByRole("menuitem", { name: "Add action" }).click();
      await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(dialogPopup()).toBeNull(), { timeout: 2_000 });
      await mounted.rerender(control(THREAD_A, [BUILD_SCRIPT], onUpdateScript));

      // Retry opens the action it failed to open, not the last one shown.
      retry();

      await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("Build");
      await expect
        .element(page.getByRole("textbox", { name: "Command" }))
        .toHaveValue("bun run build");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => expect(onUpdateScript).toHaveBeenCalledOnce());
      expect(onUpdateScript.mock.calls[0]?.[0]).toBe("build");
      expect(chunks.notify).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });
});
