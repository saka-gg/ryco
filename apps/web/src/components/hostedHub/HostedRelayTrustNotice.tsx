import { ShieldAlertIcon, ShieldIcon } from "lucide-react";

import { useWebE2eeChannelStatus } from "../../hostedHub/useWebE2eeSession";
import { hostedRelayTrustDisclosure } from "./HostedRelayTrustNotice.logic";

/**
 * The hosted relay trust disclosure, at whatever the channel behind this tab
 * actually is.
 *
 * IT READS THE PROJECTION ITSELF RATHER THAN TAKING A PROP, and that is the
 * point. The claim used to be a module constant, so all five mount sites
 * rendered it correctly by accident and would have gone on rendering it after
 * the channel changed underneath them. Subscribing here leaves the five call
 * sites untouched and lets none of them pass a stale state, because none of them
 * passes a state at all. There is deliberately no override prop: that is the
 * hole this shape exists to close.
 */
export function HostedRelayTrustNotice({ compact = false }: { readonly compact?: boolean }) {
  const status = useWebE2eeChannelStatus();
  const { tone, body } = hostedRelayTrustDisclosure(status);
  // Colour and glyph only — the claim is the sentence, and the tone never adds
  // to it. `advisory` is an informational token rather than a success one: the
  // one state that encrypted anything is still not the row a success colour
  // would read as (docs/relay-e2ee-protocol.md §2.2, §2.4).
  const Icon = tone === "advisory" ? ShieldIcon : ShieldAlertIcon;
  const iconClassName = tone === "advisory" ? "text-sky-600" : "text-amber-600";
  const frameClassName =
    tone === "advisory" ? "border-sky-500/25 bg-sky-500/5" : "border-amber-500/25 bg-amber-500/5";

  return (
    <div
      className={
        compact
          ? "flex gap-2 text-xs leading-relaxed text-muted-foreground"
          : `flex gap-2 rounded-lg border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground ${frameClassName}`
      }
      data-hosted-relay-trust-notice="true"
      data-e2ee-status={status}
      data-tone={tone}
    >
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${iconClassName}`} />
      <div className="space-y-2">
        <p>{body}</p>
        <p>
          Cloud history keeps a readable copy of recent conversation text on the Hub so threads can
          open before a device connects. This copy is separate from the live node channel.
        </p>
      </div>
    </div>
  );
}
