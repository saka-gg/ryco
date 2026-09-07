import { Schema } from "effect";

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
export const DiscoveredProjectSite = Schema.Struct({
  url: text,
  port: Schema.Number,
  process: Schema.String,
  projectMatch: Schema.Boolean,
});
export type DiscoveredProjectSite = typeof DiscoveredProjectSite.Type;
