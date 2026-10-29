import * as Schema from "effect/Schema";

const text = Schema.String.check(Schema.isMaxLength(8192));
export const ProjectBrowserTab = Schema.Struct({
  id: Schema.String,
  project: text,
  title: text,
  url: text,
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  zoom: Schema.Number,
  presentation: Schema.Literals(["background", "panel", "window"]),
  error: Schema.NullOr(text),
  signInPopup: Schema.optionalKey(Schema.Literals(["idle", "armed", "open", "blocked", "failed"])),
  /** The page was unloaded to save memory; showing or using the tab reloads its URL. */
  suspended: Schema.optionalKey(Schema.Boolean),
  /** The user's element pick on this tab: choosing an element, or one picked and highlighted. */
  picker: Schema.optionalKey(Schema.Literals(["picking", "picked"])),
});
export type ProjectBrowserTab = typeof ProjectBrowserTab.Type;
export const ProjectBrowserState = Schema.Struct({ tabs: Schema.Array(ProjectBrowserTab) });
export type ProjectBrowserState = typeof ProjectBrowserState.Type;
export const ProjectBrowserCommand = Schema.Struct({
  action: Schema.Literals([
    "navigate",
    "back",
    "forward",
    "reload",
    "stop",
    "close",
    "zoom",
    "devtools",
    "popout",
    "dock",
    "allow-sign-in",
    "cancel-sign-in",
    "end-pick",
  ]),
  tab: Schema.String,
  url: Schema.optionalKey(text),
  zoom: Schema.optionalKey(Schema.Number),
});
export type ProjectBrowserCommand = typeof ProjectBrowserCommand.Type;
export const ProjectBrowserSurface = Schema.Struct({
  owner: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  tab: Schema.NullOr(Schema.String),
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type ProjectBrowserSurface = typeof ProjectBrowserSurface.Type;

// Field limits of a page element the user picked in the Ryco browser. They are Synara's browser
// annotation limits (packages/contracts/src/browserAnnotations.ts at Synara commit
// 299fd573b1d6520c323a87c78d30be74e87e53e1, MIT; see THIRD_PARTY_NOTICES.md).
/** Picked elements one prompt may carry. */
export const BROWSER_ELEMENT_MAX_PER_PROMPT = 32;
export const BROWSER_ELEMENT_MAX_URL_LENGTH = 2_048;
export const BROWSER_ELEMENT_MAX_PAGE_TITLE_LENGTH = 256;
export const BROWSER_ELEMENT_MAX_SELECTOR_LENGTH = 1_024;
export const BROWSER_ELEMENT_MAX_TAG_LENGTH = 64;
export const BROWSER_ELEMENT_MAX_ROLE_LENGTH = 64;
export const BROWSER_ELEMENT_MAX_NAME_LENGTH = 256;
export const BROWSER_ELEMENT_MAX_TEXT_LENGTH = 280;
/** The user's note on a picked element. */
export const BROWSER_ELEMENT_MAX_COMMENT_LENGTH = 4_000;

const boundedText = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isBetweenLength(minimum, maximum));
/** An element's rectangle in CSS pixels, relative to the page's viewport. */
export const ProjectBrowserElementBox = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ProjectBrowserElementBox = typeof ProjectBrowserElementBox.Type;
/**
 * A page element the user picked: bounded, single-line and redacted (no form values, no URL query,
 * hash or credentials). `url` and `pageTitle` come from the browser, never from the page's scripts.
 */
export const ProjectBrowserPickedElement = Schema.Struct({
  url: boundedText(1, BROWSER_ELEMENT_MAX_URL_LENGTH),
  pageTitle: boundedText(0, BROWSER_ELEMENT_MAX_PAGE_TITLE_LENGTH),
  selector: boundedText(1, BROWSER_ELEMENT_MAX_SELECTOR_LENGTH),
  tagName: boundedText(1, BROWSER_ELEMENT_MAX_TAG_LENGTH).check(Schema.isLowercased()),
  role: Schema.NullOr(boundedText(1, BROWSER_ELEMENT_MAX_ROLE_LENGTH)),
  name: Schema.NullOr(boundedText(1, BROWSER_ELEMENT_MAX_NAME_LENGTH)),
  text: Schema.NullOr(boundedText(1, BROWSER_ELEMENT_MAX_TEXT_LENGTH)),
  box: Schema.NullOr(ProjectBrowserElementBox),
});
export type ProjectBrowserPickedElement = typeof ProjectBrowserPickedElement.Type;
/** Why a pick ended without an element. */
export const ProjectBrowserPickCancelReason = Schema.Literals([
  "user",
  "navigation",
  "hidden",
  "agent",
  "detached",
  "destroyed",
  "replaced",
  "timeout",
]);
export type ProjectBrowserPickCancelReason = typeof ProjectBrowserPickCancelReason.Type;
export const ProjectBrowserPickResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("picked"), element: ProjectBrowserPickedElement }),
  Schema.Struct({ kind: Schema.Literal("cancelled"), reason: ProjectBrowserPickCancelReason }),
]);
export type ProjectBrowserPickResult = typeof ProjectBrowserPickResult.Type;
export const DiscoveredProjectSite = Schema.Struct({
  url: text,
  port: Schema.Number,
  process: Schema.String,
  projectMatch: Schema.Boolean,
});
export type DiscoveredProjectSite = typeof DiscoveredProjectSite.Type;
