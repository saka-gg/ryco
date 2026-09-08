import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import type { ReactNode } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { resetPointerEmulation, setCoarsePointerEmulation } from "../../test/browserPointer";
import { measureEffectiveHitTarget } from "../../test/touchTargets";
import { syncDocumentPresentationTier } from "../lib/presentationTier";
import {
  setAppearancePreference,
  applyAppearancePreferencesToDocument,
  APPEARANCE_PREFERENCES_STORAGE_KEY,
} from "../themes/appearancePreferences";
import DiffPanel from "./DiffPanel";

// Keep the real draft schema used by cn without initializing browser draft persistence.
vi.mock("../composerDraftStore", () => import("@ryco/client-runtime/state/composer"));

const openInPreferredEditor = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

/**
 * A line far wider than any phone viewport. The unwrapped presentation is the
 * only state in which horizontal containment can be observed at all, so the
 * fixture carries it rather than exercising the short default alone.
 */
const WIDE_LINE = vi.hoisted(() => "const veryLongIdentifierName = ".repeat(40));

const diffFile = {
  name: "b/src/app.ts",
  prevName: "a/src/app.ts",
  cacheKey: "src/app.ts",
  type: "change",
  additionLines: ["const alpha = 1;", "const beta = 2;"],
  deletionLines: ["const oldAlpha = 0;"],
};

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: vi.fn(() => [{ files: [diffFile] }]),
}));

vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: (props: { children: ReactNode }) => <>{props.children}</>,
  useWorkerPool: () => null,
  // The real `Virtualizer` applies the `className` it is given; forwarding it
  // is what makes the scroll container under test the production one rather
  // than an unstyled stand-in.
  Virtualizer: (props: { children: ReactNode; className?: string }) => (
    <div className={props.className}>{props.children}</div>
  ),
  FileDiff: (props: {
    fileDiff: typeof diffFile;
    renderHeaderPrefix?: () => ReactNode;
    options: {
      overflow?: string;
      diffStyle?: string;
      onLineNumberClick?: (input: { lineNumber: number; lineType: string }) => void;
    };
  }) => (
    <div data-test-diff-style={props.options.diffStyle}>
      <div data-title="">
        {props.renderHeaderPrefix?.()}
        {props.fileDiff.name}
      </div>
      <div data-line="">
        <button
          type="button"
          // Mock-only stand-in for the renderer's line-number affordance,
          // which is not a control in the real component. Excluded from the
          // touch-target sweep for that reason and no other.
          data-test-mock-control=""
          aria-label="Open added line 12"
          onClick={() =>
            props.options.onLineNumberClick?.({
              lineNumber: 12,
              lineType: "change-addition",
            })
          }
        >
          12
        </button>
        <mark>alpha</mark>
        <span> match</span>
      </div>
      <div data-line="">beta line</div>
      {/* Mirrors what `@pierre/diffs` ships for its code block: the renderer's
          own stylesheet declares `overflow: scroll clip` there, so a long line
          scrolls inside the diff rather than widening the panel. The `overflow`
          render option is honoured so the wrapped and unwrapped presentations
          are genuinely different fixtures. */}
      <div
        data-code=""
        data-line=""
        style={{
          overflow: props.options.overflow === "wrap" ? "hidden" : "scroll clip",
          whiteSpace: props.options.overflow === "wrap" ? "pre-wrap" : "pre",
          fontFamily: "monospace",
        }}
      >
        {WIDE_LINE}
      </div>
    </div>
  ),
}));

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: vi.fn((options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = { environmentId: "environment-local", threadId: "thread-1" };
    return options?.select ? options.select(params) : params;
  }),
  useSearch: vi.fn((options?: { select?: (search: Record<string, string>) => unknown }) => {
    const search = { diff: "1" };
    return options?.select ? options.select(search) : search;
  }),
}));

vi.mock("~/lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: { isRepo: true } }),
}));

vi.mock("~/rpc/useProvider", () => ({
  useCheckpointDiff: () => ({
    data: { diff: "diff --git a/src/app.ts b/src/app.ts" },
    error: null,
    isLoading: false,
  }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    resolvedTheme: "light",
  }),
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    diffWordWrap: false,
    diffIgnoreWhitespace: false,
    timestampFormat: "locale",
  }),
}));

/**
 * Twelve turns, not one. The turn strip's whole reachability question is what
 * happens when the rail overflows; a single-chip fixture never scrolls and
 * would make every strip assertion below true of any layout.
 */
const TURN_DIFF_SUMMARIES = vi.hoisted(() =>
  Array.from({ length: 12 }, (_unused, index) => ({
    turnId: `turn-${index + 1}`,
    checkpointTurnCount: index + 1,
    completedAt: "2026-05-06T00:00:00.000Z",
    files: [{ path: "src/app.ts" }],
  })),
);

vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    turnDiffSummaries: TURN_DIFF_SUMMARIES,
    inferredCheckpointTurnCountByTurnId: {},
  }),
}));

vi.mock("../threadRoutes", () => ({
  buildThreadRouteParams: () => ({ environmentId: "environment-local", threadId: "thread-1" }),
  resolveThreadRouteRef: () => ({
    environmentId: EnvironmentId.make("environment-local"),
    threadId: ThreadId.make("thread-1"),
  }),
}));

vi.mock("../storeSelectors", () => ({
  createThreadSelectorByRef: () => () => ({
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-1"),
    worktreePath: "/repo",
    turnDiffSummaries: [],
  }),
}));

vi.mock("../store", () => ({
  selectProjectByRef: () => ({
    cwd: "/repo",
  }),
  useStore: (selector: (store: Record<string, never>) => unknown) => selector({}),
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    shell: {
      openInEditor: vi.fn(),
    },
  }),
}));

/** The phone tier's touch floor, in CSS px. */
const TOUCH_FLOOR_PX = 44;

/**
 * A phone viewport with true input-modality emulation. Width alone reports
 * `pointer: fine`, under which every coarse-gated rule is inert, so the tier
 * attribute and the media query are both asserted live rather than assumed.
 */
async function usePhoneViewport(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  await setCoarsePointerEmulation(true);
  await vi.waitFor(() => {
    expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
  });
  expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
  expect(window.innerWidth).toBe(width);
}

function diffScrollSurface(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".diff-render-surface");
  if (!element) throw new Error("Expected the diff file list to be rendered.");
  return element;
}

function turnChips(): ReadonlyArray<HTMLElement> {
  return [...document.querySelectorAll<HTMLElement>("[data-turn-chip-selected]")];
}

/**
 * How much of a chip the rail actually exposes once it has been scrolled into
 * the rail's own view, and whether that exposed strip hit-tests to the chip.
 *
 * The chip's own box is not the answer: the rail is a clipping scroller, so a
 * chip can be 88px wide while the window it shows through is 16px. A control
 * you can only see 16px of is not operable at the touch floor, and asserting
 * the chip's box alone would call that a pass.
 */
function visibleChipTarget(
  chip: HTMLElement,
  strip: HTMLElement,
): { readonly width: number; readonly hitsChip: boolean } {
  chip.scrollIntoView({ block: "nearest", inline: "nearest" });
  const chipRect = chip.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  const stripStyle = getComputedStyle(strip);
  const left = Math.max(chipRect.left, stripRect.left + Number.parseFloat(stripStyle.paddingLeft));
  const right = Math.min(
    chipRect.right,
    stripRect.right - Number.parseFloat(stripStyle.paddingRight),
  );
  if (right <= left) return { width: 0, hitsChip: false };
  const hit = document.elementFromPoint((left + right) / 2, chipRect.top + chipRect.height / 2);
  return { width: right - left, hitsChip: hit !== null && chip.contains(hit) };
}

function turnStrip(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".turn-chip-strip");
  if (!element) throw new Error("Expected the turn strip to be rendered.");
  return element;
}

describe("DiffPanel", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeAll(() => {
    syncDocumentPresentationTier();
  });

  beforeEach(() => {
    localStorage.removeItem(APPEARANCE_PREFERENCES_STORAGE_KEY);
    openInPreferredEditor.mockClear();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    localStorage.removeItem(APPEARANCE_PREFERENCES_STORAGE_KEY);
    document.body.innerHTML = "";
    document.documentElement.style.fontSize = "";
    openInPreferredEditor.mockClear();
    await resetPointerEmulation();
    await page.viewport(1_280, 720);
  });

  it("shares the persistent layout between Appearance and the live diff toolbar", async () => {
    mounted = await render(<DiffPanel mode="sheet" />);
    setAppearancePreference("diffLayout", "split");
    applyAppearancePreferencesToDocument();
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-test-diff-style]")?.getAttribute("data-test-diff-style"),
      ).toBe("split"),
    );
    expect(
      JSON.parse(localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY) ?? "{}").diffLayout,
    ).toBe("split");
    await page.getByRole("button", { name: "Stacked diff view" }).click();
    expect(
      JSON.parse(localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY) ?? "{}").diffLayout,
    ).toBeUndefined();
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-test-diff-style]")?.getAttribute("data-test-diff-style"),
      ).toBe("unified"),
    );
  });

  it("keeps the phone presentation unified when split is preferred", async () => {
    setAppearancePreference("diffLayout", "split");
    applyAppearancePreferencesToDocument();
    mounted = await render(<DiffPanel mode="phone" />);
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-test-diff-style]")?.getAttribute("data-test-diff-style"),
      ).toBe("unified"),
    );
  });

  it("filters to search matches and cycles next results", async () => {
    mounted = await render(<DiffPanel mode="sheet" />);

    const search = page.getByLabelText("Search diff");
    await search.fill("beta");

    await expect.element(page.getByText("beta line")).toBeInTheDocument();
    await expect.element(page.getByText("1 of 1")).toBeInTheDocument();
    await page.getByRole("button", { name: "Next match" }).click();
    await expect.element(page.getByText("1 of 1")).toBeInTheDocument();
  });

  it("opens clicked line numbers in the preferred editor", async () => {
    mounted = await render(<DiffPanel mode="sheet" />);

    await page.getByRole("button", { name: "Open added line 12" }).click();

    await vi.waitFor(() => {
      expect(openInPreferredEditor).toHaveBeenCalledWith(expect.anything(), "/repo/src/app.ts:12");
    });
  });

  it("defaults to wrapped lines and hides the split toggle on the phone surface", async () => {
    mounted = await render(<DiffPanel mode="phone" />);

    // Wrap defaults on even though the settings mock has diffWordWrap: false.
    await expect
      .element(page.getByRole("button", { name: "Disable diff line wrapping" }))
      .toBeInTheDocument();
    // The split/stacked view toggle is meaningless at phone width.
    expect(document.querySelector('[aria-label="Stacked diff view"]')).toBeNull();
    expect(document.querySelector('[aria-label="Split diff view"]')).toBeNull();
    // The whitespace toggle stays available.
    await expect
      .element(page.getByRole("button", { name: "Hide whitespace changes" }))
      .toBeInTheDocument();
  });

  it("keeps the settings-driven wrap default on desktop presentations", async () => {
    mounted = await render(<DiffPanel mode="sheet" />);

    // diffWordWrap: false in the settings mock stays authoritative off-phone.
    await expect
      .element(page.getByRole("button", { name: "Enable diff line wrapping" }))
      .toBeInTheDocument();
  });

  it("suppresses open-in-editor taps on the phone surface", async () => {
    mounted = await render(<DiffPanel mode="phone" />);

    // Title tap: the desktop presentation opens the file in the preferred
    // editor from a header click; the phone surface must fire nothing.
    const title = document.querySelector<HTMLElement>("[data-title]");
    expect(title).not.toBeNull();
    title!.click();

    // Line-number tap: the phone surface omits the onLineNumberClick handler,
    // so the rendered line number is inert.
    await page.getByRole("button", { name: "Open added line 12" }).click();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(openInPreferredEditor).not.toHaveBeenCalled();
  });

  it("gives every phone diff control a 44px effective touch target, measured by hit test", async () => {
    // Baseline this replaces, measured on this fixture at 320x568 under coarse
    // emulation: turn chips 87x23, strip arrows 24x24, wrap and whitespace
    // toggles 28x28 with 32px of real horizontal reach, the search row 278x16,
    // and the file collapse control 20x20 with 32x32 of real reach despite
    // declaring `after:size-11` — two ancestors clipped the slop.
    await usePhoneViewport(320, 568);
    mounted = await render(<DiffPanel mode="phone" />);
    await expect.element(page.getByLabelText("Search diff")).toBeVisible();

    // A search query is typed so the match navigation and clear controls are
    // rendered at all: leaving them out would exercise only the empty state
    // and hide three of the row's five controls.
    await page.getByLabelText("Search diff").fill("alpha");
    await expect.element(page.getByRole("button", { name: "Next match" })).toBeVisible();

    const named = [
      "Disable diff line wrapping",
      "Hide whitespace changes",
      "Previous match",
      "Next match",
      "Clear search",
      "Collapse src/app.ts",
    ];
    for (const name of named) {
      const control = document.querySelector<HTMLElement>(`[aria-label="${name}"]`);
      expect(control, `Missing control "${name}" on the phone diff surface.`).not.toBeNull();
      const hit = measureEffectiveHitTarget(control!);
      expect(hit.width, `"${name}" effective width`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
      expect(hit.height, `"${name}" effective height`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
    }

    const searchInput = document.querySelector<HTMLElement>('[aria-label="Search diff"]')!;
    expect(measureEffectiveHitTarget(searchInput).height).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);

    // The named list above is an inventory guard so the coverage cannot be
    // narrowed silently; this sweep is the actual bound. It enumerates every
    // control the surface renders outside the scrolling rail, so putting any
    // sub-floor control back — the 24x24 turn-strip arrows, for instance —
    // fails here without anyone having to remember to list it.
    const chromeControls = [...document.querySelectorAll<HTMLElement>("button, input")].filter(
      (control) =>
        !control.closest(".turn-chip-strip") && !control.hasAttribute("data-test-mock-control"),
    );
    expect(chromeControls.length).toBeGreaterThanOrEqual(named.length + 1);
    for (const control of chromeControls) {
      const label =
        control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 40) ?? "?";
      const hit = measureEffectiveHitTarget(control);
      expect(hit.width, `"${label}" effective width`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
      expect(hit.height, `"${label}" effective height`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
    }

    // The turn strip is a scrolling rail, so each chip is brought into the
    // rail's own view before it is measured — that is the primitive's
    // contract, and the page never scrolls horizontally to do it.
    const chips = turnChips();
    expect(chips.length).toBe(TURN_DIFF_SUMMARIES.length + 1);
    const strip = turnStrip();
    for (const chip of chips) {
      const visible = visibleChipTarget(chip, strip);
      expect(visible.width, "turn chip width exposed by the rail").toBeGreaterThanOrEqual(
        TOUCH_FLOOR_PX,
      );
      expect(visible.hitsChip, "the exposed strip of the chip hit-tests to it").toBe(true);
      expect(chip.getBoundingClientRect().height, "turn chip height").toBeGreaterThanOrEqual(
        TOUCH_FLOOR_PX,
      );
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("keeps every turn chip reachable at 200% text scaling on the phone surface", async () => {
    // The layout is rem-based, so doubling the root font emulates 200% browser
    // text scaling. The measured failure this pins: the desktop `px-8` arrow
    // gutter resolves to 64px per side at a 32px root, which left the rail
    // with a content window far narrower than a single chip and, before the
    // toolbar floor was pinned in px, with no content window at all.
    await usePhoneViewport(320, 568);
    document.documentElement.style.fontSize = "32px";
    mounted = await render(<DiffPanel mode="phone" />);
    await expect.element(page.getByLabelText("Search diff")).toBeVisible();

    const strip = turnStrip();
    for (const chip of turnChips()) {
      const visible = visibleChipTarget(chip, strip);
      expect(
        visible.width,
        "turn chip width exposed by the rail at 200% text",
      ).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
      expect(visible.hitsChip, "the exposed strip of the chip hit-tests to it").toBe(true);
      expect(chip.getBoundingClientRect().height).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
    }

    for (const name of ["Disable diff line wrapping", "Hide whitespace changes"]) {
      const control = document.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
      const hit = measureEffectiveHitTarget(control);
      expect(hit.width, `"${name}" at 200% text`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
      expect(hit.height, `"${name}" at 200% text`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("contains unwrapped diff overflow inside the phone surface instead of the page", async () => {
    await usePhoneViewport(320, 568);
    mounted = await render(<DiffPanel mode="phone" />);
    // Wrap is on by default here, so the unwrapped state — the only one that
    // can overflow horizontally at all — is selected explicitly.
    await page.getByRole("button", { name: "Disable diff line wrapping" }).click();
    await expect
      .element(page.getByRole("button", { name: "Enable diff line wrapping" }))
      .toBeVisible();

    const code = document.querySelector<HTMLElement>("[data-code]");
    expect(code).not.toBeNull();
    expect(
      code!.scrollWidth,
      "the fixture must actually overflow, or containment is untested",
    ).toBeGreaterThan(code!.clientWidth + 1);

    const surface = diffScrollSurface();
    const surfaceStyle = getComputedStyle(surface);
    expect(surfaceStyle.overflowX).toBe("hidden");
    expect(surfaceStyle.overflowY).toBe("auto");
    expect(surfaceStyle.overscrollBehaviorX).toBe("contain");
    expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth + 0.5);

    // The page itself does not widen. The former companion check — assigning
    // `document.documentElement.scrollLeft` and asserting it stayed 0 — was
    // removed: `#root` is `overflow-x: clip`, so the documentElement can never
    // acquire horizontal scroll range and that assertion could not fail under
    // any change to this component. Containment is carried by the computed
    // `overflow-x` and `overscroll-behavior-x` above, both of which do fail
    // when the phone gate is removed.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("keeps the desktop diff toolbar, turn-strip arrows, and two-axis scrolling unchanged", async () => {
    // Desktop regression for every phone-gated change above.
    await page.viewport(1_280, 720);
    mounted = await render(<DiffPanel mode="sheet" />);
    await expect.element(page.getByLabelText("Search diff")).toBeVisible();

    expect(document.querySelector('[aria-label="Scroll turn list left"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Scroll turn list right"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Stacked diff view"]')).not.toBeNull();

    const strip = document.querySelector<HTMLElement>(".turn-chip-strip")!;
    expect(getComputedStyle(strip).paddingLeft).toBe("32px");

    const surfaceStyle = getComputedStyle(diffScrollSurface());
    expect(surfaceStyle.overflowX).toBe("auto");
    expect(surfaceStyle.overscrollBehaviorX).toBe("auto");

    // Desktop keeps its compact control density: the phone floor must not have
    // leaked into the shared toolbar.
    const wrapToggle = document.querySelector<HTMLElement>(
      '[aria-label="Enable diff line wrapping"]',
    )!;
    expect(wrapToggle.getBoundingClientRect().height).toBeLessThan(TOUCH_FLOOR_PX);
    const chip = turnChips()[0]!;
    expect(chip.getBoundingClientRect().height).toBeLessThan(TOUCH_FLOOR_PX);
  });
});
