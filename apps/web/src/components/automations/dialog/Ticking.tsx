/**
 * Leaf text that moves every second. Each leaf re-renders on its own when its
 * text changes, so a tick never touches the row, block or button around it.
 */
import { MINUTE_MS, countdown, rel } from "@ryco/shared/automationSchedule";
import { AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS } from "@ryco/contracts";

import { useTickingText } from "./clock";

/** "13m" · "1h 5m" · m:ss in the last two minutes, when it also turns warm. */
export function Countdown(props: { readonly expiresAtMs: number; readonly className?: string }) {
  const { expiresAtMs } = props;
  const text = useTickingText((nowMs) => countdown(expiresAtMs - nowMs));
  const urgent = useTickingText((nowMs) => expiresAtMs - nowMs < 2 * MINUTE_MS);
  return (
    <span className={props.className} data-left="" data-urgent={urgent ? "" : undefined}>
      {text}
    </span>
  );
}

/** "in 1h 58m" · "in 16h" · "tomorrow" · "in 2 days". */
export function RelativeTime(props: { readonly atMs: number }) {
  const { atMs } = props;
  return useTickingText((nowMs) => rel(atMs, nowMs));
}

/** The approval window draining along a block's bottom edge. */
export function DrainLine(props: { readonly expiresAtMs: number }) {
  const { expiresAtMs } = props;
  const fraction = useTickingText((nowMs) =>
    Math.min(
      1,
      Math.max(0, (expiresAtMs - nowMs) / AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS),
    ).toFixed(4),
  );
  return <i className="ad-drain" aria-hidden="true" style={{ transform: `scaleX(${fraction})` }} />;
}
