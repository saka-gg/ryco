import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  trays: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    setToolTip: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
  }>,
  menu: vi.fn(),
}));
vi.mock("electron", () => ({
  Tray: class {
    destroy = vi.fn();
    setToolTip = vi.fn();
    setTitle = vi.fn();
    setContextMenu = vi.fn();
    constructor() {
      mocks.trays.push(this);
    }
  },
  Menu: { buildFromTemplate: mocks.menu },
  nativeImage: {
    createEmpty: () => ({
      addRepresentation: vi.fn(),
      setTemplateImage: vi.fn(),
      getSize: () => ({ width: 36, height: 36 }),
      toBitmap: () => Buffer.alloc(36 * 36 * 4),
    }),
    createFromBitmap: () => ({}),
  },
}));
import { ComputerActivityIndicator, describeComputerSessions } from "./activityIndicator.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.trays.length = 0;
});
afterEach(() => vi.useRealTimers());

it("names apps, never actions, and counts beyond two", () => {
  expect(describeComputerSessions([])).toBeNull();
  expect(describeComputerSessions([{ app: "Safari", mode: "background" }])).toBe(
    "Ryco is using Safari",
  );
  expect(
    describeComputerSessions([
      { app: "Safari", mode: "background" },
      { app: "Safari", mode: "background" },
      { app: "Notes", mode: "background" },
    ]),
  ).toBe("Ryco is using Safari and Notes");
  expect(
    describeComputerSessions([
      { app: "Safari", mode: "background" },
      { app: "Notes", mode: "foreground" },
      { app: "Mail", mode: "background" },
    ]),
  ).toBe("Ryco is controlling 3 apps");
});

it("keeps one tray without a title and rebuilds it only when the status changes", () => {
  const stop = vi.fn();
  const indicator = new ComputerActivityIndicator({ onStop: stop });
  expect(indicator.touch("a", "Safari", "background")).toBe(true);
  expect(indicator.touch("a", "Safari", "background")).toBe(false);
  expect(mocks.trays).toHaveLength(1);
  expect(mocks.trays[0]!.setTitle).not.toHaveBeenCalled();
  expect(mocks.menu).toHaveBeenCalledOnce();

  expect(indicator.touch("b", "Notes", "background")).toBe(true);
  const menu = mocks.menu.mock.calls.at(-1)![0] as Array<{ label?: string; click?: () => void }>;
  expect(menu.map((item) => item.label)).toEqual([
    "Ryco is using Safari and Notes",
    "Safari",
    "Notes",
    undefined,
    "Stop computer use",
  ]);
  menu.at(-1)!.click!();
  expect(stop).toHaveBeenCalledOnce();

  indicator.endAll();
  expect(mocks.trays[0]!.destroy).toHaveBeenCalledOnce();
  expect(indicator.summary).toBeNull();
});

it("drops a session after it goes idle and keeps the others", async () => {
  const indicator = new ComputerActivityIndicator({ onStop: vi.fn(), idleMs: 1000 });
  indicator.touch("cua:a", "Safari", "background");
  await vi.advanceTimersByTimeAsync(600);
  indicator.touch("legacy:b", "Ryco Browser", "background");
  await vi.advanceTimersByTimeAsync(500);
  expect(indicator.summary).toBe("Ryco is using Ryco Browser");
  indicator.endAll("legacy:");
  expect(mocks.trays[0]!.destroy).toHaveBeenCalledOnce();
});
