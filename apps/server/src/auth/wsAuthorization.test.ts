import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AuthSessionId } from "@ryco/contracts";
import { authorizeWsRpc } from "./wsAuthorization.ts";
import type { AuthenticatedSession } from "./Services/ServerAuth.ts";

const makeSession = (role: AuthenticatedSession["role"]): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(`session-${role}`),
  chainId: AuthSessionId.make(`session-${role}`),
  subject: role,
  method: "browser-session-cookie",
  role,
});

it.effect("allows owner sessions to call owner websocket RPC methods", () =>
  Effect.gen(function* () {
    const result = yield* authorizeWsRpc(makeSession("owner"), "owner", "terminal.open").pipe(
      Effect.result,
    );
    expect(result._tag).toBe("Success");
  }),
);

it.effect("rejects client sessions from owner websocket RPC methods", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      authorizeWsRpc(makeSession("client"), "owner", "terminal.open"),
    );
    expect(error.message).toBe("Only owner sessions can call terminal.open.");
    expect(error.status).toBe(403);
  }),
);

it.effect("allows authenticated client sessions to call authenticated websocket RPC methods", () =>
  Effect.gen(function* () {
    const result = yield* authorizeWsRpc(
      makeSession("client"),
      "authenticated",
      "server.getConfig",
    ).pipe(Effect.result);
    expect(result._tag).toBe("Success");
  }),
);
