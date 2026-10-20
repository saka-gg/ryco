import "../../index.css";

import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId, TurnId, type ScopedThreadRef } from "@ryco/contracts";
import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { calibratePointerInput, cdpSession, parkPointer } from "../../../test/browserPointer";
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

function threads(options: { readonly runningA1: boolean }): SidebarThreadSummary[] {
  return ROWS.map((row) => ({
    id: ThreadId.make(`press-${row.id}`),
    environmentId: row.environmentId,
    projectId: PROJECT_ID,
    title: `Task ${row.id.toUpperCase()}`,
    interactionMode: "default",
    session: null,
    createdAt: row.createdAt,
    archivedAt: null,
    latestTurn:
      options.runningA1 && row.id === "a1"
        ? {
            turnId: TurnId.make("press-turn-a1"),
            state: "running",
            requestedAt: "2026-09-01T10:06:00.000Z",
            startedAt: "2026-09-01T10:06:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          }
        : null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }));
}

let publishEnvironments: (next: ReadonlyArray<InboxSidebarEnvironment>) => void = () => undefined;

function Host(hostProps: InboxSidebarProps) {
  const [environments, setEnvironments] = useState(hostProps.environments);
  useLayoutEffect(() => {
    publishEnvironments = setEnvironments;
  }, []);
  // A sidebar-wide column: the row's hover card opens beside the rows, as in the app.
  return (
    <div style={{ width: 320 }}>
      <InboxSidebar {...hostProps} environments={environments} />
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
const sectionTitles = () =>
  [...document.querySelectorAll('[data-testid="inbox-sidebar"] section')].map(
    (section) => section.querySelector("h2")?.textContent,
  );
const nextFrames = async (count: number) => {
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
};

/** Input coordinates of an element's centre. */
async function centreOf(element: HTMLElement): Promise<{ x: number; y: number }> {
  const toInput = await calibratePointerInput();
  const rect = element.getBoundingClientRect();
  return toInput(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

async function pressAt(point: { x: number; y: number }): Promise<void> {
  const session = cdpSession();
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 0 });
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
}

async function releaseAt(point: { x: number; y: number }): Promise<void> {
  await cdpSession().send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mountInbox(options: { readonly runningA1: boolean }) {
  await page.viewport(1280, 900);
  const onOpenThread = vi.fn();
  mounted = await render(
    <Host
      projects={[]}
      worktrees={[]}
      environments={[MACHINE_A, MACHINE_B]}
      threads={threads(options)}
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
  harness.press.mockClear();
  harness.onPress = null;
  publishEnvironments = () => undefined;
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

describe("pressing an inbox row of a machine that is not connected", () => {
  it.each([
    {
      name: "while its machine connects",
      runningA1: false,
      published: { connectionState: "connecting" },
      shown: "Connecting",
    },
    {
      name: "next to running work in Active now",
      runningA1: true,
      published: { connectionState: "connecting" },
      shown: "Connecting",
    },
    {
      name: "while it waits for a connection slot",
      runningA1: false,
      published: { connectionState: "reconnecting", queued: true },
      shown: "Waiting",
    },
  ] as const)(
    "keeps the pressed row in place and opens it $name",
    async ({ runningA1, published, shown }) => {
      const onOpenThread = await mountInbox({ runningA1 });
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
    const onOpenThread = await mountInbox({ runningA1: false });
    const point = await centreOf(rowButton(keyOf("a2"))!);
    await pressAt(point);
    await releaseAt(point);

    await expect.poll(() => onOpenThread.mock.calls.length).toBe(1);
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(refOf("a2"));
    expect(harness.press).toHaveBeenCalledExactlyOnceWith(refOf("a2"));
  });
});
