// The runtime's browser-upload wiring: the store on start, the backend binding, settle after every
// /control request, tab resets and dispose. Electron, the beta stack, the overlay and the embedded
// browser are stubs; the policy controller, the HTTP bridge and the store are real.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { newBrowserUploadId } from "@ryco/shared/browserUpload";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ tabReset: [] as Array<(tab: string) => void> }));
vi.mock("electron", () => ({
  app: { getPath: () => "/usr/bin/ryco", getName: () => "Ryco", isPackaged: false },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  systemPreferences: { isTrustedAccessibilityClient: vi.fn() },
}));
vi.mock("./beta.ts", () => ({
  DesktopComputerBeta: class {
    async start() {}
    stop() {}
    async dispose() {}
    binding() {
      return undefined;
    }
  },
}));
vi.mock("./overlay.ts", () => ({
  ComputerUseOverlay: class {
    setEnabled() {
      return true;
    }
    show() {
      return true;
    }
    dispose() {}
  },
}));
vi.mock("./embeddedBrowser.ts", () => ({
  EmbeddedComputerBrowser: class {
    onTabReset(listener: (tab: string) => void) {
      mocks.tabReset.push(listener);
      return () => undefined;
    }
    stop() {}
    dispose() {}
  },
}));

import { BROWSER_UPLOAD_DIR_NAME, BrowserUploadStore } from "./browserUploads.ts";
import { DesktopComputerUseRuntime } from "./runtime.ts";

const temporary: string[] = [];
const runtimes: DesktopComputerUseRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
  mocks.tabReset.length = 0;
  vi.restoreAllMocks();
});

function newRuntime(stateDir: string): DesktopComputerUseRuntime {
  const runtime = new DesktopComputerUseRuntime({
    stateDir,
    helperPath: path.join(stateDir, "missing-helper"),
    extensionPath: path.join(stateDir, "missing-extension"),
    getWindow: () => null,
    changed: () => undefined,
  });
  runtimes.push(runtime);
  return runtime;
}

function stateDirectory(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryco-runtime-")));
  temporary.push(directory);
  return directory;
}

describe("DesktopComputerUseRuntime browser uploads", () => {
  it("advertises its upload directory and removes a request's copies once the request ends", async () => {
    const stateDir = stateDirectory();
    const runtime = newRuntime(stateDir);
    await runtime.start();
    const binding = runtime.backendBinding();
    const uploadDir = path.join(stateDir, BROWSER_UPLOAD_DIR_NAME);
    expect(binding.uploadDir).toBe(uploadDir);
    expect(fs.statSync(uploadDir).mode & 0o777).toBe(0o700);

    // A request the desktop refuses before the driver runs (Computer use is off by default).
    const uploadId = newBrowserUploadId();
    const slot = path.join(uploadDir, uploadId, "0");
    fs.mkdirSync(slot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(slot, "a.txt"), "hello upload");
    const response = await fetch(binding.url, {
      method: "POST",
      headers: { authorization: `Bearer ${binding.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session",
        threadId: "thread",
        turnId: "turn",
        tool: "browser",
        args: {
          action: "upload",
          browser: "ryco",
          tab: "1",
          files: [path.join(slot, "a.txt")],
          uploadId,
        },
      }),
    });
    expect(await response.json()).toMatchObject({ isError: true });
    await vi.waitFor(() => expect(fs.existsSync(path.join(uploadDir, uploadId))).toBe(false));
  });

  it("releases a tab's copies when its page resets and stops sweeping on dispose", async () => {
    const releaseTab = vi.spyOn(BrowserUploadStore.prototype, "releaseTab");
    const dispose = vi.spyOn(BrowserUploadStore.prototype, "dispose");
    const runtime = newRuntime(stateDirectory());
    // A reset before start() has no store to reach.
    expect(mocks.tabReset).toHaveLength(1);
    mocks.tabReset[0]!("7");
    expect(releaseTab).not.toHaveBeenCalled();
    await runtime.start();
    mocks.tabReset[0]!("7");
    expect(releaseTab).toHaveBeenCalledExactlyOnceWith("7");
    runtimes.splice(runtimes.indexOf(runtime), 1);
    runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps Computer use running without uploads when the directory cannot be made, and logs why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parent = stateDirectory();
    // A file where the state directory should be.
    const stateDir = path.join(parent, "state");
    fs.writeFileSync(stateDir, "");
    const runtime = newRuntime(stateDir);
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.backendBinding()).not.toHaveProperty("uploadDir");
    expect(warn).toHaveBeenCalledWith(
      "[desktop-computer-use] browser upload directory unavailable",
      expect.any(Error),
    );
  });
});
