import {
  failedTurnNotice,
  restartInterruptionNotice,
  type FailedTurnNotice,
  type FailedTurnNoticeThread,
  type RestartInterruptionThread,
} from "@ryco/client-runtime/state/threads";
import { CircleAlertIcon, InfoIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * The composer banner for a thread a server restart interrupted: a quiet info line
 * where the user would continue, never the thread error notification. Null when no
 * restart released the thread or its node already explained the interruption.
 */
export function useRestartInterruptionBannerItem(
  thread: RestartInterruptionThread | null,
): ComposerBannerStackItem | null {
  const notice = thread ? restartInterruptionNotice(thread) : null;
  return useMemo(
    () =>
      notice === null
        ? null
        : { id: "restart-interruption", variant: "info", icon: <InfoIcon />, title: notice },
    [notice],
  );
}

/**
 * The composer banner for a failed last turn (`failedTurnNotice`): what failed, with
 * Continue and Change model, until a new turn starts or the user dismisses it for that
 * turn. `notice` is returned too, so the caller can leave out the toast that says the same.
 */
export function useFailedTurnBannerItem(input: {
  readonly thread: FailedTurnNoticeThread | null;
  readonly onContinue: () => void;
  readonly onChangeModel: () => void;
}): { readonly item: ComposerBannerStackItem | null; readonly notice: FailedTurnNotice | null } {
  const [dismissedTurnId, setDismissedTurnId] = useState<string | null>(null);
  const derived = input.thread ? failedTurnNotice(input.thread) : null;
  const turnId = derived && derived.turnId !== dismissedTurnId ? derived.turnId : null;
  const title = derived?.title ?? null;
  const detail = derived?.detail ?? null;
  // Kept while the failure stays the same: the thread re-renders as anything else changes.
  const notice = useMemo<FailedTurnNotice | null>(
    () => (turnId === null || title === null ? null : { turnId, title, detail }),
    [turnId, title, detail],
  );
  const { onContinue, onChangeModel } = input;
  const item = useMemo<ComposerBannerStackItem | null>(
    () =>
      notice === null
        ? null
        : {
            id: `failed-turn:${notice.turnId}`,
            variant: "error",
            icon: <CircleAlertIcon />,
            title: notice.title,
            ...(notice.detail ? { description: notice.detail } : {}),
            actions: (
              <>
                <Button size="xs" onClick={onContinue}>
                  Continue
                </Button>
                <Button size="xs" variant="outline" onClick={onChangeModel}>
                  Change model
                </Button>
              </>
            ),
            dismissLabel: "Dismiss the failed turn notice",
            onDismiss: () => setDismissedTurnId(notice.turnId),
          },
    [notice, onContinue, onChangeModel],
  );
  return { item, notice };
}
