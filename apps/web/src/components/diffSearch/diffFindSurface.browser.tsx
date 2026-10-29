import "~/index.css";

import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ThreadId } from "@ryco/contracts";

import { resetAppKeybindings, updateAppKeybinding } from "~/appKeybindings";
import { isMacPlatform } from "~/lib/utils";
import { useTerminalStateStore } from "~/terminalStateStore";

import { shouldIgnoreDiffFindShortcut, useDiffFindSurface } from "./diffFindSurface";

function findKey(
  target: EventTarget | null,
  init: KeyboardEventInit = {},
): KeyboardEvent & { target: EventTarget | null } {
  const mac = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    metaKey: mac,
    ctrlKey: !mac,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target?.dispatchEvent(event);
  return event;
}

function dialog(): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("role", "dialog");
  element.textContent = "A dialog";
  document.body.append(element);
  return element;
}

describe("shouldIgnoreDiffFindShortcut", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function surfaceWithTarget(parent: HTMLElement = document.body) {
    const surface = document.createElement("div");
    const target = document.createElement("button");
    surface.append(target);
    parent.append(surface);
    return { surface, target };
  }

  it("handles a key from inside the surface", () => {
    const { surface, target } = surfaceWithTarget();
    expect(shouldIgnoreDiffFindShortcut({ type: "keydown", target }, surface)).toBe(false);
  });

  it("ignores a key from outside the surface, such as a portal React bubbles through it", () => {
    const { surface } = surfaceWithTarget();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    expect(shouldIgnoreDiffFindShortcut({ type: "keydown", target: elsewhere }, surface)).toBe(
      true,
    );
  });

  it("ignores IME composition and other key phases", () => {
    const { surface, target } = surfaceWithTarget();
    expect(
      shouldIgnoreDiffFindShortcut({ type: "keydown", isComposing: true, target }, surface),
    ).toBe(true);
    expect(shouldIgnoreDiffFindShortcut({ type: "keyup", target }, surface)).toBe(true);
  });

  it("is not silenced by a dialog that hosts the surface, only by another one", () => {
    const host = dialog();
    const { surface, target } = surfaceWithTarget(host);
    expect(shouldIgnoreDiffFindShortcut({ type: "keydown", target }, surface)).toBe(false);
    dialog();
    expect(shouldIgnoreDiffFindShortcut({ type: "keydown", target }, surface)).toBe(true);
  });
});

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-diff-find"),
  ThreadId.make("thread-diff-find"),
);

function Surface(props: {
  readonly onFind: () => void;
  readonly enabled: boolean;
  readonly portal?: boolean;
}) {
  const surface = useDiffFindSurface({
    onFind: props.onFind,
    enabled: props.enabled,
    scope: null,
    threadRef: THREAD_REF,
  });
  return (
    <div data-testid="surface" {...surface.props}>
      <input aria-label="Field" />
      <div className="diff-render-surface" style={{ height: 40, overflow: "auto" }}>
        <div style={{ height: 200 }}>Diff text</div>
      </div>
      <button type="button" onClick={surface.focus}>
        Focus diff
      </button>
      {props.portal ? createPortal(<button type="button">Portaled</button>, document.body) : null}
    </div>
  );
}

describe("useDiffFindSurface", () => {
  beforeEach(async () => {
    await resetAppKeybindings();
  });

  afterEach(async () => {
    useTerminalStateStore.getState().setTerminalOpen(THREAD_REF, false);
    await resetAppKeybindings();
  });

  it("runs find for the thread-find key from inside the surface, editable targets included", async () => {
    const onFind = vi.fn();
    const screen = await render(<Surface onFind={onFind} enabled />);
    const surface = screen.getByTestId("surface").element();
    expect(surface.hasAttribute("data-diff-find-surface")).toBe(true);
    expect(surface.getAttribute("tabindex")).toBe("-1");

    const text = page.getByText("Diff text").element();
    expect(findKey(text).defaultPrevented).toBe(true);
    expect(findKey(page.getByLabelText("Field").element()).defaultPrevented).toBe(true);
    expect(onFind).toHaveBeenCalledTimes(2);

    // Another key does nothing.
    expect(findKey(text, { key: "g", code: "KeyG" }).defaultPrevented).toBe(false);
    expect(onFind).toHaveBeenCalledTimes(2);
  });

  it("follows the user's thread-find binding", async () => {
    const onFind = vi.fn();
    await render(<Surface onFind={onFind} enabled />);
    await updateAppKeybinding("thread.find", { key: "mod+g", command: "thread.find" });
    const text = page.getByText("Diff text").element();
    await vi.waitFor(() =>
      expect(findKey(text, { key: "g", code: "KeyG" }).defaultPrevented).toBe(true),
    );
    expect(findKey(text).defaultPrevented).toBe(false);
  });

  it("resolves the key with the chat's context, so a terminal-only binding wins while the terminal is open", async () => {
    const onFind = vi.fn();
    await render(<Surface onFind={onFind} enabled />);
    await updateAppKeybinding("terminal.toggle", {
      key: "mod+f",
      command: "terminal.toggle",
      when: "terminalOpen",
    });
    const text = page.getByText("Diff text").element();
    useTerminalStateStore.getState().setTerminalOpen(THREAD_REF, true);
    // The new binding reaches the hook on its next render.
    await vi.waitFor(() => expect(findKey(text).defaultPrevented).toBe(false));
    onFind.mockClear();
    expect(findKey(text).defaultPrevented).toBe(false);
    expect(onFind).not.toHaveBeenCalled();

    useTerminalStateStore.getState().setTerminalOpen(THREAD_REF, false);
    expect(findKey(text).defaultPrevented).toBe(true);
    expect(onFind).toHaveBeenCalledTimes(1);
  });

  it("leaves a key from a portal alone", async () => {
    const onFind = vi.fn();
    await render(<Surface onFind={onFind} enabled portal />);
    const portaled = page.getByRole("button", { name: "Portaled" }).element();
    expect(findKey(portaled).defaultPrevented).toBe(false);
    expect(onFind).not.toHaveBeenCalled();
  });

  it("makes the scroller the click-focus target and focuses it on request", async () => {
    await render(<Surface onFind={vi.fn()} enabled />);
    const scroller = document.querySelector<HTMLElement>(".diff-render-surface")!;
    expect(scroller.getAttribute("tabindex")).toBe("-1");
    await page.getByRole("button", { name: "Focus diff" }).click();
    expect(document.activeElement).toBe(scroller);
  });

  it("adds nothing while disabled", async () => {
    const onFind = vi.fn();
    const screen = await render(<Surface onFind={onFind} enabled={false} />);
    const surface = screen.getByTestId("surface").element();
    expect(surface.hasAttribute("data-diff-find-surface")).toBe(false);
    expect(surface.hasAttribute("tabindex")).toBe(false);
    expect(document.querySelector(".diff-render-surface")!.hasAttribute("tabindex")).toBe(false);
    expect(findKey(page.getByText("Diff text").element()).defaultPrevented).toBe(false);
    expect(onFind).not.toHaveBeenCalled();
  });
});
