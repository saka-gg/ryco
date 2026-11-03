import "~/index.css";

import { scopedScriptCommand } from "@ryco/client-runtime/state/settings";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { resetAppKeybindings, updateAppKeybinding } from "~/appKeybindings";
import { isMacPlatform } from "~/lib/utils";

import { PullRequestShortcutsDialog } from "./PullRequestShortcutsDialog";

const SCOPE = { environmentId: "environment-1", projectId: "project-1" } as const;

function findRowKey(): string | null {
  const row = [...document.querySelectorAll("dt")].find(
    (term) => term.textContent === "Find in the diff",
  );
  return row?.nextElementSibling?.textContent ?? null;
}

describe("PullRequestShortcutsDialog", () => {
  beforeEach(async () => {
    await resetAppKeybindings();
  });
  afterEach(async () => {
    await resetAppKeybindings();
    document.body.innerHTML = "";
  });

  it("lists the find key as the thread-find binding", async () => {
    const mac = isMacPlatform(navigator.platform);
    const screen = await render(
      <PullRequestShortcutsDialog open onOpenChange={() => undefined} scope={SCOPE} />,
    );
    await expect.element(page.getByText("Find in the diff")).toBeVisible();
    expect(findRowKey()).toBe(mac ? "⌘F" : "Ctrl+F");

    await updateAppKeybinding("thread.find", { key: "mod+g", command: "thread.find" });
    await expect.poll(findRowKey).toBe(mac ? "⌘G" : "Ctrl+G");
    await screen.unmount();
  });

  it("leaves the row out where a project shortcut takes the key", async () => {
    const script = scopedScriptCommand(SCOPE, "build");
    await updateAppKeybinding(script, { key: "mod+f", command: script });
    const screen = await render(
      <PullRequestShortcutsDialog open onOpenChange={() => undefined} scope={SCOPE} />,
    );
    await expect.element(page.getByText("Submit comment or review")).toBeVisible();
    expect(findRowKey()).toBeNull();
    await screen.unmount();

    // Another project's shortcut does not take it.
    const other = await render(
      <PullRequestShortcutsDialog
        open
        onOpenChange={() => undefined}
        scope={{ environmentId: "environment-1", projectId: "project-2" }}
      />,
    );
    await expect.element(page.getByText("Find in the diff")).toBeVisible();
    await other.unmount();
  });
});
