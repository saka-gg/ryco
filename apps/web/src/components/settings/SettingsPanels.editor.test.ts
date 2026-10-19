import { readFile } from "node:fs/promises";
import { EDITORS, type EditorId } from "@ryco/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EDITOR_ICONS, getEditorLabel, resolveEditorOptions } from "./SettingsPanels.editor";

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("getEditorLabel", () => {
  it("uses platform-native names for the file manager editor", () => {
    expect(getEditorLabel("file-manager", "MacIntel")).toBe("Finder");
    expect(getEditorLabel("file-manager", "iPhone")).toBe("Finder");
    expect(getEditorLabel("file-manager", "Win32")).toBe("Explorer");
    expect(getEditorLabel("file-manager", "Linux x86_64")).toBe("Files");
  });

  it("uses the platform-native name for Terminal on Windows", () => {
    expect(getEditorLabel("terminal", "MacIntel")).toBe("Terminal");
    expect(getEditorLabel("terminal", "Win32")).toBe("Windows Terminal");
    expect(getEditorLabel("terminal", "Linux x86_64")).toBe("Terminal");
  });

  it("uses the contract label for every editor without a platform-specific label", () => {
    for (const editor of EDITORS) {
      if (editor.id === "file-manager" || editor.id === "terminal") continue;
      expect(getEditorLabel(editor.id, "MacIntel")).toBe(editor.label);
      expect(getEditorLabel(editor.id, "Win32")).toBe(editor.label);
      expect(getEditorLabel(editor.id, "Linux x86_64")).toBe(editor.label);
    }
  });
});

describe("resolveEditorOptions", () => {
  it("returns available editors in contract order with exhaustive display metadata", () => {
    const options = resolveEditorOptions("MacIntel", [
      "terminal",
      "android-studio",
      "windsurf",
      "file-manager",
    ]);

    expect(options.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "Windsurf", value: "windsurf" },
      { label: "Android Studio", value: "android-studio" },
      { label: "Terminal", value: "terminal" },
      { label: "Finder", value: "file-manager" },
    ]);
    for (const option of options) expect(option.Icon).toBeDefined();
  });

  it("hands out the same icon component on every call so a menu never remounts its logos", () => {
    const first = resolveEditorOptions("MacIntel", ["idea", "vscode", "file-manager"]);
    const second = resolveEditorOptions("MacIntel", ["idea", "vscode", "file-manager"]);

    expect(second.map(({ Icon }) => Icon)).toEqual(first.map(({ Icon }) => Icon));
  });

  it("uses the platform's own app icon for the file manager and terminal", () => {
    const iconOf = (platform: string, editor: EditorId) =>
      resolveEditorOptions(platform, [editor])[0]?.Icon;

    expect(iconOf("MacIntel", "file-manager")).not.toBe(EDITOR_ICONS["file-manager"]);
    expect(iconOf("Win32", "file-manager")).not.toBe(EDITOR_ICONS["file-manager"]);
    expect(iconOf("Linux x86_64", "file-manager")).toBe(EDITOR_ICONS["file-manager"]);
    expect(iconOf("MacIntel", "terminal")).not.toBe(EDITOR_ICONS.terminal);
    expect(iconOf("Win32", "terminal")).not.toBe(EDITOR_ICONS.terminal);
    expect(iconOf("Linux x86_64", "terminal")).toBe(EDITOR_ICONS.terminal);
  });
});

describe("EDITOR_ICONS", () => {
  it("has an entry for every editor id", () => {
    const icons: Record<EditorId, unknown> = EDITOR_ICONS;
    for (const editor of EDITORS) {
      expect(icons[editor.id]).toBeDefined();
    }
  });
});

describe("editor icon loading", () => {
  it("renders an empty svg in the caller's box until a lazily loaded logo arrives", () => {
    const markup = renderToStaticMarkup(
      createElement(EDITOR_ICONS.idea, { className: "size-4", "aria-hidden": "true" }),
    );

    expect(markup).toBe('<svg class="size-4" aria-hidden="true"></svg>');
  });

  it("loads the JetBrains logos on demand instead of with the thread route", async () => {
    const source = await readSource("./SettingsPanels.editor.ts");

    expect(source).not.toMatch(/^import [^;]*from "\.\.\/JetBrainsIcons";/mu);
    expect(source).toContain('import("../JetBrainsIcons")');
  });

  it("shows labels without pulling in any editor logo", async () => {
    // The thread menus and the promote dialog print only the file manager's name.
    for (const file of ["../chat/ChatProjectActions.tsx", "../chat/PromoteChatDialog.tsx"]) {
      const source = await readSource(file);
      expect(source, file).toContain('from "../settings/editorLabels.logic"');
      expect(source, file).not.toContain("SettingsPanels.editor");
    }
  });
});
