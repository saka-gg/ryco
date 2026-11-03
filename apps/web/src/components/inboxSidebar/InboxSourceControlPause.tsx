import { useSyncExternalStore } from "react";

import { useSettings } from "../../hooks/useSettings";
import {
  formatSourceControlPauseText,
  latestSourceControlPause,
  subscribeSourceControlPauses,
} from "../../sourceControlPause";

/**
 * One line above the Inbox while a forge host is rate limiting this account:
 * rows keep showing the pull request state they last loaded until it ends.
 */
export function InboxSourceControlPause() {
  const pause = useSyncExternalStore(subscribeSourceControlPauses, latestSourceControlPause);
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  if (pause === null) return null;
  const text = formatSourceControlPauseText(pause, timestampFormat);
  return (
    <p
      role="status"
      title={text.detail}
      className="px-2.5 pt-1 pb-1.5 text-[11px] leading-4 text-muted-foreground"
    >
      {text.title}
    </p>
  );
}
