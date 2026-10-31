/**
 * NodeBrowser - Browser tabs that run on this node and stream to its clients.
 * The runtime (`nodeBrowserRuntime.ts`) is loaded and built on first use and
 * serves every connection; the boot path carries only this facade and what the
 * node can tell clients without it.
 *
 * @module NodeBrowser
 */
import type {
  NodeBrowserCapability,
  NodeBrowserCommand,
  NodeBrowserCommandResult,
  NodeBrowserEvent,
  NodeBrowserInputRequest,
  NodeBrowserReadRequest,
  NodeBrowserReadResponse,
  NodeBrowserRpcError,
} from "@ryco/contracts/node-browser";
import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  type Scope,
  type Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";

import type { ServerConfig } from "../config.ts";
import { type PreviewBrowser, previewBrowserRelease } from "../htmlRender/PreviewBrowser.ts";
import type { NodeBrowserRuntimeOptions } from "./nodeBrowserRuntime.ts";
import type { ViewerSocket } from "./nodeBrowserViewerSocket.ts";

/** Operators set this to turn node browser tabs off on a node. */
export const NODE_BROWSER_DISABLED_ENV = "RYCO_NODE_BROWSER_DISABLED";
/**
 * Runs node tabs without Chrome's sandbox. Their own switch: HTML previews render pages agents
 * made, node tabs open any site, so `RYCO_HTML_PREVIEW_NO_SANDBOX` never reaches them.
 */
export const NODE_BROWSER_NO_SANDBOX_ENV = "RYCO_NODE_BROWSER_NO_SANDBOX";

export interface NodeBrowserRuntime {
  readonly capability: Effect.Effect<NodeBrowserCapability>;
  readonly read: (
    request: NodeBrowserReadRequest,
  ) => Effect.Effect<NodeBrowserReadResponse, NodeBrowserRpcError>;
  readonly command: (
    command: NodeBrowserCommand,
  ) => Effect.Effect<NodeBrowserCommandResult, NodeBrowserRpcError>;
  readonly input: (request: NodeBrowserInputRequest) => Effect.Effect<void, NodeBrowserRpcError>;
  readonly subscribe: Stream.Stream<NodeBrowserEvent>;
  /** Streams the tab the frame socket's query names, until either side ends. */
  readonly serveViewer: (
    socket: ViewerSocket,
    params: URLSearchParams,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export interface NodeBrowserShape {
  /** What clients are told: the runtime's own state once it runs. Never loads it. */
  readonly capability: Effect.Effect<NodeBrowserCapability>;
  /** The runtime, built on the first call. */
  readonly runtime: Effect.Effect<NodeBrowserRuntime>;
}

export class NodeBrowser extends Context.Service<NodeBrowser, NodeBrowserShape>()(
  "ryco/nodeBrowser/NodeBrowser",
) {}

const truthy = (value: string | undefined) =>
  ["1", "true", "yes"].includes(value?.trim().toLowerCase() ?? "");

export const nodeBrowserSandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  truthy(env[NODE_BROWSER_NO_SANDBOX_ENV]);

/**
 * Whether the browser can run here before anything ran: it is the HTML
 * preview's pinned build, so a platform without one has none, and as root
 * Chrome refuses its sandbox unless the operator turned it off for node tabs.
 * Tabs without the sandbox say so (`sandbox: false`), so clients can warn.
 */
export const nodeBrowserBaseCapability = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isRoot: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}): NodeBrowserCapability => {
  if (truthy(input.env[NODE_BROWSER_DISABLED_ENV])) return { available: false, reason: "disabled" };
  if (previewBrowserRelease(input.platform, input.arch) === null) {
    return { available: false, reason: "unsupported-platform" };
  }
  const noSandbox = nodeBrowserSandboxDisabled(input.env);
  if (input.isRoot && !noSandbox) {
    return { available: false, reason: "root-without-sandbox" };
  }
  return noSandbox ? { available: true, sandbox: false } : { available: true };
};

/** What the runtime runs with; its browser lives in this layer's scope and ends with it. */
export type NodeBrowserServices =
  | PreviewBrowser
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope;

export const makeNodeBrowserLayer = (options?: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isRoot?: boolean;
  readonly launch?: NodeBrowserRuntimeOptions["launch"];
}) =>
  Layer.effect(
    NodeBrowser,
    Effect.gen(function* () {
      const env = options?.env ?? process.env;
      const baseCapability = nodeBrowserBaseCapability({
        env,
        isRoot: options?.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0),
        platform: process.platform,
        arch: process.arch,
      });
      const context = yield* Effect.context<NodeBrowserServices>();
      let built: NodeBrowserRuntime | undefined;
      const runtime = yield* Effect.cached(
        Effect.promise(() => import("./nodeBrowserRuntime.ts")).pipe(
          Effect.flatMap((module) =>
            module.makeNodeBrowserRuntime({
              baseCapability,
              noSandbox: nodeBrowserSandboxDisabled(env),
              ...(options?.launch ? { launch: options.launch } : {}),
            }),
          ),
          Effect.tap((value) =>
            Effect.sync(() => {
              built = value;
            }),
          ),
          Effect.provideContext(context),
        ),
      );
      return NodeBrowser.of({
        capability: Effect.suspend(() =>
          built ? built.capability : Effect.succeed(baseCapability),
        ),
        runtime,
      });
    }),
  );

export const NodeBrowserLive = makeNodeBrowserLayer();
