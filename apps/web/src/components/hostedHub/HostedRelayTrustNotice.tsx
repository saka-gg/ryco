import { ChevronDownIcon, ShieldAlertIcon, ShieldIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import {
  useWebE2eeChannelStatus,
  useWebE2eeOpenChannelStatuses,
} from "../../hostedHub/useWebE2eeSession";
import {
  hostedRelayTrustDisclosure,
  hostedRelayTrustDisclosureStatus,
} from "./HostedRelayTrustNotice.logic";

/**
 * How the notice is drawn. Never what it says.
 *
 * - `panel`: the tinted, bordered block for surfaces that sit beside live node
 *   traffic (the node directory, node security settings).
 * - `inline`: the same claim as plain muted text, for surfaces that already
 *   frame it (the install instructions, the empty thread state).
 * - `disclosure`: one neutral row that expands to the full claim, for the
 *   signed-out gateway, where nothing has been sent to a node yet and a block
 *   of transport detail above the sign-in action costs every visitor a screen
 *   to protect none of them.
 *
 * The disclosure row's label is deliberately not a claim. A headline that
 * summarised the body would be the two-field shape
 * `HostedRelayTrustNotice.logic.ts` refuses, arrived at through layout: a reader
 * who stops at the row learns only that there is something to read, and the
 * glyph carries the same caution/advisory tone the panel would. Expanded, it
 * renders the unabridged body — the claim is never shortened, only folded.
 */
export type HostedRelayTrustNoticeVariant = "panel" | "inline" | "disclosure";

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
 * hole this shape exists to close. It reads every open channel too, so that
 * with no channel behind the selection it never says none is open while one is.
 */
export function HostedRelayTrustNotice({
  variant = "panel",
}: {
  readonly variant?: HostedRelayTrustNoticeVariant;
}) {
  const displayed = useWebE2eeChannelStatus();
  const openChannels = useWebE2eeOpenChannelStatuses();
  const status = hostedRelayTrustDisclosureStatus(displayed, openChannels);
  const { tone, body } = hostedRelayTrustDisclosure(status);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  // Colour and glyph only — the claim is the sentence, and the tone never adds
  // to it. `advisory` is an informational token rather than a success one: the
  // one state that encrypted anything is still not the row a success colour
  // would read as (docs/relay-e2ee-protocol.md §2.2, §2.4).
  const Icon = tone === "advisory" ? ShieldIcon : ShieldAlertIcon;
  const iconClassName = tone === "advisory" ? "text-sky-600" : "text-amber-600";
  const frameClassName =
    tone === "advisory" ? "border-sky-500/25 bg-sky-500/5" : "border-amber-500/25 bg-amber-500/5";

  const claim = (
    <div className="space-y-2">
      <p>{body}</p>
      <p>
        Cloud history keeps a readable copy of recent conversation text on the Hub so threads can
        open before a device connects. This copy is separate from the live node channel.
      </p>
    </div>
  );

  const dataAttributes = {
    "data-hosted-relay-trust-notice": "true",
    "data-e2ee-status": status,
    "data-tone": tone,
  } as const;

  if (variant === "disclosure") {
    return (
      // `contents`, so the toggle joins whatever row the page lays these
      // asides out in and the expanded claim drops to a full-width line below
      // that row instead of splitting it.
      <div className="contents" {...dataAttributes}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring phone:min-h-11"
          onClick={() => setOpen((current) => !current)}
        >
          <Icon aria-hidden className={cn("size-3.5 shrink-0", iconClassName)} />
          How this connection works
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </button>
        {open ? (
          <div
            id={panelId}
            role="region"
            aria-label="How this connection works"
            className={cn(
              "order-last mt-2 basis-full rounded-xl border px-4 py-3 text-left text-muted-foreground text-xs leading-relaxed",
              frameClassName,
            )}
          >
            {claim}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex gap-2 text-muted-foreground text-xs leading-relaxed",
        variant === "panel" && cn("rounded-lg border px-3 py-2.5", frameClassName),
      )}
      {...dataAttributes}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", iconClassName)} />
      {claim}
    </div>
  );
}
