import type { NodeSessionRole } from "@ryco/contracts";
import type { UserActionRequestActivity } from "@ryco/shared/userActionRequestState";
import { useEffect, useState } from "react";

import {
  mobileUserActionRequestCards,
  USER_ACTION_EXPIRY_RECHECK_MS,
  type MobileUserActionRequestCards,
} from "./userActionRequestCardModel";

/**
 * The thread's user action request cards (`mobileUserActionRequestCards`), with their own clock:
 * while one shows, expiry is re-read every {@link USER_ACTION_EXPIRY_RECHECK_MS}, so a card left
 * open past its time closes. Without a card no timer runs. Plain arguments, so the compiler keeps
 * the same cards between renders that change none of them.
 */
export function useUserActionRequestCards(
  activities: ReadonlyArray<UserActionRequestActivity> | undefined,
  nodeSupports: boolean,
  role: NodeSessionRole | undefined,
  mutationReady: boolean,
  promptsDisabled: boolean,
): MobileUserActionRequestCards {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const cards = mobileUserActionRequestCards({
    activities,
    nowMs,
    nodeSupports,
    role,
    mutationReady,
    promptsDisabled,
  });
  const showing = cards.requests.length > 0;
  useEffect(() => {
    if (!showing) return;
    const timer = setInterval(() => setNowMs(Date.now()), USER_ACTION_EXPIRY_RECHECK_MS);
    return () => clearInterval(timer);
  }, [showing]);
  return cards;
}
