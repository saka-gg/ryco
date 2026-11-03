import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The dialog host and card are invoked as plain functions (no React renderer
// exists in this suite), with a small stand-in for React's state, ref and
// effect hooks: state persists per mounted instance, and an effect runs after
// a render when its dependencies changed.
const hooks = vi.hoisted(() => {
  interface Effect {
    readonly deps: ReadonlyArray<unknown> | undefined;
    readonly cleanup: (() => void) | undefined;
  }
  interface Instance {
    readonly slots: unknown[];
    readonly effects: Array<Effect | undefined>;
  }
  let current: Instance | null = null;
  let slot = 0;
  let effect = 0;
  let queued: Array<() => void> = [];
  const take = () => {
    if (current === null) throw new Error("hook outside a render");
    return current;
  };
  return {
    instance: (): Instance => ({ slots: [], effects: [] }),
    unmount(instance: Instance) {
      for (const mounted of instance.effects) mounted?.cleanup?.();
    },
    render<T>(instance: Instance, component: () => T): T {
      current = instance;
      slot = 0;
      effect = 0;
      try {
        return component();
      } finally {
        current = null;
        const run = queued;
        queued = [];
        for (const next of run) next();
      }
    },
    useState<T>(initial: T | (() => T)) {
      const instance = take();
      const index = slot++;
      if (!(index in instance.slots)) {
        instance.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const set = (next: T | ((previous: T) => T)) => {
        instance.slots[index] =
          typeof next === "function"
            ? (next as (previous: T) => T)(instance.slots[index] as T)
            : next;
      };
      return [instance.slots[index] as T, set] as const;
    },
    useRef<T>(initial: T) {
      const instance = take();
      const index = slot++;
      if (!(index in instance.slots)) instance.slots[index] = { current: initial };
      return instance.slots[index] as { current: T };
    },
    useEffect(run: () => void | (() => void), deps?: ReadonlyArray<unknown>) {
      const instance = take();
      const index = effect++;
      const previous = instance.effects[index];
      if (
        previous !== undefined &&
        deps !== undefined &&
        previous.deps !== undefined &&
        deps.length === previous.deps.length &&
        deps.every((value, at) => Object.is(value, previous.deps![at]))
      ) {
        return;
      }
      queued.push(() => {
        previous?.cleanup?.();
        const cleanup = run();
        instance.effects[index] = { deps, cleanup: cleanup ?? undefined };
      });
    },
  };
});

const mocks = vi.hoisted(() => ({ alert: vi.fn(), platform: { OS: "ios" } }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  Modal: "Modal",
  Platform: mocks.platform,
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("../lib/useThemeColor", () => ({ useThemeColor: () => "#000000" }));
vi.mock("../lib/cn", () => ({
  cn: (...values: ReadonlyArray<unknown>) => values.filter(Boolean).join(" "),
}));
vi.mock("./AppText", () => ({ AppText: "AppText" }));

import {
  ConfirmDialogCard,
  ConfirmDialogHost,
  showConfirmDialog,
  type ConfirmDialogRequest,
} from "./ConfirmDialogHost";
import { createHtmlRenderMessageDelivery } from "../features/threads/htmlRenderMessage";

function isElement(value: unknown): value is ReactElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

function collect(node: unknown, predicate: (element: ReactElement) => boolean): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, predicate));
  if (!isElement(node)) return [];
  const own = predicate(node) ? [node] : [];
  return [...own, ...collect((node.props as { children?: unknown }).children, predicate)];
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isElement(node)) return "";
  return textOf((node.props as { children?: unknown }).children);
}

interface ButtonProps {
  readonly disabled?: boolean;
  readonly onPress: () => void;
}

function button(tree: unknown, label: string): ButtonProps {
  const found = collect(tree, (element) => element.type === "Pressable").find(
    (element) => textOf(element) === label,
  );
  if (found === undefined) throw new Error(`no ${label} button`);
  return found.props as ButtonProps;
}

/** The mounted host: renders it and the card it shows, as React would. */
function mountHost() {
  const host = hooks.instance();
  let card = hooks.instance();
  let cardKey: unknown;
  const render = () => {
    const modal = hooks.render(host, () => ConfirmDialogHost()) as ReactElement<{
      visible: boolean;
      children: ReactElement<ConfirmDialogCardProps> | null;
    }>;
    const shown = modal.props.children;
    if (shown === null) return { visible: modal.props.visible, card: null };
    if (shown.key !== cardKey) {
      cardKey = shown.key;
      card = hooks.instance();
    }
    return {
      visible: modal.props.visible,
      card: hooks.render(card, () => ConfirmDialogCard(shown.props)),
      request: shown.props.request,
    };
  };
  render();
  return {
    render,
    unmount: () => {
      hooks.unmount(card);
      hooks.unmount(host);
    },
  };
}

/** Reports a quote box whose text fits it, as its scroll view does once laid out. */
function quoteFits(tree: unknown) {
  const box = collect(tree, (element) => element.type === "ScrollView").at(-1)!.props as {
    readonly onLayout: (event: unknown) => void;
    readonly onContentSizeChange: (width: number, height: number) => void;
  };
  box.onLayout({ nativeEvent: { layout: { height: 20 } } });
  box.onContentSizeChange(300, 20);
}

type ConfirmDialogCardProps = Parameters<typeof ConfirmDialogCard>[0];

beforeEach(() => {
  mocks.alert.mockReset();
  mocks.platform.OS = "ios";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("showConfirmDialog", () => {
  it("uses an actionable native destructive alert on iOS", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    showConfirmDialog({
      title: "Sign out of your Hub?",
      message: "This device's Hub session ends.",
      confirmText: "Sign out",
      destructive: true,
      onCancel,
      onConfirm,
    });

    expect(mocks.alert).toHaveBeenCalledTimes(1);
    const [title, message, actions] = mocks.alert.mock.calls[0] as [
      string,
      string,
      ReadonlyArray<{
        readonly text: string;
        readonly style: string;
        readonly onPress?: () => void;
      }>,
    ];
    expect(title).toBe("Sign out of your Hub?");
    expect(message).toBe("This device's Hub session ends.");
    expect(actions.map(({ text, style }) => ({ text, style }))).toEqual([
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive" },
    ]);

    actions[1]?.onPress?.();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows a dialog with a quote in the app's own dialog on iOS, the quote in its own box", () => {
    const host = mountHost();
    showConfirmDialog({
      title: "Send this message?",
      message: "The page “Poll” wants to send this.",
      quote: { text: "Option B", caption: "1 line, 8 characters" },
      confirmText: "Send",
      onConfirm: () => undefined,
    });
    expect(mocks.alert).not.toHaveBeenCalled();
    const { visible, card } = host.render();
    expect(visible).toBe(true);
    const texts = collect(card, (element) => element.type === "AppText").map(textOf);
    expect(texts).toContain("The page “Poll” wants to send this.");
    expect(texts).toContain("Option B");
    host.unmount();
  });
});

describe("ConfirmDialogHost on Android", () => {
  beforeEach(() => {
    mocks.platform.OS = "android";
  });

  it("closes on an answer, and shows the dialog an answer asks for next", () => {
    const host = mountHost();
    const onConfirm = vi.fn();
    const second: ConfirmDialogRequest = { title: "Second", confirmText: "OK", onConfirm };
    showConfirmDialog({
      title: "First",
      confirmText: "OK",
      // An answer that asks again, as a page's too-early Send does.
      onConfirm: () => showConfirmDialog(second),
    });
    let shown = host.render();
    expect(shown.request?.title).toBe("First");
    button(shown.card, "OK").onPress();
    shown = host.render();
    expect(shown.visible).toBe(true);
    expect(shown.request).toBe(second);
    button(shown.card, "OK").onPress();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    shown = host.render();
    expect(shown.visible).toBe(false);
    expect(shown.card).toBeNull();
    host.unmount();
  });

  it("lets a page's message be sent after a too-early Send asked again", async () => {
    vi.useFakeTimers();
    const host = mountHost();
    const queue = vi.fn();
    const clock = { now: 50_000 };
    const deliver = createHtmlRenderMessageDelivery({
      pageTitle: "Poll",
      confirm: showConfirmDialog,
      queue,
      now: () => clock.now,
    });
    const sent = deliver("Option B");
    let shown = host.render();
    quoteFits(shown.card);
    // The card's own wait has passed, but the press is still too early for the delivery.
    vi.advanceTimersByTime(1_000);
    shown = host.render();
    clock.now += 300;
    button(shown.card, "Send").onPress();
    // Asked again, not closed: the promise can still settle.
    shown = host.render();
    expect(shown.visible).toBe(true);
    expect(queue).not.toHaveBeenCalled();
    expect(button(shown.card, "Send").disabled).toBe(true);
    quoteFits(shown.card);
    vi.advanceTimersByTime(1_000);
    shown = host.render();
    expect(button(shown.card, "Send").disabled).toBe(false);
    clock.now += 2_000;
    button(shown.card, "Send").onPress();
    await expect(sent).resolves.toBeUndefined();
    expect(queue).toHaveBeenCalledExactlyOnceWith("Option B");
    expect(host.render().visible).toBe(false);
    host.unmount();
  });
});

describe("ConfirmDialogCard", () => {
  function renderCard(request: ConfirmDialogRequest) {
    const instance = hooks.instance();
    const onSettle = vi.fn((action: (() => void) | undefined) => action?.());
    const render = () => hooks.render(instance, () => ConfirmDialogCard({ request, onSettle }));
    return { render, onSettle };
  }

  const quoteBox = (tree: unknown) =>
    collect(tree, (element) => element.type === "ScrollView").at(-1)!.props as {
      readonly onLayout: (event: unknown) => void;
      readonly onContentSizeChange: (width: number, height: number) => void;
      readonly onScroll: (event: unknown) => void;
    };

  it("keeps Confirm disabled until the wait is over and the quote was read to its end", () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const card = renderCard({
      title: "Send this message?",
      quote: { text: "Line\n".repeat(20).trim(), caption: "20 lines, 99 characters" },
      confirmDelayMs: 1_000,
      confirmText: "Send",
      onConfirm,
    });
    let tree = card.render();
    expect(button(tree, "Send").disabled).toBe(true);
    expect(collect(tree, (element) => element.type === "AppText").map(textOf)).toContain(
      "20 lines, 99 characters · Scroll to the end first.",
    );
    vi.advanceTimersByTime(1_000);
    tree = card.render();
    // The wait is over, but the text runs past its box.
    quoteBox(tree).onLayout({ nativeEvent: { layout: { height: 240 } } });
    quoteBox(tree).onContentSizeChange(300, 400);
    tree = card.render();
    expect(button(tree, "Send").disabled).toBe(true);
    quoteBox(tree).onScroll({
      nativeEvent: {
        contentOffset: { y: 100 },
        layoutMeasurement: { height: 240 },
        contentSize: { height: 400 },
      },
    });
    tree = card.render();
    expect(button(tree, "Send").disabled).toBe(true);
    quoteBox(tree).onScroll({
      nativeEvent: {
        contentOffset: { y: 160 },
        layoutMeasurement: { height: 240 },
        contentSize: { height: 400 },
      },
    });
    tree = card.render();
    expect(button(tree, "Send").disabled).toBe(false);
    button(tree, "Send").onPress();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("starts the wait over with every touch while it runs", () => {
    vi.useFakeTimers();
    const card = renderCard({
      title: "Send this message?",
      quote: { text: "Option B", caption: "1 line, 8 characters" },
      confirmDelayMs: 1_000,
      confirmText: "Send",
      onConfirm: () => undefined,
    });
    let tree = card.render();
    quoteFits(tree);
    const backdrop = tree as ReactElement<{ onTouchStart: () => void }>;
    vi.advanceTimersByTime(600);
    backdrop.props.onTouchStart();
    tree = card.render();
    vi.advanceTimersByTime(600);
    tree = card.render();
    expect(button(tree, "Send").disabled).toBe(true);
    vi.advanceTimersByTime(400);
    tree = card.render();
    expect(button(tree, "Send").disabled).toBe(false);
  });

  it("asks nothing extra of a plain dialog", () => {
    const tree = renderCard({
      title: "Delete?",
      confirmText: "Delete",
      onConfirm: () => undefined,
    }).render;
    expect(button(tree(), "Delete").disabled).toBe(false);
  });
});
