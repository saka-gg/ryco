import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { APP_KEYBINDINGS_STORAGE_KEY } from "@ryco/client-runtime/state/settings";
import { appKeybindingsKV, subscribeAppKeybindingsChanges } from "./appKeybindings";

vi.mock("./kv", () => ({
  webKV: {
    getItem: vi.fn(async () => "browser document"),
    setItem: vi.fn(async () => undefined),
  },
}));
import { webKV } from "./kv";
afterEach(() => vi.unstubAllGlobals());
describe("app keybindings platform persistence", () => {
  it("uses the installation bridge regardless of renderer origin or node", async () => {
    const stop = vi.fn();
    const bridge = {
      read: vi.fn(async () => "desktop document"),
      write: vi.fn(async () => undefined),
      onChanged: vi.fn(() => stop),
    };
    vi.stubGlobal("window", { desktopBridge: { appKeybindings: bridge } });
    await expect(appKeybindingsKV.getItem(APP_KEYBINDINGS_STORAGE_KEY)).resolves.toBe(
      "desktop document",
    );
    await appKeybindingsKV.setItem(APP_KEYBINDINGS_STORAGE_KEY, "new document");
    const changed = vi.fn();
    subscribeAppKeybindingsChanges(changed)();
    expect(bridge.write).toHaveBeenCalledWith("new document");
    expect(bridge.onChanged).toHaveBeenCalledWith(changed);
    expect(stop).toHaveBeenCalled();
    expect(webKV.setItem).not.toHaveBeenCalled();
  });
  it("does not silently fall back to origin-scoped storage on an older desktop bridge", async () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    await expect(appKeybindingsKV.getItem(APP_KEYBINDINGS_STORAGE_KEY)).rejects.toThrow(
      "Restart Ryco Desktop",
    );
    await expect(appKeybindingsKV.setItem(APP_KEYBINDINGS_STORAGE_KEY, "document")).rejects.toThrow(
      "Restart Ryco Desktop",
    );
  });
  it("browser profiles use KV and reload only for shortcut storage changes", async () => {
    const listeners = new Map<string, (event: { key: string | null }) => void>();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      addEventListener: (name: string, listener: (event: { key: string | null }) => void) =>
        listeners.set(name, listener),
      removeEventListener,
    });
    await expect(appKeybindingsKV.getItem(APP_KEYBINDINGS_STORAGE_KEY)).resolves.toBe(
      "browser document",
    );
    const changed = vi.fn();
    const stop = subscribeAppKeybindingsChanges(changed);
    listeners.get("storage")!({ key: "node-config" });
    expect(changed).not.toHaveBeenCalled();
    listeners.get("storage")!({ key: APP_KEYBINDINGS_STORAGE_KEY });
    listeners.get("storage")!({ key: null });
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    expect(removeEventListener).toHaveBeenCalled();
  });
});
