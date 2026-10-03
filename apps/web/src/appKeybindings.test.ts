import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const platform = vi.hoisted(() => ({
  getItem: vi.fn<() => Promise<string | null>>(),
  setItem: vi.fn(async () => undefined),
  subscribe: vi.fn(() => vi.fn()),
  stop: undefined as (() => void) | undefined,
}));
vi.mock("./platform/appKeybindings", () => ({
  appKeybindingsKV: { getItem: platform.getItem, setItem: platform.setItem },
  subscribeAppKeybindingsChanges: platform.subscribe,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (
    subscribe: (listener: () => void) => () => void,
    snapshot: () => unknown,
  ) => {
    platform.stop = subscribe(() => undefined);
    return snapshot();
  },
}));
afterEach(() => {
  platform.stop?.();
  platform.stop = undefined;
  vi.resetModules();
  vi.clearAllMocks();
});

describe("executable app shortcuts", () => {
  it("gates React and non-React consumers during a slow installation read", async () => {
    let release!: (document: string) => void;
    platform.getItem.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const app = await import("./appKeybindings");
    expect(app.getAppKeybindings()).toEqual([]);
    expect(app.useAllAppKeybindings()).toEqual([]);
    release(
      JSON.stringify({
        rules: [{ key: "mod+x", command: "terminal.toggle" }],
        disabledCommands: ["chat.new"],
      }),
    );
    await app.hydrateAppKeybindings();
    expect(app.getAppKeybindings().some((rule) => rule.command === "chat.new")).toBe(false);
    expect(
      app.getAppKeybindings().find((rule) => rule.command === "terminal.toggle")?.shortcut.key,
    ).toBe("x");
  });

  it("reloads changes missed during a zero-subscriber gap and gates the delayed reread", async () => {
    platform.getItem.mockResolvedValueOnce(null);
    const app = await import("./appKeybindings");
    app.useAllAppKeybindings();
    await app.hydrateAppKeybindings();
    platform.stop?.();
    platform.stop = undefined;
    let release!: (document: string) => void;
    platform.getItem.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    app.useAllAppKeybindings();
    await vi.waitFor(() => expect(platform.getItem).toHaveBeenCalledTimes(2));
    expect(app.getAppKeybindings()).toEqual([]);
    release(JSON.stringify({ rules: [], disabledCommands: ["chat.new"] }));
    await app.hydrateAppKeybindings();
    expect(app.getAppKeybindings().some((rule) => rule.command === "chat.new")).toBe(false);
    expect(platform.subscribe).toHaveBeenCalledTimes(2);
  });
});
