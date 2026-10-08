import { useState } from "react";

import { RollingText, useTravelDirection } from "../../chat/RollingText";

function badgeRank(text: string): number {
  return Number.parseFloat(text.replace(/[^\d.-]/g, "")) || 0;
}

/**
 * A rail icon's corner count (prototype `setBadge`). It pops in and out with
 * `data-empty` while still rendering its last value, so the exit animates the
 * number the user saw, and numbers roll in the direction they moved.
 */
export function CrownBadge(props: {
  readonly value: string | number;
  readonly variant?: "default" | "info" | "note";
}) {
  const text = props.value === 0 || props.value === "" ? "" : String(props.value);
  const [shown, setShown] = useState(text);
  if (text !== "" && text !== shown) setShown(text);
  const direction = useTravelDirection(badgeRank(shown));
  return (
    <b
      aria-hidden="true"
      className="crown-badge"
      data-slot="crown-badge"
      data-variant={props.variant ?? "default"}
      data-empty={text === "" ? "true" : undefined}
    >
      {/* The prototype's `.roll` snaps its width; the crown keyframes drop the shared blur. */}
      <RollingText text={shown} direction={direction} align="center" animateWidth={false} />
    </b>
  );
}
