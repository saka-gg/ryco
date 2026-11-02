import { DesktopUpdatedNotice } from "./DesktopUpdatedNotice";
import { RemoteInstallCountdown } from "./RemoteInstallCountdown";

/** The desktop app's own update notices; loaded off the first paint, in the desktop app only. */
export function DesktopUpdateNotices() {
  return (
    <>
      <RemoteInstallCountdown />
      <DesktopUpdatedNotice />
    </>
  );
}
