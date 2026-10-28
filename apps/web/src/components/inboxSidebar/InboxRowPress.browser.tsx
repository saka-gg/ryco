import "../../index.css";

import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId, TurnId, type ScopedThreadRef } from "@ryco/contracts";
import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  calibratePointerInput,
  cdpSession,
  parkPointer,
  resetPointerEmulation,
  setCoarsePointerEmulation,
} from "../../../test/browserPointer";
import { useInboxFilterStore } from "./inboxFilterStore";
// The inbox loads its order hold once it mounts; loaded up front, it is ready
// before each test below points at a row.
import "./inboxOrderHoldRuntime";
import { InboxSidebar, type InboxSidebarProps } from "./InboxSidebar";
import type { InboxSidebarEnvironment } from "./inboxSidebarModel";

// The press handler stands in for the press pre-connect: it publishes the
// machine's new connection state from inside the row's pointerdown handler, as
// the pre-connect's store publish does, so React commits it before the release.
const harness = vi.hoisted(() => ({
  press: vi.fn(),
  onPress: null as ((ref: ScopedThreadRef) => void) | null,
}));

vi.mock("../sidebar/threadNavigationIntent", async () => ({
  isNavigationPress: (await import("../sidebar/threadNavigationIntent.logic")).isNavigationPress,
  noteThreadHoverIntent: vi.fn(),
  noteThreadHoverEnd: vi.fn(),
  noteThreadPressIntent: (ref: ScopedThreadRef) => {
    harness.press(ref);
    harness.onPress?.(ref);
  },
  preloadDraftRoute: vi.fn(),
}));

const ENV_A = EnvironmentId.make("press-machine-a");
const ENV_B = EnvironmentId.make("press-machine-b");
const PROJECT_ID = ProjectId.make("press-project");

const MACHINE_A: InboxSidebarEnvironment = {
  environmentId: ENV_A,
  label: "Alpha",
  connectionState: "connected",
  stale: false,
  role: "owner",
  trust: "not-required",
  deliveryUnknown: false,
  threadSettlementSupported: true,
  mutationReady: true,
  shellCurrent: true,
};
const MACHINE_B: InboxSidebarEnvironment = {
  ...MACHINE_A,
  environmentId: ENV_B,
  label: "Bravo",
  connectionState: "idle",
  mutationReady: false,
};

/** Interleaved by machine, newest first: A1, B1, A2, B2, A3, B3. */
const ROWS = [
  { id: "a1", environmentId: ENV_A, createdAt: "2026-09-01T10:06:00.000Z" },
  { id: "b1", environmentId: ENV_B, createdAt: "2026-09-01T10:05:00.000Z" },
  { id: "a2", environmentId: ENV_A, createdAt: "2026-09-01T10:04:00.000Z" },
  { id: "b2", environmentId: ENV_B, createdAt: "2026-09-01T10:03:00.000Z" },
  { id: "a3", environmentId: ENV_A, createdAt: "2026-09-01T10:02:00.000Z" },
  { id: "b3", environmentId: ENV_B, createdAt: "2026-09-01T10:01:00.000Z" },
] as const;

const refOf = (id: string) =>
  scopeThreadRef(id.startsWith("a") ? ENV_A : ENV_B, ThreadId.make(`press-${id}`));
const keyOf = (id: string) => scopedThreadKey(refOf(id));
/** The inbox shows the fixture in this order, with or without running work in Active now. */
const ROW_KEYS = ROWS.map((row) => keyOf(row.id));

/** A row's latest turn, or that it was settled. Rows without one are idle and seen. */
type RowChange = "running" | "completed" | "settled";

function threads(
  changes: Readonly<Partial<Record<string, RowChange>>> = {},
): SidebarThreadSummary[] {
  return ROWS.map((row) => {
    const change = changes[row.id];
    return {
      id: ThreadId.make(`press-${row.id}`),
      environmentId: row.environmentId,
      projectId: PROJECT_ID,
      title: `Task ${row.id.toUpperCase()}`,
      interactionMode: "default",
      session: null,
      createdAt: row.createdAt,
      archivedAt: null,
      latestTurn:
        change === "running" || change === "completed"
          ? {
              turnId: TurnId.make(`press-turn-${row.id}`),
              state: change,
              requestedAt: row.createdAt,
              startedAt: row.createdAt,
              completedAt: change === "completed" ? "2026-09-01T10:07:00.000Z" : null,
              assistantMessageId: null,
            }
          : null,
      latestCompletedTurnAt: change === "completed" ? "2026-09-01T10:07:00.000Z" : null,
      settledOverride: change === "settled" ? "settled" : null,
      settledAt: change === "settled" ? "2026-09-01T10:07:00.000Z" : null,
      branch: null,
      worktreePath: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
  });
}

let publishEnvironments: (next: ReadonlyArray<InboxSidebarEnvironment>) => void = () => undefined;
let publishThreads: (next: ReadonlyArray<SidebarThreadSummary>) => void = () => undefined;

function Host(hostProps: InboxSidebarProps) {
  const [environments, setEnvironments] = useState(hostProps.environments);
  const [threadList, setThreadList] = useState(hostProps.threads);
  useLayoutEffect(() => {
    publishEnvironments = setEnvironments;
    publishThreads = setThreadList;
  }, []);
  // A sidebar-wide column: the row's hover card opens beside the rows, as in the app.
  // The field stands in for the composer, outside the inbox.
  return (
    <div style={{ display: "flex", gap: 400 }}>
      <div style={{ width: 320 }}>
        <InboxSidebar {...hostProps} environments={environments} threads={threadList} />
      </div>
      <input aria-label="Composer" />
    </div>
  );
}

const rowButton = (key: string) =>
  document.querySelector<HTMLElement>(
    `[data-inbox-row-key="${key}"] [data-testid="inbox-thread-row"]`,
  );
const rowText = (id: string) =>
  document.querySelector(`[data-inbox-row-key="${keyOf(id)}"]`)?.textContent ?? "";
const rowKeys = () =>
  [...document.querySelectorAll("[data-inbox-row-key]")].map((element) =>
    element.getAttribute("data-inbox-row-key"),
  );
const rowShell = (id: string) =>
  document.querySelector<HTMLElement>(`[data-inbox-row-key="${keyOf(id)}"]`)!;
const glyphLabel = (id: string) =>
  rowShell(id).querySelector("[data-inbox-glyph]")?.getAttribute("aria-label");
const sectionOf = (id: string) => rowShell(id).closest("section")?.querySelector("h2")?.textContent;
const sectionTitles = () =>
  [...document.querySelectorAll('[data-testid="inbox-sidebar"] section')].map(
    (section) => section.querySelector("h2")?.textContent,
  );
const nextFrames = async (count: number) => {
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
};

type InputPoint = { readonly x: number; readonly y: number };
type ClientToInput = Awaited<ReturnType<typeof calibratePointerInput>>;

function centreIn(toInput: ClientToInput, element: Element): InputPoint {
  const rect = element.getBoundingClientRect();
  return toInput(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

/** Input coordinates of an element's centre. */
async function centreOf(element: HTMLElement): Promise<InputPoint> {
  return centreIn(await calibratePointerInput(), element);
}

async function moveTo(point: InputPoint): Promise<void> {
  await cdpSession().send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 0 });
}

async function pressAt(point: InputPoint): Promise<void> {
  const session = cdpSession();
  await moveTo(point);
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
}

async function releaseAt(point: InputPoint): Promise<void> {
  await cdpSession().send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mountInbox(
  options: {
    readonly changes?: Readonly<Partial<Record<string, RowChange>>>;
    readonly motionReady?: boolean;
  } = {},
) {
  await page.viewport(1280, 900);
  const onOpenThread = vi.fn();
  mounted = await render(
    <Host
      projects={[]}
      worktrees={[]}
      environments={[MACHINE_A, MACHINE_B]}
      threads={threads(options.changes)}
      motionReady={options.motionReady}
      deliveryUnknownThreadKeys={new Set()}
      localQueuedThreadKeys={new Set()}
      activeThreadKey={null}
      aiFocusEnabled={false}
      autoSettleAfterDays={null}
      pinnedThreadKeys={new Set()}
      onOpenThread={onOpenThread}
    />,
  );
  await expect.poll(() => rowKeys()).toEqual(ROW_KEYS);
  await nextFrames(2);
  return onOpenThread;
}

function expectSameRect(before: DOMRect, after: DOMRect) {
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.left - before.left)).toBeLessThanOrEqual(0.5);
}

afterEach(async () => {
  await parkPointer(0, 0);
  await resetPointerEmulation();
  harness.press.mockClear();
  harness.onPress = null;
  publishEnvironments = () => undefined;
  publishThreads = () => undefined;
  useInboxFilterStore.getState().setStatus("all");
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

describe("pressing an inbox row of a machine that is not connected", () => {
  it.each([
    {
      name: "while its machine connects",
      changes: {},
      published: { connectionState: "connecting" },
      shown: "Connecting",
    },
    {
      name: "next to running work in Active now",
      changes: { a1: "running" },
      published: { connectionState: "connecting" },
      shown: "Connecting",
    },
    {
      name: "while it waits for a connection slot",
      changes: {},
      published: { connectionState: "reconnecting", queued: true },
      shown: "Waiting",
    },
  ] as const)(
    "keeps the pressed row in place and opens it $name",
    async ({ changes, published, shown }) => {
      const onOpenThread = await mountInbox({ changes });
      const pressed = rowButton(keyOf("b2"))!;
      const before = pressed.getBoundingClientRect();
      const keysBefore = rowKeys();
      const titlesBefore = sectionTitles();
      harness.onPress = (ref) => {
        if (ref.environmentId === ENV_B) {
          publishEnvironments([MACHINE_A, { ...MACHINE_B, ...published }]);
        }
      };

      const point = await centreOf(pressed);
      await pressAt(point);
      // The publish committed before the release.
      await vi.waitFor(() => expect(rowText("b2")).toContain(shown));
      await nextFrames(2);
      const stillThere = rowButton(keyOf("b2"));
      const during = stillThere?.getBoundingClientRect();
      await releaseAt(point);

      expect(harness.press).toHaveBeenCalledExactlyOnceWith(refOf("b2"));
      expect(stillThere).toBe(pressed);
      expect(pressed.isConnected).toBe(true);
      expectSameRect(before, during!);
      expect(rowKeys()).toEqual(keysBefore);
      expect(sectionTitles()).toEqual(titlesBefore);
      await expect.poll(() => onOpenThread.mock.calls.length).toBe(1);
      expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(refOf("b2"));

      // The machine finished connecting: the row still does not move.
      publishEnvironments([MACHINE_A, { ...MACHINE_B, connectionState: "connected" }]);
      await vi.waitFor(() => expect(rowText("b2")).not.toContain(shown));
      await nextFrames(2);
      expect(rowButton(keyOf("b2"))).toBe(pressed);
      expectSameRect(before, pressed.getBoundingClientRect());
      expect(rowKeys()).toEqual(keysBefore);
      expect(sectionTitles()).toEqual(titlesBefore);
    },
  );

  it("opens a connected machine's row with a trusted click", async () => {
    const onOpenThread = await mountInbox();
    const point = await centreOf(rowButton(keyOf("a2"))!);
    await pressAt(point);
    await releaseAt(point);

    await expect.poll(() => onOpenThread.mock.calls.length).toBe(1);
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(refOf("a2"));
    expect(harness.press).toHaveBeenCalledExactlyOnceWith(refOf("a2"));
  });
});

describe("holding the inbox order while the user aims at it", () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Calibrates once: probing moves the pointer, so it ends parked outside the inbox. */
  async function pointerInput(): Promise<ClientToInput> {
    const toInput = await calibratePointerInput();
    await moveTo(toInput(1_000, 850));
    return toInput;
  }

  /** Points at a row and lets the hold commit before anything else changes. */
  async function pointAt(toInput: ClientToInput, element: Element): Promise<void> {
    await moveTo(centreIn(toInput, element));
    await nextFrames(2);
  }

  it("keeps a finishing thread's place under the pointer and glides it once the pointer leaves", async () => {
    await mountInbox({ changes: { a1: "running" } });
    const toInput = await pointerInput();
    expect(sectionTitles()).toEqual(["Active now", "Recent"]);
    await pointAt(toInput, rowButton(keyOf("a2"))!);
    const below = rowShell("b1").getBoundingClientRect();

    publishThreads(threads({ a1: "completed" }));
    // The row shows its live state at once, but nothing moves.
    await vi.waitFor(() => expect(glyphLabel("a1")).toBe("Completed"));
    await nextFrames(2);
    expect(sectionOf("a1")).toBe("Active now");
    expect(sectionTitles()).toEqual(["Active now", "Recent"]);
    expect(rowKeys()).toEqual(ROW_KEYS);
    expectSameRect(below, rowShell("b1").getBoundingClientRect());

    await moveTo(toInput(1_000, 850));
    await vi.waitFor(() => expect(sectionTitles()).toEqual(["Recent"]));
    expect(sectionOf("a1")).toBe("Recent");
    expect(rowKeys()).toEqual(ROW_KEYS);
    expect(rowShell("b1").getAnimations().length).toBeGreaterThan(0);
  });

  it("keeps a row that leaves the filtered section until the pointer leaves", async () => {
    await mountInbox({ changes: { a1: "running" } });
    useInboxFilterStore.getState().setStatus("active");
    await vi.waitFor(() => expect(rowKeys()).toEqual([keyOf("a1")]));
    const toInput = await pointerInput();
    await pointAt(toInput, rowButton(keyOf("a1"))!);

    publishThreads(threads({ a1: "completed" }));
    await vi.waitFor(() => expect(glyphLabel("a1")).toBe("Completed"));
    expect(sectionTitles()).toEqual(["Active now"]);

    await moveTo(toInput(1_000, 850));
    await vi.waitFor(() => expect(rowKeys()).toEqual([]));
  });

  it("shows a row that enters the filtered section while the pointer stays", async () => {
    await mountInbox({ changes: { a1: "running" } });
    useInboxFilterStore.getState().setStatus("active");
    await vi.waitFor(() => expect(rowKeys()).toEqual([keyOf("a1")]));
    const toInput = await pointerInput();
    await pointAt(toInput, rowButton(keyOf("a1"))!);
    const pointed = rowShell("a1").getBoundingClientRect();

    // B2 waited in the hidden Recent section when the hold began.
    publishThreads(threads({ a1: "running", b2: "running" }));
    await vi.waitFor(() => expect(rowKeys()).toEqual([keyOf("a1"), keyOf("b2")]));
    expect(sectionTitles()).toEqual(["Active now"]);
    expectSameRect(pointed, rowShell("a1").getBoundingClientRect());
  });

  it("counts the row's hover card as the inbox", async () => {
    await mountInbox({ changes: { a1: "running" } });
    const toInput = await pointerInput();
    const row = rowButton(keyOf("a2"))!;
    await pointAt(toInput, row);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="inbox-preview"]')?.textContent).toContain(
        "Task A2",
      ),
    );
    const card = document.querySelector<HTMLElement>('[data-testid="inbox-preview"]')!;
    await pointAt(toInput, card);
    await pause(450);
    const rowBefore = row.getBoundingClientRect();
    const cardBefore = card.getBoundingClientRect();

    publishThreads(threads({ a1: "completed" }));
    await vi.waitFor(() => expect(glyphLabel("a1")).toBe("Completed"));
    await nextFrames(2);
    expect(card.isConnected).toBe(true);
    expect(sectionTitles()).toEqual(["Active now", "Recent"]);
    expectSameRect(rowBefore, row.getBoundingClientRect());
    expectSameRect(cardBefore, card.getBoundingClientRect());

    await moveTo(toInput(1_000, 850));
    await vi.waitFor(() => expect(sectionTitles()).toEqual(["Recent"]));
  });

  it("closes the row's hover card when rows move as the pointer leaves", async () => {
    await mountInbox({ changes: { a1: "running" } });
    const toInput = await pointerInput();
    await pointAt(toInput, rowButton(keyOf("a2"))!);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="inbox-preview"]')?.textContent).toContain(
        "Task A2",
      ),
    );
    publishThreads(threads({ a1: "completed" }));
    await vi.waitFor(() => expect(glyphLabel("a1")).toBe("Completed"));
    await nextFrames(2);
    expect(sectionTitles()).toEqual(["Active now", "Recent"]);

    // The rows that move as the hold ends drop the card's pending close.
    await moveTo(toInput(1_000, 850));
    await vi.waitFor(() => expect(sectionTitles()).toEqual(["Recent"]));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="inbox-preview"]')).toBeNull(),
    );
  });

  it("lets rows move once the user types outside the inbox", async () => {
    await mountInbox({ changes: { a1: "running" } });
    const toInput = await pointerInput();
    await pointAt(toInput, rowButton(keyOf("a2"))!);
    publishThreads(threads({ a1: "completed" }));
    await vi.waitFor(() => expect(glyphLabel("a1")).toBe("Completed"));
    await nextFrames(2);
    expect(sectionTitles()).toEqual(["Active now", "Recent"]);

    // The pointer stays parked on the sidebar. A modifier alone, as for a
    // Cmd-click, keeps the hold.
    document.querySelector<HTMLInputElement>('input[aria-label="Composer"]')!.focus();
    await userEvent.keyboard("{Shift}");
    await nextFrames(2);
    expect(sectionTitles()).toEqual(["Active now", "Recent"]);
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(sectionTitles()).toEqual(["Recent"]));
  });

  it("lets rows move once the user taps outside the inbox", async () => {
    await mountInbox({ changes: { a1: "running" } });
    const toInput = await pointerInput();
    await pointAt(toInput, rowButton(keyOf("a2"))!);
    publishThreads(threads({ a1: "completed" }));
    await vi.waitFor(() => expect(glyphLabel("a1")).toBe("Completed"));
    await nextFrames(2);
    expect(sectionTitles()).toEqual(["Active now", "Recent"]);

    // The mouse stays parked on the sidebar while a finger taps the composer.
    document
      .querySelector('input[aria-label="Composer"]')!
      .dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerType: "touch" }),
      );
    await vi.waitFor(() => expect(sectionTitles()).toEqual(["Recent"]));
  });

  it("moves a row the user settles at once, while the rest hold", async () => {
    await mountInbox();
    const toInput = await pointerInput();
    await pointAt(toInput, rowButton(keyOf("b2"))!);

    publishThreads(threads({ a1: "running", a2: "settled" }));
    await vi.waitFor(() => expect(sectionTitles()).toEqual(["Recent", "Settled"]));
    expect(rowKeys()).toEqual(ROW_KEYS.filter((key) => key !== keyOf("a2")));
    expect(sectionOf("a1")).toBe("Recent");
  });

  it.each([
    { name: "until its click, however late", end: (row: HTMLElement) => row.click(), opens: 1 },
    { name: "briefly after a release that no click follows", end: () => undefined, opens: 0 },
  ])("holds a touch press $name", async ({ end, opens }) => {
    const onOpenThread = await mountInbox({ motionReady: false });
    await pointerInput();
    const pressed = rowButton(keyOf("b2"))!;
    const before = pressed.getBoundingClientRect();
    const touch = (type: string) =>
      pressed.dispatchEvent(
        new PointerEvent(type, { bubbles: true, isPrimary: true, pointerType: "touch" }),
      );
    touch("pointerdown");
    touch("pointerup");
    await pause(100);

    publishThreads(threads({ a2: "running", a3: "running" }));
    await nextFrames(2);
    expect(sectionTitles()).toEqual(["Recent"]);
    expectSameRect(before, pressed.getBoundingClientRect());
    end(pressed);
    expect(onOpenThread).toHaveBeenCalledTimes(opens);
    await vi.waitFor(() => expect(sectionTitles()).toEqual(["Active now", "Recent"]));
  });

  it("lets a tap land on the row it pressed when the order changes before its click", async () => {
    // No glide: a moved row must not linger under the finger.
    const onOpenThread = await mountInbox({ motionReady: false });
    const toInput = await pointerInput();
    await setCoarsePointerEmulation(true);
    const pressed = rowButton(keyOf("b2"))!;
    const point = centreIn(toInput, pressed);
    const before = pressed.getBoundingClientRect();
    // A tap's click arrives in a later task than its release.
    window.addEventListener(
      "pointerup",
      () => publishThreads(threads({ a2: "running", a3: "running" })),
      { capture: true, once: true },
    );
    // Where the row is when the click lands: the press ends right after it.
    let atClick: DOMRect | null = null;
    window.addEventListener(
      "click",
      () => {
        atClick = pressed.getBoundingClientRect();
      },
      { capture: true, once: true },
    );
    const session = cdpSession();
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect.poll(() => onOpenThread.mock.calls.length).toBe(1);
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(refOf("b2"));
    expectSameRect(before, atClick!);
    // The press is over: the new order applies.
    await vi.waitFor(() => expect(sectionTitles()).toEqual(["Active now", "Recent"]));
    expect(sectionOf("a2")).toBe("Active now");
  });
});
