/**
 * The modules the first thread render evaluates, warmed in idle time after Home
 * paints (`scheduleWorkspaceRoutePrewarm`), so the first tap on a thread does
 * not evaluate them synchronously.
 *
 * Metro inlines requires: a module's imports run where they are first used, not
 * when the module itself runs. Evaluating `ThreadRouteScreen` therefore runs
 * only that wrapper (its `ThreadDetailScreen` import sits inside the render),
 * and evaluating `ThreadDetailScreen` runs only its own body. Each module the
 * render path always reaches needs its own function-scoped `require`, which
 * Metro registers but does not run until the entry is called. Ordered roughly
 * by when the first render reaches them; leaves only some threads use (HTML
 * renders and their WebView, video, diff and review surfaces) stay on demand.
 */
export const THREAD_ROUTE_PREWARM_MODULES: ReadonlyArray<() => unknown> = [
  () => require("./ThreadRouteScreen"),
  () => require("./ThreadDetailScreen"),
  () => require("../../state/threadTimeline"),
  () => require("../../connection/threadDetail"),
  () => require("../../connection/useThreadConnectionRetarget"),
  () => require("@legendapp/list/react-native"),
  () => require("./threadActivityFold"),
  () => require("./threadTimelineList"),
  () => require("./HtmlRenderFullScreen"),
  () => require("./ThreadMessage"),
  () => require("../../native/SelectableMarkdownText"),
  () => require("./ThreadActivityFoldRow"),
  () => require("./ThreadContextBar"),
  () => require("./modelPickerModel"),
  () => require("./sessionPolicyModel"),
  () => require("./ThreadComposer"),
  () => require("../../native/ComposerEditor"),
  () => require("./ComposerModelMenu"),
  () => require("./ComposerAccessMenu"),
];
