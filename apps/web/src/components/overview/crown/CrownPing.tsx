import { useState, type CSSProperties } from "react";

import type { CrownPing as CrownPingState } from "./useCrownAlerts";
import { CROWN_TONE_VAR } from "./crownSections";

function PingRing(props: { readonly tone: CrownPingState["tone"] }) {
  const [done, setDone] = useState(false);
  if (done) return null;
  return (
    <span
      aria-hidden="true"
      className="crown-ping"
      style={{ "--tone": CROWN_TONE_VAR[props.tone] } as CSSProperties}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setDone(true);
      }}
    />
  );
}

/**
 * A rail icon's ping (prototype `ping()`): a ring in the event's tone that
 * grows out of the button and fades. Keyed by the ping count, so every event
 * remounts it and replays the animation; it removes itself when done.
 */
export function CrownPing(props: { readonly ping: CrownPingState | undefined }) {
  const ping = props.ping;
  if (!ping || ping.n === 0) return null;
  return <PingRing key={ping.n} tone={ping.tone} />;
}
