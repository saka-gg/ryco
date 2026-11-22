import { AuthSessionId } from "@ryco/contracts";
import { NODE_BROWSER_WS_METHODS, NodeBrowserRpcError } from "@ryco/contracts/node-browser";
import { Effect, Option, Stream } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import { registerHandoffTabSource, type HandoffTabSource } from "../nodeBrowser/handoffTabs.ts";
import { makeNodeBrowserHandlers } from "./nodeBrowserRpc.ts";
import { directRpcPrincipal, relayRpcPrincipal, type RpcPrincipal } from "./RpcPrincipal.ts";

const HANDOFF_TAB = `handoff-${"a".repeat(32)}`;

const principalOf = (role: "owner" | "operator" | "viewer"): RpcPrincipal =>
  role === "owner"
    ? directRpcPrincipal({
        sessionId: AuthSessionId.make("session-owner"),
        chainId: AuthSessionId.make("session-owner"),
        subject: "owner",
        method: "browser-session-cookie",
        role: "owner",
      })
    : // A shared node's linked operator or viewer, over the relay.
      relayRpcPrincipal(role, "channel", undefined, () => true);

/** The handlers with a principal's own access checks and no node browser runtime. */
function handlersFor(role: "owner" | "operator" | "viewer") {
  const principal = principalOf(role);
  const withAccess = <A, E, R>(
    access: WsRpcAccess,
    method: string,
    effect: Effect.Effect<A, E, R>,
  ) => authorizeRpcPrincipal(principal, access, method).pipe(Effect.andThen(effect));
  return makeNodeBrowserHandlers({
    nodeBrowser: Option.none(),
    ownerEffect: (method, effect) => withAccess("operator", method, effect),
    ownerStream: (method, stream) =>
      Stream.unwrap(Effect.as(authorizeRpcPrincipal(principal, "operator", method), stream)),
    withAccess,
  });
}

const calls: string[] = [];
const source: HandoffTabSource = {
  still: (request) =>
    Effect.sync(() => {
      calls.push(`still:${request.tabId}`);
      return {
        mimeType: "image/jpeg" as const,
        width: 10,
        height: 10,
        cssWidth: 10,
        cssHeight: 10,
        seq: 1,
        bytesBase64: "AA==",
      };
    }),
  input: (request) => Effect.sync(() => void calls.push(`input:${request.tabId}`)),
  command: (tabId, type) =>
    type === "resize"
      ? Effect.succeed({
          tab: {
            id: tabId,
            scope: "",
            url: "",
            title: "",
            loading: false,
            canGoBack: false,
            canGoForward: false,
            state: "live" as const,
            viewport: { width: 1280, height: 850 },
            dialog: null,
            error: null,
          },
        })
      : Effect.fail(
          new NodeBrowserRpcError({ code: "failed", message: "desktop only", retryable: false }),
        ),
  serveViewer: () => Effect.void,
};

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: value }) as const,
        onFailure: (error) => ({ error: error as { _tag?: string; code?: string } }) as const,
      }),
    ),
  );

describe("node browser RPCs for handed-off desktop tabs", () => {
  let unregister: () => void = () => undefined;
  afterEach(() => {
    unregister();
    calls.length = 0;
  });

  it("serves stills and input of a handed-off tab to its owner only", async () => {
    unregister = registerHandoffTabSource(Effect.succeed(source));
    const owner = handlersFor("owner");
    const still = {
      type: "still" as const,
      tabId: HANDOFF_TAB,
      maxWidth: 640,
      maxHeight: 480,
      quality: 50,
    };
    expect(await run(owner[NODE_BROWSER_WS_METHODS.read](still))).toMatchObject({
      ok: { type: "still" },
    });
    expect(
      await run(
        owner[NODE_BROWSER_WS_METHODS.input]({ tabId: HANDOFF_TAB, events: [{ type: "release" }] }),
      ),
    ).toEqual({ ok: undefined });
    for (const role of ["operator", "viewer"] as const) {
      const handlers = handlersFor(role);
      expect(await run(handlers[NODE_BROWSER_WS_METHODS.read](still))).toMatchObject({
        error: { _tag: "AuthRpcError" },
      });
      expect(
        await run(
          handlers[NODE_BROWSER_WS_METHODS.input]({
            tabId: HANDOFF_TAB,
            events: [{ type: "release" }],
          }),
        ),
      ).toMatchObject({ error: { _tag: "AuthRpcError" } });
    }
    // Only the owner's two calls reached the hand-off source.
    expect(calls).toEqual([`still:${HANDOFF_TAB}`, `input:${HANDOFF_TAB}`]);
  });

  it("routes a handed-off tab's commands to the hand-off source", async () => {
    unregister = registerHandoffTabSource(Effect.succeed(source));
    const owner = handlersFor("owner");
    expect(
      await run(
        owner[NODE_BROWSER_WS_METHODS.command]({
          type: "resize",
          tabId: HANDOFF_TAB,
          width: 390,
          height: 844,
        }),
      ),
    ).toMatchObject({ ok: { tab: { id: HANDOFF_TAB, viewport: { width: 1280, height: 850 } } } });
    expect(
      await run(
        owner[NODE_BROWSER_WS_METHODS.command]({
          type: "navigate",
          tabId: HANDOFF_TAB,
          url: "https://example.com/",
        }),
      ),
    ).toMatchObject({ error: { _tag: "NodeBrowserRpcError", code: "failed" } });
  });

  it("is unavailable without a desktop bridge, and leaves other tab ids to the node's runtime", async () => {
    const owner = handlersFor("owner");
    const still = {
      type: "still" as const,
      tabId: HANDOFF_TAB,
      maxWidth: 640,
      maxHeight: 480,
      quality: 50,
    };
    expect(await run(owner[NODE_BROWSER_WS_METHODS.read](still))).toMatchObject({
      error: { code: "unavailable" },
    });
    unregister = registerHandoffTabSource(Effect.succeed(source));
    expect(
      await run(owner[NODE_BROWSER_WS_METHODS.read]({ ...still, tabId: "ordinary-tab" })),
    ).toMatchObject({ error: { code: "unavailable" } });
    expect(calls).toEqual([]);
  });
});
