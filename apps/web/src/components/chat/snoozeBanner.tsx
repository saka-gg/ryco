import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import {
  formatSnoozeCountdown,
  isThreadSnoozed,
  resolveSnoozePresets,
  SNOOZE_COUNTDOWN_TICK_MS,
  type ThreadSnoozeState,
} from "@ryco/shared/threadSnooze";
import { ClockIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { dispatchThreadSnooze, requestCustomSnooze } from "../../threadLifecycleCommands";
import { formatInboxDayTime } from "../inboxSidebar/inboxRowPresentation";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** setTimeout's largest delay; a later wake re-arms after the next render. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export type SnoozeBannerThread = ThreadSnoozeState & {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
};

const DEADLINE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

const readNowMs = () => Date.now();

const NO_PRESETS: ReturnType<typeof resolveSnoozePresets> = [];
const resolveSnoozePresetsFromNow = () => resolveSnoozePresets(new Date());

/** "Thu, Oct 30, 16:00": the day as well, since a custom snooze can be weeks out. */
function formatSnoozeDeadline(snoozedUntil: string): string {
  const deadline = new Date(snoozedUntil);
  return Number.isNaN(deadline.getTime())
    ? snoozedUntil
    : deadline.toLocaleString(undefined, DEADLINE_FORMAT);
}

/** "Returns Thu, Oct 30, 16:00 · 1 hr 28 min left", re-read on its own clock. */
function SnoozeCountdown(props: { readonly snoozedUntil: string }) {
  const [nowMs, setNowMs] = useState(readNowMs);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(readNowMs()), SNOOZE_COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      Returns {formatSnoozeDeadline(props.snoozedUntil)} ·{" "}
      {formatSnoozeCountdown(props.snoozedUntil, nowMs)}
    </>
  );
}

/** Return now, and Change time: the presets from now, then a custom time. */
function SnoozeNoticeActions(props: {
  readonly threadRef: ScopedThreadRef;
  readonly enabled: boolean;
  readonly canReschedule: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Resolved each time the menu opens: the presets count from then.
  const presets = menuOpen ? resolveSnoozePresetsFromNow() : NO_PRESETS;
  const update = (snoozedUntil: string | null) => {
    setPending(true);
    void dispatchThreadSnooze(props.threadRef, snoozedUntil).finally(() => setPending(false));
  };
  const disabled = !props.enabled || pending;
  return (
    <>
      <Button size="xs" disabled={disabled} onClick={() => update(null)}>
        Return now
      </Button>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          render={
            <Button size="xs" variant="outline" disabled={disabled || !props.canReschedule} />
          }
        >
          Change time
        </MenuTrigger>
        <MenuPopup align="end" side="top" className="min-w-52">
          {presets.map((preset) => (
            <MenuItem key={preset.id} onClick={() => update(preset.snoozedUntil)}>
              {preset.label}
              <MenuShortcut className="tracking-normal">
                {formatInboxDayTime(preset.snoozedUntil)}
              </MenuShortcut>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            onClick={() =>
              void requestCustomSnooze().then((snoozedUntil) => {
                if (snoozedUntil) update(snoozedUntil);
              })
            }
          >
            Custom…
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}

/**
 * The composer notice of a snoozed thread opened anyway: when it returns with a
 * live countdown, that sending wakes it, and Return now / Change time. Null
 * while the thread is awake; it goes away by itself when the snooze runs out.
 */
export function useSnoozeBannerItem(input: {
  readonly thread: SnoozeBannerThread | null;
  /** The connection takes commands for this thread's machine. */
  readonly dispatchAllowed: boolean;
  /** The thread may be snoozed again, by the inbox's rule. */
  readonly canSnooze: boolean;
}): ComposerBannerStackItem | null {
  const { thread } = input;
  const [nowMs, setNowMs] = useState(readNowMs);
  const snoozed = thread !== null && isThreadSnoozed(thread, nowMs);
  const wakeAtMs = snoozed ? Date.parse(thread.snoozedUntil!) : null;
  // Re-render at the wake time, when the notice goes away.
  useEffect(() => {
    if (wakeAtMs === null) return;
    const timer = setTimeout(
      () => setNowMs(readNowMs()),
      Math.min(Math.max(0, wakeAtMs - Date.now()), MAX_TIMER_DELAY_MS),
    );
    return () => clearTimeout(timer);
  }, [wakeAtMs]);
  // A thread switched to, or snoozed since, is read against the current time.
  const snoozeKey = thread ? `${thread.environmentId}:${thread.id}:${thread.snoozedUntil}` : null;
  const [stateKey, setStateKey] = useState(snoozeKey);
  if (stateKey !== snoozeKey) {
    setStateKey(snoozeKey);
    setNowMs(readNowMs);
  }
  if (!snoozed || !thread.snoozedUntil) return null;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return {
    id: `snoozed:${thread.environmentId}:${thread.id}`,
    variant: "info",
    icon: <ClockIcon />,
    title: <SnoozeCountdown snoozedUntil={thread.snoozedUntil} />,
    description: "Sending a message ends the snooze.",
    actions: (
      <SnoozeNoticeActions
        key={threadRef.threadId}
        threadRef={threadRef}
        enabled={input.dispatchAllowed}
        canReschedule={input.canSnooze}
      />
    ),
  };
}
