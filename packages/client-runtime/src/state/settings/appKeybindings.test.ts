import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import type { KVService } from "../../platform/index.ts";
import { DEFAULT_RESOLVED_KEYBINDINGS, DEFAULT_KEYBINDINGS } from "@ryco/shared/keybindings";
import {
  APP_KEYBINDINGS_STORAGE_KEY,
  appKeybindingsFromRules,
  createAppKeybindingsStore,
  DEFAULT_APP_KEYBINDINGS,
  importAppKeybindings,
  keybindingsForProject,
  resolveAppKeybindings,
  scopedScriptCommand,
  validateAppKeybindings,
} from "./appKeybindings.ts";
import {
  applyServerConfigEvent,
  clearServerState,
  setServerConfigSnapshot,
} from "../../rpc/serverState.ts";

function persistence() {
  const values = new Map<string, string>();
  const kv: KVService = {
    getItem: vi.fn(async (key) => values.get(key) ?? null),
    setItem: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key) => {
      values.delete(key);
    }),
  };
  return { kv, values };
}
const custom = { rules: [{ key: "mod+x", command: "terminal.toggle" }], disabledCommands: [] };

describe("app-owned keybindings", () => {
  it("persists across stores/relaunch independently of node clears and config pushes", async () => {
    const { kv, values } = persistence();
    const app = createAppKeybindingsStore(kv);
    await app.update(() => custom);
    const saved = app.getSnapshot().bindings;
    const node = (id: string) =>
      ({
        environment: { environmentId: EnvironmentId.make(id) },
        providers: [],
        issues: [],
        settings: DEFAULT_SERVER_SETTINGS,
        keybindings: [],
      }) as unknown as ServerConfig;
    setServerConfigSnapshot(node("node-a"));
    applyServerConfigEvent({
      version: 1,
      type: "keybindingsUpdated",
      payload: { keybindings: [], issues: [] },
    });
    expect(app.getSnapshot().bindings).toBe(saved);
    setServerConfigSnapshot(node("node-b"));
    clearServerState();
    setServerConfigSnapshot(node("node-b"));
    expect(app.getSnapshot().bindings).toBe(saved);
    const relaunched = createAppKeybindingsStore(kv);
    await relaunched.hydrate();
    expect(relaunched.getSnapshot().preferences).toEqual(custom);
    expect([...values.keys()]).toEqual([APP_KEYBINDINGS_STORAGE_KEY]);
    expect(values.has("ryco:client-settings:v1")).toBe(false);
  });

  it("awaits hydration before edits and never lets a delayed read overwrite them", async () => {
    const { kv } = persistence();
    let release!: (value: string) => void;
    vi.mocked(kv.getItem).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const app = createAppKeybindingsStore(kv);
    const hydration = app.hydrate();
    expect(app.getSnapshot().bindings).toEqual([]);
    const write = app.update((current) => ({ ...current, disabledCommands: ["chat.new"] }));
    expect(kv.setItem).not.toHaveBeenCalled();
    release(JSON.stringify(custom));
    await hydration;
    await write;
    expect(app.getSnapshot().preferences).toEqual({ ...custom, disabledCommands: ["chat.new"] });
    expect(app.getSnapshot().bindings.some((rule) => rule.command === "chat.new")).toBe(false);
    expect(
      app.getSnapshot().bindings.find((rule) => rule.command === "terminal.toggle")?.shortcut.key,
    ).toBe("x");
  });

  it("serializes writes, publishes only durable state and continues after a failure", async () => {
    const { kv, values } = persistence();
    const app = createAppKeybindingsStore(kv);
    await app.hydrate();
    let reject!: (cause: Error) => void;
    vi.mocked(kv.setItem).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const failed = app.update(() => custom);
    const failure = expect(failed).rejects.toThrow("disk full");
    const later = app.update((current) => ({ ...current, disabledCommands: ["chat.new"] }));
    await vi.waitFor(() => expect(kv.setItem).toHaveBeenCalledTimes(1));
    expect(app.getSnapshot().preferences).toEqual(DEFAULT_APP_KEYBINDINGS);
    reject(new Error("disk full"));
    await failure;
    await later;
    expect(app.getSnapshot().preferences).toEqual({ rules: [], disabledCommands: ["chat.new"] });
    expect(JSON.parse(values.get(APP_KEYBINDINGS_STORAGE_KEY)!)).toEqual(
      app.getSnapshot().preferences,
    );
  });

  it("preserves malformed local data rather than silently replacing it during hydration", async () => {
    const { kv, values } = persistence();
    values.set(APP_KEYBINDINGS_STORAGE_KEY, "{broken");
    const app = createAppKeybindingsStore(kv);
    await expect(app.hydrate()).rejects.toThrow();
    await expect(app.update(() => custom)).rejects.toThrow();
    expect(app.getSnapshot().hydrated).toBe(false);
    expect(kv.setItem).not.toHaveBeenCalled();
  });

  it("imports explicitly, preserving local overrides and deliberate unbindings; reset restores defaults", async () => {
    const { kv } = persistence();
    const app = createAppKeybindingsStore(kv);
    await app.update(() => ({ ...custom, disabledCommands: ["chat.new"] }));
    await app.update((current) =>
      importAppKeybindings(current, [
        { key: "mod+y", command: "terminal.toggle" },
        { key: "mod+t", command: "chat.new" },
        { key: "mod+r", command: "diff.toggle" },
      ]),
    );
    expect(app.getSnapshot().preferences.rules).toEqual([
      { key: "mod+r", command: "diff.toggle" },
      ...custom.rules,
    ]);
    expect(app.getSnapshot().bindings.some((rule) => rule.command === "chat.new")).toBe(false);
    await app.update(() => DEFAULT_APP_KEYBINDINGS);
    expect(app.getSnapshot().bindings).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
  });

  it("retains unbinding through reload, while newly introduced defaults remain available", () => {
    const preferences = appKeybindingsFromRules([{ key: "mod+x", command: "terminal.toggle" }]);
    const decoded = validateAppKeybindings(JSON.parse(JSON.stringify(preferences)));
    expect(resolveAppKeybindings(decoded).map((rule) => rule.command)).toEqual(["terminal.toggle"]);
    expect(resolveAppKeybindings(custom).some((rule) => rule.command === "chat.new")).toBe(true);
    expect(() =>
      validateAppKeybindings({
        rules: [{ key: "ctrl", command: "chat.new" }],
        disabledCommands: [],
      }),
    ).toThrow();
    expect(() =>
      importAppKeybindings(DEFAULT_APP_KEYBINDINGS, [{ key: "mod+x", command: "script.test.run" }]),
    ).toThrow("assigned to a project");
  });

  it("resolves identical script/project ids only for their environment/project and cannot shadow foreign shortcuts", () => {
    const first = { environmentId: "node/a", projectId: "same/id" };
    const second = { environmentId: "node%2Fa", projectId: "same/id" };
    const otherProject = { ...first, projectId: "other" };
    const bindings = resolveAppKeybindings({
      rules: [
        { key: "mod+j", command: scopedScriptCommand(first, "test") },
        { key: "mod+x", command: scopedScriptCommand(second, "test") },
        { key: "mod+y", command: scopedScriptCommand(otherProject, "test") },
      ],
      disabledCommands: [],
    });
    expect(scopedScriptCommand(first, "test")).not.toEqual(scopedScriptCommand(second, "test"));
    expect(
      keybindingsForProject(bindings, first).filter((rule) => rule.command.startsWith("script.")),
    ).toEqual([
      expect.objectContaining({
        command: "script.test.run",
        shortcut: expect.objectContaining({ key: "j" }),
      }),
    ]);
    expect(
      keybindingsForProject(bindings, null).some(
        (rule) => rule.command.startsWith("projectScript.") || rule.command.startsWith("script."),
      ),
    ).toBe(false);
  });

  it("stores only actual overrides so later import can fill untouched commands", () => {
    const fullEditor = DEFAULT_KEYBINDINGS.map((rule) =>
      rule.command === "terminal.toggle" ? { ...rule, key: "mod+x" } : rule,
    );
    const preferences = appKeybindingsFromRules(fullEditor);
    expect(preferences.rules).toEqual(custom.rules);
    expect(preferences.disabledCommands).toEqual([]);
    const imported = importAppKeybindings(preferences, [{ key: "mod+r", command: "diff.toggle" }]);
    expect(imported.rules).toEqual([{ key: "mod+r", command: "diff.toggle" }, ...custom.rules]);
    expect(appKeybindingsFromRules(DEFAULT_KEYBINDINGS)).toEqual(DEFAULT_APP_KEYBINDINGS);
  });

  it.each([
    { key: "ctrl", command: "terminal.toggle" },
    { key: "mod+x", command: "terminal.toggle", when: "terminalFocus &&" },
  ] as const)("rejects invalid extra default-command rules before normalization: %j", (invalid) => {
    expect(() => appKeybindingsFromRules([...DEFAULT_KEYBINDINGS, invalid])).toThrow(
      "Invalid shortcut or when expression.",
    );
  });

  it("recovers corrupted data only after explicit reset; retry can reload repaired data", async () => {
    const { kv, values } = persistence();
    values.set(APP_KEYBINDINGS_STORAGE_KEY, "{broken");
    const app = createAppKeybindingsStore(kv);
    await expect(app.hydrate()).rejects.toThrow();
    values.set(APP_KEYBINDINGS_STORAGE_KEY, JSON.stringify(custom));
    await app.hydrate();
    expect(app.getSnapshot().preferences).toEqual(custom);
    values.set(APP_KEYBINDINGS_STORAGE_KEY, "{broken");
    await expect(app.reload()).rejects.toThrow();
    await app.reset();
    expect(app.getSnapshot().hydrated).toBe(true);
    expect(app.getSnapshot().bindings).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
    expect(JSON.parse(values.get(APP_KEYBINDINGS_STORAGE_KEY)!)).toEqual(DEFAULT_APP_KEYBINDINGS);
  });

  it("another window can reload persisted shortcuts without a node reconnect", async () => {
    const { kv } = persistence();
    const first = createAppKeybindingsStore(kv);
    const second = createAppKeybindingsStore(kv);
    await second.hydrate();
    await first.update(() => custom);
    await second.reload();
    expect(second.getSnapshot().preferences).toEqual(custom);
  });
});
