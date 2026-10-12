/**
 * threadSessionLookup - The live provider session of a single thread.
 *
 * `ProviderService.listSessions()` reads every adapter and every persisted
 * binding; per-thread callers use `getSessionForThread` instead, which reads one
 * binding and one adapter. Test doubles that only implement `listSessions` keep
 * working through the fallback.
 *
 * @module threadSessionLookup
 */
import type { ProviderSession, ThreadId } from "@ryco/contracts";
import { Effect, Option } from "effect";

import type { ProviderServiceShape } from "./Services/ProviderService.ts";

export const findThreadSession = (
  providerService: Pick<ProviderServiceShape, "listSessions" | "getSessionForThread">,
  threadId: ThreadId,
): Effect.Effect<ProviderSession | undefined> =>
  providerService.getSessionForThread
    ? providerService.getSessionForThread(threadId).pipe(Effect.map(Option.getOrUndefined))
    : providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));
