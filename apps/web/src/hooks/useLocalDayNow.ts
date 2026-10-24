import { useEffect, useState } from "react";

/** Local "now", renewed after every local midnight so day-based views move with the calendar. */
export function useLocalDayNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const timer = setTimeout(() => setNow(Date.now()), midnight.getTime() - Date.now() + 1_000);
    // A machine waking from sleep past midnight catches up on focus.
    const onFocus = () => {
      if (Date.now() >= midnight.getTime()) setNow(Date.now());
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [now]);
  return now;
}
