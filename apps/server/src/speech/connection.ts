// @effect-diagnostics nodeBuiltinImport:off - server-minted socket-local job identity.
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { SpeechRequest } from "@ryco/contracts";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import type { RpcPrincipal } from "../ws/RpcPrincipal.ts";
import type { createSpeechService } from "./service.ts";

/** Auth session ids span tabs. Jobs belong to this handler lifetime only. */
export function createSpeechConnection(
  service: ReturnType<typeof createSpeechService>,
  principal: RpcPrincipal,
) {
  const owner = randomUUID();
  return {
    request: (input: SpeechRequest) =>
      authorizeRpcPrincipal(principal, "owner", "speech.request").pipe(
        Effect.andThen(service.request(owner, input)),
      ),
    close: () => service.closeOwner(owner),
  };
}
