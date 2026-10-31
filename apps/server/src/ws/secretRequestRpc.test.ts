import { AuthSessionId, SecretRequestId, ThreadId, WS_METHODS } from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import type { WsRpcContext } from "./context.ts";
import {
  directConnectionOf,
  directRpcPrincipal,
  relayRpcPrincipal,
  type RpcPrincipal,
} from "./RpcPrincipal.ts";
import { makeSecretRequestHandlers } from "./secretRequestRpc.ts";

const VALUE = ["typed", "on", "the", "card"].join("-");
const threadId = ThreadId.make("thread-secret-rpc");
const requestId = SecretRequestId.make(`secret-request-${"e".repeat(32)}`);

type UpgradeRequest = Parameters<typeof directConnectionOf>[0];
const directOwner = (
  remoteAddress: string,
  headers: Record<string, string> = {},
  localAddress?: string,
): RpcPrincipal => ({
  ...directRpcPrincipal({
    sessionId: AuthSessionId.make("session-owner"),
    chainId: AuthSessionId.make("session-owner"),
    subject: "owner",
    method: "browser-session-cookie",
    role: "owner",
  }),
  ...directConnectionOf({
    source: { socket: { remoteAddress, localAddress }, headers },
  } as unknown as UpgradeRequest),
});

const relayOwner = (encrypted: boolean, role: "owner" | "viewer" = "owner") =>
  relayRpcPrincipal(role, "channel", undefined, () => encrypted);

/**
 * The handler with the principal's own context: the owner check, the connection the principal
 * recorded, and an engine that knows no thread, so an answer the channel admits ends `not-found`.
 */
const answer = (principal: RpcPrincipal, type: "provide" | "decline") => {
  const ctx = {
    ownerEffect: <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
      authorizeRpcPrincipal(principal, "owner", method).pipe(Effect.andThen(effect)),
    connection: principal.connection,
    orchestrationEngine: {
      getReadModel: () => Effect.succeed({ threads: [] }),
      dispatch: () => Effect.die("unused"),
    },
    projectionSnapshotQuery: { getThreadCheckpointContext: () => Effect.die("unused") },
    workspaceAccessPolicy: undefined,
  } as unknown as WsRpcContext;
  const handle = makeSecretRequestHandlers(ctx)[WS_METHODS.secretsAnswerRequest];
  return Effect.runPromise(
    handle({
      threadId,
      requestId,
      answer: type === "provide" ? { type, value: VALUE } : { type },
    }).pipe(
      Effect.match({
        onSuccess: () => "answered",
        onFailure: (error: unknown) => {
          expect(JSON.stringify(error)).not.toContain(VALUE);
          return error instanceof Object && "reason" in error
            ? String(error.reason)
            : String((error as { _tag?: string })._tag);
        },
      }),
    ),
  );
};

describe("secrets.answerRequest over each connection", () => {
  it.each([
    ["an E2EE relay channel", relayOwner(true), "not-found"],
    ["a relay channel without E2EE", relayOwner(false), "unencrypted-connection"],
    ["this machine", directOwner("127.0.0.1"), "not-found"],
    [
      "Tailscale Serve on this machine",
      directOwner("127.0.0.1", { "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https" }),
      "not-found",
    ],
    ["a Tailscale address", directOwner("100.64.0.9", {}, "100.100.1.2"), "not-found"],
    [
      "plain ws:// on the LAN",
      directOwner("192.168.1.20", {}, "192.168.1.10"),
      "unencrypted-connection",
    ],
    [
      "plain ws:// with forged headers",
      directOwner(
        "192.168.1.20",
        { "x-forwarded-proto": "https", "x-forwarded-for": "127.0.0.1" },
        "192.168.1.10",
      ),
      "unencrypted-connection",
    ],
    [
      "a local proxy relaying plain HTTP",
      directOwner("127.0.0.1", { "x-forwarded-for": "192.168.1.20", "x-forwarded-proto": "http" }),
      "unencrypted-connection",
    ],
  ] as const)("takes a value over %s only when encrypted", async (_name, principal, expected) => {
    expect(await answer(principal, "provide")).toBe(expected);
  });

  it("takes a decline over any connection", async () => {
    for (const principal of [relayOwner(false), directOwner("192.168.1.20", {}, "192.168.1.10")]) {
      expect(await answer(principal, "decline")).toBe("not-found");
    }
  });

  it("checks the owner before the connection", async () => {
    expect(await answer(relayOwner(false, "viewer"), "provide")).toBe("AuthRpcError");
  });
});
