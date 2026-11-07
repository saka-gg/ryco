import type { PendingApproval } from "@ryco/client-runtime/state/session";
import type { ProviderApprovalDecision, ScopedThreadRef } from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";

import {
  decideNotificationThreadAction,
  type NotificationThreadActionStep,
  type PendingThreadAction,
} from "./notificationActionsModel";
import {
  clearPendingNotificationAction,
  readPendingNotificationAction,
  usePendingNotificationActionVersion,
} from "./pendingNotificationAction";

/** How often a waiting action looks again, for its time limit; readiness changes re-render anyway. */
const RECHECK_MS = 1_000;

/**
 * Carries out an action tapped on this thread's notification (Approve, Deny, Reply) with the
 * screen's own handlers, once `decideNotificationThreadAction` says it may: the same calls, the
 * same readiness and the same errors as the buttons and the composer. Runs each action once.
 */
export function useNotificationThreadAction(input: {
  readonly threadRef: ScopedThreadRef;
  readonly threadLoaded: boolean;
  /** Ready for mutations, with live (not cached) prompts. */
  readonly ready: boolean;
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly respond: (
    approval: Extract<NotificationThreadActionStep, { kind: "respond" }>["approval"],
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly send: (text: string) => Promise<boolean>;
  readonly refuse: (message: string) => void;
}): void {
  const version = usePendingNotificationActionVersion();
  const [tick, setTick] = useState(0);
  const running = useRef<PendingThreadAction | null>(null);
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });
  const { environmentId, threadId } = input.threadRef;

  useEffect(() => {
    const ref = { environmentId, threadId };
    const pending = readPendingNotificationAction(ref, Date.now());
    if (pending === null || running.current === pending) return;
    const current = latest.current;
    const step = decideNotificationThreadAction({
      pending,
      nowMs: Date.now(),
      threadLoaded: current.threadLoaded,
      ready: current.ready,
      pendingApprovals: current.pendingApprovals,
    });
    if (step.kind === "wait") {
      const timer = setTimeout(() => setTick((value) => value + 1), RECHECK_MS);
      return () => clearTimeout(timer);
    }
    running.current = pending;
    clearPendingNotificationAction(ref, pending);
    switch (step.kind) {
      case "refuse":
        current.refuse(step.message);
        return;
      case "respond":
        void current.respond(step.approval, step.decision).catch(() => {
          latest.current.refuse("The decision could not be delivered. Answer here.");
        });
        return;
      case "send":
        void current.send(step.text).catch(() => {
          latest.current.refuse("The reply was not sent.");
        });
        return;
    }
  }, [
    environmentId,
    threadId,
    version,
    tick,
    input.threadLoaded,
    input.ready,
    input.pendingApprovals,
  ]);
}
