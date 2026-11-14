// The hosted "memory only" storage boundary, checked rather than remembered.
//
// docs/hosted-hub-client.md ("Security and browser persistence"): in hosted Hub builds, draft,
// terminal, general UI and other generic local-storage state lives in memory; node ids, paths
// and conversation text do not reach the browser's localStorage. The hosted-aware adapter is
// `appLocalStorage` (hooks/useLocalStorage.ts), with `appKV` (platform/kv.ts) on top of it.
//
// The first two cases read the source back: a module that names `localStorage` directly, or
// imports the always-durable `webKV`, has to be on a list below with the reason it may. A new
// raw use fails here instead of crossing the boundary unnoticed. The last case runs the
// adapters in hosted mode and checks that nothing reaches localStorage.
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const SOURCE_ROOT = import.meta.dirname;

/** Modules that may name `localStorage` directly, each with why that is safe in hosted builds. */
const RAW_LOCAL_STORAGE_ALLOWED: Readonly<Record<string, string>> = {
  "hooks/useLocalStorage.ts": "The hosted-aware adapter itself: memory in hosted builds.",
  "composerDraftPersistence.ts": "Gated on !isHostedHubMode(): drafts are memory in hosted builds.",
  "terminalStateStore.ts": "Gated on !isHostedHubMode().",
  "pullRequestReviewDraftStore.ts": "Gated on !isHostedHubMode().",
  "promptStashStore.ts": "Memory only when hosted (`hosted: isHostedHubMode()`).",
  "uiStateStore.ts": "In hosted builds writes only the sidebar mode, no node-owned data.",
  "hostedInboxPreferences.ts": "The documented schema-validated inbox preference record.",
  "hostedHub/readCache.ts":
    "Remembered-browser preference and the account pointer of its encrypted cache.",
  "hostedHub/bootHints.ts": "A signed-in boolean hint; no account, node or content data.",
  "settingsSharing/settingsSharingRuntime.ts":
    "Account-namespaced settings-sharing state, erased by the hosted account reset.",
  "settingsSharing/forgetHostedSettingsSharing.ts": "Erases the settings-sharing namespace.",
  "persistence/workspaceMetadataCache.ts": "Only removes a retired hosted cache key.",
  "platform/kv.ts":
    "`webKV` (durable everywhere) for the importers listed below; `appKV` is hosted-aware.",
  "updates/DesktopUpdatedNotice.tsx": "Desktop app only (last version whose notice was shown).",
  "components/settings/HubSection.tsx": "Desktop app only (Hub enrollment intent).",
  "themes/registry.ts": "Theme choice and custom themes: no account, node or content data.",
  "themes/appearancePreferences.ts": "Appearance overrides: no account, node or content data.",
  "hooks/useTheme.ts": "Light/dark/system choice: no account, node or content data.",
};

/** Modules that may import `webKV`, which is localStorage even in hosted builds. */
const DURABLE_WEB_KV_ALLOWED: Readonly<Record<string, string>> = {
  "platform/appKeybindings.ts": "One fixed key holding the user's own keybindings.",
  "components/usage/CodexResetCredits.tsx":
    "A pending reset-credit attempt must survive a reload so a retry reuses its idempotency key.",
};

function isTestSource(relative: string): boolean {
  return (
    /\.(test|browser)\.tsx?$/u.test(relative) ||
    /\.browser\.helpers\.tsx?$/u.test(relative) ||
    relative.startsWith("test/")
  );
}

function* productionSources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* productionSources(full);
      continue;
    }
    if (!/\.tsx?$/u.test(entry.name)) continue;
    const relative = path.relative(SOURCE_ROOT, full).split(path.sep).join("/");
    if (!isTestSource(relative)) yield relative;
  }
}

/** Source without comments, so prose that mentions localStorage does not count as a use. */
function code(relative: string): string {
  return readFileSync(path.join(SOURCE_ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gmu, "$1");
}

const SOURCES = [...productionSources(SOURCE_ROOT)];

describe("hosted storage boundary", () => {
  it("names localStorage only in modules that keep hosted builds in memory", () => {
    const raw = SOURCES.filter((relative) => /\blocalStorage\b/u.test(code(relative)));
    const unlisted = raw.filter((relative) => !(relative in RAW_LOCAL_STORAGE_ALLOWED));
    expect(
      unlisted,
      "Use appLocalStorage or appKV, or add the module with a reason the hosted policy allows",
    ).toEqual([]);
    // A listed module that no longer touches localStorage leaves the list.
    expect(Object.keys(RAW_LOCAL_STORAGE_ALLOWED).filter((entry) => !raw.includes(entry))).toEqual(
      [],
    );
  });

  it("imports the always-durable webKV only where its value holds no node-owned data", () => {
    const importers = SOURCES.filter(
      (relative) =>
        relative !== "platform/kv.ts" &&
        relative !== "platform/index.ts" &&
        /import\s*\{[^}]*\bwebKV\b[^}]*\}\s*from/u.test(code(relative)),
    );
    expect(importers.toSorted()).toEqual(Object.keys(DURABLE_WEB_KV_ALLOWED).toSorted());
  });
});

describe("hosted builds keep node-owned values out of localStorage", () => {
  afterEach(() => {
    vi.doUnmock("./env");
    vi.resetModules();
    delete (globalThis as { window?: unknown }).window;
  });

  it("holds held sends, comparison selections and browser sites in memory", async () => {
    const writes: string[] = [];
    const localStorage = {
      get length() {
        return 0;
      },
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: (key: string) => void writes.push(`remove ${key}`),
      setItem: (key: string) => void writes.push(`set ${key}`),
    };
    const sessionValues = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage,
      sessionStorage: {
        getItem: (key: string) => sessionValues.get(key) ?? null,
        setItem: (key: string, value: string) => void sessionValues.set(key, value),
      },
    };
    vi.resetModules();
    vi.doMock("./env", () => ({ isHostedHubMode: () => true }));

    const { appLocalStorage } = await import("./hooks/useLocalStorage");
    const { appKV } = await import("./platform/kv");
    const { readHeldSendRecords, updateHeldSendRecords } = await import("./heldSendRecords");

    updateHeldSendRecords(() => [
      {
        messageId: "message-1",
        threadKey: "environment-1:thread-1",
        draftTarget: { kind: "thread" },
        tabId: "tab-1",
        heartbeatAt: 1,
        prompt: "the prompt text",
        attachments: [],
        terminalContexts: [],
        fileReferences: [],
      },
    ]);
    await appKV.setItem("ryco:comparison:environment-1:/repo", '{"kind":"head"}');
    appLocalStorage.setItem("ryco:browser-sites:environment-1:/repo", '["http://localhost"]');

    expect(writes).toEqual([]);
    // Still usable within the window.
    expect(readHeldSendRecords().map((record) => record.prompt)).toEqual(["the prompt text"]);
    expect(await appKV.getItem("ryco:comparison:environment-1:/repo")).toBe('{"kind":"head"}');
  });
});
