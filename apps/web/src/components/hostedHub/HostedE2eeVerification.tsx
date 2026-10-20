import type { EnvironmentId } from "@ryco/contracts";
import { isHostedHubMode } from "../../env";
import { CopyIcon } from "lucide-react";
import type { WebHostedE2eeChannelStatus } from "../../hostedHub/connectionStatus";
import { useHostedHubStore } from "../../hostedHub/state";
import {
  useWebE2eeChannelStatus,
  useWebE2eeChannelStatusFor,
  useWebE2eeVerificationCode,
  useWebE2eeVerificationCodeFor,
} from "../../hostedHub/useWebE2eeSession";
import {
  hostedSettingsRoleSnapshot,
  settingsSectionReachable,
} from "../settings/settingsSections.logic";
import {
  E2EE_WEB_SAS_UNAVAILABLE,
  hostedE2eeVerificationPlacement,
  hostedE2eeVerificationView,
} from "./HostedE2eeVerification.logic";

/**
 * docs/relay-e2ee-protocol.md §13.5's `WebSAS` for the active session.
 *
 * GATED ON THE LOCK, NOT ON THE CODE. `e2eeSession.ts` publishes the string from
 * inside the §4.4 machine's own `e2ee` lock, which lands one tick before the
 * caller's post-operation sync moves the projection off `negotiating` — so a
 * code can be held while the channel has not yet been reported as locked.
 * Drawing it then would show a comparison value for a channel this surface
 * cannot yet say is encrypted.
 *
 * THE ADVISORY IS NOT BEHIND A DISCLOSURE. §13.5's duty is on "the web UI text
 * accompanying the `WebSAS`", and text a reader has to open is text most readers
 * never see. It renders in the same view as the characters, every time, and it
 * comes out of the same value they do ({@link hostedE2eeVerificationView}).
 *
 * IT IS THE SHORT FORM WHEREVER THE LONG ONE IS ONE NAVIGATION AWAY. This is the
 * surface an owner is looking at while they compare eight characters, so it
 * draws the one line that discharges §13.5 and the pointer at where the rest of
 * it is, rather than the long account.
 *
 * THAT POINTER IS A PROMISE ABOUT THE READER'S OWN SETTINGS DIALOG, so the
 * promise is checked before it is made. Settings → Security is owner-only in
 * hosted mode and fails closed while the role snapshot is stale, and this
 * component has no role gate of its own — it draws for whoever is holding a
 * locked `web-unsigned` channel. Asking `settingsSectionReachable` the same
 * question the settings nav asks is what stops a viewer, an operator, or an
 * owner mid-reconnect being sent to a section that is not in their list; where
 * the answer is no they get the long form here instead, so §2.2's no-pin reason
 * is never the thing behind a door they cannot open.
 *
 * THE ABSENCE OF A CODE IS ALSO A STATE THIS DRAWS. §13.5's duty is a display
 * duty and the derivation may fail without costing the channel, so a locked
 * `web-unsigned` channel can reach this surface holding nothing to compare.
 * Rendering `null` there kept the strongest claim this tier can make while the
 * only check behind it had silently gone missing; the sentence says so instead.
 * `null` remains the answer in every state that is not `web-unsigned`, because
 * there the channel has made no claim to qualify.
 *
 * The string is display state and stays that way: it is read from the in-memory
 * projection on every render and written nowhere. §13.5 — "never logged, never
 * persisted, never sent to analytics" — so there is no `title` attribute and no
 * form control whose value a browser could restore; the one copy is the one the
 * reader asks for.
 *
 * `environmentId` names the node whose session the code belongs to — the open
 * thread's, whether or not the selection cursor is on it — so the code is
 * always the one that node's CLI shows. Without it, the displayed (selected)
 * environment's session.
 */
export function HostedE2eeVerification({
  environmentId,
}: { readonly environmentId?: EnvironmentId } = {}) {
  return environmentId === undefined ? (
    <DisplayedHostedE2eeVerification />
  ) : (
    <EnvironmentHostedE2eeVerification environmentId={environmentId} />
  );
}

function DisplayedHostedE2eeVerification() {
  return (
    <HostedE2eeVerificationView
      status={useWebE2eeChannelStatus()}
      code={useWebE2eeVerificationCode()}
    />
  );
}

function EnvironmentHostedE2eeVerification({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  return (
    <HostedE2eeVerificationView
      status={useWebE2eeChannelStatusFor(environmentId)}
      code={useWebE2eeVerificationCodeFor(environmentId)}
    />
  );
}

function HostedE2eeVerificationView({
  status,
  code,
}: {
  readonly status: WebHostedE2eeChannelStatus;
  readonly code: string | null;
}) {
  const hostedRole = useHostedHubStore((state) => state.effectiveRole);
  const directoryStatus = useHostedHubStore((state) => state.directoryStatus);
  const transportStatus = useHostedHubStore((state) => state.transportStatus);
  if (status !== "web-unsigned") return null;
  // Settings opens on the selected node, so whether its Security section is
  // this reader's to open is asked of the shared role, whichever node's code
  // this is.
  const placement = hostedE2eeVerificationPlacement(
    settingsSectionReachable("security", {
      hosted: isHostedHubMode(),
      role: hostedSettingsRoleSnapshot(hostedRole, directoryStatus, transportStatus),
    }),
  );
  const view = hostedE2eeVerificationView(code, placement);

  if (!view) {
    return (
      <section
        aria-label="Session code"
        data-testid="hosted-e2ee-verification"
        data-code="absent"
        className="space-y-2"
      >
        <p className="text-xs font-medium">Session code</p>
        <p
          data-testid="hosted-e2ee-verification-unavailable"
          className="text-[11px] leading-relaxed text-muted-foreground"
        >
          {E2EE_WEB_SAS_UNAVAILABLE}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Session code"
      data-testid="hosted-e2ee-verification"
      data-code="present"
      // Which length the reachability check picked, so a browser suite can pin
      // the decision itself rather than infer it from which sentence rendered.
      data-form={placement}
      className="space-y-2"
    >
      <p className="text-xs font-medium">Session code</p>
      <p
        data-testid="hosted-e2ee-verification-code"
        // Monospace and unbroken: the comparison is character by character, so a
        // proportional face and a wrap both cost the reader the only check §13.5
        // gives them. `select-all` makes the whole value the selection unit —
        // half a code taken by a stray drag is a comparison against nothing.
        className="font-mono text-base leading-none font-semibold tracking-[0.2em] whitespace-nowrap select-all"
      >
        {view.display}
      </p>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => void navigator.clipboard.writeText(view.display)}
      >
        <CopyIcon aria-hidden className="size-3.5" /> Copy
      </button>
    </section>
  );
}
